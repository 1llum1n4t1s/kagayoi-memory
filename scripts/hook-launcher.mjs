import { readFileSync } from "node:fs";
import { capture } from "../client/capture.mjs";
import { runHook } from "../client/memory-hooks.mjs";

const event = process.argv[2];
let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

if (event === "SessionStart" || event === "UserPromptSubmit") {
  const result = await runHook(event, payload);
  if (Object.keys(result).length) process.stdout.write(JSON.stringify(result));
} else if (event === "PreToolUse") {
  const readOnly = new Set(["search_memory", "listTopics", "listSpaces", "listMemories", "listDocuments", "getDocument", "whoAmI"]);
  const name = /^mcp__kagayoi_memory__(.+)$/.exec(payload.tool_name || "")?.[1];
  if (readOnly.has(name)) process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Memory index and document access is read-only.",
      updatedInput: payload.tool_input || {},
    },
  }));
} else if (event === "Stop") {
  try {
    const result = await capture(payload);
    if (result.saved || result.pending) process.stdout.write(JSON.stringify({
      systemMessage: `Kagayoi Memory: saved ${result.saved} documents; pending ${result.pending}.`,
    }));
  } catch {
    process.stderr.write("Kagayoi Memory capture failed; unacknowledged records will be retried.\n");
    process.exitCode = 1;
  }
}
