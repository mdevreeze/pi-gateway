/** Trusted in-process backend host. This module does not import the legacy gateway. */
import type { PlatformAdapter, PlatformMessage } from "./adapters/base.js";
import { WhatsAppAdapter, type WhatsAppConfig } from "./adapters/whatsapp.js";

export interface BackendMessage {
  platform: string;
  userId: string;
  channelId: string;
  messageId: string;
  text: string;
  chatType: "direct";
  stableMessageId: true;
}
export interface Backend {
  authorize(message: BackendMessage): boolean | Promise<boolean>;
  submit(message: BackendMessage): Promise<string | undefined>;
}
export type BackendError = "overload" | "backend" | "delivery" | "shutdown" | "startup";
export interface BackendHostOptions {
  backend: Backend;
  /** Independent defense in depth; must be explicitly supplied by the trusted host. */
  allow: (message: BackendMessage) => boolean;
  /** Trusted injected adapter, or create a strict WhatsApp adapter with the helper below. */
  adapter: PlatformAdapter;
  /** Maximum active plus waiting messages. */
  capacity: number;
  /** Maximum response size, including the fixed overflow notice. */
  maxResponseLength?: number;
  /** Sanitized operational signals, never message contents or exception objects. */
  onError?: (code: BackendError) => void;
}

export function createBackendWhatsAppAdapter(config: WhatsAppConfig): WhatsAppAdapter {
  if (!config.enabled || config.platform !== "whatsapp") throw new Error("Expected enabled WhatsApp config");
  return new WhatsAppAdapter({ ...config, strictBackendMessages: true });
}

/** Single-use host: start once, then close. No RPC, session store, HTTP or WebSocket. */
export function createBackendHost(options: BackendHostOptions) {
  const { backend, adapter, allow, capacity, onError } = options;
  const overflowNotice = "Response too long to deliver.";
  const maxResponseLength = options.maxResponseLength ?? 4096;
  if (!backend || typeof backend.authorize !== "function" || typeof backend.submit !== "function" ||
      typeof allow !== "function" || !adapter || adapter.platform !== "whatsapp" ||
      adapter.config.platform !== "whatsapp" || !adapter.config.enabled ||
      (adapter.config as WhatsAppConfig).strictBackendMessages !== true ||
      !Number.isSafeInteger(maxResponseLength) || maxResponseLength < overflowNotice.length || maxResponseLength > 4096 ||
      !Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid backend host configuration");
  let state: "new" | "starting" | "running" | "closing" | "closed" = "new";
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let initialized = false;
  let stopPromise: Promise<void> | undefined;
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
  const stopAdapter = () => stopPromise ??= Promise.resolve().then(() => adapter.stop());
  const seal = () => {
    if (state === "closed") return;
    state = "closing";
    resolveReady(false);
    if (initialized) void stopAdapter().catch(() => {});
  };
  const report = (code: BackendError) => { try { onError?.(code); } catch { /* observer cannot break dispatch */ } };

  const dispatch = async (raw: PlatformMessage): Promise<void> => {
    if (state !== "running" && state !== "starting") { report("shutdown"); return; }
    // Metadata is a trusted adapter assertion, not remote-client authentication.
    if (raw.platform !== "whatsapp" || raw.metadata?.chatType !== "direct" || raw.metadata?.stableMessageId !== true ||
        typeof raw.id !== "string" || !raw.id.trim() || raw.id.trim() !== raw.id || raw.id.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(raw.id) || typeof raw.channelId !== "string" ||
        !/^[0-9]+@s\.whatsapp\.net$/.test(raw.channelId) || raw.userId !== raw.channelId ||
        typeof raw.content !== "string" || !raw.content.trim() || raw.content.length > 65536) return;
    const message: BackendMessage = { platform: raw.platform, userId: raw.userId, channelId: raw.channelId,
      messageId: raw.id, text: raw.content, chatType: "direct", stableMessageId: true };
    try { if (allow(message) !== true) return; } catch { report("backend"); return; }
    if (pending >= capacity) { report("overload"); return; }
    pending++;
    const work = tail.then(async () => {
      if (!await ready || state !== "running") { report("shutdown"); return; }
      try {
        if (!await backend.authorize(message)) return;
      } catch { report("backend"); return; }
      if (state !== "running") { report("shutdown"); return; }
      // No commands or interactive/callback ingress in this host.
      if (/^\s*(?:\/|Callback:)/i.test(message.text)) return;
      let result: string | undefined;
      try { result = await backend.submit(message); } catch { report("backend"); return; }
      if (state !== "running") { report("shutdown"); return; }
      if (result === undefined) return;
      if (typeof result !== "string" || !result.trim()) { report("backend"); return; }
      try { await adapter.sendMessage(message.channelId, result.length > maxResponseLength ? overflowNotice : result); } catch { report("delivery"); }
    });
    tail = work.catch(() => { report("backend"); }).finally(() => { pending--; });
    // An adapter may await its callback during start; never wait for readiness here.
    if (state !== "starting") await tail;
  };
  return {
    start(): Promise<void> {
      if (state !== "new") return Promise.reject(new Error("Backend host is single-use"));
      state = "starting";
      startPromise = (async () => {
        try {
          await adapter.initialize();
          initialized = true;
          if (state !== "starting") throw new Error("cancelled");
          await adapter.start({ onMessage: dispatch });
          if (state !== "starting") throw new Error("cancelled");
          state = "running";
          resolveReady(true);
        } catch {
          resolveReady(false);
          report("startup");
          try { await stopAdapter(); } catch { /* startup failure remains primary */ }
          state = "closed";
          throw new Error("Backend host startup failed");
        }
      })();
      return startPromise;
    },
    /** Synchronously reject ingress and suppress active results before closing the backend. */
    stopIngress(): void {
      seal();
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      const wasNew = !startPromise;
      seal();
      closePromise = (async () => {
        try {
          if (startPromise) { try { await startPromise; } catch { /* cleanup still joined below */ } }
          if (!wasNew) {
            try { await stopAdapter(); } catch { throw new Error("Backend host shutdown failed"); }
          }
        } finally { await tail; state = "closed"; }
      })();
      return closePromise;
    },
  };
}
