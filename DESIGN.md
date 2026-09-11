# Design

The repository has two deployable parts.

```text
Codex plugin                          User-owned Cloudflare account
  prompt/capture hooks  ───────────▶  Worker API
  MCP search/getDocument ◀─────────   D1 + Vectorize + Workers AI
```

`client/` stores completed task records with deterministic IDs. Each record retains a `containerTag` derived from repository identity. Recall discovers nonempty containers and ranks concise metadata indexes by the user's current topic without restricting results to the current folder. Codex reads a full record through `getDocument` only when an index appears applicable.

`server/` owns authentication, persistence, lexical and semantic search, enrichment, and document retrieval. Each installation uses resources in the user's Cloudflare account. Client configuration contains only that installation's HTTPS endpoint and API key.

`scripts/setup-server.mjs` handles resource discovery, resumable provisioning, migrations, deployment, and endpoint verification. Its default mode is read-only; `--apply` enables changes. Generated resource identifiers remain in the ignored local Wrangler configuration. The distributable package includes the example configuration and migrations, but excludes local state and credentials.

Codex loads an installed plugin copy from its cache. Connection settings and capture receipts remain under the Codex home directory so reinstalling the plugin does not discard them. Hook trust is managed by Codex and requires review of each current definition. A new task picks up updated skills and MCP tools.
