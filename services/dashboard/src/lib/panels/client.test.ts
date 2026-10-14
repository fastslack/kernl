import { describe, it, expect } from "bun:test";
import { pollSource } from "./client.js";

describe("pollSource", () => {
  it("drops a response that arrives after the poller was stopped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { await gate; return new Response(JSON.stringify({ version: "1", data: { old: true } }), { status: 200 }); }) as unknown as typeof fetch;
    try {
      const seen: unknown[] = [];
      const errors: string[] = [];
      const stop = pollSource("f1", "s", {}, (d) => seen.push(d), (m) => errors.push(m), 10_000);
      await Bun.sleep(5);
      stop();
      release();
      await Bun.sleep(5);
      expect(seen).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
