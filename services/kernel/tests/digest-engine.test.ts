import { describe, expect, test } from "bun:test";
import { mapReduce } from "../src/modules/meta/digest-engine.js";
import type { DigestItem, MapReduceDeps } from "../src/modules/meta/digest-engine.js";

function items(n: number): DigestItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: String(i + 1), text: `item ${i + 1}` }));
}

// Completer that records concurrency + launch timestamps, with a real micro-delay.
function instrumentedCompleter() {
  let inFlight = 0;
  let maxInFlight = 0;
  const starts: number[] = [];
  const complete: MapReduceDeps["complete"] = async (_system, user) => {
    starts.push(Date.now());
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    if (user.includes("REDUCE_STEP")) return { text: "FINAL", tokens: 7 };
    return { text: `MAP(${user.match(/#\d+/g)?.join(",")})`, tokens: 3 };
  };
  return { complete, get maxInFlight() { return maxInFlight; }, starts };
}

describe("mapReduce", () => {
  test("chunks, caps concurrency, grounds citations, sums tokens", async () => {
    const probe = instrumentedCompleter();
    const out = await mapReduce(
      {
        items: items(5),
        mapInstruction: "summarize",
        reduceInstruction: "REDUCE_STEP combine",
        chunkSize: 2,
        concurrency: 2,
        cooldownMs: 0,
      },
      { complete: probe.complete },
    );
    expect(out.chunksProcessed).toBe(3); // [2,2,1]
    expect(out.chunksFailed).toBe(0);
    expect(probe.maxInFlight).toBeLessThanOrEqual(2);
    expect(out.citations.sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(out.digest).toBe("FINAL");
    expect(out.tokens).toBe(3 * 3 + 7); // 3 map calls + 1 reduce
  });

  test("applies cooldown between launches", async () => {
    const probe = instrumentedCompleter();
    await mapReduce(
      {
        items: items(3),
        mapInstruction: "summarize",
        reduceInstruction: "REDUCE_STEP",
        chunkSize: 1,
        concurrency: 1,
        cooldownMs: 30,
      },
      { complete: probe.complete },
    );
    // 3 map launches (+1 reduce after them), the first two map launches ≥30ms apart.
    expect(probe.starts.length).toBeGreaterThanOrEqual(3);
    expect(probe.starts[1] - probe.starts[0]).toBeGreaterThanOrEqual(25);
  });

  test("a failing chunk is reported, not silently dropped; digest is partial", async () => {
    let call = 0;
    const complete: MapReduceDeps["complete"] = async (_s, user) => {
      if (user.includes("REDUCE_STEP")) return { text: "FINAL", tokens: 1 };
      call++;
      if (call === 2) throw new Error("provider 429");
      return { text: "MAP", tokens: 1 };
    };
    const out = await mapReduce(
      {
        items: items(4),
        mapInstruction: "summarize",
        reduceInstruction: "REDUCE_STEP",
        chunkSize: 1,
        concurrency: 1,
        cooldownMs: 0,
      },
      { complete },
    );
    expect(out.chunksFailed).toBe(1);
    expect(out.chunksProcessed).toBe(3);
    expect(out.citations).not.toContain("2"); // failed chunk's id excluded
    expect(out.citations.sort()).toEqual(["1", "3", "4"]);
  });

  test("zero items → empty digest, no error", async () => {
    const out = await mapReduce(
      { items: [], mapInstruction: "x", reduceInstruction: "y", chunkSize: 2, concurrency: 2, cooldownMs: 0 },
      { complete: async () => ({ text: "should-not-run", tokens: 0 }) },
    );
    expect(out.chunksProcessed).toBe(0);
    expect(out.digest).toBe("");
    expect(out.citations).toEqual([]);
  });
});
