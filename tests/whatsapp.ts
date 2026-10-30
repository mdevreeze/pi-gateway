import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// logger resolves HOME at import time; never touch the developer's Gateway state.
const home = mkdtempSync(join(tmpdir(), "gateway-whatsapp-test-"));
process.env.HOME = home;
const { WhatsAppAdapter } = await import("../src/adapters/whatsapp.js");
const { createBackendHost } = await import("../src/backend.js");
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const jid = "123@s.whatsapp.net";
const raw = (id: string, text = "hello") => ({ key: { id, remoteJid: jid, fromMe: false }, message: { conversation: text } });
const config = { enabled: true, platform: "whatsapp" as const, strictBackendMessages: true, startupTimeoutMs: 1000, maxMessageLength: 50 };
function fake() {
  const ev = new EventEmitter();
  const sent: any[] = [];
  let opts: any; let logouts = 0; let ends = 0; let failEnd = false; let failSend = false;
  let save: () => Promise<void> = async () => {};
  const sock = { ev, end: () => { ends++; if (failEnd) throw Error("private end"); }, logout: async () => { logouts++; },
    sendMessage: async (channel: string, payload: any) => { if (failSend) throw Error("private send"); sent.push({ channel, payload }); return { key: { id: "sent" } }; } };
  const dependencies = { loadBaileys: async () => ({ useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => save() }),
    makeWASocket: (options: any) => { opts = options; return sock; } }) };
  return { ev, sent, dependencies, get options() { return opts; }, get logouts() { return logouts; }, get ends() { return ends; },
    setSave(fn: () => Promise<void>) { save = fn; }, setFailEnd(v: boolean) { failEnd = v; }, setFailSend(v: boolean) { failSend = v; } };
}
try {
  // Actual strict adapter receives Baileys-style events, and never logs QR or raw nodes.
  const f = fake(); const adapter = new WhatsAppAdapter(config, f.dependencies);
  const incoming: any[] = [];
  await adapter.initialize();
  assert.equal(f.options.printQRInTerminal, false);
  const log = f.options.logger;
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) log[level]("private-node-secret");
  log.child({ jid: "private-jid" }).info("private-child-secret");
  f.ev.emit("messages.upsert", { type: "notify", messages: [raw("before-start")] });
  const starting = adapter.start({ onMessage: async m => { incoming.push(m); } });
  await tick();
  f.ev.emit("connection.update", { qr: "private-qr-secret" });
  assert.equal(adapter.getQrCode(), "private-qr-secret");
  f.ev.emit("messages.upsert", { type: "append", messages: [raw("history")] });
  f.ev.emit("messages.upsert", { type: "notify", messages: [raw("original"), { ...raw("bad"), key: { ...raw("bad").key, remoteJid: "123@g.us" } }] });
  assert.deepEqual(incoming.map(m => m.id), ["before-start", "original"]);
  assert.deepEqual(incoming[0].metadata, { chatType: "direct", stableMessageId: true });
  f.ev.emit("connection.update", { connection: "open" }); await starting;
  assert.equal(adapter.getQrCode(), null);
  await adapter.sendMessage(jid, "ok"); assert.equal(f.sent[0].payload.text, "ok");
  await assert.rejects(adapter.sendMessage(jid, "x".repeat(51)), /exceeds/);
  f.setFailSend(true); await assert.rejects(adapter.sendMessage(jid, "x"), e => e instanceof Error && e.message === "WhatsApp backend send failed");

  let firstRelease!: () => void; let writes = 0;
  f.setSave(async () => { writes++; if (writes === 1) await new Promise<void>(r => { firstRelease = r; }); });
  f.ev.emit("creds.update"); f.ev.emit("creds.update"); await tick(); assert.equal(writes, 1);
  let stopped = false; const stop = adapter.stop().then(() => { stopped = true; }); await tick();
  assert.equal(stopped, false); assert.equal(f.logouts, 0); assert.equal(f.ends, 1);
  assert.equal(f.ev.listenerCount("messages.upsert"), 0);
  firstRelease(); await stop; assert.equal(writes, 2); assert.equal(adapter.getQrCode(), null);

  const throwing = fake(); const a2 = new WhatsAppAdapter(config, throwing.dependencies);
  await a2.initialize(); const wait = a2.start({ onMessage: async () => {} }); await tick();
  throwing.ev.emit("connection.update", { qr: "private-qr-2" }); throwing.setFailEnd(true);
  const rejectedStart = assert.rejects(wait, /cancelled/);
  await assert.rejects(a2.stop(), e => e instanceof Error && e.message === "WhatsApp disconnect failed");
  await rejectedStart; assert.equal(throwing.logouts, 0); assert.equal(a2.getQrCode(), null);
  assert.equal(throwing.ev.eventNames().length, 0);

  const failedCreds = fake(); failedCreds.setSave(async () => { throw Error("private-creds-secret"); });
  const a3 = new WhatsAppAdapter(config, failedCreds.dependencies); await a3.initialize();
  failedCreds.ev.emit("creds.update"); await a3.stop();

  const timeout = fake(); const a4 = new WhatsAppAdapter({ ...config, startupTimeoutMs: 10 }, timeout.dependencies);
  await a4.initialize(); await assert.rejects(a4.start({ onMessage: async () => {} }), /timed out/); await a4.stop();
  const disconnected = fake(); const a5 = new WhatsAppAdapter(config, disconnected.dependencies);
  await a5.initialize(); const interrupted = a5.start({ onMessage: async () => {} }); const interruptedResult = assert.rejects(interrupted, /cancelled/);
  await tick(); disconnected.ev.emit("connection.update", { connection: "close" }); await interruptedResult; await a5.stop();
  assert.throws(() => new WhatsAppAdapter({ ...config, startupTimeoutMs: 0 }, timeout.dependencies), /Invalid/);
  const buffered = fake(); const limited = new WhatsAppAdapter({ ...config, startupIngressCapacity: 1 }, buffered.dependencies);
  const bufferedIds: string[] = []; await limited.initialize();
  buffered.ev.emit("messages.upsert", { type: "notify", messages: [raw("buffered"), raw("dropped")] });
  const limitedStart = limited.start({ onMessage: async m => { bufferedIds.push(m.id); } }); await tick();
  assert.deepEqual(bufferedIds, ["buffered"]); buffered.ev.emit("connection.update", { connection: "open" }); await limitedStart; await limited.stop();
  const timedHostSource = fake(); const timedAdapter = new WhatsAppAdapter({ ...config, startupTimeoutMs: 10 }, timedHostSource.dependencies);
  const timedErrors: string[] = [];
  const timedHost = createBackendHost({ adapter: timedAdapter, capacity: 1, allow: () => true,
    backend: { authorize: () => true, submit: async () => "never" }, onError: code => timedErrors.push(code) });
  await assert.rejects(timedHost.start(), /startup failed/); await timedHost.close();
  assert.ok(timedErrors.includes("startup")); assert.equal(timedHostSource.ends, 1);
  const missing = new WhatsAppAdapter(config, { loadBaileys: async () => { throw Error("private-import-secret"); } });
  await assert.rejects(missing.initialize(), /optional @whiskeysockets\/baileys peer/);

  // Strict notify ingress during connection is bounded by the host and waits for readiness.
  const startup = fake(); const actual = new WhatsAppAdapter(config, startup.dependencies);
  const submitted: string[] = []; const signals: string[] = [];
  const host = createBackendHost({ adapter: actual, capacity: 1, allow: () => true,
    backend: { authorize: () => true, submit: async m => { submitted.push(m.messageId); return "ok"; } }, onError: code => signals.push(code) });
  const hostStarting = host.start(); await tick();
  startup.ev.emit("messages.upsert", { type: "notify", messages: [raw("first"), raw("overflow")] });
  await tick(); assert.deepEqual(submitted, []); assert.ok(signals.includes("overload"));
  startup.ev.emit("connection.update", { connection: "open" }); await hostStarting; await tick(); await tick();
  assert.deepEqual(submitted, ["first"]); assert.equal(startup.sent.length, 1); await host.close();

  const cancelled = fake(); const actual2 = new WhatsAppAdapter(config, cancelled.dependencies);
  const lifecycleErrors: string[] = [];
  const host2 = createBackendHost({ adapter: actual2, capacity: 1, allow: () => true,
    backend: { authorize: () => true, submit: async () => "never" }, onError: code => lifecycleErrors.push(code) });
  const host2Start = host2.start(); const host2Rejection = assert.rejects(host2Start, /startup failed/); await tick();
  cancelled.ev.emit("messages.upsert", { type: "notify", messages: [raw("pending")] });
  host2.stopIngress(); await Promise.all([host2Rejection, host2.close()]);
  assert.ok(lifecycleErrors.includes("startup")); assert.equal(cancelled.ends, 1); assert.equal(cancelled.sent.length, 0);

  // Legacy still accepts non-notify messages, truncates, and logs out on stop.
  const legacy = fake(); const legacyAdapter = new WhatsAppAdapter({ enabled: true, platform: "whatsapp", maxMessageLength: 5 }, legacy.dependencies);
  const oldIncoming: any[] = []; await legacyAdapter.initialize();
  legacy.ev.emit("connection.update", { connection: "open" });
  await legacyAdapter.start({ onMessage: async m => { oldIncoming.push(m); } });
  legacy.ev.emit("messages.upsert", { type: "append", messages: [raw("legacy")] });
  assert.equal(oldIncoming[0].id, "legacy");
  await legacyAdapter.sendMessage(jid, "abcdefgh"); assert.equal(legacy.sent[0].payload.text, "ab...");
  await legacyAdapter.stop(); assert.equal(legacy.logouts, 1); assert.equal(legacy.ends, 0);

  const logPath = join(home, ".pi", "gateway", "gateway.log");
  const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  for (const secret of ["private-qr-secret", "private-qr-2", "private-node-secret", "private-child-secret", "private-jid", "private-creds-secret", "private-import-secret"]) assert.equal(logText.includes(secret), false);
  console.log("WhatsApp adapter tests passed");
} finally { rmSync(home, { recursive: true, force: true }); }
