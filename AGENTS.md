# Repository guidance

This repository packages the Kagayoi Memory self-hosted Cloudflare server and its Codex plugin.

- Keep `client/` compatible with Node.js 24 and avoid runtime dependencies unless they materially improve reliability.
- Keep `server/` deployable with Wrangler. Never commit API keys, generated resource IDs, `.dev.vars`, or `.wrangler/` state.
- Preserve the storage, provenance, recall, and enrichment contracts in [DESIGN.md](DESIGN.md), including the 1.x connection/environment readers, legacy capture receipts and spaces, existing document IDs, and persisted `sm_*` metadata.
- Keep the official Codex local memory store outside this integration.
- Changes to capture must preserve deterministic capture keys/custom IDs, retry-safe document reuse, and redaction of the configured memory API key and supported secret patterns.
- Run client tests, server tests, plugin validation, and `git diff --check` for affected changes.
- Do not deploy, migrate a remote database, publish a package, create a remote repository, push, run `scripts/setup-topics.mjs --apply` or `pnpm -C server test:live`, or invoke remote consolidation without an explicit request.

## Dependency maintenance

- Update `server/package.json` and `server/pnpm-lock.yaml` together, then verify the frozen-lockfile install and server checks below.
- Review `server/pnpm-workspace.yaml` with dependency updates. It holds native build approvals for `esbuild` and `workerd` and exact-version `minimumReleaseAgeExclude` entries; replace obsolete exceptions when upgrading rather than broadening them to all versions.
- Keep `.github/dependabot.yml` covering GitHub Actions and npm manifests in both `/` and `/server` on a weekly schedule, with minor and patch updates grouped separately from major updates.

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

Server tests use local D1 and deterministic AI/vector fixtures. Provisioning tests simulate Wrangler calls without creating remote resources. In `server/tests/smoke.mjs`, preserve bounded waits for local Worker startup and MCP responses; on Windows, stop the Wrangler process tree, including `workerd`, before removing temporary D1 state so database locks are released.

When changing asynchronous enrichment, preserve revision guards and project-scoped fact relationships; validate stale topic/vector work and update/forget races in `server/tests/races.test.mjs`, plus the API coverage in `server/tests/smoke.mjs`. Vector changes must also cover bounded Vectorize lookups, forgotten-vector cleanup even when AI enrichment is disabled, and repair after late upserts or deletion races. Topic API changes must retain unclassified browsing and exact-topic filtering across legacy and shared spaces.

For recall changes, validate the [recall contracts](DESIGN.md#recall) through `server/tests/recall-efficiency.mjs`, which connects the real client and authenticated Worker API to migration-backed SQLite with deterministic AI/vector fixtures. Retain coverage for request/embedding/vector counts across many spaces, scoped searches, failure fallback, legacy indexes, source excerpts, and checkpoint selection. Inspect its reproducible metrics and results in `dist/recall-efficiency-validation.json`.

Consolidation changes must preserve the [project consolidation contracts](DESIGN.md#project-consolidation). Cover them in `client/mcp-server.test.mjs`, `server/tests/races.test.mjs`, and the authenticated API path in `server/tests/smoke.mjs`. Validate truncated-output retry, publication races, stale checkpoint recovery, and enrichment/scheduled failure diagnostics in `server/tests/log-regressions.mjs`; inspect `dist/server-log-validation.json`. Both artifact-producing checks run as part of `pnpm -C server check`. Preserve both cron definitions in `server/wrangler.example.jsonc`, and apply migration `0005_memory_consolidations.sql` before installing a client that depends on consolidation.

`pnpm run package:plugin` builds and validates `dist/kagayoi-memory`. CI runs the client, script, server, and plugin checks and uploads the package as an artifact; `git diff --check` remains a local check. Release tagging and publication are separate operations.
