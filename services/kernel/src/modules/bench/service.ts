/**
 * Model Bench — runs, persistence and the payloads the /bench screen reads.
 * One run at a time; it runs detached and the screen polls `status`.
 */

import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { runBench, ATTEMPTS, type AttemptRecord, type BenchTarget, type RunnerDeps } from "./runner.js";
import { highlights, summarize, type ResultRow } from "./scoring.js";
import { SUITE, SUITE_VERSION } from "./tasks/index.js";
import { CATEGORIES, CATEGORY_WEIGHTS, type BenchTask } from "./types.js";

export interface BenchServiceDeps {
  /** The models a run compares, resolved when it starts. */
  targets(): BenchTarget[];
  estimateCost?: RunnerDeps["estimateCost"];
  sleep?: RunnerDeps["sleep"];
  retryDelayMs?: number;
  suite?: readonly BenchTask[];
}

export interface RunRow {
  id: string;
  suite_version: number;
  status: "running" | "done" | "cancelled" | "interrupted" | "failed";
  targets: Array<{ slug: string; name: string; model: string; supportsTools: boolean }>;
  planned: number;
  done: number;
  current: string;
  error: string;
  started_at: string;
  finished_at: string | null;
}

type Raw = Record<string, unknown>;

export class BenchService {
  private cancelRequested = false;
  private active: string | null = null;
  private readonly suite: readonly BenchTask[];

  constructor(private readonly db: SqliteDb, private readonly deps: BenchServiceDeps) {
    this.suite = deps.suite ?? SUITE;
    // A run cannot survive the process that ran it.
    this.db.query("UPDATE bench_runs SET status='interrupted', finished_at=?, current='' WHERE status='running'").run(isoNow());
  }

  private toRun(r: Raw): RunRow {
    return { ...(r as unknown as RunRow), targets: JSON.parse(String(r.targets || "[]")) };
  }

  getRun(id: string): RunRow {
    const r = this.db.query("SELECT * FROM bench_runs WHERE id = ?").get(id) as Raw | null;
    if (!r) throw new Error(`No bench run ${id}`);
    return this.toRun(r);
  }

  listRuns(limit = 20): RunRow[] {
    return (this.db.query("SELECT * FROM bench_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Raw[]).map((r) => this.toRun(r));
  }

  /** What a run with these targets will do: attempts, plus one "n/a" row per tool task a target cannot run. */
  private planned(targets: BenchTarget[]): number {
    return targets.reduce((n, t) => n + this.suite.reduce((m, task) => m + (task.needsTools && !t.supportsTools ? 1 : ATTEMPTS), 0), 0);
  }

  start(): RunRow {
    if (this.active) throw new Error("A bench run is already in progress.");
    const targets = this.deps.targets();
    if (!targets.length) throw new Error("No connected model to benchmark. Connect a provider in Settings → AI first.");
    const id = newId();
    const meta = targets.map((t) => ({ slug: t.slug, name: t.name, model: t.model, supportsTools: t.supportsTools }));
    this.db.query("INSERT INTO bench_runs (id, suite_version, status, targets, planned, done, started_at) VALUES (?, ?, 'running', ?, ?, 0, ?)")
      .run(id, SUITE_VERSION, JSON.stringify(meta), this.planned(targets), isoNow());
    this.active = id;
    this.cancelRequested = false;
    void this.execute(id, targets);
    return this.getRun(id);
  }

  cancel(): RunRow | null {
    if (!this.active) return null;
    this.cancelRequested = true;
    return this.getRun(this.active);
  }

  private async execute(id: string, targets: BenchTarget[]): Promise<void> {
    const insert = this.db.query(
      "INSERT INTO bench_results (id, run_id, slug, model, task_id, category, attempt, status, score, detail, invalid, latency_ms, " +
      "input_tokens, output_tokens, cost_usd, iterations, output, calls, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const progress = this.db.query("UPDATE bench_runs SET done = done + 1, current = ? WHERE id = ?");
    let status: RunRow["status"] = "done";
    let error = "";
    try {
      await runBench(targets, this.suite, {
        isCancelled: () => this.cancelRequested,
        estimateCost: this.deps.estimateCost,
        sleep: this.deps.sleep,
        retryDelayMs: this.deps.retryDelayMs,
        onAttempt: (t: BenchTarget, r: AttemptRecord) => {
          insert.run(newId(), id, t.slug, t.model, r.taskId, r.category, r.attempt, r.status, r.score, r.detail, r.invalid,
            r.latencyMs, r.inputTokens, r.outputTokens, r.costUsd, r.iterations, r.output, JSON.stringify(r.calls), r.error, isoNow());
          progress.run(`${t.slug}/${t.model} · ${r.taskId}`, id);
        },
      });
      if (this.cancelRequested) status = "cancelled";
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : String(e);
      log.warn(`[bench] run ${id} failed: ${error}`);
    } finally {
      this.db.query("UPDATE bench_runs SET status = ?, error = ?, current = '', finished_at = ? WHERE id = ?").run(status, error, isoNow(), id);
      this.active = null;
      this.cancelRequested = false;
    }
  }

  private rows(runId: string): ResultRow[] {
    return (this.db.query(
      "SELECT slug, model, task_id, category, status, score, invalid, latency_ms, input_tokens, output_tokens, cost_usd FROM bench_results WHERE run_id = ?",
    ).all(runId) as Raw[]).map((r) => ({
      slug: String(r.slug), model: String(r.model), taskId: String(r.task_id), category: r.category as ResultRow["category"],
      status: r.status as ResultRow["status"], score: Number(r.score), invalid: String(r.invalid ?? ""),
      latencyMs: Number(r.latency_ms), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
      costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
    }));
  }

  /** Everything the screen draws for one run. */
  report(runId: string) {
    const run = this.getRun(runId);
    const models = summarize(this.rows(runId), this.suite);
    // A target with no rows yet still gets its line in the table.
    const names = Object.fromEntries(run.targets.map((t) => [`${t.slug}/${t.model}`, t]));
    return {
      run,
      models: models.map((m) => ({ ...m, name: names[m.key]?.name ?? m.slug, supportsTools: names[m.key]?.supportsTools ?? true })),
      highlights: highlights(models),
    };
  }

  /** Raw attempts of one task for one model, for the expandable row. */
  attempts(runId: string, taskId: string, slug: string, model: string) {
    return (this.db.query(
      "SELECT attempt, status, score, detail, invalid, latency_ms, input_tokens, output_tokens, cost_usd, iterations, output, calls, error " +
      "FROM bench_results WHERE run_id = ? AND task_id = ? AND slug = ? AND model = ? ORDER BY attempt",
    ).all(runId, taskId, slug, model) as Raw[]).map((r) => ({ ...r, calls: JSON.parse(String(r.calls || "[]")) }));
  }

  deleteRun(id: string): { deleted: boolean } {
    if (id === this.active) throw new Error("Cancel the run before deleting it.");
    this.db.query("DELETE FROM bench_results WHERE run_id = ?").run(id);
    return { deleted: this.db.query("DELETE FROM bench_runs WHERE id = ?").run(id).changes > 0 };
  }

  /** Totals per model across the finished runs of the current suite version, oldest first. */
  history(limit = 12) {
    const runs = (this.db.query(
      "SELECT * FROM bench_runs WHERE status IN ('done','cancelled') AND suite_version = ? ORDER BY started_at DESC LIMIT ?",
    ).all(SUITE_VERSION, limit) as Raw[]).map((r) => this.toRun(r)).reverse();
    return runs.map((r) => ({
      id: r.id, started_at: r.started_at, status: r.status,
      totals: Object.fromEntries(summarize(this.rows(r.id), this.suite).map((m) => [m.key, m.total])),
    }));
  }

  /** The screen's first read: the suite, who would run, the active run, the latest report and the history. */
  overview() {
    const latest = this.listRuns(1)[0] ?? null;
    let targets: Array<{ slug: string; name: string; model: string; supportsTools: boolean }> = [];
    try {
      targets = this.deps.targets().map((t) => ({ slug: t.slug, name: t.name, model: t.model, supportsTools: t.supportsTools }));
    } catch { /* provider config unreadable: the screen shows none */ }
    return {
      suiteVersion: SUITE_VERSION,
      attemptsPerTask: ATTEMPTS,
      categories: CATEGORIES.map((c) => ({ id: c, weight: CATEGORY_WEIGHTS[c], tasks: this.suite.filter((t) => t.category === c).length })),
      tasks: this.suite.map((t) => ({ id: t.id, category: t.category, title: t.title, needsTools: t.needsTools })),
      targets,
      active: this.active ? this.getRun(this.active) : null,
      latest: latest ? this.report(latest.id) : null,
      runs: this.listRuns(20),
      history: this.history(),
    };
  }

  status() {
    return { active: this.active ? this.getRun(this.active) : null };
  }
}
