# Kagayoi Memory

A Codex plugin and self-hosted Cloudflare backend for recalling useful implementation history across project folders.

The plugin saves completed work in a shared collection and keeps its project folder as provenance. Browse records by content topics, or ask about a topic such as “Chrome extension”: recall searches every discovered memory space, injects concise indexes, and lets Codex open an applicable source record through MCP before reusing the implementation.

## Requirements

Use Node.js 24.18.0 or later in the 24 series, pnpm 11.4.0, a Codex installation with plugin and hook support, and PowerShell 7 for the Windows setup helper. The MCP server and capture hooks have no npm runtime dependencies. The backend needs your own Cloudflare account with Workers, D1, Vectorize, and Workers AI enabled.

## Connect an existing server

Clone this repository or download the CI package. In Codex, open that folder and ask: “Use plugin-creator to install this Kagayoi Memory plugin in my personal marketplace.” The installer should register the source, validate it, and run `codex plugin add kagayoi-memory@personal`. `pnpm run package:plugin` builds the distributable in `dist/kagayoi-memory`; for updates, rebuild it and ask Codex to refresh the same local source and reinstall it.

```powershell
pwsh -NoProfile -File scripts/setup-client.ps1 -BaseUrl https://your-worker.example.workers.dev
```

Enter the API key at the secure prompt. The script verifies an authenticated session before writing `~/.codex/kagayoi-memory.json`. To update an existing connection, use `-Force`; unrelated settings are preserved. `KAGAYOI_MEMORY_API_URL` and `KAGAYOI_MEMORY_API_KEY` can supply process-level overrides.

After installing the plugin, review and trust its four hooks in Codex, then start a new task. Run the plugin's `whoAmI` MCP tool to verify connectivity and space discovery. Installing a plugin alone does not trust its hooks.

## Create or update a server

```powershell
pnpm -C server install --frozen-lockfile
pnpm -C server exec wrangler login
node scripts/setup-server.mjs
```

The default command performs read-only discovery and prints the proposed resources. To apply it, supply your chosen API key through the process environment `KAGAYOI_MEMORY_API_KEY`, then run:

```powershell
node scripts/setup-server.mjs --apply --location apac
```

The setup reuses resources by name, checks the Vectorize dimensions and metric, creates missing resources, writes the ignored `server/wrangler.jsonc`, installs the Worker secret, applies D1 migrations, deploys, and verifies the endpoint. Re-run the same command to update the installation. An existing secret is retained unless a replacement key is supplied. Without its local value, verification can check health but cannot authenticate the session. Use `--base-url` for a custom domain when Wrangler does not report a workers.dev URL. `--help` lists resource-name, profile, location, and endpoint options.

Keep the local Wrangler configuration for future updates. Never commit generated resource IDs, credentials, or `.wrangler/` state. Cloudflare usage is billed to the account that hosts the server.

## Memory behavior

- Completed user requests and final answers are saved in the shared `memories` collection with source-folder provenance. A deterministic capture identity makes retries reuse the same stored record instead of creating duplicates.
- Use `listTopics` to find content categories, then pass a `topic` to `listDocuments` or `listMemories`. Lists include records across both legacy folder spaces and the shared collection. Use `topic: "__unclassified__"` to see records without current topic labels, including records whose classification failed, is disabled, or was deliberately skipped.
- Manual `add_memory` saves to the shared collection. To forget a record after reading it, pass its `documentId` and source `containerTag`; exact stored content remains supported for compatibility. An absolute `sourceFolder` or a single workspace root supplied by the MCP client adds provenance; an explicit `containerTag` overrides storage. The plugin never uses its installation folder as the user's project. `listSpaces` exposes physical spaces for compatibility and diagnostics.
- Prompt recall searches every discovered nonempty space by topic. The initial session event does not inject unrelated recent records.
- Automatic context contains a title, description, section names, timestamps, and document IDs. Codex opens full records with `getDocument` when needed.
- The server checks projects daily at 03:00 JST. It asks Workers AI to create a consolidated checkpoint when a project has at least 20 unconsolidated records, or when it has unconsolidated records and three days have elapsed since the last successful checkpoint (before the first checkpoint, since the oldest pending record). On a project's first due run, the server automatically drains the entire existing backlog in successive bounded AI batches, so old records do not require a manual backfill command. Original records are retained and linked from the checkpoint. Older checkpoints are superseded, and changing or forgetting a source invalidates the checkpoint that depended on it.
- Use the `consolidate_memory` MCP tool to advance the current workspace checkpoint by one batch immediately without waiting for the daily check. Pass `projectId` to target a known provenance ID, or `sourceFolder` when the MCP client does not provide exactly one workspace root. Each call handles at most 40 new records; repeat it if a larger backlog remains. Manual execution still requires at least one unconsolidated source record.
- Automatic recall places a relevant current checkpoint before uncovered originals and does not repeat originals already represented by that checkpoint. Manual search continues to expose the original records.
- Capture redacts configured secrets and retries unacknowledged records. Local capture state stays under `kagayoi-memory/capture-state/` in the selected Codex home.
- Space discovery is capped by the current server API at 100. A full page is reported as incomplete rather than claiming exhaustive search.

Topics are derived from record content during the existing Workers AI enrichment step. Classification is asynchronous. Brief acknowledgements without a substantial result, and similar low-information records, remain available to manual search but are excluded from automatic recall and enrichment; explicit topic labels are still retained. Folder names are retained as source metadata. Existing records keep their original document IDs and storage locations and appear in the same topic browser.

Update the server and apply its migrations before installing a client that uses topic browsing or consolidation. The server setup preserves the existing 15-minute vector reconciliation schedule and adds the daily consolidation check. To classify old records, preview a bounded batch using the existing memory connection:

```powershell
node scripts/setup-topics.mjs --limit 10
```

Add `--apply` to queue the selected records for enrichment. This uses the backend's existing Workers AI billing and refreshes the records' derived enrichment. The result reports accepted jobs, not completed classification. Wait for processing to finish before selecting the next batch; inspect `getDocument` and `listTopics` to verify the result.

The API key grants access to the records in one server installation. Use separate installations for separate trust boundaries. Redaction reduces accidental secret capture; review what you choose to store in your own backend.

## Upgrading from 1.x names

Replace an installed 1.x `cloudflare-supermemory` plugin with `kagayoi-memory`. During this transition, the client retains compatibility readers for `~/.codex/supermemory.json`, `SUPERMEMORY_API_URL`, `SUPERMEMORY_CODEX_API_KEY`, and `CLOUDFLARE_MEMORY_API_KEY`. Run `scripts/setup-client.ps1` to migrate an existing connection to `~/.codex/kagayoi-memory.json`, then use `KAGAYOI_MEMORY_API_URL`, `KAGAYOI_MEMORY_API_KEY`, and the `kagayoi-memory` plugin name for normal operation. For resource names left at their defaults, server setup prefers existing `kagayoi-memory` resources and falls back to a matching 1.x `cloudflare-supermemory` resource only when the current-name counterpart is absent; explicit names always win. Existing document IDs, legacy spaces, deterministic capture IDs, and persisted `sm_*` metadata remain valid and are not rewritten merely because the product was renamed.

Kagayoi Memory implements its own self-hosted API. It is independent of the hosted Supermemory service and does not read or modify Codex's built-in local memory files.

For architecture and repository layout, see the repository's [DESIGN.md](https://github.com/1llum1n4t1s/kagayoi-memory/blob/main/DESIGN.md). Contributor constraints, validation, and packaging commands are in [AGENTS.md](https://github.com/1llum1n4t1s/kagayoi-memory/blob/main/AGENTS.md).

Licensed under the [MIT License](LICENSE).
