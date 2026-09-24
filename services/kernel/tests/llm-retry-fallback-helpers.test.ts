import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseDurationish, parseRetryAfterMs, retryWithBackoff } from "../src/core/llm/retry.js";
import { orderLinksByHealth, runWithFallbackChain } from "../src/core/llm/fallback-chain.js";
import * as providerHealth from "../src/core/llm/provider-health.js";

const realSetTimeout = globalThis.setTimeout;
let delays: number[] = [];
beforeEach(() => {
  delays = [];
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms > 0) {
      delays.push(ms);
      return realSetTimeout(fn, 0, ...args);
    }
    return realSetTimeout(fn, ms, ...args);
  }) as unknown as typeof setTimeout;
  providerHealth._resetForTests();
});
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  providerHealth._resetForTests();
});

const h = (o: Record<string, string>) => new Headers(o);

describe("parseDurationish (x-ratelimit-reset-* values)", () => {
  it("reads each unit — ms is milliseconds, not minutes", () => {
    expect(parseDurationish("750ms")).toBe(750);
    expect(parseDurationish("1s")).toBe(1000);
    expect(parseDurationish("12.5s")).toBe(12_500);
    expect(parseDurationish("6m0s")).toBe(360_000);
    expect(parseDurationish("1m30s")).toBe(90_000);
    expect(parseDurationish("1h2m")).toBe(3_720_000);
    expect(parseDurationish("2m500ms")).toBe(120_500);
  });

  it("reads a bare number as seconds", () => {
    expect(parseDurationish("2.5")).toBe(2500);
    expect(parseDurationish("0")).toBe(0);
  });

  it("returns undefined for anything that is not a duration", () => {
    expect(parseDurationish("")).toBeUndefined();
    expect(parseDurationish("soon")).toBeUndefined();
    expect(parseDurationish("5x")).toBeUndefined();
    expect(parseDurationish("0s")).toBeUndefined();
  });
});

describe("parseRetryAfterMs", () => {
  it("reads Retry-After seconds and dates, then the provider reset headers", () => {
    expect(parseRetryAfterMs(h({ "retry-after": "7" }))).toBe(7000);
    expect(parseRetryAfterMs(h({ "retry-after": "-3" }))).toBe(0);
    const d = parseRetryAfterMs(h({ "retry-after": new Date(Date.now() + 10_000).toUTCString() }))!;
    expect(d).toBeGreaterThan(8000);
    expect(d).toBeLessThanOrEqual(10_000);
    const a = parseRetryAfterMs(h({ "anthropic-ratelimit-tokens-reset": new Date(Date.now() + 3000).toISOString() }))!;
    expect(a).toBeGreaterThan(2000);
    expect(parseRetryAfterMs(h({ "x-ratelimit-reset-tokens": "1m30s" }))).toBe(90_000);
    expect(parseRetryAfterMs(h({ "x-ratelimit-reset-requests": "2.5" }))).toBe(2500);
    expect(parseRetryAfterMs(h({}))).toBeUndefined();
    // Retry-After wins over the reset headers.
    expect(parseRetryAfterMs(h({ "retry-after": "1", "x-ratelimit-reset-requests": "9" }))).toBe(1000);
  });
});

describe("retryWithBackoff (adapters)", () => {
  const r = (status: number, headers: Record<string, string> = {}) => new Response("b", { status, headers });

  it("now also honours an HTTP-date Retry-After and the reset headers", async () => {
    const replies = [r(429, { "x-ratelimit-reset-requests": "3" }), r(429, { "retry-after": new Date(Date.now() + 5000).toUTCString() }), r(200)];
    let i = 0;
    const resp = await retryWithBackoff(async () => replies[i++]);
    expect(resp.status).toBe(200);
    expect(delays[0]).toBe(3000);
    expect(delays[1]).toBeGreaterThan(3000);
    expect(delays[1]).toBeLessThanOrEqual(5000);
  });

  it("returns non-429 responses untouched", async () => {
    let n = 0;
    const resp = await retryWithBackoff(async () => { n++; return r(503, { "retry-after": "1" }); });
    expect(resp.status).toBe(503);
    expect(n).toBe(1);
    expect(delays).toEqual([]);
  });
});

describe("runWithFallbackChain", () => {
  it("returns the first success, reporting failures and recovery", async () => {
    const failed: Array<[string, boolean, boolean]> = [];
    const recovered: string[] = [];
    const out = await runWithFallbackChain(
      ["a", "b", "c"],
      async (l) => { if (l !== "c") throw new Error(`${l} down`); return `from ${l}`; },
      {
        isFatal: () => false,
        onLinkFailed: ({ link }, { isLast, fatal }) => failed.push([link, isLast, fatal]),
        onRecovered: (l) => recovered.push(l),
        exhausted: () => new Error("none"),
      },
    );
    expect(out).toBe("from c");
    expect(failed).toEqual([["a", false, false], ["b", false, false]]);
    expect(recovered).toEqual(["c"]);
  });

  it("rethrows a fatal error as-is and stops", async () => {
    const boom = new Error("400 invalid");
    const tried: string[] = [];
    let caught: unknown;
    try {
      await runWithFallbackChain(["a", "b"], async (l) => { tried.push(l); throw boom; }, {
        isFatal: (e) => (e as Error).message.includes("400"),
        exhausted: () => new Error("none"),
      });
    } catch (e) { caught = e; }
    expect(caught).toBe(boom);
    expect(tried).toEqual(["a"]);
  });

  it("throws what `exhausted` builds, with every failure in order", async () => {
    await expect(runWithFallbackChain(["a", "b"], async (l) => { throw new Error(l); }, {
      isFatal: () => false,
      exhausted: (f) => new Error(f.map((x) => `${x.index}:${x.link}:${(x.error as Error).message}`).join(",")),
    })).rejects.toThrow("0:a:a,1:b:b");
    await expect(runWithFallbackChain([], async () => 1, { isFatal: () => false, exhausted: (f) => new Error(`empty ${f.length}`) })).rejects.toThrow("empty 0");
  });

  it("passes index and isLast to the call", async () => {
    const seen: Array<[number, boolean]> = [];
    await runWithFallbackChain(["a", "b"], async (_l, ctx) => { seen.push([ctx.index, ctx.isLast]); if (ctx.index === 0) throw new Error("x"); return 1; }, {
      isFatal: () => false, exhausted: () => new Error("none"),
    });
    expect(seen).toEqual([[0, false], [1, true]]);
  });
});

describe("orderLinksByHealth", () => {
  it("keeps a healthy primary first, pushes blocked links to the tail, keeps duplicates", () => {
    const links = [{ s: "a", m: 1 }, { s: "b", m: 2 }, { s: "a", m: 3 }, { s: "c", m: 4 }];
    expect(orderLinksByHealth(links, (l) => l.s, "a").map((l) => l.m)).toEqual([1, 3, 2, 4]);
    providerHealth.recordFailure("a", "transient");
    providerHealth.recordSuccess("c", 50);
    expect(orderLinksByHealth(links, (l) => l.s, "a").map((l) => l.m)).toEqual([4, 2, 1, 3]);
  });
});
