/**
 * Subtitle translation concurrency pool.
 *
 * Batches used to run one at a time, so a feature film spent its whole
 * wall-clock waiting on provider latency — 683 cues took 12m46s. They now run
 * N at a time, which changes three things that are easy to get quietly wrong
 * and are what this covers:
 *
 *   • Results must land at their own offset. The old code `push`ed, which was
 *     only correct while batches finished in order.
 *   • "Consecutive failures" has to survive out-of-order completion.
 *   • A batch that never gets an answer keeps its SOURCE text, and the route
 *     reads too much unchanged text as "the model passed through" and rejects
 *     the whole file. Retrying is what keeps a transient rejection under
 *     concurrency from costing thirty good batches.
 */

import { describe, it, expect } from "bun:test";
import {
  runBatchPool,
  isContentRefusal,
  type BatchRunner,
  type TranslateProgress,
} from "../assets/extensions/leisure/cinema/_module/translate.js";

/** LLM_BATCH in translate.ts — cues per call. */
const BATCH = 22;

function cues(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `cue ${i}`);
}

/** Runner that echoes each cue prefixed, so order is verifiable per cue. */
const ok: BatchRunner = async (chunk) => ({
  translations: chunk.map((c) => `ES:${c}`),
  provider: "fake",
  model: "fake-1",
});

describe("runBatchPool — ordering", () => {
  it("writes every batch at its own offset even when they finish out of order", async () => {
    // First batch is the slowest, so it completes last. With the old `push`
    // this reversed the file.
    let call = 0;
    const jittered: BatchRunner = async (chunk) => {
      const delay = call++ === 0 ? 40 : 1;
      await new Promise((r) => setTimeout(r, delay));
      return { translations: chunk.map((c) => `ES:${c}`) };
    };
    const texts = cues(BATCH * 4);
    const r = await runBatchPool("llm", texts, { src: "en", tgt: "es" }, jittered);
    expect(r.translations).toHaveLength(texts.length);
    expect(r.translations).toEqual(texts.map((t) => `ES:${t}`));
  });

  it("returns exactly one translation per cue on a ragged last batch", async () => {
    const texts = cues(BATCH * 2 + 5);
    const r = await runBatchPool("llm", texts, { src: "en", tgt: "es" }, ok);
    expect(r.translations).toHaveLength(texts.length);
    expect(r.translations[texts.length - 1]).toBe(`ES:cue ${texts.length - 1}`);
  });

  it("pads and truncates a runner that returns the wrong count", async () => {
    const wrongCount: BatchRunner = async (chunk) => ({
      translations: chunk.slice(0, 3).map((c) => `ES:${c}`),   // too few
    });
    const texts = cues(BATCH);
    const r = await runBatchPool("llm", texts, { src: "en", tgt: "es" }, wrongCount);
    // Length is preserved — a short reply must never shift later cues.
    expect(r.translations).toHaveLength(texts.length);
    expect(r.translations[0]).toBe("ES:cue 0");
    expect(r.translations[texts.length - 1]).toBe(texts[texts.length - 1]);
  });
});

describe("runBatchPool — concurrency", () => {
  it("actually runs batches in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: BatchRunner = async (chunk) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return { translations: chunk.map((c) => `ES:${c}`) };
    };
    await runBatchPool("llm", cues(BATCH * 8), { src: "en", tgt: "es" }, slow);
    expect(peak).toBe(4);   // LLM_CONCURRENCY
  });

  it("honours an explicit concurrency and never exceeds the batch count", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: BatchRunner = async (chunk) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { translations: chunk.map((c) => `ES:${c}`) };
    };
    await runBatchPool("llm", cues(BATCH * 2), { src: "en", tgt: "es", concurrency: 8 }, slow);
    expect(peak).toBe(2);   // only two batches exist
  });

  it("keeps NLLB serial — it is CPU-bound and parallel batches only thrash", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: BatchRunner = async (chunk) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { translations: chunk.map((c) => `ES:${c}`) };
    };
    await runBatchPool("nllb", cues(200), { src: "eng_Latn", tgt: "spa_Latn" }, slow);
    expect(peak).toBe(1);
  });
});

describe("runBatchPool — failure handling", () => {
  it("retries a batch before giving up on it", async () => {
    const attempts = new Map<string, number>();
    const flaky: BatchRunner = async (chunk) => {
      const key = chunk[0];
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      if (n === 1) throw new Error("rate limited");
      return { translations: chunk.map((c) => `ES:${c}`) };
    };
    const texts = cues(BATCH * 3);
    const r = await runBatchPool("llm", texts, { src: "en", tgt: "es" }, flaky);
    // Every batch failed once and succeeded on the retry — nothing untranslated.
    expect(r.fallbackBatches).toBe(0);
    expect(r.translations).toEqual(texts.map((t) => `ES:${t}`));
  });

  it("keeps the source text and counts the batch when every attempt fails", async () => {
    // Fails only the second batch, so no three-in-a-row abort.
    const failSecond: BatchRunner = async (chunk) => {
      if (chunk[0] === `cue ${BATCH}`) throw new Error("nope");
      return { translations: chunk.map((c) => `ES:${c}`) };
    };
    const texts = cues(BATCH * 4);
    const r = await runBatchPool("llm", texts, { src: "en", tgt: "es" }, failSecond);
    expect(r.fallbackBatches).toBe(1);
    expect(r.totalBatches).toBe(4);
    // The failed batch kept its source text; the rest translated.
    expect(r.translations[BATCH]).toBe(`cue ${BATCH}`);
    expect(r.translations[0]).toBe("ES:cue 0");
  });

  it("aborts the run when three batches fail with no success between them", async () => {
    const alwaysFails: BatchRunner = async () => { throw new Error("chain exhausted"); };
    await expect(
      runBatchPool("llm", cues(BATCH * 10), { src: "en", tgt: "es", concurrency: 1 }, alwaysFails),
    ).rejects.toThrow(/aborted after 3 consecutive batch failures/);
  });

  it("stops starting batches once the signal aborts", async () => {
    const ctl = new AbortController();
    let started = 0;
    const counting: BatchRunner = async (chunk) => {
      started++;
      if (started === 2) ctl.abort();
      await new Promise((r) => setTimeout(r, 5));
      return { translations: chunk.map((c) => `ES:${c}`) };
    };
    await expect(
      runBatchPool(
        "llm",
        cues(BATCH * 20),
        { src: "en", tgt: "es", concurrency: 1, signal: ctl.signal },
        counting,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(started).toBeLessThan(20);
  });
});

describe("content refusals", () => {
  // The real message, from claude-code declining a 1980 disaster film's cues.
  const real =
    "Claude Code returned an error result: API Error: Claude Code is unable to " +
    "respond to this request, which appears to violate our Usage Policy " +
    "(https://www.anthropic.com/legal/aup).";

  it("recognises a provider declining on content grounds", () => {
    expect(isContentRefusal(real)).toBe(true);
    expect(isContentRefusal("blocked by content policy")).toBe(true);
    expect(isContentRefusal("the model refused to answer")).toBe(true);
  });

  it("does not mistake transport failures for refusals", () => {
    expect(isContentRefusal("429 Too Many Requests")).toBe(false);
    expect(isContentRefusal("ECONNREFUSED")).toBe(false);
    expect(isContentRefusal("upstream 502")).toBe(false);
    expect(isContentRefusal("context length exceeded")).toBe(false);
  });

  it("stops the run at the FIRST refusal instead of retrying it", async () => {
    let calls = 0;
    const refusing: BatchRunner = async () => { calls++; throw new Error(real); };
    await expect(
      runBatchPool("llm", cues(BATCH * 10), { src: "en", tgt: "es", concurrency: 1 }, refusing),
    ).rejects.toThrow(/declined to translate this subtitle text/);
    // One call. Retrying is pointless — same cues, same model, same answer —
    // and the old path burned two attempts across three batches before giving up.
    expect(calls).toBe(1);
  });

  it("names the way out in the error", async () => {
    const refusing: BatchRunner = async () => { throw new Error(real); };
    const err = await runBatchPool("llm", cues(BATCH), { src: "en", tgt: "es" }, refusing)
      .then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/Settings → AI/);
    expect(err?.message).toMatch(/nllb/);
  });

  it("still retries a genuine transport failure", async () => {
    let calls = 0;
    const flaky: BatchRunner = async (chunk) => {
      calls++;
      if (calls === 1) throw new Error("429 Too Many Requests");
      return { translations: chunk.map((c) => `ES:${c}`) };
    };
    const r = await runBatchPool("llm", cues(BATCH), { src: "en", tgt: "es" }, flaky);
    expect(calls).toBe(2);
    expect(r.fallbackBatches).toBe(0);
  });
});

describe("runBatchPool — progress", () => {
  it("reports monotonically increasing cuesDone up to the total", async () => {
    const seen: TranslateProgress[] = [];
    const texts = cues(BATCH * 5);
    await runBatchPool(
      "llm",
      texts,
      { src: "en", tgt: "es", onProgress: (p) => seen.push(p) },
      ok,
    );
    expect(seen).toHaveLength(5);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].cuesDone).toBeGreaterThan(seen[i - 1].cuesDone);
    }
    expect(seen[seen.length - 1].cuesDone).toBe(texts.length);
    expect(seen[seen.length - 1].cuesTotal).toBe(texts.length);
    // ETA counts down to zero on the final batch, not to a stale projection.
    expect(seen[seen.length - 1].etaMs).toBe(0);
  });

  it("survives a throwing progress hook", async () => {
    const texts = cues(BATCH * 2);
    const r = await runBatchPool(
      "llm",
      texts,
      { src: "en", tgt: "es", onProgress: () => { throw new Error("subscriber blew up"); } },
      ok,
    );
    expect(r.translations).toHaveLength(texts.length);
  });
});
