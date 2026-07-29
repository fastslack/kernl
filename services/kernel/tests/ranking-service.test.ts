import { describe, expect, test } from "bun:test";
import { cosine } from "../src/core/ranking/cosine.js";
import { RankingService } from "../src/core/ranking/service.js";
import type { EmbeddingsClient } from "../src/core/embeddings/client.js";

describe("cosine", () => {
  test("identical vectors → 1", () => {
    expect(cosine([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 6);
  });
  test("orthogonal vectors → 0", () => {
    expect(cosine([1, 0, 0], [0, 1, 0])).toBe(0);
  });
  test("length mismatch → 0", () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
  test("zero vector → 0 (no NaN)", () => {
    expect(cosine([0, 0, 0], [1, 1, 1])).toBe(0);
  });
  test("NaN-containing input → 0 (never NaN)", () => {
    expect(cosine([NaN, 1, 0], [1, 1, 1])).toBe(0);
  });
});

// Deterministic fake: vector = [#alpha, #beta, #gamma] occurrences (case-insensitive).
function countWord(s: string, w: string): number {
  return (s.toLowerCase().match(new RegExp(w, "g")) || []).length;
}
const fakeEmbeddings: EmbeddingsClient = {
  provider: "local",
  model: "fake",
  dim: 3,
  async available() {
    return true;
  },
  async embed(texts: string[]) {
    return texts.map((t) => [countWord(t, "alpha"), countWord(t, "beta"), countWord(t, "gamma")]);
  },
};

type Doc = { id: string; body: string };
const docs: Doc[] = [
  { id: "1", body: "alpha alpha" },
  { id: "2", body: "beta" },
  { id: "3", body: "alpha beta" },
];
const key = (d: Doc) => ({ id: d.id, text: d.body });

describe("RankingService.rankAndPage (semantic)", () => {
  test("ranks by cosine to the query, caps to k", async () => {
    const svc = new RankingService(fakeEmbeddings);
    const out = await svc.rankAndPage({ items: docs, query: "alpha", key, k: 2 });
    expect(out.degraded).toBe(false);
    expect(out.ranked.map((d) => d.id)).toEqual(["1", "3"]);
  });
});

describe("RankingService.rankAndPage (degraded)", () => {
  test("no embeddings → lexical token-overlap, degraded flag set", async () => {
    const svc = new RankingService(null);
    const out = await svc.rankAndPage({ items: docs, query: "alpha", key, k: 3 });
    expect(out.degraded).toBe(true);
    expect(out.ranked[0].id).toBe("1"); // most "alpha" occurrences
    expect(out.ranked.map((d) => d.id)).not.toContain("2"); // zero overlap drops out
  });

  test("embeddings present but unavailable → degraded fallback", async () => {
    const down: EmbeddingsClient = { ...fakeEmbeddings, async available() { return false; } };
    const svc = new RankingService(down);
    const out = await svc.rankAndPage({ items: docs, query: "beta", key, k: 3 });
    expect(out.degraded).toBe(true);
    expect(out.ranked[0].id).toBe("2");
  });
});

describe("RankingService.rankAndPage (fts phantom ids)", () => {
  test("ids returned by fts but absent from items do not shrink the top-k", async () => {
    const svc = new RankingService(null); // no semantic leg → fts leg only
    const fts = (_q: string, _n: number) => ["999", "1", "888", "2", "3"]; // 999/888 are phantom
    const out = await svc.rankAndPage({ items: docs, query: "alpha", key, k: 3, fts });
    // All 3 real docs must be returned despite phantom ids occupying high ranks.
    expect(out.ranked.length).toBe(3);
    expect(out.ranked.map((d) => d.id).sort()).toEqual(["1", "2", "3"]);
  });
});
