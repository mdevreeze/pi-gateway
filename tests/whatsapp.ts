import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// logger resolves HOME at import time; never touch the developer's Gateway state.
const home = mkdtempSync(join(tmpdir(), "gateway-whatsapp-test-"));
process.env.HOME = home;
const { WhatsAppAdapter, mapStrictWhatsAppMessage } = await import("../src/adapters/whatsapp.js");
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
  const queries: any[] = [];
  let query: () => Promise<any> = async () => ({ list: [{ id: jid, lid: "777@lid" }] });
  class USyncUser {
    id?: string;
    withId(id: string) { this.id = id; return this; }
  }
  class USyncQuery {
    users: USyncUser[] = []; lid = false; context?: string;
    withLIDProtocol() { this.lid = true; return this; }
    withContext(context: string) { this.context = context; return this; }
    withUser(user: USyncUser) { this.users.push(user); return this; }
  }
  const sock = { ev, executeUSyncQuery: async (q: any) => { queries.push(q); return query(); }, end: () => { ends++; if (failEnd) throw Error("private end"); }, logout: async () => { logouts++; },
    sendMessage: async (channel: string, payload: any) => { if (failSend) throw Error("private send"); sent.push({ channel, payload }); return { key: { id: "sent" } }; } };
  const dependencies = { loadBaileys: async () => ({ USyncQuery, USyncUser, useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => save() }),
    makeWASocket: (options: any) => { opts = options; return sock; } }) };
  return { ev, sent, queries, dependencies, setQuery(fn: () => Promise<any>) { query = fn; }, get options() { return opts; }, get logouts() { return logouts; }, get ends() { return ends; },
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
  const earlyClose = fake(); const early = new WhatsAppAdapter(config, earlyClose.dependencies);
  await early.initialize();
  earlyClose.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await assert.rejects(early.start({ onMessage: async () => {} }), /cancelled/); await early.stop();
  assert.equal(early.getConnectionFailure(), "logged-out");
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
  assert.equal(missing.getConnectionFailure(), "initialization-failed");

  // Fixed diagnostics survive host cleanup and never expose raw error data.
  for (const [code, reason] of [[515, "restart-required"], [401, "logged-out"],
    [403, "forbidden"], [408, "connection-lost"], [411, "multidevice-mismatch"],
    [428, "connection-closed"], [440, "connection-replaced"], [500, "bad-session"],
    [503, "service-unavailable"], [999, "unknown-disconnect"],
    ["private-disconnect-secret", "unknown-disconnect"]] as const) {
    const source = fake(); const diagnostic = new WhatsAppAdapter(config, source.dependencies);
    await diagnostic.initialize();
    const pending = diagnostic.start({ onMessage: async () => {} });
    const rejected = assert.rejects(pending, /cancelled/); await tick();
    source.ev.emit("connection.update", { qr: "private-qr-secret", connection: "close",
      lastDisconnect: { error: { message: "private-disconnect-secret", output: { statusCode: code } } } });
    await rejected; await diagnostic.stop();
    assert.equal(diagnostic.getConnectionFailure(), reason);
    assert.equal(diagnostic.getQrCode(), null);
  }

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

  // Diagnose dropped input without changing the conservative mapping or exposing IDs.
  const observedSource = fake(); const observedAdapter = new WhatsAppAdapter(config, observedSource.dependencies);
  await observedAdapter.initialize();
  observedSource.ev.emit("messages.upsert", { type: "append", messages: [raw("private-history")] });
  observedSource.ev.emit("messages.upsert", { type: "notify", messages: [
    raw("mapped"),
    { ...raw("private-lid"), key: { ...raw("private-lid").key, remoteJid: "123@lid", remoteJidAlt: jid } },
    { ...raw("private-alt"), key: { ...raw("private-alt").key, remoteJidAlt: "123@lid" } },
    { ...raw("private-self"), key: { ...raw("private-self").key, fromMe: true } },
    { ...raw("private-invalid"), message: {} },
  ] });
  const snapshot = observedAdapter.getMessageDiagnostics();
  assert.deepEqual(snapshot, { mapped: 1, lid: 1, alternateIdentity: 1, self: 1, unsupported: 1, nonNotify: 1 });
  snapshot.mapped = 999;
  assert.equal(observedAdapter.getMessageDiagnostics().mapped, 1);
  await observedAdapter.stop();

  // Bind only the independently configured owner, using a fresh server query.
  const boundSource = fake(); const bound = new WhatsAppAdapter({ ...config, ownerJid: jid }, boundSource.dependencies);
  const boundIncoming: any[] = [];
  await bound.initialize(); const boundStart = bound.start({ onMessage: async m => { boundIncoming.push(m); } });
  await tick(); boundSource.ev.emit("connection.update", { connection: "open" }); await boundStart;
  assert.equal(boundSource.queries.length, 1);
  assert.equal(boundSource.queries[0].lid, true);
  assert.equal(boundSource.queries[0].context, "background");
  assert.deepEqual(boundSource.queries[0].users.map((u: any) => u.id), [jid]);
  const lidMessage = { ...raw("lid-original"), key: { ...raw("lid-original").key, remoteJid: "777@lid", remoteJidAlt: jid, addressingMode: "lid" } };
  // Exercise the real SDK cleanup step, not just an idealized event fixture.
  const { cleanMessage } = await import("@whiskeysockets/baileys");
  const cleanedLid: any = structuredClone(lidMessage);
  cleanMessage(cleanedLid, "555@s.whatsapp.net", "555@lid");
  assert.equal(cleanedLid.key.participant, "");
  boundSource.ev.emit("messages.upsert", { type: "notify", messages: [cleanedLid] });
  assert.equal(boundIncoming.length, 1);
  assert.equal(boundIncoming[0].id, "lid-original");
  assert.equal(boundIncoming[0].channelId, jid); assert.equal(boundIncoming[0].userId, jid);
  await bound.sendMessage(jid, "ok"); assert.equal(boundSource.sent[0].channel, "777@lid");
  await bound.stop();

  const binding = { ownerJid: jid, ownerLid: "777@lid" };
  assert.ok(mapStrictWhatsAppMessage(cleanedLid, binding));
  assert.ok(mapStrictWhatsAppMessage({ ...cleanedLid, participant: "", key: { ...cleanedLid.key, participantAlt: "" } }, binding));
  const cleanedPn: any = structuredClone(raw("cleaned-pn"));
  cleanMessage(cleanedPn, "555@s.whatsapp.net", "555@lid");
  assert.ok(mapStrictWhatsAppMessage(cleanedPn));
  assert.ok(mapStrictWhatsAppMessage({ ...lidMessage, key: { ...lidMessage.key, remoteJidAlt: undefined } }, binding));
  assert.ok(mapStrictWhatsAppMessage({ ...raw("pn-alt"), key: { ...raw("pn-alt").key, remoteJidAlt: "777@lid", addressingMode: "pn" } }, binding));
  for (const patch of [
    { remoteJid: "888@lid" }, { remoteJid: "777@g.us" }, { remoteJid: "777:1@lid" },
    { remoteJidAlt: "999@s.whatsapp.net" }, { remoteJidAlt: "777@lid" },
    { fromMe: true }, { fromMe: undefined }, { id: "" }, { participant: "777@lid" },
    { participantAlt: jid }, { participant: " " }, { participantAlt: " " }, { addressingMode: "pn" },
  ]) assert.equal(mapStrictWhatsAppMessage({ ...lidMessage, key: { ...lidMessage.key, ...patch } }, binding), undefined);
  assert.equal(mapStrictWhatsAppMessage(lidMessage), undefined);
  assert.equal(mapStrictWhatsAppMessage({ ...lidMessage, broadcast: true }, binding), undefined);
  assert.equal(mapStrictWhatsAppMessage({ ...lidMessage, participant: "777@lid" }, binding), undefined);
  assert.equal(mapStrictWhatsAppMessage(lidMessage, { ...binding, ownerLid: "777:1@lid" }), undefined);
  assert.throws(() => new WhatsAppAdapter({ ...config, ownerJid: "777@lid" }, fake().dependencies), /owner direct JID/);

  // Missing, conflicting or ambiguous lookup results fail closed; no inbound IDs are learned.
  for (const result of [undefined, { list: [] }, { list: [{ id: "999@s.whatsapp.net", lid: "777@lid" }] },
    { list: [{ id: jid, lid: "777:1@lid" }] }, { list: [{ id: jid, lid: "777@lid" }, { id: jid, lid: "888@lid" }] }]) {
    const source = fake(); source.setQuery(async () => result);
    const rejected = new WhatsAppAdapter({ ...config, ownerJid: jid }, source.dependencies);
    await rejected.initialize(); source.ev.emit("connection.update", { connection: "open" });
    await assert.rejects(rejected.start({ onMessage: async () => {} }), /owner lookup failed/);
    assert.equal(rejected.getConnectionFailure(), "owner-lookup-failed"); await rejected.stop();
  }
  const lookupTimeout = fake(); lookupTimeout.setQuery(() => new Promise(() => {}));
  const timedLookup = new WhatsAppAdapter({ ...config, startupTimeoutMs: 10, ownerJid: jid }, lookupTimeout.dependencies);
  await timedLookup.initialize(); lookupTimeout.ev.emit("connection.update", { connection: "open" });
  await assert.rejects(timedLookup.start({ onMessage: async () => {} }), /owner lookup failed/); await timedLookup.stop();

  const lookupCancelled = fake(); let releaseLookup!: (value: any) => void;
  lookupCancelled.setQuery(() => new Promise(resolve => { releaseLookup = resolve; }));
  const cancelledLookup = new WhatsAppAdapter({ ...config, ownerJid: jid }, lookupCancelled.dependencies);
  await cancelledLookup.initialize(); lookupCancelled.ev.emit("connection.update", { connection: "open" });
  const pendingLookup = assert.rejects(cancelledLookup.start({ onMessage: async () => {} }), /owner lookup failed/);
  await tick(); await cancelledLookup.stop(); await pendingLookup;
  releaseLookup({ list: [{ id: jid, lid: "777@lid" }] }); await tick();
  await assert.rejects(cancelledLookup.sendMessage(jid, "never"), /not connected/);

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
  for (const secret of ["private-qr-secret", "private-qr-2", "private-node-secret", "private-child-secret", "private-jid", "private-creds-secret", "private-import-secret", "private-disconnect-secret"]) assert.equal(logText.includes(secret), false);
  console.log("WhatsApp adapter tests passed");
} finally { rmSync(home, { recursive: true, force: true }); }
