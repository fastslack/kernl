/**
 * Token usage per model: the call log's daily rollup, the /api/llm/usage
 * query behind it, the instrumented chat adapters that feed it, and the
 * Agent SDK result parser the Claude Code paths use.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as callLog from "../src/core/llm/call-log.js";
import { instrumentProvider } from "../src/core/llm/chat-instrumentation.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-provider.js";
import { sdkResultUsage, sumSdkUsage } from "../src/sdk/llm-usage.js";

const DAY1 = Date.UTC(2026, 9, 1, 12);
const DAY2 = Date.UTC(2026, 9, 2, 12);

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  callLog.attachDb(db);
});

function rec(over: Partial<callLog.LlmCallRecord> = {}): void {
  callLog.record({
    slug: "claude-code",
    model: "claude-sonnet-4-5",
    ok: true,
    latencyMs: 10,
    inputTokens: 100,
    outputTokens: 20,
    caller: "subs:translate",
    startedAt: DAY1,
    ...over,
  }, { silent: true });
}

describe("call-log usage rollup", () => {
  it("adds every call into one daily row per day/slug/model/caller", () => {
    rec();
    rec({ cacheReadTokens: 500, cacheWriteTokens: 50, costUsd: 0.01 });
    rec({ ok: false, inputTokens: undefined, outputTokens: undefined });
    const rows = db.prepare("SELECT * FROM llm_usage_daily").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-10-01", slug: "claude-code", model: "claude-sonnet-4-5", caller: "subs:translate",
      calls: 3, fails: 1, input_tokens: 200, output_tokens: 40,
      cache_read_tokens: 500, cache_write_tokens: 50,
    });
    expect(rows[0].cost_usd).toBeCloseTo(0.01);
  });

  it("groups by model, caller or day and filters by date range", () => {
    rec();
    rec({ slug: "nvidia", model: "nemotron", inputTokens: 1000, outputTokens: 1, caller: "email-triage" });
    rec({ startedAt: DAY2, caller: "agent:Pitch" });

    const byModel = callLog.usage({ group: "model" });
    expect(byModel.map((r) => [r.slug, r.key, r.calls])).toEqual([
      ["nvidia", "nemotron", 1],
      ["claude-code", "claude-sonnet-4-5", 2],
    ]);

    expect(callLog.usage({ group: "caller", from: "2026-10-02" }).map((r) => r.key)).toEqual(["agent:Pitch"]);
    expect(callLog.usage({ group: "day" }).map((r) => r.key)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(callLog.usage({ group: "caller", model: "nemotron" }).map((r) => r.key)).toEqual(["email-triage"]);
  });

  it("prices each model: reported cost first, else the price table, dated ids included", () => {
    db.exec("CREATE TABLE llm_model_prices (provider TEXT, model TEXT, input_per_mtok REAL, output_per_mtok REAL)");
    db.prepare("INSERT INTO llm_model_prices VALUES (?,?,?,?)").run("openai", "gpt-4.1-nano", 0.1, 0.4);
    rec({ costUsd: 0.5, caller: "chat" });
    rec({ slug: "openai", model: "gpt-4.1-nano-2025-04-14", inputTokens: 1_000_000, outputTokens: 1_000_000, caller: "chat" });
    rec({ slug: "nvidia", model: "nemotron", caller: "triage" });

    const byModel = callLog.usage({ group: "model" });
    const nano = byModel.find((r) => r.slug === "openai")!;
    expect(nano.costKind).toBe("estimated");
    expect(nano.costUsd).toBeCloseTo(0.5);
    expect(byModel.find((r) => r.slug === "claude-code")).toMatchObject({ costKind: "reported", costUsd: 0.5 });
    expect(byModel.find((r) => r.slug === "nvidia")).toMatchObject({ costKind: "none", costUsd: 0 });

    const byCaller = callLog.usage({ group: "caller" });
    expect(byCaller.find((r) => r.key === "chat")).toMatchObject({ costKind: "mixed" });
    expect(byCaller.find((r) => r.key === "chat")!.costUsd).toBeCloseTo(1.0);
  });

  it("keeps the totals when old call-log rows are pruned", () => {
    rec();
    db.exec("DELETE FROM llm_call_log");
    expect(callLog.usage()[0].calls).toBe(1);
  });

  it("seeds the rollup from an existing call log and upgrades its columns", () => {
    const old = new Database(":memory:");
    old.exec(
      "CREATE TABLE llm_call_log (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, model TEXT NOT NULL, " +
        "ok INTEGER NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, " +
        "error_kind TEXT, error_msg TEXT, caller TEXT, started_at INTEGER NOT NULL)",
    );
    old.prepare("INSERT INTO llm_call_log (slug, model, ok, latency_ms, input_tokens, output_tokens, caller, started_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("nvidia", "nemotron", 1, 5, 30, 7, null, DAY1);
    callLog.attachDb(old);
    expect(callLog.usage({ group: "caller" })).toMatchObject([{ key: "", calls: 1, inputTokens: 30, outputTokens: 7 }]);
    const cols = (old.prepare("SELECT name FROM pragma_table_info('llm_call_log')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("cost_usd");
  });
});

describe("instrumented adapters feed the log", () => {
  function fakeProvider(name: string, impl: ChatLlmProvider["chatCompletion"]): ChatLlmProvider {
    return { name, available: () => true, chatCompletion: impl } as ChatLlmProvider;
  }

  it("records the split under the catalog slug, with caller", async () => {
    const p = instrumentProvider(fakeProvider("claude_code", async () => ({
      content: "ok", model: "claude-opus-4-7", tokens_used: 15,
      input_tokens: 10, output_tokens: 5, cache_read_tokens: 900, cost_usd: 0.2,
    })));
    await p.chatCompletion([{ role: "user", content: "hi" }], { caller: "agent:Nadia" });
    expect(callLog.recent()[0]).toMatchObject({
      slug: "claude-code", model: "claude-opus-4-7", caller: "agent:Nadia",
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, costUsd: 0.2,
    });
  });

  it("files a total-only adapter's tokens as output and records failures", async () => {
    const ok = instrumentProvider(fakeProvider("openai", async () => ({ content: "x", model: "m", tokens_used: 42 })));
    await ok.chatCompletion([{ role: "user", content: "hi" }]);
    expect(callLog.recent()[0]).toMatchObject({ inputTokens: undefined, outputTokens: 42 });

    const bad = instrumentProvider(fakeProvider("openai", async () => { throw new Error("openai API error 500: boom"); }));
    await expect(bad.chatCompletion([{ role: "user", content: "hi" }], { model: "gpt-x" })).rejects.toThrow();
    expect(callLog.recent()[0]).toMatchObject({ ok: false, model: "gpt-x" });
  });
});

describe("sdkResultUsage", () => {
  it("splits per model when the SDK reports modelUsage", () => {
    const rows = sdkResultUsage({
      usage: { input_tokens: 999 },
      modelUsage: {
        "claude-opus-4-7": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.5 },
        "claude-haiku-4-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
      },
    }, "fallback");
    expect(rows.map((r) => r.model)).toEqual(["claude-opus-4-7", "claude-haiku-4-5"]);
    const sum = sumSdkUsage(rows);
    expect(sum).toMatchObject({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 300, cacheWriteTokens: 40 });
    expect(sum.costUsd).toBeCloseTo(0.51);
  });

  it("falls back to the aggregate usage under the requested model", () => {
    expect(sdkResultUsage({
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 },
      total_cost_usd: 0.02,
    }, "sonnet")).toEqual([{ model: "sonnet", inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6, costUsd: 0.02 }]);
    expect(sdkResultUsage({}, "sonnet")).toEqual([]);
  });
});
