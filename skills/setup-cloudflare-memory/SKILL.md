---
name: setup-cloudflare-memory
description: Configure, verify, or troubleshoot the Cloudflare Supermemory Codex plugin against a user-owned compatible server. Use for connecting another PC, preparing a self-hosted Cloudflare deployment, or checking memory connectivity. Do not use for hosted Supermemory accounts.
---

# Setup Cloudflare Memory

Paths below are relative to the installed plugin root, two directories above this file. Resolve them to absolute paths before running commands; the current task folder does not necessarily contain the plugin's scripts or server.

Determine whether the user is connecting to an existing server or creating resources in their own Cloudflare account.

For an existing server, obtain the HTTPS base URL without secrets in chat. Run `scripts/setup-client.ps1`; accept the API key through its secure prompt or the process-scoped `SUPERMEMORY_CODEX_API_KEY` or `CLOUDFLARE_MEMORY_API_KEY` environment variable. Use `-Force` when intentionally updating an existing connection; preserve its other settings. Verify `/v3/session`, then run the MCP `whoAmI` tool and report the discovered topic-search scope without printing credentials.

For a new server, install the pinned dependencies with `pnpm -C server install --frozen-lockfile`, authenticate Wrangler, and run `node scripts/setup-server.mjs` for read-only discovery. When deployment is authorized, supply the chosen key through `CLOUDFLARE_MEMORY_API_KEY` and run the same command with `--apply`. Consult `--help` for resource names and location. The script creates or reuses D1 and Vectorize, writes ignored local configuration, applies migrations, deploys, and verifies the endpoint. Reuse the configuration for updates. A request to prepare files locally does not authorize provisioning or deployment.

Install or update this package using Codex's plugin-creator workflow and its personal marketplace. Do not duplicate its hooks in user hooks or register a second copy of its MCP server. Codex requires user review and trust of current plugin hook definitions; installing alone is insufficient. After installation or update, use a new task to load the skills and MCP tools. Preserve the existing connection file and v2 capture receipts when replacing an older manual integration.

Keep each installation isolated by endpoint and key. Preserve project `containerTag` values as provenance while topic recall searches every nonempty space returned by that server. The integration must not read or modify Codex's built-in local memory files.

For manual saves and project-scoped lists, pass the current task's absolute folder as `sourceFolder` unless the MCP client has supplied a single valid workspace root. An explicit `containerTag` is also supported. Never use the installed plugin folder as provenance. `whoAmI` can report an unavailable workspace while API authentication and global topic discovery remain connected.

For code changes, run the client tests, `pnpm -C server test`, the plugin validator, and the skill validator. Treat a 100-space discovery result as incomplete because the current API caps that listing.
