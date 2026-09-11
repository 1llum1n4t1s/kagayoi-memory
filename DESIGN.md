# Design

The repository has two deployable parts.

```text
Codex plugin                          User-owned Cloudflare account
  prompt/capture hooks  ───────────▶  Worker API
  MCP search/getDocument ◀─────────   D1 + Vectorize + Workers AI
```

`client/` stores completed task records with deterministic v2 IDs in the shared `memories` container. Repository identity is retained separately in `metadata.sm_project_id` and `metadata.project`; it does not partition new storage. Existing records keep their IDs and physical containers, and capture reuses matching legacy records instead of moving them. Manual saves also default to `memories`, with an explicit `containerTag` overriding storage. Manual forget is restricted to that explicit or default container.

Recall discovers nonempty containers and ranks concise metadata indexes by the user's current topic without restricting results to the current folder. Discovery is capped at 100 spaces and reports a full page as incomplete. Codex reads a full record through `getDocument` only when an index appears applicable. Topic browsing uses a separate cross-container list API, so it is not limited by recall's space-discovery cap.

Capture retains JSON sent-document receipts and coordinates their updates through Node's built-in SQLite under `cloudflare-memory/capture-state/` in the selected Codex home. Deterministic IDs and retrying unacknowledged records preserve retry safety; configured secrets are redacted before capture. Codex's official local memory store remains outside this integration.

`server/` owns authentication, persistence, lexical and semantic search, enrichment, and document retrieval. Each installation uses resources in the user's Cloudflare account. Client configuration contains only that installation's HTTPS endpoint and API key.

Migration `0004_content_topics.sql` adds revisioned `memory_topics` rows and classification state. Workers AI extracts content topics alongside facts; explicit validated `metadata.topics` can supply labels. Topic labels describe content, while containers remain physical storage and project metadata remains provenance. Fact support and supersession lookup is restricted to matching project provenance within a container, so shared storage does not make one project's facts replace another's.

`GET /v4/topics` lists topic counts and an unclassified count. `POST /v3/documents/list` spans all containers by default, with optional container and normalized exact-topic filters; `__unclassified__` selects records without current topic rows. Topic reads join against the document's current revision and omit forgotten records. Topic replacement uses a guarded D1 batch, and updates or enrichment retries change the revision to prevent stale jobs from publishing topic rows for newer content.

Enrichment is asynchronous and independently tracks embedding, vector, fact, and topic outcomes. Disabled or failed classification leaves records available through unclassified browsing. `scripts/setup-topics.mjs` previews a bounded unclassified batch; `--apply` submits those IDs to `POST /v4/enrich` using the existing backend, without adding a queue service. Acceptance is not completion, and re-enrichment refreshes other derived data too. This keeps classification within existing Workers AI usage at the cost of requiring callers to observe completion before selecting another batch. Server migrations precede clients that depend on topic APIs.

`scripts/setup-server.mjs` handles resource discovery, resumable provisioning, migrations, deployment, and endpoint verification. Its default mode is read-only; `--apply` enables changes. Generated resource identifiers remain in the ignored local Wrangler configuration. The distributable package includes the example configuration and migrations, but excludes local state and credentials.

Codex loads an installed plugin copy from its cache. Connection settings and capture receipts remain under the Codex home directory so reinstalling the plugin does not discard them. Hook trust is managed by Codex and requires review of each current definition. A new task picks up updated skills and MCP tools.

The package uses Codex's `.codex-plugin/plugin.json` format because Codex 0.153.4 does not load lifecycle hooks from portable Agent Plugin manifests. Its legacy MCP configuration sets `cwd` to `.`; Codex resolves that directory against the installed plugin root. The launcher path is relative to that root, while workspace provenance comes from MCP roots or an explicit `sourceFolder`, never the server process directory.

Repository entry points are `.codex-plugin/`, `.mcp.json`, and `hooks/` for plugin wiring; `client/` for MCP, recall, and capture; `server/` for the Worker and migrations; `scripts/` for launchers, setup, and packaging; and `skills/setup-cloudflare-memory/` for the setup workflow. Development checks are maintained in [AGENTS.md](AGENTS.md); installation and operation are in [README.md](README.md).
