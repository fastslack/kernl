import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  textResult,
  errorResult,
  newId,
  isoNow,
  fireAndForget,
  withTimeout,
  extractErrorMessage,
  stripInternalArgs,
} from "../src/core/helpers.js";

describe("helpers", () => {
  // ── MCP Result Helpers ────────────────────────────────────

  it("textResult wraps text for MCP", () => {
    const r = textResult("hello");
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.isError).toBeUndefined();
  });

  it("errorResult wraps error for MCP", () => {
    const r = errorResult("boom");
    expect(r.content).toEqual([{ type: "text", text: "boom" }]);
    expect(r.isError).toBe(true);
  });

  // ── ID & Time Helpers ─────────────────────────────────────

  it("newId generates valid UUIDs", () => {
    const id = newId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newId()).not.toBe(id);
  });

  it("isoNow returns ISO string", () => {
    const now = isoNow();
    expect(new Date(now).toISOString()).toBe(now);
  });

  // ── Async Helpers ─────────────────────────────────────────

  it("fireAndForget does not throw on rejected promise", async () => {
    // Should not throw - errors are logged at debug level
    fireAndForget(Promise.reject(new Error("test error")), "test-context");
    // Give it time to process
    await new Promise((r) => setTimeout(r, 10));
  });

  it("fireAndForget handles resolved promises silently", async () => {
    fireAndForget(Promise.resolve("ok"), "test-context");
    await new Promise((r) => setTimeout(r, 10));
  });

  it("withTimeout resolves if promise completes in time", async () => {
    const result = await withTimeout(
      Promise.resolve("success"),
      1000,
      "Should not timeout"
    );
    expect(result).toBe("success");
  });

  it("withTimeout rejects if promise takes too long", async () => {
    const slowPromise = new Promise((resolve) => setTimeout(resolve, 500));

    await expect(
      withTimeout(slowPromise, 10, "Operation timed out")
    ).rejects.toThrow("Operation timed out");
  });

  it("withTimeout uses default error message", async () => {
    const slowPromise = new Promise((resolve) => setTimeout(resolve, 500));

    await expect(withTimeout(slowPromise, 10)).rejects.toThrow(
      "Operation timed out"
    );
  });

  // ── Error Helpers ─────────────────────────────────────────

  it("extractErrorMessage handles Error instances", () => {
    const err = new Error("Something went wrong");
    expect(extractErrorMessage(err)).toBe("Something went wrong");
  });

  it("extractErrorMessage handles string errors", () => {
    expect(extractErrorMessage("String error")).toBe("String error");
  });

  it("extractErrorMessage handles other types", () => {
    expect(extractErrorMessage(42)).toBe("42");
    expect(extractErrorMessage(null)).toBe("null");
    expect(extractErrorMessage(undefined)).toBe("undefined");
    expect(extractErrorMessage({ code: 500 })).toBe("[object Object]");
  });

  // ── Internal-arg hygiene ────────────────────────────────────

  it("stripInternalArgs removes every top-level double-underscore key", () => {
    const stripped = stripInternalArgs({
      name: "colleague",
      __caller_agent_id: "attacker-supplied-id",
      __caller_run_id: "attacker-supplied-run",
    }) as Record<string, unknown>;
    expect(stripped).toEqual({ name: "colleague" });
    expect(stripped.__caller_agent_id).toBeUndefined();
  });

  it("stripInternalArgs leaves args with no internal keys untouched", () => {
    expect(stripInternalArgs({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
  });

  it("stripInternalArgs passes through non-object args unchanged", () => {
    expect(stripInternalArgs(null)).toBeNull();
    expect(stripInternalArgs(undefined)).toBeUndefined();
    expect(stripInternalArgs("not an object")).toBe("not an object");
    expect(stripInternalArgs([1, 2])).toEqual([1, 2]);
  });

  it(
    "regression: a client-supplied __caller_agent_id does not survive strip+parse " +
      "even when the tool's own schema declares that field (mirrors server.ts's " +
      "external MCP dispatch: stripInternalArgs() runs immediately before schema.parse())",
    () => {
      // Same shape as CALLER_AGENT_ID_FIELD in modules/agents/tools.ts — a
      // tool schema that legitimately declares the field for the in-process
      // AgentExecutor path (which never goes through this strip+parse logic).
      const schema = z.object({
        question: z.string(),
        __caller_agent_id: z.string().optional(),
      });

      // Simulates an external `tools/call` request forging the field.
      const externalArgs = {
        question: "impersonate?",
        __caller_agent_id: "some-other-agents-id",
      };

      const parsed = schema.parse(stripInternalArgs(externalArgs));
      expect(parsed.__caller_agent_id).toBeUndefined();

      // Sanity check: without the strip step, the same schema would have
      // let the forged value through — proving the strip is load-bearing.
      const withoutStrip = schema.parse(externalArgs);
      expect(withoutStrip.__caller_agent_id).toBe("some-other-agents-id");
    },
  );

  it(
    "regression: bridge-shaped dispatch (tool.handler(stripInternalArgs(req.args))) " +
      "drops a forged __caller_agent_id before it reaches the handler",
    () => {
      // Mirrors BridgeServer.handleFrame()'s dispatch in
      // services/kernel/src/core/mtw/bridge-server.ts: an external
      // mtwRequest client sends { tool, args }, and args go straight to
      // tool.handler(). Simulate a ToolDefinition handler and a forged
      // frame from that external path.
      const handler = (args: unknown) => Promise.resolve(args as Record<string, unknown>);
      const forgedFrameArgs = {
        question: "impersonate?",
        __caller_agent_id: "attacker-supplied-id",
      };

      return handler(stripInternalArgs(forgedFrameArgs)).then((received) => {
        expect(received.__caller_agent_id).toBeUndefined();
        expect(received.question).toBe("impersonate?");
      });
    },
  );
});
