import { describe, it, expect } from "bun:test";
import {
  runToolLoop,
  prepareResumeMessages,
  type LoopCheckpoint,
} from "../src/core/llm/tool-loop.js";
import type { ChatCompletionResult, ChatMessage, ContentBlock } from "../src/core/llm/chat-types.js";

function scripted(script: Array<Partial<ChatCompletionResult>>) {
  let i = 0;
  const seen: ChatMessage[][] = [];
  return {
    seen,
    provider: {
      name: "fake",
      available: () => true,
      async chatCompletion(msgs: ChatMessage[]) {
        seen.push(JSON.parse(JSON.stringify(msgs)));
        const next = script[i++] ?? script[script.length - 1];
        return {
          content: next.content ?? "",
          model: "fake",
          tokens_used: next.tokens_used ?? 10,
          tool_calls: next.tool_calls,
        } as ChatCompletionResult;
      },
    },
  };
}

const budgets = { maxIterations: 10, maxTokens: 1_000_000, maxErrors: 5, timeoutMs: 60_000 };

const toolTurn = (...ids: string[]): Partial<ChatCompletionResult> => ({
  content: "",
  tool_calls: ids.map((id) => ({ type: "tool_use" as const, id, name: "work", input: { id } })),
});

describe("runToolLoop checkpoints", () => {
  it("checkpoints before the tools run and after each result", async () => {
    const { provider } = scripted([toolTurn("a", "b"), { content: "done" }]);
    const checkpoints: LoopCheckpoint[] = [];
    await runToolLoop({
      provider,
      systemText: "S",
      messages: [{ role: "user", content: "goal" }],
      tools: [{ name: "work", description: "", input_schema: {} }],
      executeTool: async (_n, input) => ({ text: `did ${input.id}`, isError: false }),
      budgets,
      hooks: { onCheckpoint: (c) => checkpoints.push(JSON.parse(JSON.stringify(c))) },
    });

    // assistant turn pushed, then result a, then result b.
    expect(checkpoints.length).toBe(3);
    const ids = (c: LoopCheckpoint) => {
      const last = c.messages[c.messages.length - 1];
      return last.role === "user" && Array.isArray(last.content)
        ? (last.content as ContentBlock[]).map((b) => (b as { tool_use_id?: string }).tool_use_id)
        : [];
    };
    expect(checkpoints[0].messages[checkpoints[0].messages.length - 1].role).toBe("assistant");
    expect(ids(checkpoints[1])).toEqual(["a"]);
    expect(ids(checkpoints[2])).toEqual(["a", "b"]);
    expect(checkpoints[2].iterations).toBe(1);
    expect(checkpoints[2].totalTokens).toBe(10);
  });

  it("resumes with the counters it was interrupted at", async () => {
    const { provider } = scripted([{ content: "finished", tokens_used: 5 }]);
    const result = await runToolLoop({
      provider,
      systemText: "S",
      messages: [{ role: "user", content: "goal" }],
      tools: [],
      executeTool: async () => ({ text: "", isError: false }),
      budgets,
      resumeFrom: { iterations: 4, totalTokens: 400, elapsedMs: 1_000 },
    });
    expect(result.iterations).toBe(5);
    expect(result.totalTokens).toBe(405);
  });

  it("counts the time spent before the interruption against the timeout", async () => {
    const { provider } = scripted([{ content: "never" }]);
    const result = await runToolLoop({
      provider,
      systemText: "S",
      messages: [{ role: "user", content: "goal" }],
      tools: [],
      executeTool: async () => ({ text: "", isError: false }),
      budgets: { ...budgets, timeoutMs: 1_000 },
      resumeFrom: { iterations: 1, totalTokens: 0, elapsedMs: 1_000 },
    });
    expect(result.status).toBe("aborted");
    expect(result.abortReason).toMatch(/Timeout/);
  });
});

describe("prepareResumeMessages", () => {
  const assistant = (...ids: string[]): ChatMessage => ({
    role: "assistant",
    content: ids.map((id) => ({ type: "tool_use" as const, id, name: "send_email", input: {} })),
  });
  const results = (...ids: string[]): ChatMessage => ({
    role: "user",
    content: ids.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: `ok ${id}`, is_error: false })),
  });

  it("leaves a conversation that ended on complete results alone", () => {
    const msgs = [{ role: "user", content: "goal" } as ChatMessage, assistant("a"), results("a")];
    const out = prepareResumeMessages(msgs);
    expect(out.messages).toEqual(msgs);
    expect(out.unknownToolCalls).toEqual([]);
  });

  it("never re-runs a tool whose outcome was lost — it tells the model instead", () => {
    const out = prepareResumeMessages([{ role: "user", content: "goal" }, assistant("a", "b")]);
    expect(out.unknownToolCalls).toEqual(["a", "b"]);
    const last = out.messages[out.messages.length - 1];
    expect(last.role).toBe("user");
    const blocks = last.content as Array<{ tool_use_id: string; content: string }>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["a", "b"]);
    expect(blocks[0].content).toMatch(/outcome is unknown/);
  });

  it("fills only the results that are missing from a partial turn", () => {
    const out = prepareResumeMessages([{ role: "user", content: "goal" }, assistant("a", "b"), results("a")]);
    expect(out.unknownToolCalls).toEqual(["b"]);
    const blocks = out.messages[out.messages.length - 1].content as Array<{ tool_use_id: string; content: string }>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["a", "b"]);
    expect(blocks[0].content).toBe("ok a");
  });
});
