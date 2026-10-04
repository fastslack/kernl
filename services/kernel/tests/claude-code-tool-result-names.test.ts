import { describe, it, expect } from "bun:test";
import { ClaudeCodeExecutor } from "../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js";

// A tool result has to carry the name of the tool that produced it. The SDK
// links the two by `tool_use_id`; the executor used to ignore that id and
// label every result with the LAST tool called. With two calls in one turn —
// the chief loading a tool with ToolSearch and calling it — "Agent Scout
// updated." was recorded, and shown live, as ToolSearch's output.

type Step = { type: string; tool_name?: string; tool_input?: unknown; tool_output?: string };

function harness() {
  const steps: Step[] = [];
  const service = {
    addStep: (s: Step) => { steps.push(s); },
    getSteps: () => steps.map((s) => ({ ...s, tool_input: JSON.stringify(s.tool_input ?? {}) })),
    logEvent: () => {},
  };
  const executor = new ClaudeCodeExecutor() as unknown as {
    handleMessage: (msg: unknown, ctx: unknown) => unknown;
  };
  let n = 0;
  const ctx = {
    agent: { id: "chief", name: "Chief" },
    run: { id: "run-1" },
    service,
    stepNumberRef: () => ++n,
  };
  const send = (msg: unknown) => executor.handleMessage(msg, ctx);
  const results = () => steps.filter((s) => s.type === "tool_result").map((s) => [s.tool_name, s.tool_output]);
  return { send, results };
}

const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
const result = (id: string, text: string) => ({ type: "tool_result", tool_use_id: id, content: text });

describe("ClaudeCodeExecutor tool_result names", () => {
  it("labels each result with the tool its tool_use_id points at, in any order", () => {
    const h = harness();
    h.send({ type: "assistant", message: { content: [
      call("tu_a", "ToolSearch", { query: "select:mcp__kernel__kernel_agents_update" }),
      call("tu_b", "mcp__kernel__kernel_agents_update", { id: "scout", max_iterations: 40 }),
    ] } });
    h.send({ type: "user", message: { content: [result("tu_b", "Agent **Scout** updated."), result("tu_a", "")] } });

    expect(h.results()).toEqual([
      ["mcp__kernel__kernel_agents_update", "Agent **Scout** updated."],
      ["ToolSearch", ""],
    ]);
  });

  it("still names a result whose id it never saw after the last call", () => {
    const h = harness();
    h.send({ type: "assistant", message: { content: [call("tu_a", "Bash", { command: "ls" })] } });
    h.send({ type: "user", message: { content: [result("tu_unknown", "out")] } });
    expect(h.results()).toEqual([["Bash", "out"]]);
  });
});
