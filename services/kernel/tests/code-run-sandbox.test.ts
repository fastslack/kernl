import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runScript } from "../src/modules/meta/code-runner.js";
import type { ToolDefinition } from "../src/core/types.js";

// Contract characterization for the kernel_code_run sandbox. These lock the
// observable behavior so the vm→worker_thread isolation refactor (C2) cannot
// silently change it.

const echoTool: ToolDefinition = {
  name: "echo",
  description: "echo back n",
  inputSchema: z.object({ n: z.number() }),
  async handler(args: unknown) {
    const a = args as { n: number };
    return { content: [{ type: "text", text: "ok" }], structuredContent: { n: a.n } };
  },
};

const failTool: ToolDefinition = {
  name: "boom",
  description: "always errors",
  inputSchema: z.object({}),
  async handler() {
    return { isError: true, content: [{ type: "text", text: "kaboom" }] };
  },
};

const catalog = () => [echoTool, failTool];

describe("code_run sandbox contract", () => {
  test("tool() dispatches into the catalog and returns structuredContent", async () => {
    const out = await runScript(
      { script: `const r = await tool("echo", { n: input.n }); return r.n + 1;`, vars: { n: 41 }, timeoutMs: 5000 },
      catalog,
    );
    expect(out.result).toBe(42);
  });

  test("tool() throws for an unknown tool", async () => {
    await expect(
      runScript({ script: `return await tool("nope", {});`, timeoutMs: 5000 }, catalog),
    ).rejects.toThrow(/tool not found: nope/);
  });

  test("tool() surfaces an isError result as a thrown error", async () => {
    await expect(
      runScript({ script: `return await tool("boom", {});`, timeoutMs: 5000 }, catalog),
    ).rejects.toThrow(/kaboom/);
  });

  test("log() is collected into output.logs", async () => {
    const out = await runScript(
      { script: `log("hello"); log(42); return 1;`, timeoutMs: 5000 },
      catalog,
    );
    expect(out.logs).toEqual(["hello", "42"]);
  });

  test("return value is returned as result, with durationMs present", async () => {
    const out = await runScript({ script: `return JSON.stringify({a: Math.max(1,2)});`, timeoutMs: 5000 }, catalog);
    expect(out.result).toBe('{"a":2}');
    expect(typeof out.durationMs).toBe("number");
  });

  test("a thrown error propagates", async () => {
    await expect(
      runScript({ script: `throw new Error("boom-xyz");`, timeoutMs: 5000 }, catalog),
    ).rejects.toThrow(/boom-xyz/);
  });

  test("a synchronous infinite loop is bounded by the timeout", async () => {
    await expect(
      runScript({ script: `while (true) {}`, timeoutMs: 400 }, catalog),
    ).rejects.toThrow(/timed out/);
  });

  test("static reject blocks constructor/prototype/process escape syntax", async () => {
    await expect(
      runScript({ script: `return ({}).constructor.constructor("return 1")();`, timeoutMs: 5000 }, catalog),
    ).rejects.toThrow(/Script rejected/);
  });
});
