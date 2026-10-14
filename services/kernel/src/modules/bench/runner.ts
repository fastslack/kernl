/**
 * Runs the suite against each target, in series: one model at a time, one
 * task at a time, so a benchmark never trips a provider's rate limit and the
 * latencies it records are not inflated by its own concurrency.
 *
 * Every attempt is metered at the adapter (tokens, reported cost) and timed
 * here. A provider failure — the call threw — is retried once; a second one
 * marks the attempt "provider_error", which the scores leave out. A model
 * that answered badly is a low score, never a provider error.
 */

import { runToolLoop } from "../../core/llm/tool-loop.js";
import type { ChatLlmProvider } from "../../core/llm/chat-provider.js";
import type { ChatCompletionResult } from "../../core/llm/chat-types.js";
import { stripReasoning } from "../../sdk/strip-reasoning.js";
import { TOOLS, baseWorld, type World } from "./world.js";
import type { AttemptOutput, BenchTask, Category, CheckResult } from "./types.js";

export interface BenchTarget {
  /** Catalog slug, e.g. "nvidia". */
  slug: string;
  /** Provider display name. */
  name: string;
  model: string;
  provider: ChatLlmProvider;
  /** False for providers that cannot drive a tool loop (Claude Code): tool tasks are "n/a". */
  supportsTools: boolean;
}

export type AttemptStatus = "ok" | "provider_error" | "na";

export interface AttemptRecord {
  taskId: string;
  category: Category;
  attempt: number;
  status: AttemptStatus;
  score: number;
  detail: string;
  invalid: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** USD; null when nothing reported it and no price is known. */
  costUsd: number | null;
  iterations: number;
  output: string;
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  error: string;
}

export interface RunnerDeps {
  isCancelled(): boolean;
  /** Called after every attempt (including "n/a" ones) — the service persists it. */
  onAttempt(target: BenchTarget, rec: AttemptRecord): void;
  /** Cost when the provider did not report one; null if no price is known. */
  estimateCost?(slug: string, model: string, inputTokens: number, outputTokens: number): number | null;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** Wait before retrying a provider error. */
  retryDelayMs?: number;
}

export const ATTEMPTS = 3;
const OUTPUT_CAP = 6000;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`timeout after ${Math.round(ms / 1000)} s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Counts what one attempt spent, and remembers whether the provider itself failed. */
function meter(inner: ChatLlmProvider) {
  const m = { calls: 0, ok: 0, input: 0, output: 0, reportedCost: 0, reported: false, failure: "" };
  const provider: ChatLlmProvider = {
    name: inner.name,
    available: () => inner.available(),
    supportsToolLoop: inner.supportsToolLoop,
    async chatCompletion(messages, opts) {
      m.calls++;
      let r: ChatCompletionResult;
      try {
        r = await inner.chatCompletion(messages, opts);
      } catch (e) {
        m.failure = e instanceof Error ? e.message : String(e);
        throw e;
      }
      m.ok++;
      m.input += r.input_tokens ?? 0;
      m.output += r.output_tokens ?? (r.input_tokens === undefined ? r.tokens_used : 0);
      if (typeof r.cost_usd === "number") { m.reportedCost += r.cost_usd; m.reported = true; }
      return r;
    },
  };
  return { provider, m };
}

interface Outcome { out: AttemptOutput; providerError: string; invalid: string; m: ReturnType<typeof meter>["m"]; latencyMs: number }

async function attemptOnce(target: BenchTarget, task: BenchTask, deps: RunnerDeps): Promise<Outcome> {
  const now = deps.now ?? Date.now;
  const { provider, m } = meter(target.provider);
  const caller = `bench:${task.id}`;
  const timeoutMs = task.timeoutMs ?? 60_000;
  const t0 = now();
  const out: AttemptOutput = { text: "", calls: [], world: null, iterations: 0 };
  let invalid = "";
  let providerError = "";
  try {
    if (task.needsTools) {
      const world: World = baseWorld();
      task.seed?.(world);
      out.world = world;
      const offered = new Set(task.tools ?? []);
      const tools = [...offered].map((n) => TOOLS[n]).filter(Boolean)
        .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
      const res = await withTimeout(runToolLoop({
        provider, systemText: task.system, model: target.model,
        messages: [{ role: "user", content: task.prompt }],
        tools,
        executeTool: async (name, input) => {
          out.calls.push({ name, input });
          const tool = offered.has(name) ? TOOLS[name] : undefined;
          if (!tool) { invalid = "unknown-tool"; return { text: `Unknown tool: ${name}`, isError: true }; }
          return tool.run(input, world);
        },
        budgets: { maxIterations: task.maxIterations ?? 8, maxTokens: 80_000, maxErrors: 4, timeoutMs },
        caller,
        isCancelled: deps.isCancelled,
      }), timeoutMs + 5_000);
      out.text = stripReasoning(res.finalContent ?? "");
      out.iterations = res.iterations;
      if (res.status === "aborted" && /timeout/i.test(res.abortReason)) invalid = "timeout";
    } else {
      const r = await withTimeout(provider.chatCompletion(
        [{ role: "user", content: task.prompt }],
        { system: task.system, model: target.model, max_tokens: task.maxTokens ?? 1500, caller },
      ), timeoutMs);
      out.text = stripReasoning(r.content ?? "");
    }
  } catch (e) {
    if (e instanceof TimeoutError) invalid = "timeout";
    else providerError = m.failure || (e instanceof Error ? e.message : String(e));
  }
  return { out, providerError, invalid, m, latencyMs: now() - t0 };
}

async function runAttempt(target: BenchTarget, task: BenchTask, attempt: number, deps: RunnerDeps): Promise<AttemptRecord> {
  let o = await attemptOnce(target, task, deps);
  if (o.providerError && !deps.isCancelled()) {
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(deps.retryDelayMs ?? 5_000);
    o = await attemptOnce(target, task, deps);
  }
  let check: CheckResult = { score: 0, detail: "" };
  if (!o.providerError) {
    try {
      check = o.invalid === "timeout" ? { score: 0, detail: "✗ timed out" } : task.check(o.out);
    } catch (e) {
      check = { score: 0, detail: `✗ check failed: ${e instanceof Error ? e.message : String(e)}`, invalid: "check" };
    }
  }
  const cost = o.m.reported ? o.m.reportedCost : deps.estimateCost?.(target.slug, target.model, o.m.input, o.m.output) ?? null;
  return {
    taskId: task.id, category: task.category, attempt,
    status: o.providerError ? "provider_error" : "ok",
    score: o.providerError ? 0 : check.score,
    detail: o.providerError ? `provider error: ${o.providerError}` : check.detail,
    invalid: o.providerError ? "" : (o.invalid || check.invalid || ""),
    latencyMs: o.latencyMs,
    inputTokens: o.m.input, outputTokens: o.m.output, costUsd: cost,
    iterations: o.out.iterations,
    output: o.out.text.slice(0, OUTPUT_CAP),
    calls: o.out.calls,
    error: o.providerError,
  };
}

/** Runs every task, ATTEMPTS times, against each target in turn. */
export async function runBench(targets: BenchTarget[], tasks: readonly BenchTask[], deps: RunnerDeps, attempts = ATTEMPTS): Promise<void> {
  for (const target of targets) {
    for (const task of tasks) {
      if (deps.isCancelled()) return;
      if (task.needsTools && !target.supportsTools) {
        deps.onAttempt(target, {
          taskId: task.id, category: task.category, attempt: 0, status: "na", score: 0,
          detail: "n/a — this provider cannot drive a tool loop", invalid: "", latencyMs: 0,
          inputTokens: 0, outputTokens: 0, costUsd: null, iterations: 0, output: "", calls: [], error: "",
        });
        continue;
      }
      for (let a = 1; a <= attempts; a++) {
        if (deps.isCancelled()) return;
        deps.onAttempt(target, await runAttempt(target, task, a, deps));
      }
    }
  }
}
