import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const state = mkdtempSync(join(tmpdir(), "cloudflare-memory-test-"));
const token = "sm_cf_test_only";
const port = 8900 + (process.pid % 500);
const baseUrl = `http://127.0.0.1:${port}`;

function run(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args, "--config", "wrangler.test.jsonc"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MEMORY_API_KEY: token },
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The local Worker is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 125));
  }
  throw new Error("Timed out waiting for wrangler dev");
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

async function callMcp() {
  const child = spawn(process.execPath, [join(root, "..", "client", "mcp-server.mjs")], {
    cwd: root,
    env: { ...process.env, SUPERMEMORY_API_URL: baseUrl, SUPERMEMORY_CODEX_API_KEY: token },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_memory", arguments: { query: "Cloudflare", containerTag: "repo_test__0123456789abcdef" } } })}\n`);
  for (let attempt = 0; attempt < 80 && responses.length < 3; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  await stopChild(child);
  assert.equal(responses.find((item) => item.id === 1)?.result?.serverInfo?.name, "cloudflare-supermemory");
  assert.ok(responses.find((item) => item.id === 2)?.result?.tools?.some((tool) => tool.name === "whoAmI"));
  assert.equal(responses.find((item) => item.id === 3)?.result?.isError, undefined);
}

let worker;
try {
  run(["d1", "migrations", "apply", "cloudflare-supermemory", "--local", "--persist-to", state]);
  worker = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--config",
      "wrangler.test.jsonc",
      "--local",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--var",
      `MEMORY_API_KEY:${token}`,
      "--var",
      "AI_ENRICHMENT_MODE:off",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitForServer();

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.semanticSearch, "disabled");
  assert.equal(health.factGraph, "disabled");

  const unauthorized = await fetch(`${baseUrl}/v3/session`);
  assert.equal(unauthorized.status, 401);

  const containerTag = "repo_test__0123456789abcdef";
  const first = await request("/v3/documents", {
    method: "POST",
    body: JSON.stringify({
      content: "記憶データはCloudflare D1へ保存する",
      containerTag,
      customId: "session-1",
      metadata: { sm_scope: "personal" },
    }),
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.enrichmentStatus, "disabled");

  const update = await request("/v3/documents", {
    method: "POST",
    body: JSON.stringify({
      content: "記憶データはSupermemory HostedではなくCloudflare D1へ保存する",
      containerTag,
      customId: "session-1",
      metadata: { sm_scope: "personal" },
    }),
  });
  const updateBody = await update.json();
  assert.equal(updateBody.id, firstBody.id);

  const profile = await request("/v4/profile", {
    method: "POST",
    body: JSON.stringify({ containerTag, q: "Cloudflare D1" }),
  });
  assert.equal(profile.status, 200);
  const profileBody = await profile.json();
  assert.equal(profileBody.searchResults.results.length, 1);
  assert.match(profileBody.searchResults.results[0].memory, /Supermemory HostedではなくCloudflare D1/);

  const list = await request("/v3/documents/list", {
    method: "POST",
    body: JSON.stringify({ containerTag, page: 1, limit: 10 }),
  });
  const listBody = await list.json();
  assert.equal(listBody.pagination.totalItems, 1);
  assert.equal(listBody.documents[0].enrichment.embeddingStatus, "disabled");
  assert.equal(listBody.documents[0].enrichment.vectorStatus, "disabled");

  const graph = await request("/v4/graph", {
    method: "POST",
    body: JSON.stringify({ containerTag }),
  });
  assert.deepEqual(await graph.json(), { facts: [], relations: [] });

  await callMcp();

  const forgotten = await request("/v4/memories", {
    method: "DELETE",
    body: JSON.stringify({ containerTag, content: "記憶データはSupermemory HostedではなくCloudflare D1へ保存する" }),
  });
  assert.equal(forgotten.status, 200);
  const afterForget = await request("/v4/search", {
    method: "POST",
    body: JSON.stringify({ containerTag, q: "Cloudflare D1" }),
  });
  assert.equal((await afterForget.json()).results.length, 0);

  console.log("Cloudflare memory smoke tests passed: auth, save/upsert, search, list, graph, MCP, forget");
} finally {
  await stopChild(worker);
  rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
