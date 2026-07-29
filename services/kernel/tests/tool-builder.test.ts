import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, defineToolNoInput } from "../src/core/tool-builder.js";

describe("defineTool", () => {
  it("passes through metadata fields", () => {
    const tool = defineTool({
      name: "kernel_test_echo",
      description: "echo",
      schema: z.object({ msg: z.string() }),
      tags: ["test"],
      sideEffects: ["test.echo:1"],
      handler: async (input) => ({ content: [{ type: "text", text: input.msg }] }),
    });
    expect(tool.tags).toEqual(["test"]);
    expect(tool.sideEffects).toEqual(["test.echo:1"]);
  });

  it("converts thrown errors to errorResult", async () => {
    const tool = defineTool({
      name: "kernel_test_boom",
      description: "boom",
      schema: z.object({}),
      handler: async () => { throw new Error("kaput"); },
    });
    const res = await tool.handler({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("kaput");
  });

  it("returns errorResult on invalid input instead of throwing", async () => {
    const tool = defineTool({
      name: "kernel_test_strict",
      description: "strict",
      schema: z.object({ n: z.number() }),
      handler: async (input) => ({ content: [{ type: "text", text: String(input.n) }] }),
    });
    const res = await tool.handler({ n: "not-a-number" });
    expect(res.isError).toBe(true);
  });

  it("returns a human-readable message on Zod validation failure", async () => {
    const tool = defineTool({
      name: "kernel_test_strict",
      description: "strict",
      schema: z.object({ n: z.number() }),
      handler: async (input) => ({ content: [{ type: "text", text: String(input.n) }] }),
    });
    const res = await tool.handler({ n: "not-a-number" });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain("n");
    expect(text.startsWith("[")).toBe(false);
    expect(text).not.toContain('"code":');
  });

  it("defineToolNoInput catches errors too", async () => {
    const tool = defineToolNoInput({
      name: "kernel_test_noinput",
      description: "x",
      handler: async () => { throw new Error("sin args"); },
    });
    const res = await tool.handler({});
    expect(res.isError).toBe(true);
  });
});
