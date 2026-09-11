import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

for (const secret of [undefined, "", "   "]) {
  test(`missing or blank configured key denies access (${JSON.stringify(secret)})`, async () => {
    for (const authorization of [undefined, "Bearer ", "Bearer wrong"]) {
      const headers = authorization ? { authorization } : {};
      const response = await worker.fetch(new Request("https://memory.example/v3/session", { headers }),
        { MEMORY_API_KEY: secret, AI_ENRICHMENT_MODE: "off" }, {});
      assert.equal(response.status, 401);
    }
  });
}

test("configured key requires matching bearer authentication", async () => {
  for (const [authorization, status] of [[undefined, 401], ["Bearer wrong", 401], ["Bearer test-key", 200]]) {
    const response = await worker.fetch(new Request("https://memory.example/v3/session", {
      headers: authorization ? { authorization } : {},
    }), { MEMORY_API_KEY: "test-key", AI_ENRICHMENT_MODE: "off" }, {});
    assert.equal(response.status, status);
  }
});
