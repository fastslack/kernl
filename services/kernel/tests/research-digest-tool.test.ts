import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildDigest } from "../src/modules/meta/digest.js";
import { RankingService } from "../src/core/ranking/service.js";
import type { ToolDefinition, ToolResult } from "../src/core/types.js";

function fakeSourceTool(rows: unknown[]): ToolDefinition {
  return {
    name: "kernel_fake_list",
    description: "fake",
    inputSchema: z.object({}),
    async handler(): Promise<ToolResult> {
      return { content: [{ type: "text", text: "" }], structuredContent: { items: rows } };
    },
  };
}

const completer = async (_system: string, _user: string) => ({ text: "DIGEST", tokens: 2 });

function build(rows: unknown[]) {
  const source = fakeSourceTool(rows);
  return buildDigest({
    getCatalog: () => [source],
    ranking: new RankingService(null), // degrade path is fine for tool-level wiring tests
    complete: completer,
    defaults: { k: 10, chunkSize: 2, concurrency: 2, cooldownMs: 0, maxItems: 100 },
  });
}

async function callJson(tool: ToolDefinition, args: unknown) {
  const res = await tool.handler(args);
  expect(res.isError ?? false).toBe(false);
  return res.structuredContent as Record<string, unknown>;
}

describe("kernel_research_digest", () => {
  test("resolves a {tool,args} source, returns a grounded digest", async () => {
    const tool = build([
      { id: "a", title: "alpha" },
      { id: "b", title: "beta" },
      { id: "c", title: "gamma" },
    ]);
    const out = await callJson(tool, {
      source: { tool: "kernel_fake_list", args: {} },
      map_instruction: "summarize",
      reduce_instruction: "combine",
    });
    expect(out.digest).toBe("DIGEST");
    expect(out.chunks_processed).toBeGreaterThan(0);
    expect((out.citations as string[]).sort()).toEqual(["a", "b", "c"]);
  });

  test("no query → caps to max_items and reports items_truncated", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: `t${i}` }));
    const source = fakeSourceTool(rows);
    const tool = buildDigest({
      getCatalog: () => [source],
      ranking: new RankingService(null),
      complete: completer,
      defaults: { k: 10, chunkSize: 10, concurrency: 1, cooldownMs: 0, maxItems: 3 },
    });
    const out = await callJson(tool, {
      source: { tool: "kernel_fake_list", args: {} },
      map_instruction: "summarize",
      reduce_instruction: "combine",
    });
    expect(out.items_truncated).toBe(2);
    expect((out.citations as string[]).length).toBe(3);
  });

  test("inline {items} source works", async () => {
    const tool = build([]);
    const out = await callJson(tool, {
      source: { items: [{ id: "x", title: "hello" }] },
      map_instruction: "summarize",
      reduce_instruction: "combine",
    });
    expect((out.citations as string[])).toEqual(["x"]);
  });

  test("source tool error → clean errorResult", async () => {
    const boom: ToolDefinition = {
      name: "kernel_boom",
      description: "boom",
      inputSchema: z.object({}),
      async handler(): Promise<ToolResult> {
        return { content: [{ type: "text", text: "kaboom" }], isError: true };
      },
    };
    const tool = buildDigest({
      getCatalog: () => [boom],
      ranking: new RankingService(null),
      complete: completer,
      defaults: { k: 10, chunkSize: 2, concurrency: 1, cooldownMs: 0, maxItems: 100 },
    });
    const res = await tool.handler({
      source: { tool: "kernel_boom", args: {} },
      map_instruction: "summarize",
      reduce_instruction: "combine",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("kernel_boom");
  });

  test("zero items → empty digest, not an error", async () => {
    const tool = build([]);
    const out = await callJson(tool, {
      source: { items: [] },
      map_instruction: "summarize",
      reduce_instruction: "combine",
    });
    expect(out.digest).toBe("");
    expect(out.chunks_processed).toBe(0);
  });
});
