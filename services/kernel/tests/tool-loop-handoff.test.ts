/**
 * End-of-conversation compaction (handoffAtTokens): past the threshold the
 * model writes a handoff and the loop restarts from the task plus it.
 */

import { describe, it, expect } from "bun:test";
import {
  runToolLoop,
  taskMessages,
  buildHandoffConversation,
  HANDOFF_MARK,
} from "../src/core/llm/tool-loop.js";
import type { ChatCompletionOptions, ChatCompletionResult, ChatMessage, ContentBlock } from "../src/core/llm/chat-types.js";

type Step = Partial<ChatCompletionResult>;

/** Scripted provider; a call with tools off is a handoff request and gets `handoffReply`. */
function scripted(script: Step[], handoffReply: Step | (() => Step) = { content: "## Goal\nread things" }, tokens = 10) {
  let i = 0;
  const seen: Array<{ msgs: ChatMessage[]; opts: ChatCompletionOptions }> = [];
  return {
    seen,
    provider: {
      name: "fake",
      available: () => true,
      async chatCompletion(msgs: ChatMessage[], opts: ChatCompletionOptions) {
        seen.push({ msgs: JSON.parse(JSON.stringify(msgs)), opts });
        const next = opts.tools ? (script[i++] ?? script[script.length - 1]) : typeof handoffReply === "function" ? handoffReply() : handoffReply;
        return { content: next.content ?? "", model: "fake", tokens_used: next.tokens_used ?? tokens, input_tokens: next.input_tokens, tool_calls: next.tool_calls } as ChatCompletionResult;
      },
    },
  };
}

const call = (id: string, arg: string, input_tokens?: number): Step => ({
  content: "",
  input_tokens,
  tool_calls: [{ type: "tool_use" as const, id, name: "read", input: { arg } }],
});

const tools = [{ name: "read", description: "", input_schema: {} }];
const budgets = { maxIterations: 12, maxTokens: 1_000_000, maxErrors: 5, timeoutMs: 60_000 };

function texts(m: ChatMessage): string[] {
  return typeof m.content === "string"
    ? [m.content]
    : (m.content as ContentBlock[]).filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
}

describe("taskMessages / buildHandoffConversation", () => {
  it("keeps the opening turns and drops an earlier handoff", () => {
    const task: ChatMessage[] = [{ role: "user", content: "do the thing" }];
    const after = buildHandoffConversation(task, "## Goal\nx", 1);
    expect(after).toHaveLength(1);
    expect(texts(after[0])[1].startsWith(HANDOFF_MARK)).toBe(true);
    const again = taskMessages([...after, { role: "assistant", content: "ok" }]);
    expect(again).toEqual([{ role: "user", content: [{ type: "text", text: "do the thing" }] }]);
    // The original task is not mutated.
    expect(task[0].content).toBe("do the thing");
  });

  it("appends a user turn when the task ends with an assistant turn", () => {
    const out = buildHandoffConversation([{ role: "assistant", content: "hi" }], "h", 2);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
  });
});

describe("runToolLoop with handoffAtTokens", () => {
  it("is off by default: the history keeps growing", async () => {
    const { provider, seen } = scripted([call("a", "1", 9000), call("b", "2", 9000), { content: "done" }]);
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    const r = await runToolLoop({
      provider, systemText: "s", messages, tools, budgets,
      executeTool: async () => ({ text: "out", isError: false }),
    });
    expect(r.handoffs).toBe(0);
    expect(seen.every((s) => s.opts.tools)).toBe(true);
    expect(seen[2].msgs).toHaveLength(5);
  });

  it("compacts past the threshold and restarts from the task plus the handoff", async () => {
    const { provider, seen } = scripted([call("a", "1", 9000), call("b", "2", 100), { content: "done" }]);
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    const handoffs: string[] = [];
    const checkpoints: number[] = [];
    const r = await runToolLoop({
      provider, systemText: "s", messages, tools,
      budgets: { ...budgets, handoffAtTokens: 8000 },
      executeTool: async () => ({ text: "out", isError: false }),
      hooks: {
        onHandoff: ({ handoff, contextTokens }) => { handoffs.push(handoff); expect(contextTokens).toBe(9000); },
        onCheckpoint: (cp) => checkpoints.push(cp.messages.length),
      },
    });
    expect(r.status).toBe("completed");
    expect(r.handoffs).toBe(1);
    expect(handoffs).toEqual(["## Goal\nread things"]);

    // Call 2 is the handoff request: tools off, instruction on the tool-result turn.
    const req = seen[1];
    expect(req.opts.tools).toBeUndefined();
    expect(req.opts.caller).toBe("handoff");
    const last = req.msgs[req.msgs.length - 1];
    expect(last.role).toBe("user");
    expect(texts(last).some((t) => t.startsWith("[CONTEXT HANDOFF]"))).toBe(true);

    // Call 3 starts over: one user turn with the task and the handoff, no tool history.
    const restart = seen[2].msgs;
    expect(restart).toHaveLength(1);
    expect(texts(restart[0])[0]).toBe("task");
    expect(texts(restart[0])[1]).toContain("## Goal\nread things");
    // A checkpoint was taken right after the reset.
    expect(checkpoints).toContain(1);
    // Handoff tokens are counted: call a, handoff, call b, final.
    expect(r.totalTokens).toBe(40);
  });

  it("re-executes a call after the reset instead of answering ALREADY CALLED", async () => {
    let executions = 0;
    const { provider, seen } = scripted([call("a", "1", 9000), call("b", "1", 100), { content: "done" }]);
    await runToolLoop({
      provider, systemText: "s", messages: [{ role: "user", content: "task" }], tools,
      budgets: { ...budgets, handoffAtTokens: 8000 },
      executeTool: async () => { executions++; return { text: "fresh", isError: false }; },
    });
    expect(executions).toBe(2);
    const final = seen[seen.length - 1].msgs;
    const result = (final[final.length - 1].content as ContentBlock[]).find((b) => b.type === "tool_result") as { content: string };
    expect(result.content).toBe("fresh");
  });

  it("carries on with the full history when the handoff comes back empty", async () => {
    const { provider, seen } = scripted([call("a", "1", 9000), call("b", "2", 100), { content: "done" }], { content: "  " });
    const r = await runToolLoop({
      provider, systemText: "s", messages: [{ role: "user", content: "task" }], tools,
      budgets: { ...budgets, handoffAtTokens: 8000 },
      executeTool: async () => ({ text: "out", isError: false }),
    });
    expect(r.status).toBe("completed");
    expect(r.handoffs).toBe(0);
    // The turn after the failed handoff still sees the whole history.
    expect(seen[2].msgs).toHaveLength(3);
  });

  it("a second handoff sees the first one and replaces it", async () => {
    let n = 0;
    const { provider, seen } = scripted(
      [call("a", "1", 9000), call("b", "2", 9000), { content: "done" }],
      () => ({ content: `## Goal\nhandoff ${++n}` }),
    );
    const r = await runToolLoop({
      provider, systemText: "s", messages: [{ role: "user", content: "task" }], tools,
      budgets: { ...budgets, handoffAtTokens: 8000 },
      executeTool: async () => ({ text: "out", isError: false }),
    });
    expect(r.handoffs).toBe(2);
    // The second handoff request carries the first handoff in its history.
    const secondReq = seen.filter((s) => !s.opts.tools)[1].msgs;
    expect(JSON.stringify(secondReq)).toContain("handoff 1");
    // After it, only the newest handoff remains next to the task.
    const restart = seen[seen.length - 1].msgs;
    expect(restart).toHaveLength(1);
    const t = texts(restart[0]);
    expect(t).toHaveLength(2);
    expect(t[1]).toContain("handoff 2");
    expect(t[1]).not.toContain("handoff 1");
  });

  it("uses tokens_used as the context size when the provider gives no split", async () => {
    const { provider } = scripted([{ ...call("a", "1"), tokens_used: 9000 }, { content: "done" }]);
    const r = await runToolLoop({
      provider, systemText: "s", messages: [{ role: "user", content: "task" }], tools,
      budgets: { ...budgets, handoffAtTokens: 8000 },
      executeTool: async () => ({ text: "out", isError: false }),
    });
    expect(r.handoffs).toBe(1);
  });
});
