import { describe, it, expect } from "bun:test";
import { ClaudeCodeExecutor } from "../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js";

// The message stream shows what each post cost. The SDK sends one assistant
// message per content block, each repeating its turn's usage under the same
// message id — so a turn's tokens must land once, on its first post, and the
// run total must not count the repeats.

type Emitted = { type: string; tokens?: number; tokens_total?: number };

function harness() {
  const emitted: Emitted[] = [];
  const executor = new ClaudeCodeExecutor() as unknown as {
    handleMessage: (msg: unknown, ctx: unknown) => unknown;
  };
  let n = 0;
  const ctx = {
    agent: { id: "a", name: "A" },
    run: { id: "run-1" },
    service: { addStep: () => {}, logEvent: () => {} },
    events: { emit: (_e: string, p: Emitted) => { emitted.push(p); } },
    stepNumberRef: () => ++n,
  };
  return { send: (msg: unknown) => executor.handleMessage(msg, ctx), emitted };
}

const turn = (id: string, block: unknown, input: number, output: number) => ({
  type: "assistant",
  message: { id, content: [block], usage: { input_tokens: input, output_tokens: output } },
});

describe("ClaudeCodeExecutor per-post tokens", () => {
  it("puts a turn's tokens on its first post only, and keeps a running total", () => {
    const h = harness();
    h.send(turn("msg_1", { type: "text", text: "Miro el ledger." }, 100, 20));
    h.send(turn("msg_1", { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }, 100, 20));
    h.send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } });
    h.send(turn("msg_2", { type: "tool_use", id: "tu_2", name: "Bash", input: { command: "pwd" } }, 50, 5));

    expect(h.emitted.map((e) => [e.type, e.tokens, e.tokens_total])).toEqual([
      ["thought", 120, 120],
      ["tool_call", undefined, 120],
      ["tool_result", undefined, 120],
      ["tool_call", 55, 175],
    ]);
  });
});
