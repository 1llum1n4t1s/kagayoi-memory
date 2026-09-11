#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { api, getReadContext, searchIndex, listIndex, readDocument, formatSearchResult, discoverSearchContainers } from "./memory-client.mjs";
import { buildMemoryIndex } from "./memory-index.mjs";

const SERVER_VERSION = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")).version;
const PROTOCOL_VERSION = "2025-06-18";
const RUNTIME_PLUGIN_ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const UNRESOLVED_CONTEXT = { containerTag: undefined, projectName: undefined, projectTags: [], sharedTags: [], readTags: [] };
const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;

const stringSchema = { type: "string", minLength: 1 };
const containerProperty = { type: "string", minLength: 1, maxLength: 160, description: "Optional memory space tag" };
const sourceFolderProperty = {
  type: "string",
  minLength: 1,
  maxLength: 4096,
  description: "Absolute current workspace folder. Use when the MCP client does not provide exactly one workspace root.",
};
const tools = [
  {
    name: "search_memory",
    description: "Search concise memory indexes by topic across every nonempty Supermemory space, independent of the current work folder. Returns document IDs, source spaces and dates; use getDocument for details. An explicit containerTag restricts the search to that space.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000 },
        includeProfile: { type: "boolean", default: false, description: "Compatibility option. true adds the searched-space index, never extracted factual profiles." },
        containerTag: containerProperty,
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "add_memory",
    description: "Save or forget a memory in the user's Cloudflare D1 database. When containerTag is omitted, pass sourceFolder as the absolute current workspace if client roots are unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 200000 },
        action: { type: "string", enum: ["save", "forget"], default: "save" },
        containerTag: containerProperty,
        sourceFolder: sourceFolderProperty,
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "listMemories",
    description: "List recent memory indexes in one space; use getDocument for full details. Pass containerTag or sourceFolder when the current workspace cannot be resolved from client roots.",
    inputSchema: {
      type: "object",
      properties: { page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 }, containerTag: containerProperty, sourceFolder: sourceFolderProperty },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "listDocuments",
    description: "List stored document indexes with provenance; use getDocument for full details. Pass containerTag or sourceFolder when the current workspace cannot be resolved from client roots.",
    inputSchema: {
      type: "object",
      properties: { page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 }, containerTag: containerProperty, sourceFolder: sourceFolderProperty },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "getDocument",
    description: "Read one memory document from Cloudflare D1.",
    inputSchema: { type: "object", properties: { documentId: stringSchema }, required: ["documentId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "listSpaces",
    description: "List memory spaces stored in Cloudflare D1.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "whoAmI",
    description: "Show the active self-hosted Cloudflare memory context. sourceFolder can identify the current workspace when client roots are unavailable.",
    inputSchema: { type: "object", properties: { sourceFolder: sourceFolderProperty }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function textResult(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

export function contextFromSourceFolder(sourceFolder, workspaceSource = "sourceFolder") {
  if (typeof sourceFolder !== "string" || !sourceFolder.trim() || sourceFolder.length > 4_096 || !isAbsolute(sourceFolder)) {
    throw new Error("sourceFolder must be an absolute existing directory path.");
  }
  let folder;
  try {
    folder = realpathSync(sourceFolder);
    if (!statSync(folder).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("sourceFolder must be an absolute existing directory path.");
  }
  return { ...getReadContext(folder), workspaceSource };
}

export async function callTool(name, args, { request = api, context, settings, resolveContext } = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
  if (args.containerTag !== undefined && (typeof args.containerTag !== "string" || !args.containerTag.trim() || args.containerTag.length > 160)) {
    throw new Error("containerTag must be a nonempty string of at most 160 characters.");
  }
  const explicitTag = typeof args.containerTag === "string" ? args.containerTag.trim() : undefined;
  const explicitContext = args.sourceFolder === undefined ? context : contextFromSourceFolder(args.sourceFolder);
  let resolvedContext;
  async function workspaceContext() {
    if (resolvedContext !== undefined) return resolvedContext;
    resolvedContext = explicitContext || (typeof resolveContext === "function" ? await resolveContext() : null);
    return resolvedContext;
  }

  if (name === "search_memory") {
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 1_000) throw new Error("query must be a nonempty string of at most 1000 characters.");
    // 通常検索は全保存先を横断するため、作業場所を解決できなくても安全に実行できる。
    const result = await searchIndex({ query: args.query, containerTag: explicitTag, context: explicitContext || UNRESOLVED_CONTEXT, request, settings });
    const structured = { ...result, ...(args.includeProfile === true ? { profile: { type: "space-index", containers: result.searchedContainers } } : {}) };
    return textResult(formatSearchResult(result), structured);
  }

  if (name === "add_memory") {
    if (typeof args.content !== "string" || !args.content.trim() || args.content.length > 200_000) throw new Error("content must be a nonempty string of at most 200000 characters.");
    if (args.action !== undefined && args.action !== "save" && args.action !== "forget") throw new Error("action must be save or forget.");
    const workspace = explicitTag ? explicitContext : await workspaceContext();
    const containerTag = explicitTag || workspace?.containerTag;
    if (!containerTag) {
      throw new Error("Cannot determine the current workspace. Pass sourceFolder as an absolute path or specify containerTag explicitly.");
    }
    if (args.action === "forget") {
      const result = await request("/v4/memories", { method: "DELETE", body: { containerTag, content: args.content } });
      return textResult(result.message, { action: "forget", success: true, containerTag, message: result.message });
    }

    const result = await request("/v3/documents", {
      method: "POST",
      body: { containerTag, content: args.content, metadata: { sm_source: "codex-mcp", sm_scope: "project",
        ...(workspace ? { project: workspace.projectName, sm_project_id: containerTag } : {}),
        memoryIndex: buildMemoryIndex({ request: args.content, sourceKind: "explicit-memory" }) } },
    });
    const message = `Memory saved in Cloudflare D1 (ID: ${result.id})`;
    return textResult(message, { action: "save", success: true, containerTag, message, id: result.id, status: result.status });
  }

  if (name === "listMemories" || name === "listDocuments") {
    if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1)) throw new Error("page must be a positive integer.");
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) throw new Error("limit must be an integer from 1 through 50.");
    const workspace = explicitTag ? explicitContext : await workspaceContext();
    const containerTag = explicitTag || workspace?.containerTag;
    if (!containerTag) {
      throw new Error("Cannot determine the current workspace. Pass sourceFolder as an absolute path or specify containerTag explicitly.");
    }
    const result = await listIndex({ containerTag, page: args.page ?? 1, limit: args.limit ?? 10, context, request });
    const items = result.documents;
    return textResult(JSON.stringify(items, null, 2), { [name === "listMemories" ? "memoryEntries" : "documents"]: items, pagination: result.pagination });
  }

  if (name === "getDocument") {
    if (typeof args.documentId !== "string" || !args.documentId.trim()) throw new Error("documentId must be a nonempty string.");
    const result = await readDocument(args.documentId.trim(), request);
    return textResult(result.text, { document: result.document });
  }

  if (name === "listSpaces") {
    const result = await request("/v3/container-tags");
    return textResult(JSON.stringify(result.spaces, null, 2), result);
  }

  if (name === "whoAmI") {
    const workspace = await workspaceContext();
    const [session, discovery] = await Promise.all([request("/v3/session"), discoverSearchContainers(request)]);
    const structured = {
      userId: session.user.id,
      name: session.user.name,
      role: session.role,
      accessType: session.accessType,
      activeSpace: workspace?.containerTag || null,
      workspaceSource: workspace?.workspaceSource || (explicitContext ? "provided-context" : "unavailable"),
      searchScope: "all-discovered-containers",
      readSpaces: discovery.tags,
      spaceDiscoveryComplete: discovery.complete,
      recallFormat: "document-index",
      storage: "cloudflare-d1",
    };
    return textResult(JSON.stringify(structured), structured);
  }

  throw new Error("Unknown tool");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let clientSupportsRoots = false;
let cachedRootContext = null;
let cachedRootGeneration = -1;
let rootGeneration = 0;
let rootResolution = null;
let nextServerRequestId = 1;
const pendingClientRequests = new Map();

function requestClient(method, params, timeoutMs = 1_000) {
  const id = `cloudflare-supermemory-${nextServerRequestId++}`;
  return new Promise((resolveRequest, reject) => {
    const timeout = setTimeout(() => {
      pendingClientRequests.delete(id);
      reject(new Error(`MCP client did not answer ${method}.`));
    }, timeoutMs);
    pendingClientRequests.set(id, {
      resolve(value) { clearTimeout(timeout); resolveRequest(value); },
      reject(error) { clearTimeout(timeout); reject(error); },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function resolveClientContext() {
  if (!clientSupportsRoots) return null;
  if (cachedRootGeneration === rootGeneration) return cachedRootContext;
  if (rootResolution?.generation === rootGeneration) return rootResolution.promise;

  const generation = rootGeneration;
  const promise = (async () => {
    let context = null;
    try {
      const response = await requestClient("roots/list", {});
      if (Array.isArray(response?.roots)) {
        const folders = [...new Set(response.roots.flatMap((root) => {
          if (!root || typeof root.uri !== "string") return [];
          try {
            const url = new URL(root.uri);
            if (url.protocol !== "file:") return [];
            return [realpathSync(fileURLToPath(url))];
          } catch { return []; }
        }))];
        if (folders.length === 1 && pathKey(folders[0]) !== pathKey(RUNTIME_PLUGIN_ROOT)) {
          context = contextFromSourceFolder(folders[0], "mcp-roots");
        }
      }
    } catch {
      // 利用できないrootsは明示sourceFolderへフォールバックする。
    }

    // 取得中にrootsが更新された場合、古い応答を待っていた呼び出しも新しい世代へ合流する。
    if (generation !== rootGeneration) return resolveClientContext();
    cachedRootContext = context;
    cachedRootGeneration = generation;
    return context;
  })();
  rootResolution = { generation, promise };
  try {
    return await promise;
  } finally {
    if (rootResolution?.promise === promise) rootResolution = null;
  }
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.method === undefined && message.id !== undefined) {
    const pending = pendingClientRequests.get(message.id);
    if (!pending) return;
    pendingClientRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "MCP client request failed."));
    else pending.resolve(message.result);
    return;
  }
  if (message.id === undefined) {
    if (message.method === "notifications/roots/list_changed") {
      rootGeneration += 1;
      cachedRootContext = null;
      cachedRootGeneration = -1;
    }
    return;
  }

  try {
    let result;
    if (message.method === "initialize") {
      clientSupportsRoots = message.params?.capabilities?.roots !== undefined;
      rootGeneration += 1;
      cachedRootContext = null;
      cachedRootGeneration = -1;
      rootResolution = null;
      result = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cloudflare-supermemory", version: SERVER_VERSION },
      };
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools };
    } else if (message.method === "tools/call") {
      result = await callTool(message.params?.name, message.params?.arguments ?? {}, { resolveContext: resolveClientContext });
    } else if (message.method === "resources/list" || message.method === "prompts/list") {
      result = { [message.method.startsWith("resources") ? "resources" : "prompts"]: [] };
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: error instanceof Error ? error.message : "Cloudflare memory request failed" }],
        isError: true,
      },
    });
  }
}

export function startMcpServer() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim() || line.length > 1024 * 1024) return;
    try {
      const message = JSON.parse(line);
      void handle(message);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer();
}
