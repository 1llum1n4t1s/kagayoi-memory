import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.ts";

function d1Adapter(database) {
  let beforeFirst;

  function prepare(sql) {
    const operation = (values = []) => ({
      sql,
      values,
      bind: (...nextValues) => operation(nextValues),
      first: async () => {
        const row = database.prepare(sql).get(...values);
        if (beforeFirst) return beforeFirst(sql, row);
        return row;
      },
      all: async () => ({ results: database.prepare(sql).all(...values) }),
      run: async () => {
        const result = database.prepare(sql).run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
      batch: () => {
        if (/^\s*(?:SELECT|WITH|PRAGMA)\b/iu.test(sql)) {
          return { results: database.prepare(sql).all(...values), meta: { changes: 0 } };
        }
        const result = database.prepare(sql).run(...values);
        return { results: [], meta: { changes: Number(result.changes) } };
      },
    });
    return operation();
  }

  return {
    prepare,
    batch: async (operations) => {
      database.exec("BEGIN");
      try {
        const results = operations.map((operation) => operation.batch());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    interceptFirst(callback) {
      beforeFirst = callback;
    },
  };
}

function request(path, body, method = "POST") {
  return new Request(`https://memory.example${path}`, {
    method,
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("same-millisecond retry cannot restore stale topics after a content patch", async () => {
  const OriginalDate = globalThis.Date;
  const fixedTime = "2026-09-11T00:00:00.000Z";
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedTime] : args));
    }
    static now() {
      return OriginalDate.parse(fixedTime);
    }
  };

  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_initial.sql",
      "0002_semantic_graph.sql",
      "0003_vector_resilience.sql",
      "0004_content_topics.sql",
    ]) {
      database.exec(readFileSync(resolve(import.meta.dirname, "..", "migrations", name), "utf8"));
    }
    const DB = d1Adapter(database);
    const waits = [];
    const ctx = { waitUntil: (promise) => waits.push(promise) };
    const env = {
      DB,
      MEMORY_API_KEY: "test-key",
      AI_ENRICHMENT_MODE: "off",
      AI: { run: async () => { throw new Error("AI should not run"); } },
      MEMORY_VECTORS: {},
    };

    const saved = await worker.fetch(request("/v3/documents", {
      containerTag: "legacy-folder",
      customId: "race",
      content: "Old content",
      metadata: { topics: ["Old"] },
    }), env, ctx);
    assert.equal(saved.status, 201);
    const { id } = await saved.json();

    let intercepted = false;
    DB.interceptFirst(async (sql, row) => {
      if (intercepted || !sql.includes("SELECT id, container_tag, content, metadata_json, updated_at, topic_revision")) {
        return row;
      }
      intercepted = true;
      env.AI_ENRICHMENT_MODE = "off";
      const patched = await worker.fetch(request(`/v3/documents/${id}`, { content: "New content" }, "PATCH"), env, ctx);
      assert.equal(patched.status, 200);
      env.AI_ENRICHMENT_MODE = "on";
      return row;
    });

    env.AI_ENRICHMENT_MODE = "on";
    const retry = await worker.fetch(request("/v4/enrich", { id }), env, ctx);
    assert.equal(retry.status, 409);
    assert.equal(intercepted, true);

    const current = await worker.fetch(new Request(`https://memory.example/v3/documents/${id}`, {
      headers: { Authorization: "Bearer test-key" },
    }), env, ctx);
    const currentBody = await current.json();
    assert.equal(currentBody.content, "New content");
    assert.deepEqual(currentBody.topics, []);
    assert.equal(currentBody.metadata.topics, undefined);
  } finally {
    database.close();
    globalThis.Date = OriginalDate;
  }
});
