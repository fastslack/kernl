import { describe, it, expect } from "bun:test";
import { runToolLoop, type LlmLoopConfig } from "../src/modules/chat/llm-loop.js";
import type { ChatCompletionResult, ChatMessage } from "../src/modules/chat/types.js";

/**
 * Build a fake ChatLlmProvider that returns scripted completions in order.
 * Each script entry is one turn's response. The caller can inspect the
 * `system` it received per turn via the `seenSystems` array.
 */
function fakeProvider(
  script: Array<Partial<ChatCompletionResult> & { content?: string }>,
  seenSystems: Array<string | undefined>,
  seenToolsFlag: Array<boolean>,
) {
  let i = 0;
  return {
    name: "fake",
    available: () => true,
    async chatCompletion(_msgs: ChatMessage[], opts?: { system?: string; tools?: unknown }) {
      seenSystems.push(opts?.system);
      seenToolsFlag.push(!!opts?.tools);
      const next = script[i++] ?? script[script.length - 1];
      return {
        content: next.content ?? "",
        model: next.model ?? "fake",
        tokens_used: next.tokens_used ?? 1,
        tool_calls: next.tool_calls,
      } as ChatCompletionResult;
    },
  };
}

describe("llm-loop iteration budget warnings", () => {
  it("does not inject any warning at low iteration count", async () => {
    const seen: Array<string | undefined> = [];
    const seenTools: boolean[] = [];
    const config: LlmLoopConfig = {
      provider: fakeProvider([{ content: "done" }], seen, seenTools),
      systemText: "BASE",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      executeTool: async () => ({ text: "", isError: false }),
      budgets: { maxIterations: 10, maxTokens: 1_000_000, maxErrors: 5, timeoutMs: 60_000 },
    };
    await runToolLoop(config);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe("BASE");
    expect(seen[0]).not.toContain("BUDGET");
  });

  it("injects caution at 70% threshold", async () => {
    const seen: Array<string | undefined> = [];
    const seenTools: boolean[] = [];
    // Force loop to 7/10 by emitting tool_calls until then, then a final.
    const toolTurn: Partial<ChatCompletionResult> = {
      content: "thinking",
      tool_calls: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
    };
    const finalTurn: Partial<ChatCompletionResult> = { content: "done" };
    const config: LlmLoopConfig = {
      provider: fakeProvider(
        [toolTurn, toolTurn, toolTurn, toolTurn, toolTurn, toolTurn, finalTurn],
        seen,
        seenTools,
      ),
      systemText: "BASE",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "noop", description: "noop", input_schema: {} }],
      executeTool: async () => ({ text: "ok", isError: false }),
      // Bump the loop threshold so duplicate tool calls don't abort early
      budgets: {
        maxIterations: 10,
        maxTokens: 1_000_000,
        maxErrors: 5,
        timeoutMs: 60_000,
        toolLoopThreshold: 999,
      },
    };
    await runToolLoop(config);
    // Iteration 7 → 70% → caution warning expected
    expect(seen[6]).toContain("[BUDGET:");
    // Iteration 1-6 → no warning
    for (let i = 0; i < 6; i++) expect(seen[i]).not.toContain("BUDGET");
  });

  it("injects warning at 90% threshold and runs synthesis pass on overflow", async () => {
    const seen: Array<string | undefined> = [];
    const seenTools: boolean[] = [];
    const toolTurn: Partial<ChatCompletionResult> = {
      content: "calling",
      tool_calls: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
    };
    // Always emit tool calls — the loop will hit maxIterations
    const synth: Partial<ChatCompletionResult> = { content: "FINAL ANSWER FROM SYNTHESIS" };
    // 5 tool turns + 1 synthesis turn = 6 calls. fakeProvider falls back to
    // last entry if it runs out, but we want explicit synth distinct from tool turns.
    const config: LlmLoopConfig = {
      provider: fakeProvider(
        [toolTurn, toolTurn, toolTurn, toolTurn, toolTurn, synth],
        seen,
        seenTools,
      ),
      systemText: "BASE",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "noop", description: "noop", input_schema: {} }],
      executeTool: async () => ({ text: "ok", isError: false }),
      budgets: {
        maxIterations: 5,
        maxTokens: 1_000_000,
        maxErrors: 5,
        timeoutMs: 60_000,
        toolLoopThreshold: 999,
      },
    };
    const result = await runToolLoop(config);

    // 5 main loop turns + 1 synthesis turn = 6 calls observed
    expect(seen.length).toBe(6);
    // Last call (synthesis) had tools disabled
    expect(seenTools[5]).toBe(false);
    // Synthesis system should contain the budget exhausted marker
    expect(seen[5]).toContain("[BUDGET EXHAUSTED]");
    // Final content includes synthesis output
    expect(result.finalContent).toContain("FINAL ANSWER FROM SYNTHESIS");
    expect(result.hitMaxIterations).toBe(true);
  });

  it("falls back to legacy stub if synthesis pass throws", async () => {
    const seen: Array<string | undefined> = [];
    const seenTools: boolean[] = [];
    let calls = 0;
    const failingProvider = {
      name: "failing",
      available: () => true,
      async chatCompletion(_msgs: ChatMessage[], opts?: { system?: string; tools?: unknown }) {
        seen.push(opts?.system);
        seenTools.push(!!opts?.tools);
        calls++;
        if (calls <= 3) {
          // First 3 calls: emit tool_use to keep the loop running
          return {
            content: "",
            model: "f",
            tokens_used: 1,
            tool_calls: [{ type: "tool_use" as const, id: `t${calls}`, name: "noop", input: {} }],
          } as ChatCompletionResult;
        }
        // 4th call (synthesis pass) throws
        throw new Error("synthesis network error");
      },
    };
    const config: LlmLoopConfig = {
      provider: failingProvider,
      systemText: "BASE",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "noop", description: "noop", input_schema: {} }],
      executeTool: async () => ({ text: "ok", isError: false }),
      budgets: {
        maxIterations: 3,
        maxTokens: 1_000_000,
        maxErrors: 5,
        timeoutMs: 60_000,
        toolLoopThreshold: 999,
      },
    };
    const result = await runToolLoop(config);
    expect(result.finalContent).toContain("[Reached maximum iterations]");
    expect(result.hitMaxIterations).toBe(true);
  });
});
