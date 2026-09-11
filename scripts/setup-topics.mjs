#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { api } from "../client/memory-client.mjs";

export function parseOptions(args) {
  const options = { apply: false, limit: 10 };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--apply") options.apply = true;
    else if (args[i] === "--help") options.help = true;
    else if (args[i] === "--limit") options.limit = Number(args[++i]);
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new Error("--limit must be an integer from 1 through 50");
  }
  return options;
}

export async function setupTopics({ apply = false, limit = 10 } = {}, request = api) {
  const overview = await request("/v4/topics");
  const page = await request("/v3/documents/list", {
    body: { topic: "__unclassified__", page: 1, limit },
  });
  const ids = [...new Set((page.documents || []).map((document) => document.id))];
  if (ids.length > limit || ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("The server returned an invalid classification batch");
  }
  const result = { mode: apply ? "apply" : "plan", unclassifiedCount: overview.unclassifiedCount,
    selected: ids.length, accepted: [], failed: [], asynchronous: true };
  if (!apply) return result;
  // 実行開始時に選んだ有限件数だけを送る。再試行は次の明示実行で行う。
  for (const id of ids) {
    try {
      await request("/v4/enrich", { body: { id } });
      result.accepted.push(id);
    } catch {
      result.failed.push(id);
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/setup-topics.mjs [--limit 1..50] [--apply]\nDefaults to a read-only plan. --apply queues at most the selected number of unclassified records for Workers AI enrichment; this incurs existing backend usage. Run again only after the queued work completes. Uses the existing memory connection.");
    } else {
      const result = await setupTopics(options);
      console.log(JSON.stringify(result, null, 2));
      if (result.failed.length) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
