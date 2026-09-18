# Repository guidance

This repository packages the Kagayoi Memory self-hosted Cloudflare server and its Codex plugin.

- Keep `client/` compatible with Node.js 24 and avoid runtime dependencies unless they materially improve reliability.
- Keep `server/` deployable with Wrangler. Never commit API keys, generated resource IDs, `.dev.vars`, or `.wrangler/` state.
- Preserve the storage, provenance, recall, and enrichment contracts in [DESIGN.md](DESIGN.md), including the 1.x connection/environment readers, legacy capture receipts and spaces, existing document IDs, and persisted `sm_*` metadata.
- Keep the official Codex local memory store outside this integration.
- Changes to capture must preserve deterministic capture keys/custom IDs, retry-safe document reuse, and configured-secret redaction.
- Run client tests, server tests, plugin validation, and `git diff --check` for affected changes.
- Do not deploy, migrate a remote database, publish a package, create a remote repository, push, run `scripts/setup-topics.mjs --apply` or `pnpm -C server test:live`, or invoke remote consolidation without an explicit request.

## Validation

Run these checks from the repository root for affected changes (Node.js 24.18.0 or later in the 24 series, pnpm 11.4.0):

```powershell
node --test client/*.test.mjs scripts/*.test.mjs
pnpm -C server install --frozen-lockfile
pnpm -C server check
node scripts/validate-plugin.mjs
pnpm run package:plugin
git diff --check
```

Server tests use local D1 and deterministic AI/vector fixtures. Provisioning tests simulate Wrangler calls without creating remote resources. When changing asynchronous enrichment, preserve revision guards and project-scoped fact relationships; validate stale topic/vector work and update/forget races in `server/tests/races.test.mjs`, plus the API coverage in `server/tests/smoke.mjs`. Topic API changes must retain unclassified browsing and exact-topic filtering across legacy and shared spaces.

Consolidation changes must preserve project leases, source-revision publication guards, exact source membership, invalidation after source or checkpoint mutation, the 40-source batch limit, one-batch manual requests, initial scheduled backlog draining, and the 25-project recurring cap. Preserve both Wrangler crons (`*/15 * * * *` for vector reconciliation and `0 18 * * *` for daily consolidation), and apply migration `0005_memory_consolidations.sql` before installing a client that depends on consolidation. Cover these contracts in `client/mcp-server.test.mjs`, `server/tests/races.test.mjs`, and the authenticated API path in `server/tests/smoke.mjs`.

`pnpm run package:plugin` builds and validates `dist/kagayoi-memory`. CI runs the client, script, server, and plugin checks and uploads the package as an artifact; `git diff --check` remains a local check. Release tagging and publication are separate operations.
