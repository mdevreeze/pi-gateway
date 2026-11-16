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
  /** Independently configured owner PN; enables owner-only LID binding via a fresh USync query. */
  ownerJid?: string;
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

export interface WhatsAppOwnerBinding { ownerJid: string; ownerLid: string }
export interface WhatsAppGroupParticipant { id: string; pn: string }
export interface WhatsAppGroupContext {
  /** WhatsApp group creator, in canonical phone-number JID form. */
  creatorJid: string;
  /** Canonical participant identities. LIDs are resolved to PNs before reaching Kit. */
  participants: WhatsAppGroupParticipant[];
  /** The bot's own PN/LID identities, used to detect mentions. */
  botJids: string[];
}

// Baileys cleanMessage() normalizes absent participants to the empty string.
const hasParticipant = (value: unknown): boolean => value != null && value !== "";
const isPnJid = (value: unknown): value is string => typeof value === "string" && /^[0-9]+@s\.whatsapp\.net$/.test(value);
const isLidJid = (value: unknown): value is string => typeof value === "string" && /^[0-9]+@lid$/.test(value);
const isGroupJid = (value: unknown): value is string => typeof value === "string" && /^[0-9-]+@g\.us$/.test(value);

/** Only the trusted adapter may supply a binding obtained by querying the configured owner. */
export function mapStrictWhatsAppMessage(msg: any, binding?: WhatsAppOwnerBinding): PlatformMessage | undefined {
  const key = msg?.key;
  let jid = key?.remoteJid;
  if (binding) {
    if (!/^[0-9]+@s\.whatsapp\.net$/.test(binding.ownerJid) || !/^[0-9]+@lid$/.test(binding.ownerLid)) return undefined;
    if (jid === binding.ownerLid || jid === binding.ownerJid) {
      const isLid = jid === binding.ownerLid;
      const expectedAlt = isLid ? binding.ownerJid : binding.ownerLid;
      if (hasParticipant(key.participant) || hasParticipant(key.participantAlt) || hasParticipant(msg.participant) ||
          (key.remoteJidAlt != null && key.remoteJidAlt !== expectedAlt) ||
          (key.addressingMode != null && key.addressingMode !== (isLid ? "lid" : "pn"))) return undefined;
      // Preserve the original message ID; canonicalize only a server-verified owner pair.
      jid = binding.ownerJid;
    } else if (key?.remoteJidAlt != null) return undefined;
  }
  const boundOwner = !!binding && jid === binding.ownerJid &&
    (key?.remoteJid === binding.ownerJid || key?.remoteJid === binding.ownerLid);
  if (!key || msg.broadcast === true || key.fromMe !== false || typeof key.id !== "string" || !key.id.trim() ||
      key.id !== key.id.trim() || /[\u0000-\u001f\u007f]/.test(key.id) || key.id.length > 512 ||
      typeof jid !== "string" || !/^[0-9]+@s\.whatsapp\.net$/.test(jid) ||
      (hasParticipant(key.participant) && key.participant !== jid) ||
      (!boundOwner && key.remoteJidAlt != null) || hasParticipant(key.participantAlt) || hasParticipant(msg.participant)) return undefined;
  const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption;
  if (typeof content !== "string" || !content.trim() || content.length > 65536) return undefined;
  return { id: key.id, platform: "whatsapp", channelId: jid, userId: jid, content,
    timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
    metadata: { chatType: "direct", stableMessageId: true } };
}

/**
 * Map one strict WhatsApp group message. The context comes from a fresh group-metadata query:
 * participant LIDs are resolved to phone-number JIDs and the creator is authenticated there.
 */
export function mapStrictWhatsAppGroupMessage(msg: any, context?: WhatsAppGroupContext): PlatformMessage | undefined {
  const key = msg?.key;
  if (!context || !isPnJid(context.creatorJid) || !Array.isArray(context.participants) ||
      !context.participants.length || !context.participants.every((p) => isPnJid(p.pn) && (isPnJid(p.id) || isLidJid(p.id))) ||
      !Array.isArray(context.botJids) || !context.botJids.every((jid) => isPnJid(jid) || isLidJid(jid)) ||
      !isGroupJid(key?.remoteJid) || key.fromMe !== false || msg.broadcast === true ||
      typeof key.id !== "string" || !key.id.trim() || key.id !== key.id.trim() || /[\u0000-\u001f\u007f]/.test(key.id) || key.id.length > 512) return undefined;
  const participant = key.participant;
  if (!isPnJid(participant) && !isLidJid(participant)) return undefined;
  const resolved = context.participants.find((p) => p.id === participant || p.pn === participant);
  if (!resolved) return undefined;
  const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption;
  if (typeof content !== "string" || !content.trim() || content.length > 65536) return undefined;
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const mentioned = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [];
  const quotedParticipant = contextInfo?.participant;
  const addressed = mentioned.some((jid: unknown) => context.botJids.includes(jid as string)) ||
    (typeof quotedParticipant === "string" && context.botJids.includes(quotedParticipant));
  return { id: key.id, platform: "whatsapp", channelId: key.remoteJid, userId: resolved.pn, content,
    timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
    metadata: { chatType: "group", stableMessageId: true, addressed,
      groupCreator: context.creatorJid, groupParticipants: context.participants.map((p) => p.pn) } };
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
  private connectionFailure: string | undefined;
  private ownerBinding: WhatsAppOwnerBinding | undefined;
  private queryOwnerBinding: (() => Promise<any>) | undefined;
  private messageDiagnostics = { mapped: 0, lid: 0, alternateIdentity: 0, self: 0, unsupported: 0, nonNotify: 0 };
  private qrCode: string | null = null;
  private readonly loadBaileys: () => Promise<any>;
  private strictListeners: Array<[string, (...args: any[]) => void]> = [];
  private credsWrites: Promise<void> = Promise.resolve();
  private cancelWait: (() => void) | undefined;
  private wakeWait: (() => void) | undefined;
  private strictStopPromise: Promise<void> | undefined;
  private startupMessages: PlatformMessage[] = [];
  private strictCallbacksReady = false;
  /** Serialize ingress so async group metadata lookups cannot bypass the startup bound. */
  private messageQueue: Promise<void> = Promise.resolve();

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
    if (this.config.ownerJid != null && (!this.config.strictBackendMessages ||
        typeof this.config.ownerJid !== "string" || !/^[0-9]+@s\.whatsapp\.net$/.test(this.config.ownerJid))) {
      throw new Error("Expected strict WhatsApp owner direct JID");
    }
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

      if (this.config.ownerJid) {
        // Query the configured PN directly. Never infer authority from an incoming
        // remoteJidAlt or the SDK's cache (which can be populated by received events).
        const owner = this.config.ownerJid;
        this.queryOwnerBinding = () => this.sock.executeUSyncQuery(
          new baileys.USyncQuery().withLIDProtocol().withContext("background")
            .withUser(new baileys.USyncUser().withId(owner)),
        );
      }

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
      on("connection.update", ({ qr, connection, lastDisconnect }: any) => {
        if (qr) {
          this.qrCode = qr;
        }
        if (connection === "open") {
          this.connectionFailure = undefined;
          this.connected = true;
          this.qrCode = null;
          this.wakeWait?.();
          logger.info("[WhatsApp] Connected!");
        }
        if (connection === "close") {
          this.connected = false;
          this.ownerBinding = undefined;
          if (this.config.strictBackendMessages) {
            // Only fixed labels leave the adapter, never exception text or payloads.
            const code = lastDisconnect?.error?.output?.statusCode;
            const reasons = new Map<number, string>([
              [401, "logged-out"], [403, "forbidden"], [408, "connection-lost"],
              [411, "multidevice-mismatch"], [428, "connection-closed"],
              [440, "connection-replaced"], [500, "bad-session"],
              [503, "service-unavailable"], [515, "restart-required"],
            ]);
            this.connectionFailure = reasons.get(code) ?? "unknown-disconnect";
            this.qrCode = null;
            this.cancelWait?.();
          }
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
        if (this.config.strictBackendMessages && type !== "notify") {
          this.messageDiagnostics.nonNotify++;
          return;
        }
        if (Array.isArray(messages)) this.messageQueue = this.messageQueue.then(() => this.handleMessages(messages)).catch(() => {});
      });

      logger.info("[WhatsApp] Initializing...");
    } catch (err) {
      if (this.config.strictBackendMessages) {
        this.connectionFailure = "initialization-failed";
        throw new Error("WhatsApp initialization failed; ensure the optional @whiskeysockets/baileys peer is installed and configured");
      }
      logger.error("[WhatsApp] Failed to initialize:", err);
      throw err;
    }
  }

  private async handleMessages(messages: any[]): Promise<void> {
    for (const msg of messages) {
      if (this.config.strictBackendMessages) {
        const remoteJid = msg?.key?.remoteJid;
        const message = isGroupJid(remoteJid)
          ? mapStrictWhatsAppGroupMessage(msg, await this.groupContext(remoteJid))
          : mapStrictWhatsAppMessage(msg, this.ownerBinding);
        if (message) {
          this.messageDiagnostics.mapped++;
          if (this.strictCallbacksReady) await this.emitMessage(message);
          else if (!this.strictStopPromise && this.startupMessages.length < (this.config.startupIngressCapacity ?? 32)) this.startupMessages.push(message);
        } else {
          // Diagnostics describe rejection categories only, not identities or content.
          const key = msg?.key;
          if (key?.fromMe === true) this.messageDiagnostics.self++;
          else if (typeof key?.remoteJid === "string" && key.remoteJid.endsWith("@lid")) this.messageDiagnostics.lid++;
          else if (key?.remoteJidAlt != null || key?.participantAlt != null) this.messageDiagnostics.alternateIdentity++;
          else this.messageDiagnostics.unsupported++;
        }
        continue;
      }
      // Skip messages sent by us
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const isGroup = jid?.endsWith("@g.us");
      const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
      if (!content) continue;

      const message: PlatformMessage = {
        id: msg.key.id || this.generateMessageId(), platform: "whatsapp", channelId: jid,
        userId: msg.key.participant || jid, content,
        timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
        metadata: { isGroup, messageType: msg.message ? Object.keys(msg.message)[0] : "unknown", pushName: msg.pushName },
      };
      await this.emitMessage(message);
    }
  }

  /** Fresh server metadata for a group: creator, canonical participants and the bot's own identities. */
  private async groupContext(groupJid: string): Promise<WhatsAppGroupContext | undefined> {
    if (!this.sock?.groupMetadata) return undefined;
    try {
      const metadata = await this.sock.groupMetadata(groupJid);
      if (!metadata || metadata.id !== groupJid) return undefined;
      const creator = isPnJid(metadata.ownerPn) ? metadata.ownerPn : isPnJid(metadata.owner) ? metadata.owner : undefined;
      if (!creator || !Array.isArray(metadata.participants)) return undefined;
      const botJids = [this.sock.user?.id, this.sock.user?.lid].filter((jid: unknown): jid is string => isPnJid(jid) || isLidJid(jid));
      const participants: WhatsAppGroupParticipant[] = [];
      for (const participant of metadata.participants) {
        if (!participant || typeof participant.id !== "string") continue;
        const pn = isPnJid(participant.phoneNumber) ? participant.phoneNumber : isPnJid(participant.id) ? participant.id : undefined;
        if (!pn) continue;
        if (botJids.includes(participant.id) || botJids.includes(participant.lid ?? "") || botJids.includes(pn)) continue;
        participants.push({ id: participant.id, pn });
      }
      if (!participants.length) return undefined;
      return { creatorJid: creator, participants, botJids };
    } catch {
      return undefined;
    }
  }

  async start(callbacks): Promise<void> {
    await super.start(callbacks);
    
    if (this.config.strictBackendMessages) {
      if (!this.running || this.connectionFailure) throw new Error("WhatsApp startup cancelled");
      this.strictCallbacksReady = true;
      for (const message of this.startupMessages.splice(0)) void this.emitMessage(message);
      if (!this.connected) await new Promise<void>((resolve, reject) => {
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
      if (this.config.ownerJid) await this.bindOwnerIdentity();
      if (!this.running || !this.connected || this.strictStopPromise) throw new Error("WhatsApp startup cancelled");
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

  private async bindOwnerIdentity(): Promise<void> {
    try {
      const result = await new Promise<any>((resolve, reject) => {
        let done = false;
        const finish = (value?: any, failed = false) => {
          if (done) return;
          done = true; clearTimeout(timer); this.cancelWait = undefined;
          if (failed) reject(new Error("WhatsApp owner lookup failed")); else resolve(value);
        };
        const timer = setTimeout(() => finish(undefined, true), this.config.startupTimeoutMs ?? 30000);
        this.cancelWait = () => finish(undefined, true);
        void Promise.resolve().then(() => this.queryOwnerBinding!()).then(
          value => finish(value), () => finish(undefined, true),
        );
      });
      const owner = this.config.ownerJid!;
      if (!this.running || !this.connected || this.strictStopPromise || !Array.isArray(result?.list) ||
          result.list.length !== 1 || result.list[0]?.id !== owner ||
          typeof result.list[0]?.lid !== "string" || !/^[0-9]+@lid$/.test(result.list[0].lid)) {
        throw new Error("WhatsApp owner lookup failed");
      }
      this.ownerBinding = { ownerJid: owner, ownerLid: result.list[0].lid };
    } catch {
      if (!this.connectionFailure) this.connectionFailure = "owner-lookup-failed";
      throw new Error("WhatsApp owner lookup failed");
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
        await this.messageQueue.catch(() => {});
        this.sock = null;
        this.connected = false;
        this.ownerBinding = undefined;
        this.queryOwnerBinding = undefined;
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
      const destination = this.ownerBinding?.ownerJid === channelId ? this.ownerBinding.ownerLid : channelId;
      const result = await this.sock.sendMessage(destination, { text });
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

  /** Aggregate observations only; no message text, IDs, phone numbers or QR data. */
  getMessageDiagnostics(): { mapped: number; lid: number; alternateIdentity: number; self: number; unsupported: number; nonNotify: number } {
    return { ...this.messageDiagnostics };
  }

  /** Sanitized failure survives stop() so a host can diagnose failed startup. */
  getConnectionFailure(): string | undefined {
    return this.connectionFailure;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }
}
