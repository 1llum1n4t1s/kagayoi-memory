// 保存時と読出時で同じ索引を作る。要約を新しい事実として生成せず、原文への入口だけを残す。
const INDEX_VERSION = 1;
const compact = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

export function shortText(value, limit = 160) {
  const text = compact(value).replace(/<[^>]*>/g, "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function plainLine(line) {
  return line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`]/g, "")
    .replace(/^(?:desc|description|task|Rollout context):\s*/i, "").trim();
}

function meaningfulLines(value) {
  let fenced = false;
  return String(value || "").split(/\r?\n/).filter((line) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return false; }
    return !fenced && !/^\s*#{1,6}\s/.test(line);
  }).map(plainLine).filter((line) => line &&
    !/^(?:Session|Turn|Part|Source(?: SHA-256)?|Imported snapshot|updated_at|rollout_path|cwd|thread_id|git_branch|task_group|task_outcome|keywords)\s*:/i.test(line) &&
    !/^rollout_summaries[\\/]/i.test(line) &&
    !/^(?:User request|User comment:|Referenced assistant response:|Final assistant response|Codex saved memory import|Historical memory evidence|v\d+$|<|:codex-|::)/i.test(line));
}

function firstText(value) {
  return meaningfulLines(value).find((line) => !/^(?:ゆーくん[、,。!！\s]*|ありがとう[。!！\s]*|了解(?:です)?[。!！\s]*|承知しました[。!！\s]*)$/.test(line)) || "";
}

export function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function buildMemoryIndex({ title, request, response, sourceUpdatedAt, sourceKind = "conversation" } = {}) {
  const taskTitle = shortText(title, 100);
  const requestLine = firstText(String(request || "").split("### Current user request\n").at(-1));
  const sections = [...new Set(String(response || "").split(/\r?\n/)
    .filter((line) => /^#{1,4}\s+/.test(line)).map(plainLine).filter(Boolean))].slice(0, 4).map((line) => shortText(line, 60));
  const briefFollowup = /^(?:はい|いいえ|了解(?:です|しました)?|承知しました|ありがとう(?:ございます)?|お疲れ(?:様|さま)(?:です|でした)?|[Oo][Kk]|続けて|お願いします|よろしく(?:お願いします)?)[。！!\s]*$/.test(requestLine);
  const detailedResponse = sections.length > 0 || meaningfulLines(response).join(" ").length >= 160;
  return {
    version: INDEX_VERSION,
    title: taskTitle && !/^(?:s|Codex task|Memory [a-f0-9]+)$/i.test(taskTitle) ? taskTitle : shortText(requestLine || firstText(response) || "保存された記録", 100),
    description: shortText(briefFollowup && detailedResponse ? `${taskTitle || "作業"}の継続結果・詳細` : requestLine || firstText(response), 180),
    sections,
    recallable: Boolean(requestLine) && (!briefFollowup || detailedResponse),
    sourceKind,
    ...(validDate(sourceUpdatedAt) ? { sourceUpdatedAt } : {}),
  };
}

function matchingSection(content, terms) {
  if (!terms.length) return content;
  const headings = [...content.matchAll(/^(#{1,4})\s+(.+)$/gm)];
  let selected;
  let best = 0;
  for (const heading of headings) {
    if (/^Codex saved memory import:/i.test(heading[2])) continue;
    const matches = terms.filter((term) => heading[2].toLowerCase().includes(term)).length;
    if (matches > best) { best = matches; selected = heading; }
  }
  if (!selected) return content;
  const next = headings.find((h) => h.index > selected.index && h[1].length <= selected[1].length);
  return content.slice(selected.index, next?.index ?? content.length);
}

export function documentIndex(document, fallbackContainer, terms = []) {
  const metadata = document.metadata && typeof document.metadata === "object" ? document.metadata : {};
  const originalContent = String(document.content || document.memory || "");
  const content = matchingSection(originalContent, terms);
  const sourceDates = [...new Set([...originalContent.matchAll(/^updated_at:\s*(\S+)\s*$/gm)].map((match) => match[1]).filter(validDate))];
  const originalDate = sourceDates.length === 1 ? sourceDates[0] : undefined;
  const request = content.match(/### User request\s*\n([\s\S]*?)(?=\n### Final assistant response|$)/)?.[1];
  const response = content.match(/### Final assistant response\s*\n([\s\S]*)/)?.[1];
  const headings = [...content.matchAll(/^#{1,4}\s+(.+)$/gm)].map((match) => match[1]);
  const heading = headings.find((h) => !/^Codex saved memory import:/i.test(h)) || headings[0];
  const importedTitle = heading?.replace(/^Codex saved memory import:\s*/i, "");
  const saved = metadata.memoryIndex?.version === INDEX_VERSION ? metadata.memoryIndex : null;
  const index = saved ? buildMemoryIndex({
    title: saved.title,
    request: saved.description,
    response: "",
    sourceUpdatedAt: saved.sourceUpdatedAt,
    sourceKind: saved.sourceKind,
  }) : buildMemoryIndex({
    title: metadata.title || (document.title && !/^Memory [a-f0-9]+$/i.test(document.title) ? document.title : importedTitle),
    request: request || content.match(/^description:\s*(.+)$/m)?.[1] || firstText(content),
    response,
    sourceUpdatedAt: metadata.sourceTimestamp || metadata.sourceUpdatedAt || metadata.completedAt || originalDate,
    sourceKind: metadata.type === "conversation" ? "conversation" : "historical-document",
  });
  if (saved && Array.isArray(saved.sections)) index.sections = saved.sections.filter((s) => typeof s === "string").slice(0, 4).map((s) => shortText(s, 60));
  if (saved?.recallable === false) index.recallable = false;
  if (!saved && !request && !metadata.title && !heading) index.recallable = false;
  const containerTag = document.containerTag || document.containerTags?.[0] || fallbackContainer;
  return {
    id: String(document.id || ""),
    containerTag,
    ...index,
    createdAt: validDate(document.createdAt),
    updatedAt: validDate(document.updatedAt),
    sourceUpdatedAt: index.sourceUpdatedAt || validDate(metadata.sourceTimestamp) || validDate(metadata.sourceUpdatedAt) || validDate(metadata.completedAt),
    sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
    turn: Number.isInteger(metadata.turn) ? metadata.turn : undefined,
    part: Number.isInteger(metadata.part) ? metadata.part : undefined,
    parts: Number.isInteger(metadata.parts) ? metadata.parts : undefined,
    evidence: "historical record; inspect the document before relying on it",
  };
}

export function formatIndexItem(item) {
  const timestamp = item.sourceUpdatedAt || item.updatedAt || item.createdAt || "日時不明";
  const when = item.description && item.description !== item.title ? ` — 参照する場面: ${item.description}` : "";
  const sections = item.sections?.length ? `（収録: ${item.sections.slice(0, 2).join("、")}）` : "";
  const parts = item.parts > 1 ? ` | part=${item.part}/${item.parts}` : "";
  return `- ◪ ${shortText(item.title, 100)}${when}${sections}\n  id=${item.id} | container=${item.containerTag} | ${item.sourceUpdatedAt ? "sourceDate" : "storedDate"}=${timestamp}${parts}`;
}
