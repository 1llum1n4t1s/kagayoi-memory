import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME, getProjectContext, loadConfig } from "./Import-KagayoiMemoryHistory.mjs";
import { documentIndex, formatIndexItem, publicIndex } from "./memory-index.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const unique = (values) => [...new Set(values.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))];
function git(args, cwd) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

export function readSettings(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  let config = {};
  try { config = JSON.parse(readFileSync(join(codexHome, CONFIG_FILE_NAME), "utf8")); }
  catch {
    try { config = JSON.parse(readFileSync(join(codexHome, LEGACY_CONFIG_FILE_NAME), "utf8")); }
    catch { /* 認証のエラーはAPI接続時に通知する。 */ }
  }
  return {
    codexHome,
    recallMode: config.recallMode || "direct",
    maxMemories: Math.max(1, Math.min(5, Number(config.maxMemories) || 5)),
    minimumSimilarity: Math.max(0.65, Math.min(0.95, Number(config.similarityThreshold) || 0.70)),
    projectContainerTag: config.projectContainerTag,
    userContainerTag: config.userContainerTag,
    readContainerTags: Array.isArray(config.readContainerTags) ? config.readContainerTags : [],
    sharedContainerTags: Array.isArray(config.sharedContainerTags) ? config.sharedContainerTags : [],
  };
}

// project由来tagは出典と旧形式空間の検索用別名として扱い、新規保存は共通containerへ集約する。
// Codex公式のmemoriesディレクトリや生成物を開く処理は持たない。
export function getReadContext(cwd = process.cwd(), settings = readSettings()) {
  const project = getProjectContext(cwd);
  const root = git(["rev-parse", "--show-toplevel"], cwd) || resolve(cwd);
  const pathHash = hash(root);
  const identity = git(["config", "user.email"], root) || process.env.USER || process.env.USERNAME || hostname();
  const userHash = hash(identity);
  const projectTags = unique([
    project.containerTag, settings.projectContainerTag,
    `user_project_${pathHash}`, `claudecode_project_${pathHash}`, `repo_${project.projectName}`,
    `codex_project_${pathHash}`, `opencode_project_${pathHash}`, `cursor_project_${pathHash}`,
    ...(settings.readContainerTags || []),
  ]);
  const sharedTags = unique([
    settings.userContainerTag, `codex_user_${userHash}`, `opencode_user_${userHash}`, `cursor_user_${userHash}`,
    ...(settings.sharedContainerTags || []),
  ]).filter((tag) => !projectTags.includes(tag));
  return { ...project, projectTags, sharedTags, readTags: unique([...projectTags, ...sharedTags]) };
}

export async function api(path, { body, method = body ? "POST" : "GET", timeoutMs = 8_000, fetchImpl = fetch, config, codexHome } = {}) {
  config ||= loadConfig(codexHome || process.env.CODEX_HOME || join(homedir(), ".codex"));
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method,
    redirect: "error",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "x-sm-source": "codex-kagayoi-memory" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Kagayoi Memory API request failed (HTTP ${response.status})`);
  return response.status === 204 ? null : response.json();
}

const STOP_WORDS = new Set(["memory", "memories", "codex", "情報", "こと", "もの", "これ", "それ", "この", "その", "あの", "どの", "ここ", "そこ", "this", "that", "ため", "よう", "です", "ます", "ください", "する", "した", "して", "れる", "ある", "いる", "確認", "対応", "作業", "実装", "調査"]);
const SEARCH_CONCURRENCY = 8;
export function queryTerms(query) {
  const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
  const words = [...segmenter.segment(query)].filter((segment) => segment.isWordLike)
    .map((segment) => ({ value: segment.segment.toLowerCase(), index: segment.index, end: segment.index + segment.segment.length }));
  const useful = words.filter(({ value }) => value.length >= 2 && !STOP_WORDS.has(value));
  const japanese = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
  const compounds = [];
  const compounded = new Set();
  for (let index = 0; index < useful.length - 1; index++) {
    const current = useful[index];
    const next = useful[index + 1];
    if (current.end !== next.index || !japanese.test(current.value) || !japanese.test(next.value)) continue;
    compounds.push(`${current.value}${next.value}`);
    compounded.add(current.value);
    compounded.add(next.value);
  }
  return unique([...useful.filter(({ value }) => !compounded.has(value)).map(({ value }) => value), ...compounds]).slice(0, 30);
}

function topicRelevance(index, terms) {
  const topic = `${index.title} ${index.description} ${(index.sections || []).join(" ")} ${(index.topics || []).join(" ")}`.toLowerCase();
  if (!terms.length) return 0;
  const matches = terms.filter((term) => topic.includes(term));
  if (!matches.length) return 0;
  return matches.reduce((total, term) => total + Math.min(12, term.length), 0) / terms.reduce((total, term) => total + Math.min(12, term.length), 0);
}

function semanticEligible(row, minimumSimilarity) {
  return typeof row.semanticSimilarity === "number" &&
    Number.isFinite(row.semanticSimilarity) && row.semanticSimilarity >= minimumSimilarity;
}

function lexicalEligible(row) {
  return typeof row.lexicalSimilarity === "number" && Number.isFinite(row.lexicalSimilarity);
}

export async function discoverSearchContainers(request = api) {
  let response;
  try {
    response = await request("/v3/container-tags");
  } catch (error) {
    throw new Error("Kagayoi Memory space discovery failed; global topic search was not performed", { cause: error });
  }
  if (!Array.isArray(response?.spaces)) throw new Error("Kagayoi Memory space discovery returned an invalid response; global topic search was not performed");
  const tags = unique(response.spaces.filter((space) => {
    if (!space || typeof space !== "object" || typeof space.containerTag !== "string") return false;
    return space.memoryCount === undefined || Number(space.memoryCount) > 0;
  }).map((space) => space.containerTag));
  return { tags, complete: response.spaces.length < 100, returnedCount: response.spaces.length };
}

async function mapConcurrent(values, concurrency, task) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await task(values[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function searchIndex({ query = "", containerTag, cwd, settings = readSettings(), context, limit = settings.maxMemories, request = api, automatic = false } = {}) {
  query = typeof query === "string" ? query.trim().slice(0, 1_000) : "";
  if (!query) return { query, containerTag: containerTag || null, searchScope: "none", searchedContainers: [], failedContainers: [], failedDocuments: [], spaceDiscoveryComplete: true, results: [], total: 0 };
  const discovery = containerTag ? { tags: [containerTag], complete: true, returnedCount: 1 } : await discoverSearchContainers(request);
  const tags = discovery.tags;
  const results = await mapConcurrent(tags, SEARCH_CONCURRENCY, async (tag) => {
    const response = await request("/v4/search", {
      body: { containerTag: tag, q: query, limit: 20, ...(automatic ? { indexOnly: true } : {}) },
    });
    if (!Array.isArray(response?.results)) throw new Error("Invalid memory search response");
    return response.results.map((row, rank) => ({ row, rank, index: documentIndex(row, tag) }));
  });
  const failedTags = tags.filter((_, i) => results[i].status === "rejected");
  if (tags.length && failedTags.length === tags.length) throw new Error("Kagayoi Memory search unavailable for all requested spaces");
  const terms = queryTerms(query);
  const rawCandidates = results.flatMap((r) => r.status === "fulfilled" ? r.value : []).filter(({ row, index }) => {
    if (!index.id || !index.containerTag) return false;
    // indexOnly応答では旧文書の本文が無いため、関連度は詳細取得後に判定する。
    if (row.metadata?.memoryIndex?.version !== 1) return true;
    const relevance = topicRelevance(index, terms);
    return semanticEligible(row, settings.minimumSimilarity) || lexicalEligible(row) || relevance > 0;
  });
  rawCandidates.sort((a, b) => topicRelevance(b.index, terms) - topicRelevance(a.index, terms) ||
    Number(b.row.semanticSimilarity ?? -1) - Number(a.row.semanticSimilarity ?? -1) || a.rank - b.rank);
  const hydrateLimit = Math.min(80, Math.max(20, Number(limit) * 8));
  const distinct = [...new Map(rawCandidates.map((c) => [`${c.index.containerTag}:${c.index.id}`, c])).values()].slice(0, hydrateLimit);
  const failedDocuments = [];
  // 旧文書の検索excerptには見出しの直前に別話題が混ざる。索引metadataが無い場合は原文を確認してから入口を作る。
  const hydratedResults = await mapConcurrent(distinct, SEARCH_CONCURRENCY, async (candidate) => {
    if (candidate.row.metadata?.memoryIndex?.version === 1) return candidate;
    try {
      const document = await request(`/v3/documents/${encodeURIComponent(candidate.index.id)}`);
      if (document?.id !== candidate.index.id || typeof document.content !== "string") throw new Error("Invalid memory document response");
      return { ...candidate, index: documentIndex(document, candidate.index.containerTag, terms) };
    } catch {
      failedDocuments.push(candidate.index.id);
      return { ...candidate, index: { ...candidate.index, title: candidate.row.metadata?.title || "保存された記録", description: "", recallable: false } };
    }
  });
  const hydrated = hydratedResults.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const eligible = hydrated.filter(({ row, index }) =>
    semanticEligible(row, settings.minimumSimilarity) || lexicalEligible(row) || topicRelevance(index, terms) > 0);
  let candidates = eligible.filter(({ index }) =>
    !automatic || index.recallable && topicRelevance(index, terms) > 0);
  if (automatic) {
    const coveredSourceIds = new Set(candidates.filter(({ index }) => index.consolidation)
      .flatMap(({ index }) => index.sourceMemoryIds));
    candidates = candidates.filter(({ index }) => index.consolidation || !coveredSourceIds.has(index.id));
  }
  candidates.sort((a, b) => {
    const topicDifference = topicRelevance(b.index, terms) - topicRelevance(a.index, terms);
    const consolidationDifference = automatic ? Number(b.index.consolidation) - Number(a.index.consolidation) : 0;
    return consolidationDifference || topicDifference || Number(b.row.semanticSimilarity ?? -1) - Number(a.row.semanticSimilarity ?? -1) || a.rank - b.rank ||
      String(b.index.consolidationCreatedAt || "").localeCompare(String(a.index.consolidationCreatedAt || "")) ||
      String(b.index.sourceUpdatedAt || b.index.updatedAt || "").localeCompare(String(a.index.sourceUpdatedAt || a.index.updatedAt || ""));
  });
  const documents = [];
  const seen = new Set();
  for (const { index } of candidates) {
    const key = `${index.containerTag}:${index.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    documents.push(index);
    if (documents.length >= Math.min(20, Math.max(1, limit))) break;
  }
  return {
    query,
    containerTag: containerTag || null,
    searchScope: containerTag ? "explicit-container" : "all-discovered-containers",
    searchedContainers: tags,
    failedContainers: failedTags,
    failedDocuments,
    spaceDiscoveryComplete: discovery.complete,
    discoveredContainerCount: discovery.returnedCount,
    results: documents,
    total: documents.length,
  };
}

export function formatSearchResult(result) {
  const text = result.results.length ? result.results.map(formatIndexItem).join("\n") : "No matching memory index entries found.";
  const failure = result.failedContainers.length || result.failedDocuments?.length ? `\nIncomplete search: ${result.failedContainers.length} spaces and ${result.failedDocuments?.length || 0} document indexes were unavailable.` : "";
  const discovery = result.spaceDiscoveryComplete === false ? "\nIncomplete space discovery: the API returned its 100-space limit, so additional spaces may exist." : "";
  return `${text}${failure}${discovery}\nWhen an entry appears applicable, read the original with getDocument(documentId), validate it against the current implementation, and reuse the parts that still fit.`;
}

export async function listIndex({ containerTag, topic, page = 1, limit = 10, request = api } = {}) {
  const body = { page, limit, projection: "index", ...(containerTag ? { containerTag } : {}), ...(topic ? { topic } : {}) };
  const result = await request("/v3/documents/list", { body });
  if (!Array.isArray(result?.documents)) throw new Error("Invalid memory document-list response");
  return {
    documents: result.documents.map((document) => publicIndex(documentIndex(document, containerTag))),
    pagination: result.pagination,
    containerTag: containerTag || null,
    topic: topic || null,
    listScope: containerTag ? "explicit-container" : "all-containers",
  };
}

function sanitizedDocumentContent(document) {
  const content = String(document.content || document.summary || "");
  const metadata = document.metadata && typeof document.metadata === "object" ? document.metadata : {};
  if (metadata.captureVersion !== 2 || typeof metadata.title !== "string" ||
      typeof metadata.sessionId !== "string" || !Number.isInteger(metadata.turn)) return content;
  const title = `# ${metadata.title}`;
  const prefix = `${title}\n\nSession: ${metadata.sessionId}\nTurn: ${metadata.turn}\n\n`;
  if (!content.startsWith(prefix)) return content;
  const hasPartMetadata = metadata.part !== undefined || metadata.parts !== undefined;
  if (hasPartMetadata) {
    if (!Number.isInteger(metadata.part) || !Number.isInteger(metadata.parts)) return content;
    const fullPrefix = `${prefix}Part: ${metadata.part}/${metadata.parts}\n\n`;
    if (!content.startsWith(fullPrefix)) return content;
    return `${title}\n\n${content.slice(fullPrefix.length)}`;
  }
  return `${title}\n\n${content.slice(prefix.length)}`;
}

function publicEnrichment(enrichment) {
  if (!enrichment || typeof enrichment !== "object") return undefined;
  const keys = [
    "embeddingStatus", "factStatus", "vectorStatus", "topicStatus", "error",
    "embeddedAt", "factsExtractedAt", "topicsExtractedAt", "vectorAttemptedAt", "updatedAt",
  ];
  return Object.fromEntries(keys.flatMap((key) => enrichment[key] === undefined ? [] : [[key, enrichment[key]]]));
}

export async function listTopics(request = api, options = {}) {
  const page = options.page ?? 1;
  const limit = options.limit ?? 100;
  const query = options.page === undefined && options.limit === undefined ? "" : `?page=${page}&limit=${limit}`;
  const result = await request(`/v4/topics${query}`);
  if (!Array.isArray(result?.topics) || !Number.isInteger(result.unclassifiedCount) || result.unclassifiedCount < 0) {
    throw new Error("Invalid memory topic-list response");
  }
  const topics = result.topics.map((entry) => {
    if (!entry || typeof entry.topic !== "string" || !entry.topic || !Number.isInteger(entry.documentCount) || entry.documentCount < 0) {
      throw new Error("Invalid memory topic-list response");
    }
    return { topic: entry.topic, documentCount: entry.documentCount };
  });
  return { topics, unclassifiedCount: result.unclassifiedCount, ...(result.pagination ? { pagination: result.pagination } : {}) };
}

export async function readDocument(documentId, request = api) {
  const document = await request(`/v3/documents/${encodeURIComponent(documentId)}`);
  const index = documentIndex(document);
  const content = sanitizedDocumentContent(document);
  const projectedIndex = publicIndex(index);
  const enrichment = publicEnrichment(document.enrichment);
  const text = `${formatIndexItem(index)}\n\nこれは過去の記録です。現在の状態と照合して利用してください。\n\n${content}`;
  return {
    text,
    document: {
      id: String(document.id || ""),
      content,
      topics: index.topics,
      ...(index.provenance ? { provenance: index.provenance } : {}),
      index: projectedIndex,
      ...(enrichment ? { enrichment } : {}),
    },
  };
}
