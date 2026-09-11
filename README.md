# Cloudflare Supermemory for Codex

A Codex plugin and self-hosted Cloudflare backend for recalling useful implementation history across project folders.

The plugin saves completed work with its project folder as provenance. When a later prompt mentions a topic such as “Chrome extension,” recall searches every discovered memory space, injects concise indexes, and lets Codex open an applicable source record through MCP before reusing the implementation.

## Requirements

Use Node.js 24, pnpm 11.4.0, a Codex installation with plugin and hook support, and PowerShell 7 for the Windows setup helper. The MCP server and capture hooks have no npm runtime dependencies. The backend needs your own Cloudflare account with Workers, D1, Vectorize, and Workers AI enabled.

## Connect an existing server

Clone this repository or download the CI package. In Codex, open that folder and ask: “Use plugin-creator to install this Cloudflare Supermemory plugin in my personal marketplace.” The installer should register the source, validate it, and run `codex plugin add cloudflare-supermemory@personal`. For updates, rebuild the package and ask Codex to refresh the same local source and reinstall it.

```powershell
pwsh -NoProfile -File scripts/setup-client.ps1 -BaseUrl https://your-worker.example.workers.dev
```

Enter the API key at the secure prompt. The script verifies an authenticated session before writing `~/.codex/supermemory.json`. To update an existing connection, use `-Force`; unrelated settings are preserved. `SUPERMEMORY_API_URL` and `SUPERMEMORY_CODEX_API_KEY` can supply process-level overrides; `CLOUDFLARE_MEMORY_API_KEY` is also accepted for setup and runtime authentication.

After installing the plugin, review and trust its four hooks in Codex, then start a new task. Run the plugin's `whoAmI` MCP tool to verify connectivity and space discovery. Installing a plugin alone does not trust its hooks.

## Create or update a server

```powershell
pnpm -C server install --frozen-lockfile
pnpm -C server exec wrangler login
node scripts/setup-server.mjs
```

The default command performs read-only discovery and prints the proposed resources. To apply it, supply your chosen API key through the process environment `CLOUDFLARE_MEMORY_API_KEY`, then run:

```powershell
node scripts/setup-server.mjs --apply --location apac
```

The setup reuses resources by name, checks the Vectorize dimensions and metric, creates missing resources, writes the ignored `server/wrangler.jsonc`, installs the Worker secret, applies D1 migrations, deploys, and verifies the endpoint. Re-run the same command to update the installation. An existing secret is retained unless a replacement key is supplied. Without its local value, verification can check health but cannot authenticate the session. Use `--base-url` for a custom domain when Wrangler does not report a workers.dev URL. `--help` lists resource-name, profile, location, and endpoint options.

Keep the local Wrangler configuration for future updates. Never commit generated resource IDs, credentials, or `.wrangler/` state. Cloudflare usage is billed to the account that hosts the server.

## Memory behavior

- Completed user requests and final answers are saved with deterministic IDs and source-folder provenance.
- Manual `add_memory` and project-scoped lists use a single workspace root advertised by the MCP client. If unavailable, pass an absolute `sourceFolder` or an explicit `containerTag`; the plugin never treats its installation folder as the user's project.
- Prompt recall searches every discovered nonempty space by topic. The initial session event does not inject unrelated recent records.
- Automatic context contains a title, description, section names, timestamps, and document IDs. Codex opens full records with `getDocument` when needed.
- Capture preserves existing v2 IDs and sent-document receipts, redacts configured secrets, and retries unacknowledged records.
- Space discovery is capped by the current server API at 100. A full page is reported as incomplete rather than claiming exhaustive search.

The API key grants access to the records in one server installation. Use separate installations for separate trust boundaries. Redaction reduces accidental secret capture; review what you choose to store in your own backend.

This project implements its own Supermemory-compatible API. It is independent of the hosted Supermemory service and does not read or modify Codex's built-in local memory files.

## Repository layout

- `plugin.json`, `mcp.json`, `.codex-plugin/`, `hooks/`: portable plugin manifests and Codex compatibility metadata
- `client/`: MCP server, topic recall, capture hooks, and tests
- `server/`: Cloudflare Worker, D1 migrations, and API tests
- `scripts/`: portable plugin launchers and setup utilities
- `skills/setup-cloudflare-memory/`: setup and diagnostics workflow for Codex

## Development

```powershell
node --test client/*.test.mjs scripts/*.test.mjs
pnpm -C server install --frozen-lockfile
pnpm -C server check
node scripts/validate-plugin.mjs
node scripts/package-plugin.mjs
git diff --check
```

Server tests use local D1 and deterministic AI/vector fixtures. Provisioning tests simulate Wrangler calls; they do not create remote resources. A clean package is written to `dist/cloudflare-supermemory`. CI runs the checks and uploads that package as an artifact. A release tag or package-registry publication is a separate operation.

Licensed under the [MIT License](LICENSE).
