import { describe, expect, test } from "bun:test";
import { runScript } from "../src/modules/meta/code-runner.js";
import { RankingService } from "../src/core/ranking/service.js";
import type { EmbeddingsClient } from "../src/core/embeddings/client.js";

function countWord(s: string, w: string): number {
  return (s.toLowerCase().match(new RegExp(w, "g")) || []).length;
}
const fakeEmbeddings: EmbeddingsClient = {
  provider: "local",
  model: "fake",
  dim: 2,
  async available() {
    return true;
  },
  async embed(texts: string[]) {
    return texts.map((t) => [countWord(t, "alpha"), countWord(t, "beta")]);
  },
};

const sandboxDeps = {
  ranking: new RankingService(fakeEmbeddings),
  embeddings: fakeEmbeddings,
};

describe("code_run ranking helpers", () => {
  test("rank(query, items, opts) returns top-k by relevance", async () => {
    const out = await runScript(
      {
        script: `
          const items = [
            { id: "1", body: "alpha alpha" },
            { id: "2", body: "beta" },
            { id: "3", body: "alpha beta" },
          ];
          const top = await rank("alpha", items, { key: (x) => ({ id: x.id, text: x.body }), k: 2 });
          return top.map((x) => x.id);
        `,
        timeoutMs: 5000,
      },
      () => [],
      sandboxDeps,
    );
    expect(out.result).toEqual(["1", "3"]);
  });

  test("embed(texts) returns vectors", async () => {
    const out = await runScript(
      { script: `return (await embed(["alpha", "beta beta"]));`, timeoutMs: 5000 },
      () => [],
      sandboxDeps,
    );
    expect(out.result).toEqual([
      [1, 0],
      [0, 2],
    ]);
  });

  test("ask() is NOT exposed (no free-form LLM recursion in the sandbox)", async () => {
    const out = await runScript(
      { script: `return typeof ask;`, timeoutMs: 5000 },
      () => [],
      sandboxDeps,
    );
    expect(out.result).toBe("undefined");
  });
});
