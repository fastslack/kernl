/**
 * Model Bench runner, scoring and service, with a fake provider: series order,
 * "n/a" for providers without a tool loop, the provider-error retry, timeouts,
 * cancellation, and what the service persists and reports.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runBench, type AttemptRecord, type BenchTarget } from "../src/modules/bench/runner.js";
import { highlights, percentile, summarize, type ResultRow } from "../src/modules/bench/scoring.js";
import { BenchService } from "../src/modules/bench/service.js";
import { benchMigrations } from "../src/modules/bench/migrations.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-provider.js";
import type { ChatCompletionResult, ChatMessage } from "../src/core/llm/chat-types.js";
import type { BenchTask } from "../src/modules/bench/types.js";

type Reply = (messages: ChatMessage[], hasTools: boolean) => Promise<Partial<ChatCompletionResult>> | Partial<ChatCompletionResult>;

function fakeProvider(reply: Reply, opts: { tools?: boolean } = {}): ChatLlmProvider & { seen: string[] } {
  const seen: string[] = [];
  return {
    name: "fake", seen,
    available: () => true,
    supportsToolLoop: opts.tools === false ? false : undefined,
    async chatCompletion(messages, o) {
      seen.push(String(o?.caller ?? ""));
      const r = await reply(messages, !!o?.tools?.length);
      return { content: "", model: "m", tokens_used: 30, input_tokens: 20, output_tokens: 10, ...r };
    },
  };
}

const plain = (id: string, check: BenchTask["check"] = (o) => ({ score: o.text === "ok" ? 1 : 0, detail: "" })): BenchTask =>
  ({ id, category: "json", title: id, needsTools: false, system: "s", prompt: "p", timeoutMs: 1000, check });

const withTools: BenchTask = {
  id: "tools/x", category: "tools", title: "x", needsTools: true, system: "s", prompt: "p",
  tools: ["reminders_create"], timeoutMs: 2000,
  check: (o) => ({ score: o.world?.reminders.length === 1 ? 1 : 0, detail: "" }),
};

const target = (provider: ChatLlmProvider, slug = "fake", supportsTools = true): BenchTarget =>
  ({ slug, name: slug, model: "m", provider, supportsTools });

async function run(targets: BenchTarget[], tasks: BenchTask[], extra: Partial<Parameters<typeof runBench>[2]> = {}, attempts = 1) {
  const recs: Array<[string, AttemptRecord]> = [];
  await runBench(targets, tasks, {
    isCancelled: () => false, onAttempt: (t, r) => recs.push([t.slug, r]), sleep: async () => {}, ...extra,
  }, attempts);
  return recs;
}

describe("runBench", () => {
  it("runs models in series, every task, every attempt, tagging the caller", async () => {
    const a = fakeProvider(() => ({ content: "ok" }));
    const b = fakeProvider(() => ({ content: "no" }));
    const recs = await run([target(a, "a"), target(b, "b")], [plain("json/1"), plain("json/2")], {}, 2);
    expect(recs.map(([s, r]) => `${s}:${r.taskId}:${r.attempt}`)).toEqual([
      "a:json/1:1", "a:json/1:2", "a:json/2:1", "a:json/2:2", "b:json/1:1", "b:json/1:2", "b:json/2:1", "b:json/2:2",
    ]);
    expect(recs.filter(([s]) => s === "a").every(([, r]) => r.score === 1)).toBe(true);
    expect(recs.filter(([s]) => s === "b").every(([, r]) => r.score === 0)).toBe(true);
    expect(a.seen[0]).toBe("bench:json/1");
    expect(recs[0][1]).toMatchObject({ inputTokens: 20, outputTokens: 10, status: "ok" });
  });

  it("drives the tool loop on the fake world", async () => {
    let turn = 0;
    const p = fakeProvider((_m, hasTools) => {
      if (!hasTools) return { content: "?" };
      turn++;
      return turn === 1
        ? { tool_calls: [{ type: "tool_use", id: "1", name: "reminders_create", input: { text: "x", at: "2026-10-15T09:00" } }] }
        : { content: "Listo" };
    });
    const [[, r]] = await run([target(p)], [withTools]);
    expect(r).toMatchObject({ score: 1, status: "ok" });
    expect(r.calls).toEqual([{ name: "reminders_create", input: { text: "x", at: "2026-10-15T09:00" } }]);
    expect(r.output).toBe("Listo");
  });

  it("flags a call to a tool the task did not offer", async () => {
    let turn = 0;
    const p = fakeProvider(() => (++turn === 1 ? { tool_calls: [{ type: "tool_use", id: "1", name: "mail_send", input: {} }] } : { content: "ok" }));
    const [[, r]] = await run([target(p)], [withTools]);
    expect(r.invalid).toBe("unknown-tool");
  });

  it("marks tool tasks n/a for a provider without a tool loop, once, without calling it", async () => {
    const p = fakeProvider(() => ({ content: "ok" }), { tools: false });
    const recs = await run([target(p, "cc", false)], [withTools, plain("json/1")], {}, 3);
    expect(recs.map(([, r]) => `${r.taskId}:${r.status}`)).toEqual(["tools/x:na", "json/1:ok", "json/1:ok", "json/1:ok"]);
    expect(p.seen).toHaveLength(3);
  });

  it("retries a provider error once, then records it apart from quality", async () => {
    let calls = 0;
    const flaky = fakeProvider(() => { calls++; if (calls === 1) throw new Error("429 Too Many Requests"); return { content: "ok" }; });
    const [[, r1]] = await run([target(flaky)], [plain("json/1")]);
    expect(r1).toMatchObject({ status: "ok", score: 1 });

    const dead = fakeProvider(() => { throw new Error("401 unauthorized"); });
    const [[, r2]] = await run([target(dead)], [plain("json/1")]);
    expect(r2).toMatchObject({ status: "provider_error", score: 0 });
    expect(r2.error).toContain("401");
  });

  it("times out a hung call as invalid output, not a provider error", async () => {
    const slow = fakeProvider(() => new Promise(() => {}));
    const t = { ...plain("json/1"), timeoutMs: 20 };
    const [[, r]] = await run([target(slow)], [t]);
    expect(r).toMatchObject({ status: "ok", score: 0, invalid: "timeout" });
  });

  it("stops when cancelled", async () => {
    let n = 0;
    const p = fakeProvider(() => ({ content: "ok" }));
    const recs: AttemptRecord[] = [];
    await runBench([target(p)], [plain("json/1"), plain("json/2"), plain("json/3")], {
      isCancelled: () => n >= 2, onAttempt: (_t, r) => { n++; recs.push(r); },
    }, 1);
    expect(recs).toHaveLength(2);
  });
});

describe("scoring", () => {
  const suite: BenchTask[] = [
    { ...plain("tools/a"), category: "tools", needsTools: true },
    { ...plain("json/a") }, { ...plain("json/b") },
  ];
  const row = (slug: string, taskId: string, score: number, extra: Partial<ResultRow> = {}): ResultRow => ({
    slug, model: "m", taskId, category: taskId.startsWith("tools") ? "tools" : "json", status: "ok", score, invalid: "",
    latencyMs: 1000, inputTokens: 100, outputTokens: 50, costUsd: 0.01, ...extra,
  });

  it("percentile is nearest-rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });

  it("renormalises over what ran and ranks by total × coverage", () => {
    const rows = [
      row("full", "tools/a", 0.8), row("full", "json/a", 0.8), row("full", "json/b", 0.8),
      row("cc", "tools/a", 0, { status: "na" }), row("cc", "json/a", 1), row("cc", "json/b", 1),
    ];
    const [first, second] = summarize(rows, suite);
    expect(first.key).toBe("full/m");
    expect(first).toMatchObject({ total: 80, coverage: 1 });
    // In this tiny suite tools weigh 0.25 and json 0.20: json alone covers 0.20 / 0.45 of it.
    expect(second).toMatchObject({ key: "cc/m", total: 100 });
    expect(second.coverage).toBeCloseTo(0.444, 3);
    expect(second.categories.tools).toBeNull();
    expect(second.tasks["tools/a"].status).toBe("na");
  });

  it("leaves provider errors out of quality and counts them apart", () => {
    const rows = [row("p", "json/a", 1), row("p", "json/a", 0, { status: "provider_error" }), row("p", "json/b", 0, { invalid: "json" })];
    const [m] = summarize(rows, suite);
    expect(m.tasks["json/a"]).toMatchObject({ mean: 1, n: 1 });
    expect(m.providerErrorRate).toBeCloseTo(1 / 3);
    expect(m.invalidRate).toBeCloseTo(0.5);
  });

  it("highlights: best value is the cheapest close to the top", () => {
    const rows = [
      row("top", "json/a", 1, { costUsd: 0.05, latencyMs: 3000 }), row("top", "json/b", 1, { costUsd: 0.05, latencyMs: 3000 }),
      row("cheap", "json/a", 0.9, { costUsd: 0, latencyMs: 500 }), row("cheap", "json/b", 0.9, { costUsd: 0, latencyMs: 500 }),
      row("bad", "json/a", 0.2, { costUsd: 0 }), row("bad", "json/b", 0.2, { costUsd: 0 }),
    ];
    const h = highlights(summarize(rows, suite));
    expect(h).toEqual({ winner: "top/m", bestValue: "cheap/m", fastest: "cheap/m", mostReliable: "top/m" });
  });
});

describe("BenchService", () => {
  function db() {
    const d = new Database(":memory:");
    for (const m of benchMigrations) d.exec(m.sql);
    return d;
  }
  const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); };

  it("runs detached, persists every attempt and reports", async () => {
    const d = db();
    const p = fakeProvider(() => ({ content: "ok" }));
    const svc = new BenchService(d, { targets: () => [target(p)], suite: [plain("json/a"), plain("json/b")], sleep: async () => {} });
    const run = svc.start();
    expect(run).toMatchObject({ status: "running", planned: 6 });
    expect(() => svc.start()).toThrow(/already/);
    await until(() => svc.status().active === null);
    const rep = svc.report(run.id);
    expect(rep.run).toMatchObject({ status: "done", done: 6 });
    expect(rep.models[0]).toMatchObject({ key: "fake/m", total: 100, name: "fake" });
    expect(svc.attempts(run.id, "json/a", "fake", "m")).toHaveLength(3);
    expect(svc.overview().history).toHaveLength(1);
  });

  it("refuses to start with no connected model", () => {
    const svc = new BenchService(db(), { targets: () => [], suite: [plain("json/a")] });
    expect(() => svc.start()).toThrow(/No connected model/);
  });

  it("marks a run left 'running' by a previous process as interrupted", () => {
    const d = db();
    d.query("INSERT INTO bench_runs (id, suite_version, status, started_at) VALUES ('r1', 1, 'running', '2026-10-13T10:00:00Z')").run();
    const svc = new BenchService(d, { targets: () => [], suite: [] });
    expect(svc.getRun("r1").status).toBe("interrupted");
  });

  it("cancels a run in progress", async () => {
    const d = db();
    const p = fakeProvider(() => new Promise((r) => setTimeout(() => r({ content: "ok" }), 5)));
    const svc = new BenchService(d, { targets: () => [target(p)], suite: [plain("json/a"), plain("json/b"), plain("json/c")] });
    const run = svc.start();
    svc.cancel();
    await until(() => svc.status().active === null);
    expect(svc.getRun(run.id).status).toBe("cancelled");
    expect(svc.getRun(run.id).done).toBeLessThan(9);
  });
});
