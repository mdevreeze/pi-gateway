/**
 * The one place where WhatsApp account identities enter Gateway.
 *
 * Baileys hands out the same account in several spellings: "123@s.whatsapp.net", "123:7@s.whatsapp.net"
 * (a specific device) and the matching "456@lid" / "456:7@lid". Comparing those as plain strings silently
 * fails, so every identity read from the socket, group metadata or a message goes through userJid() first.
 * Everything after that compares canonical values only.
 */
export type PnJid = string & { readonly __jid: "pn" };
export type LidJid = string & { readonly __jid: "lid" };
export type UserJid = PnJid | LidJid;

const CANONICAL_PN = /^[0-9]+@s\.whatsapp\.net$/;
const CANONICAL_LID = /^[0-9]+@lid$/;
const ANY_DEVICE = /^([0-9]+)(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/;

/** Already canonical phone-number identity; a device-suffixed value is not. */
export const isPnJid = (value: unknown): value is PnJid => typeof value === "string" && CANONICAL_PN.test(value);
/** Already canonical LID identity; a device-suffixed value is not. */
export const isLidJid = (value: unknown): value is LidJid => typeof value === "string" && CANONICAL_LID.test(value);
export const isUserJid = (value: unknown): value is UserJid => isPnJid(value) || isLidJid(value);

/**
 * Canonical account identity for any spelling of a personal account, or undefined.
 * The device part is dropped: every device of an account is that account. Groups, broadcasts,
 * hosted and agent-qualified identities are not personal accounts and yield undefined.
 */
export function userJid(value: unknown): UserJid | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  const match = ANY_DEVICE.exec(value);
  return match ? `${match[1]}@${match[2]}` as UserJid : undefined;
}
/** Canonical phone-number identity, or undefined when the value is a LID or not an account. */
export function pnJid(value: unknown): PnJid | undefined {
  const jid = userJid(value);
  return isPnJid(jid) ? jid : undefined;
}
/** Canonical identities from a list of raw values; unusable entries are dropped, duplicates collapse. */
export function userJids(values: unknown[]): UserJid[] {
  return [...new Set(values.map(userJid).filter((jid): jid is UserJid => jid !== undefined))];
}
