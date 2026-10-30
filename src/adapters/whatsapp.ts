/**
 * WhatsApp Adapter - Hermes-style WhatsApp platform adapter
 * 
 * Features:
 * - WhatsApp Web protocol via Baileys
 * - QR code authentication
 * - Contact and group management
 * - Media messaging
 */

import { BaseAdapter, type PlatformMessage, type PlatformConfig } from "./base.js";
import { logger } from "../logger.js";

export interface WhatsAppConfig extends PlatformConfig {
  platform: "whatsapp";
  sessionPath?: string;
  printQr?: boolean;  // Print QR to console
  maxMessageLength?: number;
  /** Opt in to the restrictive, unverified direct-message mapping for backend hosts. */
  strictBackendMessages?: boolean;
  /** Strict mode connection deadline in milliseconds. */
  startupTimeoutMs?: number;
  /** Maximum strict notify messages buffered before callbacks are installed. */
  startupIngressCapacity?: number;
}

/** Trusted test/host injection; production uses the optional Baileys peer. */
export interface WhatsAppDependencies {
  loadBaileys: () => Promise<any>;
}

// Baileys receives no logger capable of writing QR codes, nodes or metadata.
const silentLogger: any = {
  level: "silent", trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger; },
};

/** Conservative mapping only; actual Baileys identity semantics still require platform verification. */
export function mapStrictWhatsAppMessage(msg: any): PlatformMessage | undefined {
  const key = msg?.key;
  const jid = key?.remoteJid;
  if (!key || key.fromMe !== false || typeof key.id !== "string" || !key.id.trim() ||
      key.id !== key.id.trim() || /[\u0000-\u001f\u007f]/.test(key.id) || key.id.length > 512 ||
      typeof jid !== "string" || !/^[0-9]+@s\.whatsapp\.net$/.test(jid) ||
      (key.participant != null && key.participant !== jid) ||
      key.remoteJidAlt != null || key.participantAlt != null || msg.participant != null) return undefined;
  const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption;
  if (typeof content !== "string" || !content.trim() || content.length > 65536) return undefined;
  return { id: key.id, platform: "whatsapp", channelId: jid, userId: jid, content,
    timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
    metadata: { chatType: "direct", stableMessageId: true } };
}

interface WhatsAppContact {
  id: string;
  name?: string;
  isGroup: boolean;
}

export class WhatsAppAdapter extends BaseAdapter {
  readonly platform = "whatsapp" as const;
  config: WhatsAppConfig;
  
  private sock: any = null;
  private connected = false;
  private qrCode: string | null = null;
  private readonly loadBaileys: () => Promise<any>;
  private strictListeners: Array<[string, (...args: any[]) => void]> = [];
  private credsWrites: Promise<void> = Promise.resolve();
  private cancelWait: (() => void) | undefined;
  private wakeWait: (() => void) | undefined;
  private strictStopPromise: Promise<void> | undefined;
  private startupMessages: PlatformMessage[] = [];
  private strictCallbacksReady = false;

  constructor(config: WhatsAppConfig, dependencies?: WhatsAppDependencies) {
    super();
    this.config = {
      enabled: true,
      platform: "whatsapp",
      sessionPath: "./whatsapp-session",
      printQr: true,
      maxMessageLength: 4096,
      ...config,
    };
    this.loadBaileys = dependencies?.loadBaileys ?? (() => import("@whiskeysockets/baileys"));
    if (this.config.strictBackendMessages && (!Number.isSafeInteger(this.config.startupTimeoutMs ?? 30000) ||
        (this.config.startupTimeoutMs ?? 30000) < 1 || (this.config.startupTimeoutMs ?? 30000) > 2147483647 ||
        !Number.isSafeInteger(this.config.maxMessageLength) || this.config.maxMessageLength! < 1 ||
        !Number.isSafeInteger(this.config.startupIngressCapacity ?? 32) ||
        (this.config.startupIngressCapacity ?? 32) < 1 || (this.config.startupIngressCapacity ?? 32) > 1024)) {
      throw new Error("Invalid strict WhatsApp configuration");
    }
  }

  async initialize(): Promise<void> {
    try {
      const baileys = await this.loadBaileys();
      
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.config.sessionPath || "./whatsapp-session");
      
      this.sock = baileys.makeWASocket({
        auth: state,
        printQRInTerminal: this.config.strictBackendMessages ? false : this.config.printQr,
        defaultQueryTimeoutMs: 60 * 1000,
        ...(this.config.strictBackendMessages ? { logger: silentLogger } : {}),
      });

      const on = (event: string, listener: (...args: any[]) => void) => {
        this.sock.ev.on(event, listener);
        if (this.config.strictBackendMessages) this.strictListeners.push([event, listener]);
      };
      // Legacy QR event only. Strict mode uses connection.update and never logs QR.
      if (!this.config.strictBackendMessages) on("qr", (qr: string) => {
        this.qrCode = qr;
        if (!this.config.strictBackendMessages) {
          logger.info("[WhatsApp] QR Code received - scan with WhatsApp app");
          logger.info(qr);
        }
      });

      // Handle connection update
      on("connection.update", ({ qr, connection }: any) => {
        if (qr) {
          this.qrCode = qr;
        }
        if (connection === "open") {
          this.connected = true;
          this.qrCode = null;
          this.wakeWait?.();
          logger.info("[WhatsApp] Connected!");
        }
        if (connection === "close") {
          this.connected = false;
          if (this.config.strictBackendMessages) this.cancelWait?.();
          logger.info("[WhatsApp] Disconnected");
        }
      });

      // Handle credentials update
      if (this.config.strictBackendMessages) {
        on("creds.update", () => {
          this.credsWrites = this.credsWrites.then(() => saveCreds()).catch(() => {
            logger.warn("[WhatsApp] Credential persistence failed");
          });
        });
      } else on("creds.update", saveCreds);

      // Handle messages
      on("messages.upsert", ({ messages, type }: any) => {
        // History/append is deliberately dropped; no durable offline inbox exists.
        if (this.config.strictBackendMessages && type !== "notify") return;
        if (Array.isArray(messages)) this.handleMessages(messages);
      });

      logger.info("[WhatsApp] Initializing...");
    } catch (err) {
      if (this.config.strictBackendMessages) throw new Error("WhatsApp initialization failed; ensure the optional @whiskeysockets/baileys peer is installed and configured");
      logger.error("[WhatsApp] Failed to initialize:", err);
      throw err;
    }
  }

  private handleMessages(messages: any[]): void {
    for (const msg of messages) {
      if (this.config.strictBackendMessages) {
        const message = mapStrictWhatsAppMessage(msg);
        if (message) {
          if (this.strictCallbacksReady) void this.emitMessage(message);
          else if (!this.strictStopPromise && this.startupMessages.length < (this.config.startupIngressCapacity ?? 32)) this.startupMessages.push(message);
        }
        continue;
      }
      // Skip messages sent by us
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const isGroup = jid?.endsWith("@g.us");
      
      // Get message content
      const content = 
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      if (!content) continue;

      const message: PlatformMessage = {
        id: msg.key.id || this.generateMessageId(),
        platform: "whatsapp",
        channelId: jid,
        userId: msg.key.participant || jid,
        content,
        timestamp: msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(),
        metadata: {
          isGroup,
          messageType: msg.message ? Object.keys(msg.message)[0] : "unknown",
          pushName: msg.pushName,
        },
      };

      this.emitMessage(message);
    }
  }

  async start(callbacks): Promise<void> {
    await super.start(callbacks);
    
    if (this.config.strictBackendMessages) {
      if (!this.running) throw new Error("WhatsApp startup cancelled");
      this.strictCallbacksReady = true;
      for (const message of this.startupMessages.splice(0)) void this.emitMessage(message);
      if (this.connected) return;
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (error?: string) => {
          if (done) return;
          done = true; clearTimeout(timer); this.wakeWait = undefined; this.cancelWait = undefined;
          if (error) reject(new Error(error)); else resolve();
        };
        const timer = setTimeout(() => finish("WhatsApp connection timed out"), this.config.startupTimeoutMs ?? 30000);
        this.wakeWait = () => finish();
        this.cancelWait = () => finish("WhatsApp startup cancelled");
        if (this.connected) finish();
      });
      return;
    }
    // Wait for connection
    let attempts = 0;
    while (!this.connected && attempts < 30) {
      await this.sleep(1000);
      attempts++;
    }

    if (!this.connected) {
      logger.warn("[WhatsApp] Not yet connected - waiting for QR scan");
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
    if (!this.config.strictBackendMessages) {
      if (this.sock) { await this.sock.logout(); this.sock = null; }
      this.connected = false;
      await super.stop();
      return;
    }
    if (this.strictStopPromise) return this.strictStopPromise;
    this.cancelWait?.();
    const sock = this.sock;
    this.strictStopPromise = (async () => {
      let failed = false;
      try {
        // Remove only our listeners before disconnecting or draining credential writes.
        for (const [event, listener] of this.strictListeners) {
          try { sock?.ev?.off?.(event, listener); } catch { failed = true; }
        }
        if (sock) await sock.end(undefined);
      } catch { failed = true; }
      finally {
        this.strictListeners = [];
        this.startupMessages = [];
        this.strictCallbacksReady = false;
        this.sock = null;
        this.connected = false;
        this.qrCode = null;
        await super.stop();
        await this.credsWrites;
      }
      if (failed) throw new Error("WhatsApp disconnect failed");
    })();
    return this.strictStopPromise;
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    // Backend mode must never silently turn a committed answer into a partial answer.
    if (this.config.strictBackendMessages && content.length > (this.config.maxMessageLength || 4096)) {
      throw new Error("WhatsApp backend response exceeds message limit");
    }
    // Legacy mode truncates if too long
    const text = content.length > (this.config.maxMessageLength || 4096)
      ? content.slice(0, this.config.maxMessageLength - 3) + "..."
      : content;

    try {
      const result = await this.sock.sendMessage(channelId, { text });
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      if (this.config.strictBackendMessages) throw new Error("WhatsApp backend send failed");
      logger.error("[WhatsApp] Send error:", err);
      throw err;
    }
  }

  async sendImage(channelId: string, imageUrl: string, caption?: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      const result = await this.sock.sendMessage(channelId, {
        image: { url: imageUrl },
        caption,
      });
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      logger.error("[WhatsApp] Send image error:", err);
      throw err;
    }
  }

  async sendReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      await this.sock.sendMessage(channelId, {
        react: { text: emoji, key: { remoteJid: channelId, id: messageId } },
      });
    } catch (err) {
      logger.error("[WhatsApp] Reaction error:", err);
    }
  }

  async reply(channelId: string, content: string, messageId: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      const result = await this.sock.sendMessage(channelId, {
        text: content,
        contextInfo: {
          stanzaId: messageId,
          remoteJid: channelId,
        },
      });
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      logger.error("[WhatsApp] Reply error:", err);
      throw err;
    }
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      await this.sock.relayMessage(channelId, {
        protocolMessage: {
          type: 6, // MESSAGE_EDIT
          key: { remoteJid: channelId, id: messageId },
          editedMessage: { conversation: [{ text: content }] },
        },
      }, {});
    } catch (err) {
      logger.error("[WhatsApp] Edit error:", err);
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      await this.sock.sendMessage(channelId, {
        delete: { remoteJid: channelId, id: messageId },
      });
    } catch (err) {
      logger.error("[WhatsApp] Delete error:", err);
    }
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    if (!this.sock || !this.connected) return;

    try {
      await this.sock.sendPresenceUpdate(isTyping ? "composing" : "available", channelId);
    } catch (err) {
      // Ignore presence errors
    }
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    return { connected: this.connected };
  }

  async getContacts(): Promise<WhatsAppContact[]> {
    if (!this.sock?.store?.contacts) {
      return [];
    }

    return Object.entries(this.sock.store.contacts).map(([id, contact]: [string, any]) => ({
      id,
      name: contact?.name || contact?.notify || id.split("@")[0],
      isGroup: id.endsWith("@g.us"),
    }));
  }

  async getContact(jid: string): Promise<WhatsAppContact | null> {
    const contacts = await this.getContacts();
    return contacts.find(c => c.id === jid) || null;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }
}
