/**
 * Old tool results are trimmed from the history the loop re-sends each turn,
 * and asking for the same call again hands back the full text from the cache.
 */

import { describe, it, expect } from "bun:test";
import { runToolLoop, compactOldToolResults } from "../src/core/llm/tool-loop.js";
import type { ChatCompletionResult, ChatMessage, ContentBlock } from "../src/core/llm/chat-types.js";

const BIG = "x".repeat(5000);

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
        return { content: next.content ?? "", model: "fake", tokens_used: 10, tool_calls: next.tool_calls } as ChatCompletionResult;
      },
    },
  };
}

const call = (id: string, arg: string): Partial<ChatCompletionResult> => ({
  content: "",
  tool_calls: [{ type: "tool_use" as const, id, name: "read", input: { arg } }],
});

const budgets = { maxIterations: 12, maxTokens: 1_000_000, maxErrors: 5, timeoutMs: 60_000 };

function results(msgs: ChatMessage[]): Array<{ id: string; text: string }> {
  return msgs.flatMap((m) =>
    m.role === "user" && Array.isArray(m.content)
      ? (m.content as ContentBlock[])
          .filter((b) => b.type === "tool_result")
          .map((b) => ({ id: (b as { tool_use_id: string }).tool_use_id, text: (b as { content: string }).content }))
      : [],
  );
}

describe("compactOldToolResults", () => {
  const turn = (id: string, text: string): ChatMessage => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: text }],
  });

  it("keeps the newest turns whole and trims long older results", () => {
    const msgs: ChatMessage[] = [turn("a", BIG), turn("b", BIG), turn("c", BIG), turn("d", BIG)];
    expect(compactOldToolResults(msgs, 3)).toEqual(["a"]);
    const [a, b] = results(msgs);
    expect(a.text.startsWith("[TRIMMED")).toBe(true);
    expect(a.text.length).toBeLessThan(900);
    expect(b.text).toBe(BIG);
  });

  it("leaves short results alone and never trims twice", () => {
    const msgs: ChatMessage[] = [turn("s", "short"), turn("a", BIG), turn("b", "y"), turn("c", "z")];
    expect(compactOldToolResults(msgs, 1)).toEqual(["a"]);
    expect(compactOldToolResults(msgs, 1)).toEqual([]);
    expect(results(msgs)[0].text).toBe("short");
  });

  it("does nothing when disabled", () => {
    const msgs: ChatMessage[] = [turn("a", BIG), turn("b", BIG)];
    expect(compactOldToolResults(msgs, 0)).toEqual([]);
    expect(results(msgs)[0].text).toBe(BIG);
  });
});

describe("runToolLoop trims what it re-sends", () => {
  it("sends a trimmed copy of an old result on later turns", async () => {
    const { provider, seen } = scripted([
      call("1", "a"), call("2", "b"), call("3", "c"), call("4", "d"), call("5", "e"), { content: "done" },
    ]);
    await runToolLoop({
      provider,
      systemText: "S",
      messages: [{ role: "user", content: "goal" }],
      tools: [{ name: "read", description: "", input_schema: {} }],
      executeTool: async () => ({ text: BIG, isError: false }),
      budgets,
    });
    const last = results(seen[seen.length - 1]);
    expect(last.find((r) => r.id === "1")!.text.startsWith("[TRIMMED")).toBe(true);
    expect(last.find((r) => r.id === "5")!.text).toBe(BIG);
    // Total re-sent size stays well under five full copies.
    const sent = last.reduce((n, r) => n + r.text.length, 0);
    expect(sent).toBeLessThan(BIG.length * 4);
  });

  it("hands back the full text when a trimmed call is repeated, without re-running it", async () => {
    const { provider, seen } = scripted([
      call("1", "a"), call("2", "b"), call("3", "c"), call("4", "d"), call("5", "a"), { content: "done" },
    ]);
    let runs = 0;
    const out = await runToolLoop({
      provider,
      systemText: "S",
      messages: [{ role: "user", content: "goal" }],
      tools: [{ name: "read", description: "", input_schema: {} }],
      executeTool: async (_n, input) => {
        runs++;
        return { text: `${input.arg}:${BIG}`, isError: false };
      },
      budgets: { ...budgets, toolLoopThreshold: 2 },
    });
    expect(out.status).toBe("completed");
    expect(runs).toBe(4);
    const refetch = results(seen[seen.length - 1]).find((r) => r.id === "5")!;
    expect(refetch.text).toBe(`a:${BIG}`);
  });

  it("keeps the old behaviour with keepFullToolTurns: 0", async () => {
    const { provider, seen } = scripted([call("1", "a"), call("2", "b"), call("3", "c"), call("4", "d"), call("5", "e"), { content: "done" }]);
    await runToolLoop({
      provider,
      systemText: "S",
      messages: [{ role: "user", content: "goal" }],
      tools: [{ name: "read", description: "", input_schema: {} }],
      executeTool: async () => ({ text: BIG, isError: false }),
      budgets: { ...budgets, keepFullToolTurns: 0 },
    });
    expect(results(seen[seen.length - 1]).every((r) => r.text === BIG)).toBe(true);
  });
});

describe("runToolLoop and an empty reply after a tool result", () => {
  it("asks once to carry on instead of closing the run", async () => {
    const { provider, seen } = scripted([call("1", "state"), { content: "" }, call("2", "next"), { content: "done" }]);
    let runs = 0;
    const out = await runToolLoop({
      provider,
      systemText: "S",
      messages: [{ role: "user", content: "goal" }],
      tools: [{ name: "read", description: "", input_schema: {} }],
      executeTool: async () => {
        runs++;
        return { text: "ok", isError: false };
      },
      budgets,
    });
    expect(runs).toBe(2);
    expect(out.finalContent).toBe("done");
    expect(JSON.stringify(seen[2])).toContain("Your last reply was empty");
  });

  it("takes a second empty reply as the end", async () => {
    const { provider, seen } = scripted([call("1", "state"), { content: "" }, { content: "" }, { content: "never" }]);
    const out = await runToolLoop({
      provider,
      systemText: "S",
      messages: [{ role: "user", content: "goal" }],
      tools: [{ name: "read", description: "", input_schema: {} }],
      executeTool: async () => ({ text: "ok", isError: false }),
      budgets,
    });
    expect(out.status).toBe("completed");
    expect(seen.length).toBe(3);
  });
});
