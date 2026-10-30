import assert from "node:assert/strict";
import { BaseAdapter, type PlatformMessage } from "../src/adapters/base.js";
import { mapStrictWhatsAppMessage } from "../src/adapters/whatsapp.js";
import { createBackendHost, type BackendError } from "../src/backend.js";

const jid = "123@s.whatsapp.net";
const raw = (id = "id", content = "hello") => ({ key: { id, remoteJid: jid, fromMe: false }, message: { conversation: content } });
assert.equal(mapStrictWhatsAppMessage(raw())?.id, "id");
for (const key of [
  { id: "", remoteJid: jid, fromMe: false }, { id: "1", remoteJid: jid, fromMe: true },
  { id: "1", remoteJid: "1@g.us", fromMe: false }, { id: "1", remoteJid: "1@lid", fromMe: false },
  { id: "1", remoteJid: jid, fromMe: false, participant: "999@s.whatsapp.net" },
  { id: "1", remoteJid: jid, fromMe: false, remoteJidAlt: "1@lid" },
  { id: "1", remoteJid: jid },
]) assert.equal(mapStrictWhatsAppMessage({ key, message: { conversation: "hi" } }), undefined);

class Fake extends BaseAdapter {
  readonly platform = "whatsapp";
  config = { enabled: true, platform: "whatsapp", strictBackendMessages: true };
  sent: string[] = [];
  fail = false;
  emit(m: PlatformMessage) { return this.emitMessage(m); }
  async sendMessage(channel: string, text: string) { if (this.fail) throw Error("secret"); this.sent.push(`${channel}:${text}`); return "sent"; }
  async editMessage() {} async deleteMessage() {} async setTyping() {}
  async getStatus() { return { connected: true }; }
}
const adapter = new Fake();
const errors: BackendError[] = [];
let auth = 0, calls = 0;
let release!: () => void;
let block = false;
const host = createBackendHost({ adapter, capacity: 2, allow: m => m.userId === jid,
  backend: { authorize: m => { auth++; return m.messageId !== "deny"; }, submit: async m => {
    calls++; if (block) await new Promise<void>(resolve => { release = resolve; });
    if (m.text === "throw") throw Error("private"); return `answer ${m.text}`;
  } }, onError: e => errors.push(e) });
await host.start();
const emit = (id: string, content: string) => adapter.emit(mapStrictWhatsAppMessage(raw(id, content))!);
await adapter.emit(mapStrictWhatsAppMessage({ ...raw("other", "/restart"), key: { id: "other", remoteJid: "999@s.whatsapp.net", fromMe: false } })!);
assert.equal(auth, 0);
await emit("deny", "/model evil");
assert.equal(auth, 1); assert.equal(calls, 0); assert.deepEqual(adapter.sent, []);
await emit("ok", "/model evil"); await emit("ok", "Callback: model:evil"); await emit("ok", "/restart");
assert.equal(calls, 0);
await emit("ok", "hello"); assert.deepEqual(adapter.sent, [`${jid}:answer hello`]);
await emit("err", "throw"); assert.equal(errors.at(-1), "backend");
adapter.fail = true; await emit("send", "hi"); assert.equal(errors.at(-1), "delivery"); adapter.fail = false;
block = true;
const first = emit("a", "one");
await new Promise(resolve => setTimeout(resolve, 0));
for (let i = 0; i < 100; i++) {
  await adapter.emit(mapStrictWhatsAppMessage({ ...raw(`flood${i}`), key: { id: `flood${i}`, remoteJid: "999@s.whatsapp.net", fromMe: false } })!);
}
assert.equal(errors.includes("overload"), false);
const second = emit("b", "two");
await emit("c", "three"); assert.equal(errors.at(-1), "overload");
host.stopIngress();
const closing = host.close(); assert.equal(host.close(), closing); release(); await Promise.all([first, second, closing]);
assert.equal(calls, 4); // hello, throw, failed delivery, active one; queued two cancelled
assert.equal(errors.includes("shutdown"), true);
assert.equal(adapter.sent.length, 1);
await assert.rejects(host.start());
// Identical IDs are deliberately not deduplicated by the host.
const replayAdapter = new Fake(); let replayCalls = 0;
const replayHost = createBackendHost({ adapter: replayAdapter, capacity: 2, allow: () => true,
  backend: { authorize: () => true, submit: async () => { replayCalls++; return "ok"; } } });
await replayHost.start();
await replayAdapter.emit(mapStrictWhatsAppMessage(raw())!);
await replayAdapter.emit(mapStrictWhatsAppMessage(raw())!);
assert.equal(replayCalls, 2); assert.equal(replayAdapter.sent.length, 2);
await replayHost.close();
assert.throws(() => createBackendHost({ adapter: replayAdapter, capacity: 1, maxResponseLength: 1,
  allow: () => true, backend: { authorize: () => true, submit: async () => "" } }));
const overflowAdapter = new Fake();
const overflowHost = createBackendHost({ adapter: overflowAdapter, capacity: 1, maxResponseLength: 29,
  allow: () => true, backend: { authorize: () => true, submit: async () => "x".repeat(30) } });
await overflowHost.start();
await overflowAdapter.emit(mapStrictWhatsAppMessage(raw())!);
assert.deepEqual(overflowAdapter.sent, [`${jid}:Response too long to deliver.`]);
overflowAdapter.fail = true;
await overflowAdapter.emit(mapStrictWhatsAppMessage(raw())!);
await overflowHost.close();
// A startup callback may be awaited by the adapter: it must not wait on readiness.
class StartupAdapter extends Fake {
  async start(callbacks: Parameters<BaseAdapter["start"]>[0]) {
    await super.start(callbacks);
    await this.emit(mapStrictWhatsAppMessage(raw("during-start"))!);
  }
}
const startupAdapter = new StartupAdapter(); let startupCalls = 0;
const startupHost = createBackendHost({ adapter: startupAdapter, capacity: 1, allow: () => true,
  backend: { authorize: () => true, submit: async () => { startupCalls++; return "ok"; } } });
await startupHost.start(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(startupCalls, 1); await startupHost.close();

// A seal during asynchronous initialization must not be reported as readiness.
let finishInit!: () => void; let stopped = 0;
class SlowInit extends Fake {
  async initialize() { await new Promise<void>(resolve => { finishInit = resolve; }); }
  async stop() { stopped++; await super.stop(); }
}
const slow = new SlowInit(); const slowErrors: BackendError[] = [];
const slowHost = createBackendHost({ adapter: slow, capacity: 1, allow: () => true,
  backend: { authorize: () => true, submit: async () => "bad" }, onError: e => slowErrors.push(e) });
const slowStart = slowHost.start(); const rejection = assert.rejects(slowStart, /startup failed/);
const slowClose = slowHost.close(); finishInit(); await Promise.all([rejection, slowClose]);
assert.equal(stopped, 1); assert.ok(slowErrors.includes("startup"));
console.log("backend host tests passed");
