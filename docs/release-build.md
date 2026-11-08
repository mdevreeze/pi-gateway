# Reproducible fork builds

`package-lock.json` is the canonical lock for this fork; the stale Bun lock has been removed. Baileys is pinned to the locally verified `7.0.0-rc14` as a runtime dependency, not a dev-only/optional peer. Locked registry tarballs include integrity hashes; do not regenerate dependency versions during deployment.

Use an unprivileged build account, without application secrets, on the target Node/platform:

```sh
npm ci --ignore-scripts --no-audit --no-fund
# Explicitly allow this locked native package's build/prebuilt install only:
npm rebuild better-sqlite3 --no-audit --no-fund
npm run build
npm test
npm prune --omit=dev --ignore-scripts --no-audit --no-fund
node --input-type=module -e 'await import("./dist/backend.js"); await import("@whiskeysockets/baileys"); console.log("runtime imports passed")'
```

Node >=22.18 is the Kit integration baseline. The native SQLite rebuild may require a C++ toolchain, make and Python if no prebuilt binary is available. Keep build/install scripts away from root and runtime credentials. After a successful build, seal the complete release root-owned/read-only to the service account. Never copy workstation node_modules to another platform.

Kit must load `dist/backend.js`, never the legacy entrypoint. It has its own SQLite Durable transcripts. The owner reply path was manually verified; security/reliability limits are documented in `backend-host.md`. Successful clean installation/build/tests plus Kit's `test:gateway` against the pruned artifact verify this deployment shape, not real-platform reconnect or exactly-once delivery.
