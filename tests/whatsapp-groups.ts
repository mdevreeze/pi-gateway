/**
 * Group handling against identities and metadata produced by the real Baileys code, not hand-written
 * look-alikes. A fixture that is tidier than the library's real output hides exactly the bugs that
 * matter here: the same account spelled with and without a device, as a phone number or as a LID.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "gateway-whatsapp-groups-test-"));
process.env.HOME = home;
const { WhatsAppAdapter } = await import("../src/adapters/whatsapp.js");
const { userJid } = await import("../src/adapters/whatsapp-jid.js");
const { jidEncode, jidNormalizedUser } = await import("@whiskeysockets/baileys");
// @ts-ignore deep import: the library's own parser for a group-metadata server response.
const { extractGroupMetadata } = await import("@whiskeysockets/baileys/lib/Socket/groups.js");

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const config = { enabled: true, platform: "whatsapp" as const, strictBackendMessages: true, startupTimeoutMs: 1000 };
const pn = (user: string, device?: number) => jidEncode(user, "s.whatsapp.net", device);
const lid = (user: string, device?: number) => jidEncode(user, "lid", device);
const GROUP = "120363000000000001@g.us";
const OWNER = { pn: "31600000001", lid: "100000000000001" };
const MEMBER = { pn: "31600000002", lid: "100000000000002" };
const BOT = { pn: "31600000009", lid: "100000000000009", device: 7 };

/** The server's group-metadata response, parsed by Baileys itself. Members are LID-addressed, as in current groups. */
function groupResponse(members: Array<{ pn?: string; lid: string }>) {
  return extractGroupMetadata({ tag: "iq", attrs: {}, content: [{ tag: "group",
    attrs: { id: GROUP.split("@")[0], creator: lid(OWNER.lid), creator_pn: pn(OWNER.pn), subject: "test", s_t: "1", creation: "1", addressing_mode: "lid" },
    content: members.map(member => ({ tag: "participant",
      attrs: { jid: lid(member.lid), ...(member.pn ? { phone_number: pn(member.pn) } : {}) } })) }] });
}
const everyone = [OWNER, MEMBER, BOT];

async function started(options: { user?: any; metadata?: () => Promise<any>; lidToPn?: (lid: string) => any } = {}) {
  const ev = new EventEmitter();
  // What Baileys stores for its own account after pairing: device-qualified, and no phoneNumber field.
  const user = "user" in options ? options.user : { id: pn(BOT.pn, BOT.device), lid: lid(BOT.lid, BOT.device) };
  const sock = { ev, user, groupMetadata: options.metadata ?? (async () => groupResponse(everyone)),
    signalRepository: { lidMapping: { getPNForLID: async (value: string) => options.lidToPn?.(value) } },
    end: () => {}, sendMessage: async () => ({ key: { id: "sent" } }) };
  const adapter = new WhatsAppAdapter(config, { loadBaileys: async () => ({
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }), makeWASocket: () => sock }) });
  const incoming: any[] = [];
  await adapter.initialize();
  const starting = adapter.start({ onMessage: async m => { incoming.push(m); } });
  await tick(); ev.emit("connection.update", { connection: "open" }); await starting;
  let n = 0;
  const say = async (participant: string, text: string, contextInfo?: any) => {
    ev.emit("messages.upsert", { type: "notify", messages: [{ key: { id: `m${++n}`, remoteJid: GROUP, participant, fromMe: false },
      message: contextInfo ? { extendedTextMessage: { text, contextInfo } } : { conversation: text } }] });
    await settle();
    return incoming.at(-1);
  };
  return { adapter, incoming, say };
}

try {
  // Our canonical form is the library's own, for every spelling of a personal account.
  for (const raw of [pn("31600000001"), pn("31600000001", 7), pn("31600000001", 0), lid("100000000000001"), lid("100000000000001", 12)]) {
    assert.equal(userJid(raw), jidNormalizedUser(raw), raw);
  }
  // Not a personal account, or not an identity at all: never coerced into one.
  for (const raw of [GROUP, "status@broadcast", jidEncode("31600000001", "s.whatsapp.net", 7, 1), "31600000001@hosted",
    "31600000001", "", " 31600000001@s.whatsapp.net", "31600000001@s.whatsapp.net\n", "abc@s.whatsapp.net", undefined, null, 5, {}]) {
    assert.equal(userJid(raw), undefined, String(raw));
  }

  // The bot is a member of every group it hears, but is never one of the people to authorize.
  const a = await started();
  const plain = await a.say(lid(MEMBER.lid), "hello everyone");
  assert.equal(plain.userId, pn(MEMBER.pn));
  assert.equal(plain.metadata.groupCreator, pn(OWNER.pn));
  assert.deepEqual(plain.metadata.groupParticipants, [pn(OWNER.pn), pn(MEMBER.pn)]);
  assert.equal(plain.metadata.groupMembersResolved, true);
  assert.equal(plain.metadata.addressed, false);
  // Mentions and quoted replies name the bot without a device.
  assert.equal((await a.say(lid(MEMBER.lid), "@bot hi", { mentionedJid: [lid(BOT.lid)] })).metadata.addressed, true);
  assert.equal((await a.say(lid(MEMBER.lid), "@bot hi", { mentionedJid: [pn(BOT.pn)] })).metadata.addressed, true);
  assert.equal((await a.say(lid(MEMBER.lid), "answering you", { participant: lid(BOT.lid), stanzaId: "x" })).metadata.addressed, true);
  assert.equal((await a.say(lid(MEMBER.lid), "@owner hi", { mentionedJid: [lid(OWNER.lid)] })).metadata.addressed, false);
  // A message typed on a linked device (WhatsApp Web or desktop) carries that device in the sender.
  const linked = await a.say(lid(OWNER.lid, 14), "from my laptop");
  assert.equal(linked.userId, pn(OWNER.pn));
  // Somebody who is not in the group's member list is nobody.
  const before = a.incoming.length;
  await a.say(lid("100000000000077"), "stranger");
  assert.equal(a.incoming.length, before);
  assert.equal(a.adapter.getMessageDiagnostics().unsupported, 1);
  await a.adapter.stop();

  // If the bot cannot find itself among the members, its own identity is wrong: refuse and say so.
  for (const user of [undefined, {}, { id: "not-a-jid" }, { id: pn("31600000099", 7), lid: lid("100000000000099", 7) }]) {
    const b = await started({ user });
    await b.say(lid(MEMBER.lid), "hello");
    assert.equal(b.incoming.length, 0);
    assert.equal(b.adapter.getMessageDiagnostics().groupBotIdentity, 1);
    await b.adapter.stop();
  }

  // Each way a group can be unreadable has its own label.
  const noMetadata = await started({ metadata: async () => { throw new Error("private-failure"); } });
  await noMetadata.say(lid(MEMBER.lid), "hello");
  assert.equal(noMetadata.incoming.length, 0);
  assert.equal(noMetadata.adapter.getMessageDiagnostics().groupMetadata, 1);
  await noMetadata.adapter.stop();
  const noCreator = await started({ metadata: async () => ({ ...groupResponse(everyone), owner: undefined, ownerPn: undefined }) });
  await noCreator.say(lid(MEMBER.lid), "hello");
  assert.equal(noCreator.adapter.getMessageDiagnostics().groupCreator, 1);
  await noCreator.adapter.stop();

  // A member known only by LID is looked up; the mapping answers with a device-qualified number.
  const hidden = [OWNER, { lid: MEMBER.lid }, BOT];
  const mapped = await started({ metadata: async () => groupResponse(hidden),
    lidToPn: value => value === lid(MEMBER.lid) ? pn(MEMBER.pn, 0) : undefined });
  const resolved = await mapped.say(lid(MEMBER.lid), "hello");
  assert.deepEqual(resolved.metadata.groupParticipants, [pn(OWNER.pn), pn(MEMBER.pn)]);
  assert.equal(resolved.metadata.groupMembersResolved, true);
  await mapped.adapter.stop();
  // A member whose number stays unknown marks the whole group unresolved, so the backend can refuse it.
  const unknown = await started({ metadata: async () => groupResponse(hidden) });
  const partial = await unknown.say(lid(OWNER.lid), "hello");
  assert.deepEqual(partial.metadata.groupParticipants, [pn(OWNER.pn)]);
  assert.equal(partial.metadata.groupMembersResolved, false);
  await unknown.adapter.stop();

  console.log("WhatsApp group tests passed");
} finally { rmSync(home, { recursive: true, force: true }); }
