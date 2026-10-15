import { describe, it, expect } from "bun:test";
import { structuredResult } from "../src/sdk/helpers.js";

describe("structuredResult", () => {
  it("wraps an array: MCP structuredContent must be an object", () => {
    const r = structuredResult([{ a: 1 }, { a: 2 }]);
    expect(r.structuredContent).toEqual({ items: [{ a: 1 }, { a: 2 }] });
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it("leaves objects as they are", () => {
    expect(structuredResult({ ok: true }).structuredContent).toEqual({ ok: true });
  });
});
