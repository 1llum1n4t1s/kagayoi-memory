import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanUserRequest, parseTaskTranscript, buildTurnDocuments, readSessionMeta, getProjectContext } from "./Import-CodexSupermemoryHistory.mjs";
import { capture, findTranscript } from "./capture.mjs";

const user = (text, timestamp) => ({ ...(timestamp ? { timestamp } : {}), type: "response_item", payload: { role: "user", content: [{ type: "input_text", text }] } });
const assistant = (text, channel = "final", timestamp) => ({ ...(timestamp ? { timestamp } : {}), type: "response_item", payload: { role: "assistant", channel, content: [{ type: "output_text", text }] } });
function fixture(t, rows = []) {
  const home = mkdtempSync(join(tmpdir(), "memory-capture-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, "sessions", "2020", "01", "01");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "rollout-task-a.jsonl");
  const meta = { id: "task-a", session_id: "task-a", cwd: home };
  writeFileSync(path, [ { type: "session_meta", payload: meta }, ...rows ].map(JSON.stringify).join("\n") + "\n");
  writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ id: "task-a", thread_name: "保存テスト" }) + "\n");
  return { home, path, meta, payload: { session_id: "task-a", transcript_path: path },
    options: { codexHome: home, config: { baseUrl: "https://example.invalid", apiKey: "test-only-secret" } } };
}

test("自動注入文を除き、同じメッセージ内の実要求は保持する", () => {
  assert.equal(cleanUserRequest("# AGENTS.md instructions\n\n<INSTRUCTIONS>legacy rules</INSTRUCTIONS>"), "");
  assert.equal(cleanUserRequest("# AGENTS.md instructions for C:\\test\n<INSTRUCTIONS>rules</INSTRUCTIONS>"), "");
  assert.equal(cleanUserRequest("<recommended_plugins>plugins</recommended_plugins>\n# AGENTS.md instructions for C:\\test\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n<environment_context>env</environment_context>"), "");
  for (const tag of ["recommended_plugins", "environment_context", "codex_internal_context", "supermemory-context", "supermemory-recall", "supermemory-index"]) {
    assert.equal(cleanUserRequest(`<${tag}>injected\nnoise</${tag}>\n直して`), "直して");
  }
  assert.equal(cleanUserRequest("## Referenced chats with Codex:\nwrapper\n## My request:\nタスクを探して"), "タスクを探して");
  assert.equal(cleanUserRequest("AGENTS.md の手順を直して"), "AGENTS.md の手順を直して");
});

test("response annotationは利用者のコメントと参照箇所だけを依頼として保持する", () => {
  const source = {
    messageId: "internal-message-id",
    startOffset: 10,
    endOffset: 20,
  };
  const annotations = JSON.stringify([
    { text: "以前の回答", annotation: "この方針で対応してください。", source },
    { text: "別の回答", annotation: "Codex公式メモリは見ないでください。", source },
  ]);
  const cleaned = cleanUserRequest(`# Response annotations:\n自動案内と内部metadata\n<response-annotations>${annotations}</response-annotations>\n\n## My request:\n保存情報も整理してください。`);
  assert.equal(cleaned, [
    "### Feedback on earlier response 1\n\nReferenced assistant response:\n以前の回答\n\nUser comment:\nこの方針で対応してください。",
    "### Feedback on earlier response 2\n\nReferenced assistant response:\n別の回答\n\nUser comment:\nCodex公式メモリは見ないでください。",
    "### Current user request\n保存情報も整理してください。",
  ].join("\n\n"));
  assert.doesNotMatch(cleaned, /messageId|startOffset|endOffset|自動案内と内部metadata/);
  assert.equal(cleanUserRequest(`<supermemory-recall><response-annotations>${annotations}</response-annotations></supermemory-recall>\n直して`), "直して");
  assert.equal(cleanUserRequest("# Response annotations:\n案内\n<response-annotations>{invalid}</response-annotations>\n## My request:\n本文だけ"), "本文だけ");
});

test("完了応答のみ抽出し、ツール・分析・進捗・未完了要求・秘密値を保存しない", async (t) => {
  const f = fixture(t, [user("<environment_context>noise</environment_context>"), user("依頼 test-only-secret"),
    assistant("analysis", "analysis"), assistant("progress", "commentary"),
    { type: "response_item", payload: { type: "function_call_output", output: "secret output" } },
    assistant("完了 <private>private detail</private>"), user("未完了"), assistant("working", "commentary")]);
  const parsed = await parseTaskTranscript(f.path, ["test-only-secret"]);
  assert.deepEqual(parsed.turns, [{ user: "依頼 [REDACTED]", assistant: "完了 [REDACTED]" }]);
});

test("旧形式の重複イベントを一つにまとめる", async (t) => {
  const f = fixture(t, [{ type: "event_msg", payload: { type: "user_message", message: "依頼" } }, user("依頼"),
    { type: "event_msg", payload: { type: "assistant_output_text", text: "完了" } }, assistant("完了")]);
  assert.equal((await parseTaskTranscript(f.path, [])).turns.length, 1);
});

test("実機のphase形式で進捗を完了応答と誤認しない", async (t) => {
  const progress = assistant("進捗");
  delete progress.payload.channel;
  progress.payload.phase = "commentary";
  const final = assistant("完了");
  delete final.payload.channel;
  final.payload.phase = "final_answer";
  const f = fixture(t, [user("完了した依頼"), final, user("実行中の依頼"), progress]);
  assert.deepEqual((await parseTaskTranscript(f.path, [])).turns, [{ user: "完了した依頼", assistant: "完了" }]);
});

test("turnの原文イベント時刻をmetadataへ保持するが文書IDには含めない", async (t) => {
  const sourceTimestamp = "2026-09-11T01:02:03.456Z";
  const f = fixture(t, [user("依頼", sourceTimestamp), assistant("完了", "final", "2026-09-11T01:03:04.567Z")]);
  const transcript = await parseTaskTranscript(f.path, []);
  assert.deepEqual(transcript.turns, [{ user: "依頼", assistant: "完了", sourceTimestamp }]);
  const project = getProjectContext(f.home);
  const [document] = buildTurnDocuments({ meta: f.meta }, transcript, project, "タイトル");
  const [withoutTimestamp] = buildTurnDocuments({ meta: f.meta }, { turns: [{ user: "依頼", assistant: "完了" }] }, project, "タイトル");
  assert.equal(document.metadata.sourceTimestamp, sourceTimestamp);
  assert.deepEqual(document.metadata.memoryIndex, {
    version: 1,
    title: "タイトル",
    description: "依頼",
    sections: [],
    recallable: true,
    sourceKind: "conversation",
    sourceUpdatedAt: sourceTimestamp,
  });
  assert.equal(document.customId, withoutTimestamp.customId);
  assert.equal(document.metadata.captureKey, withoutTimestamp.metadata.captureKey);
});

test("assistant回答を索引上の確認済み事実へ昇格しない", () => {
  const transcript = { turns: [{ user: "保存内容を整理して", assistant: "接続は確認済みです。" }] };
  const project = { projectName: "project", containerTag: "repo_project" };
  const [document] = buildTurnDocuments({ meta: { id: "task", rootSessionId: "task", isSubagent: false } }, transcript, project, "記憶の整理");
  assert.equal(document.metadata.memoryIndex.description, "保存内容を整理して");
  assert.doesNotMatch(JSON.stringify(document.metadata.memoryIndex), /確認済み|verified|evidence/i);
  assert.match(document.content, /接続は確認済みです。/);
});

test("作業中の補足要求と、別ターンで繰り返された同じ要求を失わない", async (t) => {
  const f = fixture(t, [user("直して"), assistant("確認中", "commentary"), user("Safariです"),
    assistant("修正済み"), user("直して"), assistant("再修正済み")]);
  assert.deepEqual((await parseTaskTranscript(f.path, [])).turns, [
    { user: "直して\n\nSafariです", assistant: "修正済み" },
    { user: "直して", assistant: "再修正済み" },
  ]);
});

test("別ターンを追加しても前の文書は保持され、再実行は送信しない", async (t) => {
  const f = fixture(t, [user("最初の依頼"), assistant("最初の結果")]);
  const remote = new Map();
  let calls = 0;
  const options = { ...f.options, send: async (doc) => { calls++; remote.set(doc.customId, doc); return { id: doc.customId }; } };
  assert.equal((await capture(f.payload, options)).saved, 1);
  const original = [...remote.values()][0];
  appendFileSync(f.path, [user("次の依頼"), assistant("次の結果")].map(JSON.stringify).join("\n") + "\n");
  assert.equal((await capture(f.payload, options)).saved, 1);
  assert.equal((await capture(f.payload, options)).saved, 0);
  assert.equal(calls, 2);
  assert.equal(remote.size, 2);
  assert.deepEqual(remote.get(original.customId), original);
  assert.equal(original.metadata.title, "保存テスト");
  assert.equal(original.metadata.sessionId, "task-a");
  assert.equal(original.metadata.sm_scope, "project");
});

test("通信結果不明の再送は同じIDで、未確認文書を既送にしない", async (t) => {
  const f = fixture(t, [user("依頼"), assistant("結果")]);
  const ids = [];
  const options = { ...f.options, send: async (doc) => { ids.push(doc.customId); throw new Error("lost response"); } };
  await assert.rejects(capture(f.payload, options), /lost response/);
  options.send = async (doc) => { ids.push(doc.customId); return { id: "stored" }; };
  assert.equal((await capture(f.payload, options)).saved, 1);
  assert.equal(ids[0], ids[1]);
});

test("APIが成功を確認しない応答では再試行できる", async (t) => {
  const f = fixture(t, [user("依頼"), assistant("結果")]);
  await assert.rejects(capture(f.payload, { ...f.options, send: async () => ({ error: "failed" }) }), /acknowledge/);
  assert.equal((await capture(f.payload, { ...f.options, send: async () => ({ id: "ok" }) })).saved, 1);
});

test("途中失敗後は成功分を保持して残りを送る", async (t) => {
  const f = fixture(t, [user("一"), assistant("結果一"), user("二"), assistant("結果二")]);
  let count = 0;
  await assert.rejects(capture(f.payload, { ...f.options, send: async () => {
    if (++count === 2) throw new Error("offline"); return { id: "first" };
  } }), /offline/);
  const remaining = [];
  await capture(f.payload, { ...f.options, send: async (doc) => { remaining.push(doc); return { id: "second" }; } });
  assert.equal(remaining.length, 1);
  assert.match(remaining[0].content, /結果二/);
});

test("同じタスクの保存が並行してもv2レシートを失わず次回は再送しない", async (t) => {
  const f = fixture(t, [user("一"), assistant("結果一"), user("二"), assistant("結果二")]);
  const sent = [];
  const gate = [];
  const send = async (document) => {
    sent.push(document);
    if (sent.length <= 2) await new Promise((resolve) => gate.push(resolve));
    return { id: document.customId };
  };
  const first = capture(f.payload, { ...f.options, send });
  const second = capture(f.payload, { ...f.options, send });
  while (gate.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  gate.splice(0).forEach((release) => release());
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.saved), [2, 2]);
  assert.ok(sent.every((document) => document.customId.startsWith("codex-turn-v2:")));
  const stateDirectory = join(f.home, "cloudflare-memory", "capture-state");
  const receiptFiles = readdirSync(stateDirectory).filter((name) => name.endsWith(".json"));
  assert.equal(receiptFiles.length, 1);
  const receipts = JSON.parse(readFileSync(join(stateDirectory, receiptFiles[0]), "utf8"));
  assert.deepEqual(receipts, [...new Set(sent.map((document) => document.customId))].sort());
  let retried = 0;
  const retry = await capture(f.payload, { ...f.options, send: async () => { retried++; return { id: "unexpected" }; } });
  assert.deepEqual(retry, { saved: 0, pending: 0, completedTurns: 2 });
  assert.equal(retried, 0);
});

test("古い日付の継続タスクを探索し、別タスクの明示パスを拒否する", async (t) => {
  const f = fixture(t);
  assert.equal((await findTranscript({ session_id: "task-a" }, f.home)).filePath, f.path);
  await assert.rejects(findTranscript({ ...f.payload, session_id: "task-b" }, f.home), /mismatch/);
});

test("session_idのない履歴も自身のidを親タスクIDとして読める", async (t) => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ type: "session_meta", payload: { id: "old-task", cwd: f.home } }) + "\n");
  const meta = await readSessionMeta(f.path);
  assert.equal(meta.rootSessionId, "old-task");
  assert.equal(meta.isSubagent, false);
});

test("自動保存と復元は同じIDを使い、分割しても本文を欠落させない", async (t) => {
  const f = fixture(t, [user("依頼"), assistant("長い結果".repeat(4000))]);
  const transcript = await parseTaskTranscript(f.path, []);
  const docs = buildTurnDocuments({ meta: f.meta }, transcript, getProjectContext(f.home), "タイトル", 10000);
  assert.ok(docs.length > 1);
  assert.ok(docs.every((doc) => doc.content.length <= 10000));
  assert.deepEqual(docs, buildTurnDocuments({ meta: f.meta }, transcript, getProjectContext(f.home), "タイトル", 10000));
  const body = docs.map((doc) => doc.content.slice(doc.content.indexOf("\n\n", doc.content.indexOf("Part:")) + 2)).join("");
  assert.equal(body, `### User request\n依頼\n\n### Final assistant response\n${"長い結果".repeat(4000)}`);
  const largerParts = buildTurnDocuments({ meta: f.meta }, transcript, getProjectContext(f.home), "タイトル", 12000);
  assert.notEqual(docs[0].customId, largerParts[0].customId);
});

test("時間枠を超えた未送信分を明示して次回へ残す", async (t) => {
  const f = fixture(t, [user("依頼"), assistant("結果")]);
  const result = await capture(f.payload, { ...f.options, budgetMs: 0, send: async () => assert.fail("must not send") });
  assert.deepEqual(result, { saved: 0, pending: 1, completedTurns: 1 });
});
