# Repository guidance

This repository packages a self-hosted Cloudflare memory server and its Codex plugin.

- Keep `client/` compatible with Node.js 24 and avoid runtime dependencies unless they materially improve reliability.
- Keep `server/` deployable with Wrangler. Never commit API keys, generated resource IDs, `.dev.vars`, or `.wrangler/` state.
- Preserve the memory contract: project folders remain provenance tags; ordinary recall searches all discovered spaces by topic; injected context contains indexes and document IDs rather than full records.
- Keep the official Codex local memory store outside this integration.
- Changes to capture must preserve deterministic document IDs and redact configured secrets.
- Run client tests, server tests, plugin validation, and `git diff --check` for affected changes.
- Do not deploy, migrate a remote database, publish a package, create a remote repository, or push without an explicit request.
