import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptions, setupTopics } from "./setup-topics.mjs";

test("classification plan reads all-space unclassified indexes without enqueueing AI", async () => {
  const calls = [];
  const result = await setupTopics({}, async (path, options) => {
    calls.push([path, options]);
    return path === "/v4/topics" ? { unclassifiedCount: 200 } : { documents: [{ id: "legacy-a" }] };
  });
  assert.equal(result.mode, "plan");
  assert.equal(result.selected, 1);
  assert.deepEqual(result.accepted, []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1].body, { topic: "__unclassified__", page: 1, limit: 10 });
});

test("apply uses a finite snapshot and reports partial enqueue failures", async () => {
  const queued = [];
  const result = await setupTopics({ apply: true, limit: 2 }, async (path, options) => {
    if (path === "/v4/topics") return { unclassifiedCount: 100 };
    if (path === "/v3/documents/list") return { documents: [{ id: "a" }, { id: "b" }] };
    queued.push(options.body.id);
    if (options.body.id === "a") throw new Error("offline");
    return { enrichmentStatus: "pending" };
  });
  assert.deepEqual(queued, ["a", "b"]);
  assert.deepEqual(result.accepted, ["b"]);
  assert.deepEqual(result.failed, ["a"]);
  assert.equal(result.asynchronous, true);
});

test("batch sizes and unexpected server pages are bounded", async () => {
  for (const value of ["0", "51", "1.5", "NaN"]) assert.throws(() => parseOptions(["--limit", value]));
  assert.deepEqual(parseOptions(["--limit", "2", "--apply"]), { apply: true, limit: 2 });
  await assert.rejects(setupTopics({ apply: true, limit: 1 }, async (path) =>
    path === "/v4/topics" ? {} : { documents: [{ id: "a" }, { id: "b" }] }), /invalid classification batch/);
});
