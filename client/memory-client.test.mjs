import test from "node:test";
import assert from "node:assert/strict";
import { buildMemoryIndex, documentIndex } from "./memory-index.mjs";
import { searchIndex, listIndex, readDocument, getReadContext, queryTerms } from "./memory-client.mjs";
import { runHook } from "./memory-hooks.mjs";
import { callTool } from "./mcp-server.mjs";
import { buildTurnDocuments, cleanUserRequest } from "./Import-CodexSupermemoryHistory.mjs";

const settings = { recallMode: "direct", maxMemories: 5, minimumSimilarity: 0.7 };
const context = { containerTag: "project", projectName: "project", projectTags: ["project", "legacy-project"], sharedTags: ["shared"], readTags: ["project", "legacy-project", "shared"] };
const date = "2026-09-11T01:02:03.000Z";
const spaceList = (tags) => ({ spaces: tags.map((containerTag) => ({ containerTag, memoryCount: 1 })) });
const withDiscovery = (handler, tags = context.readTags) => async (path, options = {}) => path === "/v3/container-tags" ? spaceList(tags) : handler(path, options);
function row(id = "doc-1", tag = "shared", overrides = {}) {
  return { id, containerTag: tag, createdAt: date, updatedAt: date, similarity: 0.8,
    content: "DETAIL_ONLY: 実際のコードと検証結果を含む長い原文。".repeat(100),
    metadata: { memoryIndex: buildMemoryIndex({ title: "Kirihaの選択解除", request: "Kirihaで選択解除の経緯を確認する", sourceUpdatedAt: date }) }, ...overrides };
}

test("BフォルダからChrome拡張機能を検索するとAフォルダの索引を発見し、由来と詳細を保つ", async () => {
  const tags = ["folder-b", "folder-a"];
  const current = { ...context, containerTag: "folder-b", projectTags: ["folder-b"], sharedTags: [], readTags: ["folder-b"] };
  const chrome = row("chrome-a", "folder-a", { similarity: 0.86, metadata: { memoryIndex: buildMemoryIndex({ title: "Chrome拡張機能の実装", request: "Chrome拡張機能を実装する", response: "## Manifest V3\nDETAIL_ONLY", sourceUpdatedAt: date }) } });
  const calls = [];
  const request = withDiscovery(async (path, { body } = {}) => {
    calls.push([path, body?.containerTag]);
    if (path.startsWith("/v3/documents/")) return chrome;
    return { results: body.containerTag === "folder-a" ? [chrome] : [] };
  }, tags);
  const hook = await runHook("UserPromptSubmit", { prompt: "Chrome拡張機能を実装して" }, { settings, context: current, request });
  const hookCalls = calls.splice(0);
  const mcp = await callTool("search_memory", { query: "Chrome拡張機能を実装して", includeProfile: false }, { settings, context: current, request });
  assert.deepEqual(calls, hookCalls);
  assert.deepEqual(calls.filter(([path]) => path === "/v4/search").map((c) => c[1]), tags);
  assert.ok(calls.every(([path]) => path === "/v4/search"));
  const text = hook.hookSpecificOutput.additionalContext;
  assert.match(text, /id=chrome-a.*container=folder-a.*2026-09-11/);
  assert.doesNotMatch(text, /DETAIL_ONLY/);
  assert.doesNotMatch(JSON.stringify(mcp), /DETAIL_ONLY/);
  assert.equal(mcp.structuredContent.results[0].id, "chrome-a");
  assert.equal(mcp.structuredContent.results[0].containerTag, "folder-a");
  assert.deepEqual(mcp.structuredContent.searchedContainers, tags);
  assert.equal("profile" in mcp.structuredContent, false);
  assert.ok(text.length < 1500);
  const detail = await readDocument("chrome-a", request);
  assert.equal(detail.document.index.containerTag, "folder-a");
  assert.match(detail.text, /DETAIL_ONLY/);
});

test("SessionStartは話題がないため保存先一覧も最近の文書も読まず何も注入しない", async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); throw new Error("unexpected request"); };
  const hook = await runHook("SessionStart", {}, { settings, context, request });
  assert.deepEqual(calls, []);
  assert.deepEqual(hook, {});
});

test("明示した保存先での検索はその一つだけに限定する", async () => {
  const calls = [];
  const result = await searchIndex({ query: "Kiriha", containerTag: "chosen", settings, context,
    request: async (_path, { body }) => { calls.push(body.containerTag); return { results: [row("chosen-id", "chosen")] }; } });
  assert.deepEqual(calls, ["chosen"]);
  assert.equal(result.results[0].containerTag, "chosen");
});

test("低スコア候補と高スコアでも拡張だけが一致する別話題を自動注入しない", async () => {
  assert.deepEqual(queryTerms("Chrome拡張機能を実装して"), ["chrome", "拡張機能"]);
  const request = withDiscovery(async (_path, { body }) => ({ results: [row("unrelated", body.containerTag, { similarity: 0.61 })] }));
  const hook = await runHook("UserPromptSubmit", { prompt: "Supermemoryの接続経路を確認" }, { settings, context, request });
  assert.deepEqual(hook, {});
  const sharedOnly = { ...context, projectTags: [], readTags: ["shared"] };
  const semanticOnly = await runHook("UserPromptSubmit", { prompt: "Supermemoryの接続経路" }, { settings, context: sharedOnly,
    request: withDiscovery(async () => ({ results: [row("unrelated", "shared", { similarity: 0.99,
      metadata: { memoryIndex: buildMemoryIndex({ title: "ファイルドロップ対応を拡張", request: "ドロップ対象を増やす" }) } })] }), ["shared"]) });
  assert.deepEqual(semanticOnly, {});
});

test("分類済みtopicに検索語が一致する索引はタイトルが別でも自動注入する", async () => {
  const classified = row("classified-topic", "shared", { similarity: 0.61, topics: ["Cloudflare D1"],
    metadata: { memoryIndex: buildMemoryIndex({ title: "保存基盤の設計", request: "永続化方式を整理する" }) } });
  const result = await runHook("UserPromptSubmit", { prompt: "Cloudflare D1" }, { settings, context,
    request: withDiscovery(async () => ({ results: [classified] }), ["shared"]) });
  assert.match(result.hookSpecificOutput.additionalContext, /id=classified-topic.*topics=Cloudflare D1/);
});

test("短い相づちと出典のない旧fact断片は索引として自動注入しない", async () => {
  const ack = row("ack", "project", { metadata: { memoryIndex: buildMemoryIndex({ title: "Kiriha", request: "ありがとうございます。", response: "どういたしまして。" }) } });
  const fact = row("fact", "project", { metadata: {}, content: "Kiriha has BookmarkTree selection logic" });
  const request = withDiscovery(async (path) => path.startsWith("/v3/documents/") ? fact : ({ results: [ack, fact] }));
  assert.deepEqual(await runHook("SessionStart", {}, { settings, context, request }), {});
  assert.equal((await searchIndex({ query: "Kiriha", settings, context, request })).results.length, 2);
});

test("一部失敗と全失敗を検索結果なしから区別する", async () => {
  const request = withDiscovery(async (_path, { body }) => {
    if (body.containerTag !== "shared") throw new Error("offline");
    return { results: [row()] };
  });
  const result = await searchIndex({ query: "Kiriha", settings, context, request });
  assert.deepEqual(result.failedContainers, context.projectTags);
  assert.equal(result.results.length, 1);
  const failSearch = withDiscovery(async () => { throw new Error("offline"); });
  await assert.rejects(searchIndex({ query: "Kiriha", settings, context, request: failSearch }), /unavailable/);
  const hook = await runHook("UserPromptSubmit", { prompt: "Kiriha" }, { settings, context, request: failSearch });
  assert.match(hook.systemMessage, /取得できません/);
  assert.equal(hook.hookSpecificOutput, undefined);
});

test("保存先一覧の取得失敗を局所検索へフォールバックせず明示する", async () => {
  const request = async () => { throw new Error("offline"); };
  await assert.rejects(searchIndex({ query: "Chrome拡張機能", settings, context, request }), /space discovery failed.*not performed/);
  const hook = await runHook("UserPromptSubmit", { prompt: "Chrome拡張機能を実装して" }, { settings, context, request });
  assert.match(hook.systemMessage, /保存先一覧.*全フォルダ横断.*実行できません/);
});

test("保存先一覧がAPI上限100件なら検索結果へ不完全性を残す", async () => {
  const tags = Array.from({ length: 100 }, (_, index) => `space-${index}`);
  const result = await searchIndex({ query: "Chrome拡張機能", settings, context,
    request: withDiscovery(async () => ({ results: [] }), tags) });
  assert.equal(result.spaceDiscoveryComplete, false);
  assert.match(callTool ? (await callTool("search_memory", { query: "Chrome拡張機能" }, { settings, context,
    request: withDiscovery(async () => ({ results: [] }), tags) })).content[0].text : "", /100-space limit/);
});

test("保存文書の索引からgetDocumentで欠落なく同じ原文に戻れる", async () => {
  const [saved] = buildTurnDocuments({ meta: { id: "session-1" } }, { turns: [{ user: "Kirihaの選択解除を調査して", assistant: "検証結果は未確定。DETAIL_ONLYの詳細を残す。", sourceTimestamp: date }] },
    { containerTag: "project", projectName: "Kiriha" }, "Kirihaの選択解除");
  const document = { ...saved, id: "actual-id", createdAt: date, updatedAt: date, similarity: 0.85 };
  const request = async (path) => path === "/v4/search" ? { results: [document] } : document;
  const result = await searchIndex({ query: "Kiriha", containerTag: "memories", settings, context, request });
  assert.equal(result.results[0].sourceUpdatedAt, date);
  assert.doesNotMatch(JSON.stringify(result), /DETAIL_ONLY|未確定/);
  const detail = await readDocument(result.results[0].id, async (path) => {
    assert.equal(path, "/v3/documents/actual-id"); return document;
  });
  assert.equal(detail.document.content, saved.content);
  assert.match(detail.text, /検証結果は未確定/);
  assert.equal(detail.document.index.containerTag, "memories");
  assert.deepEqual(detail.document.index.provenance, { containerTag: "memories", projectId: "project", project: "Kiriha", filepath: undefined });
});

test("旧文書も本文を索引から分離し、新しい保存日時を原文の日時と誤表示しない", () => {
  const index = documentIndex({ id: "old", containerTags: ["legacy"], updatedAt: date,
    content: "# 旧タスク\nSession: previous\n\n### User request\nブックマークの並び順を調べて\n\n### Final assistant response\nDETAIL_ONLY" });
  assert.equal(index.title, "旧タスク");
  assert.equal(index.description, "ブックマークの並び順を調べて");
  assert.equal(index.sourceUpdatedAt, undefined);
  assert.doesNotMatch(JSON.stringify(index), /DETAIL_ONLY/);
});

test("serverが返す空topicsは旧metadata topicより優先する", () => {
  const index = documentIndex({ id: "doc", content: "new", topics: [], metadata: { topics: ["obsolete"] } });
  assert.deepEqual(index.topics, []);
});

test("注釈付き依頼では現在の要求を索引と検索語に使い、注入を再保存しない", async () => {
  const text = '# Response annotations:\n<response-annotations>[{"text":"古い引用","annotation":"対応して"}]</response-annotations>\n## My request:\nKirihaの選択解除を整理して';
  const clean = cleanUserRequest(text);
  const index = buildMemoryIndex({ request: clean });
  assert.equal(index.description, "Kirihaの選択解除を整理して");
  assert.equal(cleanUserRequest("<supermemory-index>PRIVATE_INDEX</supermemory-index>\n新しい要求"), "新しい要求");
  let query;
  await runHook("UserPromptSubmit", { prompt: text }, { settings, context, request: withDiscovery(async (_path, { body }) => { query = body.q; return { results: [] }; }) });
  assert.equal(query, "Kirihaの選択解除を整理して");
});

test("includeProfile trueも事実プロフィールを呼ばず検索空間の索引を返す", async () => {
  const result = await callTool("search_memory", { query: "Kiriha", includeProfile: true }, { settings, context,
    request: withDiscovery(async (path) => { assert.equal(path, "/v4/search"); return { results: [] }; }) });
  assert.deepEqual(result.structuredContent.profile, { type: "space-index", containers: context.readTags });
});

test("MCPツールはスキーマ外の値をAPIへ送信しない", async () => {
  let calls = 0;
  const request = async () => { calls += 1; throw new Error("must not call API"); };
  const invalidCalls = [
    ["search_memory", { query: " " }],
    ["search_memory", { query: "topic", containerTag: " " }],
    ["add_memory", { content: "value", action: "remove" }],
    ["add_memory", { content: "" }],
    ["listDocuments", { page: 0 }],
    ["listMemories", { limit: 51 }],
    ["listDocuments", { topic: " " }],
    ["listTopics", { limit: 101 }],
    ["getDocument", { documentId: " " }],
  ];
  for (const [name, args] of invalidCalls) {
    await assert.rejects(callTool(name, args, { settings, context, request }));
  }
  assert.equal(calls, 0);
});

test("一覧は全文を返さず詳細IDを返す", async () => {
  for (const name of ["listDocuments", "listMemories"]) {
    const result = await callTool(name, {}, { settings, context, request: async () => ({ documents: [row()], pagination: { currentPage: 1 } }) });
    assert.doesNotMatch(JSON.stringify(result), /DETAIL_ONLY/);
    assert.match(JSON.stringify(result), /doc-1/);
  }
});

test("文書一覧は既定で全spaceを横断し、topicと物理containerを独立して絞り込む", async () => {
  const calls = [];
  const request = async (path, { body }) => {
    calls.push([path, body]);
    return { documents: [{ ...row("topic-doc", "legacy-space"), topics: ["Cloudflare D1"], metadata: {
      ...row().metadata,
      project: "memory-service",
      sm_project_id: "repo_memory_service__1234",
    } }], pagination: { currentPage: 1 } };
  };
  const all = await listIndex({ topic: "Cloudflare D1", request });
  const limited = await listIndex({ containerTag: "memories", topic: "__unclassified__", page: 2, limit: 5, request });
  assert.deepEqual(calls, [
    ["/v3/documents/list", { page: 1, limit: 10, topic: "Cloudflare D1" }],
    ["/v3/documents/list", { page: 2, limit: 5, containerTag: "memories", topic: "__unclassified__" }],
  ]);
  assert.equal(all.listScope, "all-containers");
  assert.equal(all.containerTag, null);
  assert.deepEqual(all.documents[0].topics, ["Cloudflare D1"]);
  assert.deepEqual(all.documents[0].provenance, {
    containerTag: "legacy-space",
    projectId: "repo_memory_service__1234",
    project: "memory-service",
    filepath: undefined,
  });
  assert.equal(limited.listScope, "explicit-container");
});

test("統一した読取り空間には保存canonicalと明示された共有空間が含まれる", () => {
  const result = getReadContext(process.cwd(), { sharedContainerTags: ["explicit-shared"], readContainerTags: ["explicit-project"] });
  assert.ok(result.projectTags.includes(result.containerTag));
  assert.ok(result.projectTags.includes("explicit-project"));
  assert.ok(result.sharedTags.includes("explicit-shared"));
  assert.equal(new Set(result.readTags).size, result.readTags.length);
});

test("共有文書の索引見出しに一致した話題は本文を注入せず発見できる", async () => {
  const entry = row("timeout", "shared", { metadata: { memoryIndex: buildMemoryIndex({ title: "Supermemoryの接続調査", request: "設定を確認して", response: "## AbortSignal のタイムアウト\nDETAIL_ONLY" }) } });
  const result = await runHook("UserPromptSubmit", { prompt: "AbortSignal のタイムアウトを調べて" }, { settings, context,
    request: withDiscovery(async (_path, { body }) => ({ results: body.containerTag === "shared" ? [entry] : [] })) });
  assert.match(result.hookSpecificOutput.additionalContext, /id=timeout/);
  assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /DETAIL_ONLY/);
});

test("旧文書の抜粋に別話題が混じっていても原文の該当見出しから索引を作る", async () => {
  const entry = row("old-section", "shared", { metadata: {}, content: "前の無関係な課金設定の段落だけが検索抜粋へ入った" });
  const original = { ...entry, title: "Memory 01234567", content: "updated_at: 2026-09-09T02:11:00+00:00\n# 課金\n無関係な課金設定\n# Kiriha\nブックマークの選択解除\n## 詳細\nDETAIL_ONLY" };
  const result = await searchIndex({ query: "Kiriha", settings, context, request: withDiscovery(async (path) => path === "/v4/search" ? { results: [entry] } : original) });
  assert.equal(result.results[0].title, "Kiriha");
  assert.equal(result.results[0].description, "ブックマークの選択解除");
  assert.equal(result.results[0].sourceUpdatedAt, "2026-09-09T02:11:00+00:00");
  assert.doesNotMatch(JSON.stringify(result.results), /課金|DETAIL_ONLY/);
});

test("短い継続依頼でも実質的な結果がある文書は索引に残す", () => {
  const index = buildMemoryIndex({ title: "接続経路の改善", request: "続けて", response: "## タイムアウトの修正\n既存の経路を変更。\n## 検証\nテスト結果を記載。" });
  assert.equal(index.recallable, true);
  assert.match(index.description, /継続結果/);
  assert.ok(index.sections.includes("タイムアウトの修正"));
});
