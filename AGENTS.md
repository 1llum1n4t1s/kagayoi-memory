# Repository guidance

This repository packages a self-hosted Cloudflare memory server and its Codex plugin.

- Keep `client/` compatible with Node.js 24 and avoid runtime dependencies unless they materially improve reliability.
- Keep `server/` deployable with Wrangler. Never commit API keys, generated resource IDs, `.dev.vars`, or `.wrangler/` state.
- Preserve the storage, provenance, recall, and enrichment contracts in [DESIGN.md](DESIGN.md), including compatibility with existing document IDs and legacy spaces.
- Keep the official Codex local memory store outside this integration.
- Changes to capture must preserve deterministic document IDs and redact configured secrets.
- Run client tests, server tests, plugin validation, and `git diff --check` for affected changes.
- Do not deploy, migrate a remote database, publish a package, create a remote repository, or push without an explicit request.

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

Server tests use local D1 and deterministic AI/vector fixtures. Provisioning tests simulate Wrangler calls without creating remote resources. When changing asynchronous enrichment, preserve revision guards and project-scoped fact relationships; validate the stale-topic retry case in `server/tests/races.test.mjs` and the API coverage in `server/tests/smoke.mjs`. Topic API changes must retain unclassified browsing and exact-topic filtering across legacy and shared spaces.

`pnpm run package:plugin` builds and validates `dist/cloudflare-supermemory`. CI runs these checks and uploads the package as an artifact; release tagging and publication remain separate operations.
