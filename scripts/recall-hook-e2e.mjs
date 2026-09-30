// 実hookプロセスとローカルHTTP APIを接続する再現用E2E。秘密・外部APIは使わない。
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length > 2 && (process.argv[2] !== "--runtime-root" || process.argv.length !== 4)) {
  throw new Error("Usage: node scripts/recall-hook-e2e.mjs [--runtime-root plugin-directory]");
}
const runtimeRoot = process.argv[3] ? resolve(process.argv[3]) : root;
const temporary = await mkdtemp(join(tmpdir(), "kagayoi-recall-e2e-"));
const artifact = join(root, "dist", runtimeRoot === root ? "recall-hook-validation.json" : "recall-hook-installed-validation.json");
const checks = [];
// 失敗条件: 重複注入、更新/compact見逃し、出力超過、Git/API過剰呼出し、子の停止漏れ、fixtureの認証漏れ。
const children = new Set();
const configuredKey = "local-fixture-key";
let revision = "2026-09-30T00:00:00.000Z";
let failure = false;
let huge = false;
let empty = false;
let fixtureRows = null;
let lastSearchQuery = "";
let report;
let requests = 0;
const rows = () => fixtureRows || Array.from({ length: huge ? 5 : 1 }, (_, index) => ({
  id: `doc-${index}`, containerTag: "fixture-space", updatedAt: revision, createdAt: "2026-09-01T00:00:00.000Z",
  topics: huge ? Array.from({ length: 500 }, (_, topic) => `Chrome-${topic}-${"&".repeat(100)}`) : ["Chrome"],
  metadata: { project: "fixture-project", memoryIndex: { version: 1, title: "Chrome extension history", description: "Chrome extension implementation", sections: [], recallable: true } },
}));
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${configuredKey}`) {
    response.writeHead(401); response.end(); return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  if (body && request.url === "/v4/search") lastSearchQuery = JSON.parse(body).q;
  requests += 1;
  response.writeHead(failure ? 503 : 200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(failure ? { error: "fixture unavailable" } : {
    searchScope: "all-containers", searchedContainers: ["fixture-space"], spaceDiscoveryComplete: true,
    spaces: [{ containerTag: "fixture-space", memoryCount: 5 }], results: empty ? [] : rows(),
  }));
});
const environment = { ...process.env, CODEX_HOME: temporary,
  KAGAYOI_MEMORY_API_KEY: configuredKey };
const transcript = join(temporary, "rollout.jsonl");
const payload = { prompt: "Chrome extension implementation", cwd: root, session_id: "fixture-session", transcript_path: transcript };
const count = (output) => output.hookSpecificOutput?.additionalContext?.length || 0;
async function hook(input = payload, event = "UserPromptSubmit") {
  const args = [join(runtimeRoot, "scripts", "hook-launcher.mjs"), event];
  return await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let output = "", errors = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20_000);
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => errors += chunk);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout); children.delete(child);
      if (timedOut || code !== 0) { reject(new Error(timedOut ? "hook exceeded 20 seconds and was stopped" : `hook exit ${code}: ${errors}`)); return; }
      try { done(output ? JSON.parse(output) : {}); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
async function check(name, operation) {
  const detail = await operation();
  checks.push({ name, passed: true, ...detail });
}
try {
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  environment.KAGAYOI_MEMORY_API_URL = `http://127.0.0.1:${server.address().port}`;
  await writeFile(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "fixture-session" } })}\n`);
  await check("duplicate injection suppression", async () => {
    const after = [count(await hook()), count(await hook())];
    assert.ok(after[0]); assert.equal(after[1], 0);
    return { characters: after };
  });
  await check("document update date", async () => {
    revision = "2026-09-30T01:00:00.000Z";
    assert.ok(count(await hook())); assert.equal(count(await hook()), 0);
  });
  await check("session start and topic-less requests avoid Git discovery", async () => {
    const trace = join(temporary, "git-activity.log");
    environment.GIT_TRACE = trace;
    try {
      await writeFile(trace, "");
      const requestsBefore = requests;
      await hook(payload, "SessionStart");
      await hook({ ...payload, prompt: "修正して最適化してください" });
      const after = (await readFile(trace, "utf8")).match(/built-in: git/gu)?.length || 0;
      assert.equal(after, 0); assert.equal(requests, requestsBefore);
      return { gitProcesses: after, apiRequests: requests - requestsBefore };
    } finally { delete environment.GIT_TRACE; }
  });
  await check("project identifier excludes account, action and partial-word noise", async () => {
    const row = (id, title, description, searchExcerpt) => ({ id, containerTag: "other-folder-space", updatedAt: revision, semanticSimilarity: 0.99,
      metadata: { memoryIndex: { version: 1, title, description, sections: [], recallable: true } }, ...(searchExcerpt ? { searchExcerpt } : {}) });
    fixtureRows = [row("wanted-memory", "Kagayoi Memory", "索引の読込"),
      row("support-noise", "Kagayoi.Support", String.raw`C:\Users\IMT\dev\Kagayoi.Support`),
      row("invoice-noise", "請求書", "修正してください"), row("release-noise", "Release", "Developer release"),
      row("excerpt-noise", "Other task", "別の話題", String.raw`C:\Users\IMT\dev\Other を修正してください`)];
    try {
      const prompt = String.raw`"C:\Users\IMT\dev\kagayoi-memory" メモリー機能側で修正で最適化が出来そうな部分が発見できていたら修正してください`;
      const input = { ...payload, prompt, session_id: "topic-noise-session" };
      const after = await hook(input);
      const text = after.hookSpecificOutput.additionalContext;
      assert.match(text, /id=wanted-memory/u);
      assert.doesNotMatch(text, /id=(?:support|invoice|release|excerpt)-noise/u);
      assert.doesNotMatch(lastSearchQuery, /Users|IMT|\bdev\b/u);
      assert.match(lastSearchQuery, /kagayoi-memory/u);
      return { indexItems: (text.match(/\n  id=/gu) || []).length, characters: count(after), crossFolderMatch: true };
    } finally { fixtureRows = null; }
  });
  await check("POSIX, UNC and nested file paths preserve their project identifier", async () => {
    fixtureRows = [{ id: "wanted-path", containerTag: "other-folder-space", updatedAt: revision,
      metadata: { memoryIndex: { version: 1, title: "Kagayoi Memory", description: "索引の読込", sections: [], recallable: true } } },
      { id: "unrelated-readme", containerTag: "other-project", updatedAt: revision,
        metadata: { memoryIndex: { version: 1, title: "README.md", description: "Documentation", sections: [], recallable: true } } }];
    try {
      for (const [session_id, path] of [["posix-path", '"/Users/IMT/dev/kagayoi-memory"'], ["unc-path", String.raw`"\\server\share\kagayoi-memory"`],
        ["windows-file", String.raw`"C:\Users\IMT\dev\kagayoi-memory\README.md"`],
        ["nested-file", String.raw`C:\Users\IMT\dev\kagayoi-memory\client\memory-client.mjs`],
        ["home-file", '"/home/imt/projects/kagayoi-memory/client/memory-client.mjs"']]) {
        const output = await hook({ ...payload, session_id, prompt: `${path} を最適化してください` });
        assert.match(output.hookSpecificOutput.additionalContext, /id=wanted-path/u);
        assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /id=unrelated-readme/u);
        assert.doesNotMatch(lastSearchQuery, /Users|IMT|server|share/u);
      }
    } finally { fixtureRows = null; }
  });
  await check("dotted directory names outside known workspaces remain intact", async () => {
    fixtureRows = [{ id: "wanted-support", containerTag: "other-folder-space", updatedAt: revision,
      metadata: { memoryIndex: { version: 1, title: "Kagayoi.Support", description: "Support service", sections: [], recallable: true } } },
      { id: "unrelated-code", containerTag: "other-project", updatedAt: revision,
        metadata: { memoryIndex: { version: 1, title: "Code", description: "Code samples", sections: [], recallable: true } } }];
    try {
      for (const [session_id, path] of [["dotted-directory", String.raw`"C:\Code\Kagayoi.Support"`],
        ["dotted-trailing", String.raw`"C:\Code\Kagayoi.Support\"`], ["dotted-posix", '"/opt/Kagayoi.Support"']]) {
        const output = await hook({ ...payload, session_id, prompt: `${path} を最適化してください` });
        assert.match(output.hookSpecificOutput.additionalContext, /id=wanted-support/u);
        assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /id=unrelated-code/u);
        assert.match(lastSearchQuery, /Kagayoi\.Support/u);
      }
    } finally { fixtureRows = null; }
  });
  await check("different session and unknown session", async () => {
    assert.ok(count(await hook({ ...payload, session_id: "other-session" })));
    for (let turn = 0; turn < 2; turn++) assert.ok(count(await hook({ ...payload, session_id: undefined })));
  });
  await check("transcript compaction and SessionStart compact", async () => {
    await appendFile(transcript, `${JSON.stringify({ type: "compacted", payload: { message: "fixture" } })}\n`);
    assert.ok(count(await hook())); assert.equal(count(await hook()), 0);
    assert.deepEqual(await hook({ ...payload, source: "compact" }, "SessionStart"), {});
    assert.ok(count(await hook())); assert.equal(count(await hook()), 0);
    await appendFile(transcript, `${JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } })}\n`);
    assert.ok(count(await hook()));
  });
  const stateDirectory = join(temporary, "kagayoi-memory", "recall-state");
  const stateFile = join(stateDirectory, `${createHash("sha256").update(payload.session_id).digest("hex")}.json`);
  await check("large complete compaction row resets without a following event", async () => {
    assert.equal(count(await hook()), 0);
    await appendFile(transcript, `${JSON.stringify({ type: "compacted", payload: { message: "x".repeat(200 * 1024) } })}\n`);
    assert.ok(count(await hook())); assert.equal(count(await hook()), 0);
  });
  await check("incomplete transcript row persists no conversation text", async () => {
    const marker = "private-fixture-do-not-copy-秘密";
    const row = JSON.stringify({ type: "compacted", payload: { message: `${marker}${"x".repeat(200 * 1024)}` } });
    const start = (await readFile(transcript)).length;
    await appendFile(transcript, row.slice(0, 200));
    assert.ok(count(await hook()));
    const saved = await readFile(stateFile, "utf8");
    assert.ok(!saved.includes(marker)); assert.ok(!saved.includes("remainder"));
    assert.equal(JSON.parse(saved).offset, start);
    await appendFile(transcript, `${row.slice(200)}\n`);
    assert.ok(count(await hook())); assert.equal(count(await hook()), 0);
  });
  await check("missing transcript retains recall on every prompt", async () => {
    const input = { ...payload, session_id: "no-transcript-session", transcript_path: undefined };
    assert.ok(count(await hook(input))); assert.ok(count(await hook(input)));
    assert.deepEqual(await hook({ ...input, source: "compact" }, "SessionStart"), {});
    assert.ok(count(await hook(input)));
    const path = join(stateDirectory, `${createHash("sha256").update(input.session_id).digest("hex")}.json`);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  });
  await check("corrupt state and unreadable transcript fail open", async () => {
    await writeFile(stateFile, "broken fixture");
    assert.ok(count(await hook()));
    assert.ok(count(await hook({ ...payload, transcript_path: join(temporary, "missing.jsonl") })));
    await rm(stateFile);
  });
  await check("unwritable state path fail open", async () => {
    await rm(stateDirectory, { recursive: true }); await writeFile(stateDirectory, "fixture file blocks directory");
    assert.ok(count(await hook())); assert.ok(count(await hook()));
    await rm(stateDirectory);
  });
  await check("API failure remains visible and does not mark seen", async () => {
    failure = true; assert.ok((await hook()).systemMessage); failure = false;
    assert.ok(count(await hook()));
  });
  await check("empty results remain silent and do not mark documents seen", async () => {
    const input = { ...payload, session_id: "empty-session" };
    empty = true; assert.deepEqual(await hook(input), {}); empty = false;
    assert.ok(count(await hook(input))); assert.equal(count(await hook(input)), 0);
  });
  await check("concurrent hooks leave valid state", async () => {
    const input = { ...payload, session_id: "concurrent-session" };
    const output = await Promise.all([hook(input), hook(input)]);
    assert.ok(output.some((item) => count(item)));
    assert.equal(count(await hook(input)), 0);
    for (const name of await readdir(stateDirectory)) JSON.parse(await readFile(join(stateDirectory, name), "utf8"));
    return { simultaneousInjectionCount: output.filter(count).length, semantics: "concurrent calls may both recall; persisted state remains valid" };
  });
  await check("topic count and escaped output size bound", async () => {
    huge = true;
    const input = { ...payload, session_id: "large-session" };
    const output = await hook(input);
    const text = output.hookSpecificOutput.additionalContext;
    assert.ok(text.length <= 6000);
    assert.match(text, /id=doc-0/); assert.match(text, /container=fixture-space/); assert.match(text, /provenance=fixture-project/); assert.match(text, /2026-09-30/);
    assert.doesNotMatch(text, /Chrome-3-/);
    return { characters: text.length, maximumCharacters: 6000, fixtureTopicCharacters: rows()[0].topics.join("").length };
  });
  await check("large transcript gap resets safely and next prompt deduplicates", async () => {
    huge = false;
    await appendFile(transcript, `${"x".repeat(1100 * 1024)}\n${JSON.stringify({ type: "compacted" })}\n`);
    assert.ok(count(await hook())); assert.equal(count(await hook()), 0);
  });
  await check("unknown launcher event remains a no-op", async () => {
    const before = requests;
    assert.deepEqual(await hook(payload, "UnknownEvent"), {});
    assert.equal(requests, before);
  });
  report = { command: `node scripts/recall-hook-e2e.mjs${runtimeRoot === root ? "" : ` --runtime-root ${JSON.stringify(runtimeRoot)}`}`, runtimeRoot, checks, requests, fixture: "local HTTP API + real hook subprocess; no remote memory", temporary, temporaryRemoved: false };
} finally {
  await Promise.all([...children].map((child) => new Promise((done) => { child.once("close", done); child.kill("SIGKILL"); })));
  await new Promise((done) => server.close(done));
  // mkdtempが今回作った専用ディレクトリだけを清掃する。
  assert.ok(temporary.startsWith(join(tmpdir(), "kagayoi-recall-e2e-")));
  if (process.platform === "win32") execFileSync("pwsh", ["-NoProfile", "-Command", `
    $target = [IO.Path]::GetFullPath($env:KAGAYOI_RECALL_E2E_TEMP)
    $base = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -notmatch '^kagayoi-recall-e2e-[A-Za-z0-9]{6}$') { throw 'Unexpected temporary target' }
    $resolved = (Resolve-Path -LiteralPath $target -ErrorAction Stop).Path
    if ($resolved -ne $target) { throw 'Temporary target changed' }
    $items = @((Get-Item -LiteralPath $resolved -Force)) + @(Get-ChildItem -LiteralPath $resolved -Recurse -Force)
    if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Linked temporary item' }
    if (Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($resolved) }) { throw 'Temporary target is still in use' }
    Remove-Item -LiteralPath $resolved -Recurse -ErrorAction Stop
    if (Test-Path -LiteralPath $resolved) { throw 'Temporary target remains' }
  `], { env: { ...process.env, KAGAYOI_RECALL_E2E_TEMP: temporary }, windowsHide: true, stdio: "pipe" });
  else {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    async function verify(path) {
      const item = await lstat(path);
      assert.ok(!item.isSymbolicLink(), "Linked temporary item");
      if (item.isDirectory()) for (const name of await readdir(path)) await verify(join(path, name));
    }
    await verify(temporary);
    await rm(temporary, { recursive: true });
    await assert.rejects(lstat(temporary), { code: "ENOENT" });
  }
}
report.temporaryRemoved = true;
report.pendingChildren = children.size;
await mkdir(dirname(artifact), { recursive: true });
await writeFile(artifact, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify({ passed: checks.length, artifact })}\n`);
