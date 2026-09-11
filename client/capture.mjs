#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { api, loadConfig, getProjectContext, listJsonlFiles, readSessionMeta,
  chooseCandidates, parseTaskTranscript, readTaskTitles, buildTurnDocuments, sanitizeText } from "./Import-CodexSupermemoryHistory.mjs";

export async function findTranscript(payload, codexHome) {
  if (!payload.session_id) throw new Error("Missing session ID.");
  if (payload.transcript_path && existsSync(payload.transcript_path)) {
    const meta = await readSessionMeta(payload.transcript_path);
    if (meta?.id === payload.session_id) return { filePath: payload.transcript_path, meta };
    throw new Error("Transcript session ID mismatch.");
  }
  // 古い日付の継続タスクも対象にし、ファイル名の部分一致だけでは採用しない。
  const files = ["sessions", "archived_sessions"].flatMap((name) => listJsonlFiles(join(codexHome, name)))
    .filter((path) => path.includes(payload.session_id));
  const { candidates } = await chooseCandidates(files, false);
  const candidate = candidates.find((item) => item.meta.id === payload.session_id);
  if (!candidate) throw new Error("Session transcript was not found.");
  return candidate;
}

function readReceipts(statePath) {
  if (!existsSync(statePath)) return new Set();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!Array.isArray(state) || state.some((receipt) => typeof receipt !== "string" || !receipt)) {
    throw new Error("Invalid capture receipts.");
  }
  return new Set(state);
}

async function acquireReceiptLock(statePath, timeoutMs = 10_000) {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, "wx");
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      return () => {
        try { closeSync(descriptor); } finally {
          try { unlinkSync(lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* best-effort cleanup */ }
        try { unlinkSync(lockPath); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
      }
      if (error?.code !== "EEXIST") throw error;
      // 終了したhookの孤児ロックだけを除去する。通常の保存はこの閾値より十分短い。
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 5 * 60_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === "ENOENT") continue;
        throw lockError;
      }
      if (Date.now() >= deadline) throw new Error("Timed out while updating capture receipts.");
      await delay(20);
    }
  }
}

async function recordReceipt(statePath, customId) {
  const release = await acquireReceiptLock(statePath);
  try {
    const receipts = readReceipts(statePath);
    receipts.add(customId);
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify([...receipts].sort()), "utf8");
      renameSync(temporary, statePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
      throw error;
    }
  } finally {
    release();
  }
}

export async function capture(payload, { codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  config, send, budgetMs = 90_000 } = {}) {
  config ||= loadConfig(codexHome);
  const candidate = await findTranscript(payload, codexHome);
  const cwd = candidate.meta.cwd || payload.cwd;
  if (!cwd) throw new Error("Missing project path.");
  const project = getProjectContext(cwd);
  const transcript = await parseTaskTranscript(candidate.filePath, [config.apiKey]);
  const titles = await readTaskTitles(codexHome);
  const title = sanitizeText(titles.get(candidate.meta.id) || "", [config.apiKey], { count: 0 });
  const documents = buildTurnDocuments(candidate, transcript, project, title);
  // 応答を確認した文書だけ記録する。中断後の再送も同じcustomIdなので上書き損失は起きない。
  const stateDirectory = join(codexHome, "cloudflare-memory", "capture-state");
  const stateId = createHash("sha256").update(`${config.baseUrl}:${project.containerTag}:${candidate.meta.id}`).digest("hex");
  const statePath = join(stateDirectory, `${stateId}.json`);
  const receipts = readReceipts(statePath);
  const pending = documents.filter((document) => !receipts.has(document.customId));
  const started = Date.now();
  let saved = 0;
  for (const document of pending) {
    if (Date.now() - started >= budgetMs) break;
    const result = await (send ? send(document) : api(config, "/v3/documents", { method: "POST", body: document }));
    if (!result || typeof result.id !== "string" || !result.id) throw new Error("Memory API did not acknowledge the document.");
    receipts.add(document.customId);
    mkdirSync(stateDirectory, { recursive: true });
    await recordReceipt(statePath, document.customId);
    saved += 1;
  }
  return { saved, pending: pending.length - saved, completedTurns: transcript.turns.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    const result = await capture(payload);
    if (result.saved || result.pending) process.stdout.write(JSON.stringify({
      systemMessage: `Supermemory: saved ${result.saved} documents; pending ${result.pending}.`,
    }));
  } catch {
    // 本文・接続設定・HTTP応答をログへ出さず、失敗は呼び出し元に通知する。
    process.stderr.write("Supermemory capture failed; unacknowledged records will be retried.\n");
    process.exitCode = 1;
  }
}
