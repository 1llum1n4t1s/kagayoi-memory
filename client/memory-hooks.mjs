import { readFileSync } from "node:fs";
import { cleanUserRequest } from "./Import-CodexSupermemoryHistory.mjs";
import { readSettings, getReadContext, searchIndex, queryTerms, api } from "./memory-client.mjs";
import { formatIndexItem } from "./memory-index.mjs";

export async function runHook(event, payload, { settings = readSettings(), request, context } = {}) {
  if (settings.recallMode === "off") return {};
  const cwd = payload.cwd || process.cwd();
  context ||= getReadContext(cwd, settings);
  const query = event === "SessionStart" ? "" : cleanUserRequest(payload.prompt || payload.input || "").split("### Current user request\n").at(-1).trim().slice(0, 1_000);
  if (event === "SessionStart") return {};
  if (event !== "SessionStart" && (!query || !queryTerms(query).length || /^[!/]/.test(query))) return {};
  const deadline = Date.now() + 9_000;
  request ||= (path, options = {}) => api(path, { ...options, timeoutMs: Math.max(1, Math.min(4_000, deadline - Date.now())) });
  try {
    const result = await searchIndex({ query, context, settings, request, automatic: true });
    if (!result.results.length) {
      return result.failedContainers.length || result.failedDocuments.length || result.spaceDiscoveryComplete === false ? { systemMessage: "◪ Supermemory のトピック索引検索は一部の保存先を取得できませんでした。" } : {};
    }
    const additionalContext = `<supermemory-index>\nHistorical document index from a folder-independent topic search across Supermemory. The container tag records where each document came from.\n${result.results.map(formatIndexItem).join("\n")}\n\nWhen an entry appears applicable, call supermemory getDocument with its id, validate the prior implementation against the current code and requirements, and reuse the parts that still fit. Use search_memory for another topic; its default scope is every nonempty space discovered by the API. Preserve source dates and container provenance.\n${result.failedContainers.length ? `Partial search: ${result.failedContainers.length} spaces unavailable.\n` : ""}${result.spaceDiscoveryComplete === false ? "Space discovery reached the API's 100-space limit; additional spaces may exist.\n" : ""}</supermemory-index>`;
    return { hookSpecificOutput: { hookEventName: event, additionalContext } };
  } catch (error) {
    const discoveryFailure = error instanceof Error && error.message.includes("space discovery");
    return { systemMessage: discoveryFailure
      ? "◪ Supermemory の保存先一覧を取得できなかったため、全フォルダ横断のトピック索引検索を実行できませんでした。"
      : "◪ Supermemory の索引を取得できませんでした。必要な履歴は検索ツールで再確認できます。" };
  }
}

export async function runFromStdin(event) {
  let payload;
  try { payload = JSON.parse(readFileSync(0, "utf8")); }
  catch { return; }
  const result = await runHook(event, payload);
  if (Object.keys(result).length) process.stdout.write(JSON.stringify(result));
}
