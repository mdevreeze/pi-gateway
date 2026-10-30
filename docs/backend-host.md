# Trusted in-process backend host (experimental)

`@gamalan/pi-gateway/backend` is a separate entrypoint. It does not import the legacy Gateway entrypoint, spawn Pi RPC, open Gateway sessions, or start HTTP/WebSocket listeners. It owns one enabled WhatsApp adapter; other platforms and all interactive callbacks are disabled. The normal Gateway entrypoint and WhatsApp mapping remain unchanged.

```ts
import { createBackendHost, createBackendWhatsAppAdapter } from '@gamalan/pi-gateway/backend';
// boundary is an application-owned, trusted in-process Kit GatewayBoundary.
const adapter = createBackendWhatsAppAdapter({
  enabled: true, platform: 'whatsapp', sessionPath: './whatsapp-session',
});
const host = createBackendHost({
  adapter, capacity: 8,
  // Independent Gateway-side allowlist. Configure locally, never from a message.
  allow: m => m.userId === '123@s.whatsapp.net',
  backend: {
    authorize: m => boundary.authorize(m),
    submit: m => boundary.handle(m),
  },
  onError: code => console.error('backend host:', code),
});
await host.start();
// At shutdown, first seal ingress synchronously, then interrupt/close the
// application-owned backend (e.g. Durable), and finally join the host:
// host.stopIngress();
// await durable.close();
// await host.close();
```

The synchronous allowlist runs before capacity reservation; backend authorization precedes command handling and any send. All slash-prefixed and `Callback:`-prefixed input is silently dropped, including `/model` and `/restart`. Only final nonempty backend text is delivered, to the original authorized chat. The factory requires explicit backend, allowlist, enabled strict WhatsApp adapter and positive capacity; no fallback exists. Injected adapters and all in-process code are trusted: they must not forge the metadata assertion. Backend exceptions and delivery exceptions produce only sanitized error codes, not content or exception details.

The strict mapper accepts only original nonempty IDs, explicit `fromMe: false`, direct numeric `@s.whatsapp.net` JIDs and matching/absent participant; alternate JIDs and ambiguous events are dropped. Input text is limited to 65,536 characters. The host replaces responses exceeding its validated `maxResponseLength` (default 4096) with a fixed overflow notice rather than truncating them. Configure the adapter's message limit at least as high as the host limit; adapter send failures are reported as `delivery`. This is a conservative assumption, **not a verification of real Baileys events or JID stability**. Real platform testing is required before use. Strict mode may reject legitimate messages. WhatsApp authentication files are adapter state, not Gateway conversation transcripts. The host must pre-create the authentication `sessionPath` directory with mode `0700`, use a restrictive umask (for example `077`), and ensure authentication files have restrictive permissions (for example `0600`). In strict mode, `~/.pi/gateway/gateway.log` is status-only; protect it as operational state, not a conversation transcript. Install the optional `@whiskeysockets/baileys` peer to use WhatsApp; initialization failure is sanitized, and the host emits `startup`. Strict mode passes a silent logger to Baileys, disables terminal QR printing and never logs QR values; `getQrCode()` exposes the current QR to an explicitly trusted local pairing UI, which must protect it. Strict stop removes adapter listeners, clears callbacks and QR, disconnects without logout, and joins serialized credential writes (write failures emit a sanitized log warning). The legacy adapter retains its logout behavior.

## Reliability and lifecycle

Capacity counts active plus queued inputs. A single serial worker bounds requests reaching the backend; overload emits `overload` and drops the input. The adapter callback interface does not offer durable admission or negative acknowledgements: BaseAdapter logs/swallows callback failures, and Baileys ingress is not retained by this host. Errors (`startup`, `backend`, `delivery`, `overload`, `shutdown`) are operational signals only, not a delivery protocol. Strict WhatsApp accepts `notify` upserts only: `append`/history is deliberately dropped, so offline messages may be lost. Before callbacks are installed, up to `startupIngressCapacity` (default 32, maximum 1024) mapped notify messages are buffered; additional messages are dropped without a signal. Once callbacks are installed, startup notify messages enter the host's capacity-bounded queue, with overload signaled, but backend calls wait until readiness succeeds; startup failure or shutdown drops them. Ingress after sealing is dropped. There is no retry, durable inbox, outbound deduplication, or exactly-once send. A caller must independently arrange retention/redelivery using the same original ID if its transport supports it. A backend can deduplicate generation, but a send can succeed and then appear to fail, so redelivery can duplicate replies. Terminal backend failures need application policy; do not fabricate a new message ID.

`start()` rejects on connection failure, cancellation or timeout (`startupTimeoutMs`, default 30 seconds), and cleans up; it never reports readiness after a seal. `stopIngress()` synchronously seals ingress and initiates adapter stop if initialized; close the application backend next to interrupt active work, then call `close()` to join the host. `close()` also seals ingress and waits for the active backend call and any in-progress send; queued calls are dropped and active results are not sent after shutdown begins. Calls already inside a send cannot be recalled. Close may wait indefinitely for an uncooperative backend or adapter. The backend is application-owned and is not closed by the host. Startup failures clean up the adapter; the host is single-use. The adapter exposes `getStatus().connected` but does **not** reconnect automatically after a disconnect; an operator must replace the single-use host. No approval or tool policy is implemented here.
