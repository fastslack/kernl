/**
 * "Que lo arregle Claude Code": a Kernl bug report handed to a coding agent.
 *
 * Several sessions work on the kernl repo at once, so nothing here may touch
 * its working tree. The layers that keep it that way:
 *
 *  1. Mounts: the kernel sees the working tree read-only; only `<repo>/.git`
 *     and the fix root (`KERNL_FIX_ROOT`) are writable.
 *  2. Each fix gets its own `git worktree` under the fix root, on its own
 *     branch `fix/kernl-<id>` cut from the repo's HEAD.
 *  3. The agent runs in the Docker sandbox with only that worktree mounted.
 *     It cannot reach `.git` (git does not even work there), the kernel's
 *     tools are denied to it, and Edit/Write/Bash stay inside /workspace.
 *  4. The kernel — not the agent — commits, on that branch only, with hooks
 *     off and no push. Before and after it checks that the repo's HEAD and
 *     current branch did not move.
 *  5. One fix at a time.
 *
 * Integrating the branch is the operator's call; nothing here merges.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { KernlBug } from "./kernl-bugs-service.js";

export type FixStatus = "preparing" | "running" | "committing" | "ready" | "no_changes" | "failed" | "discarded";
const ACTIVE: ReadonlySet<FixStatus> = new Set(["preparing", "running", "committing"]);

export interface FixFile { status: string; path: string }
export interface KernlFix {
  bug_id: string; status: FixStatus; branch: string; worktree: string; base_sha: string;
  run_id: string; commit_sha: string; files: FixFile[]; summary: string; error: string;
  started_at: string; finished_at: string | null;
}

export interface FixPreflight { ok: boolean; reasons: string[]; repo: string; root: string }

/** `git <args>` in `cwd`; resolves stdout, rejects with stderr. */
export type GitRunner = (cwd: string, args: string[], env?: Record<string, string>) => Promise<string>;

export const runGit: GitRunner = (cwd, args, env) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });

/** What the fixer needs from the agents module. */
export interface FixerAgents {
  /** Create or update the fixer agent for a run in `cwd`; returns its id. */
  ensureFixer(cwd: string): string;
  /** Start a run; returns its id. */
  run(agentId: string, goal: string): Promise<string>;
  /** Status of a run: running, completed, failed… null when unknown. */
  runStatus(runId: string): { status: string; result: string; error: string } | null;
  /** Whether the Docker sandbox driver can take a run now. */
  sandboxReady(): boolean;
}

type Row = Omit<KernlFix, "files"> & { files_json: string };
const toFix = (r: Row): KernlFix => {
  const { files_json, ...rest } = r;
  let files: FixFile[] = [];
  try { files = JSON.parse(files_json || "[]"); } catch { /* keep [] */ }
  return { ...rest, files };
};
const now = () => new Date().toISOString();
const short = (id: string) => id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();

/** The brief the fixer agent receives. Plain text: the report fields are already redacted. */
export function buildFixGoal(bug: Pick<KernlBug, "id" | "title" | "area" | "diagnosis" | "repro">): string {
  return [
    `Fix this bug in Kernl. The repository is checked out in your working directory (/workspace).`,
    ``,
    `Bug: ${bug.title}`,
    bug.area ? `Area: ${bug.area}` : "",
    bug.diagnosis ? `\nDiagnosis:\n${bug.diagnosis}` : "",
    bug.repro ? `\nRepro:\n${bug.repro}` : "",
    ``,
    `Rules:`,
    `- Work only inside /workspace. Change the fewest files that fix the root cause; no unrelated refactors.`,
    `- Do not run git: it is not available here. The kernel commits your changes when you finish.`,
    `- Add or update a test that fails without the fix. Kernel tests: \`cd services/kernel && bun install && bun test tests/<file>\`; dashboard: \`cd services/dashboard && bun install && bun test src/lib/<file>\`.`,
    `- Never mention Claude, Anthropic or AI in code, comments or docs.`,
    `- If you cannot fix it safely, change nothing and explain why.`,
    ``,
    `Finish with a short summary: root cause, what you changed (file by file), and which tests you ran with their result.`,
  ].filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}

export class KernlFixService {
  private busy = false;

  constructor(
    private readonly db: SqliteDb,
    private readonly agents: FixerAgents,
    private readonly opts: { repo: string; root: string; git?: GitRunner; author?: { name: string; email: string } },
  ) {}

  private get git(): GitRunner { return this.opts.git ?? runGit; }

  preflight(): FixPreflight {
    const { repo, root } = this.opts;
    const reasons: string[] = [];
    if (!repo) reasons.push("KERNL_REPO_PATH is not set: the kernel does not know where the kernl repo is.");
    else if (!existsSync(join(repo, ".git")) || !statSync(join(repo, ".git")).isDirectory()) reasons.push(`${repo} is not a git repository the kernel can see.`);
    else {
      try { accessSync(join(repo, ".git"), constants.W_OK); }
      catch { reasons.push(`${repo}/.git is read-only for the kernel: mount it writable (docker-compose.host.yml).`); }
    }
    if (!root) reasons.push("KERNL_FIX_ROOT is not set: there is nowhere to put the fix worktrees.");
    else {
      try { mkdirSync(root, { recursive: true }); accessSync(root, constants.W_OK); }
      catch { reasons.push(`${root} is not writable for the kernel.`); }
    }
    if (!this.agents.sandboxReady()) reasons.push("The Docker sandbox driver is not ready: the fixer only runs isolated.");
    return { ok: reasons.length === 0, reasons, repo, root };
  }

  get(bugId: string): KernlFix | null {
    const r = this.db.prepare("SELECT * FROM kernl_bug_fixes WHERE bug_id = ?").get(bugId) as Row | undefined;
    return r ? toFix(r) : null;
  }

  private save(fix: KernlFix): KernlFix {
    this.db.prepare(
      `INSERT OR REPLACE INTO kernl_bug_fixes
         (bug_id, status, branch, worktree, base_sha, run_id, commit_sha, files_json, summary, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fix.bug_id, fix.status, fix.branch, fix.worktree, fix.base_sha, fix.run_id, fix.commit_sha,
      JSON.stringify(fix.files), fix.summary.slice(0, 20_000), fix.error.slice(0, 4_000), fix.started_at, fix.finished_at);
    return fix;
  }

  private patch(bugId: string, p: Partial<KernlFix>): KernlFix {
    const cur = this.get(bugId);
    if (!cur) throw new Error("fix not found");
    return this.save({ ...cur, ...p });
  }

  /** Any fix still in flight (only one may run). */
  active(): KernlFix | null {
    const r = this.db.prepare(
      `SELECT * FROM kernl_bug_fixes WHERE status IN ('preparing','running','committing') LIMIT 1`,
    ).get() as Row | undefined;
    return r ? toFix(r) : null;
  }

  /** Where the repo stands: HEAD sha and the checked-out branch ('' when detached). */
  private async repoHead(): Promise<{ sha: string; branch: string }> {
    const sha = (await this.git(this.opts.repo, ["rev-parse", "HEAD"])).trim();
    const branch = (await this.git(this.opts.repo, ["branch", "--show-current"]).catch(() => "")).trim();
    return { sha, branch };
  }

  async start(bug: KernlBug): Promise<KernlFix> {
    const pre = this.preflight();
    if (!pre.ok) throw new Error(pre.reasons.join(" "));
    if (bug.status !== "new" && bug.status !== "published") throw new Error("Only an open report (new or published) can be fixed.");
    if (this.busy || this.active()) throw new Error("Another fix is running; one at a time.");
    const prev = this.get(bug.id);
    if (prev && prev.status === "ready") throw new Error("This report already has a fix waiting for review: discard it first.");

    this.busy = true;
    const id = short(bug.id);
    const branch = `fix/kernl-${id}`;
    const worktree = join(this.opts.root, `kernl-${id}`);
    let fix = this.save({
      bug_id: bug.id, status: "preparing", branch, worktree, base_sha: "", run_id: "", commit_sha: "",
      files: [], summary: "", error: "", started_at: now(), finished_at: null,
    });
    try {
      if (prev) await this.cleanup(prev);
      const head = await this.repoHead();
      await this.git(this.opts.repo, ["worktree", "add", "-b", branch, worktree, head.sha]);
      const agentId = this.agents.ensureFixer(worktree);
      const runId = await this.agents.run(agentId, buildFixGoal(bug));
      fix = this.patch(bug.id, { status: "running", base_sha: head.sha, run_id: runId });
      return fix;
    } catch (e) {
      return this.patch(bug.id, { status: "failed", error: (e as Error).message, finished_at: now() });
    } finally {
      this.busy = false;
    }
  }

  /**
   * The agent run ended: commit what it changed, on the fix branch only.
   * Idempotent — the run-completed event and the startup sweep may both call it.
   */
  async finish(bugId: string, run: { ok: boolean; result: string; error: string }, title: string): Promise<KernlFix | null> {
    const fix = this.get(bugId);
    if (!fix || fix.status !== "running") return fix;
    this.patch(bugId, { status: "committing", summary: run.result });
    try {
      const before = await this.repoHead();
      const changed = (await this.git(fix.worktree, ["status", "--porcelain"])).trim();
      if (!changed) {
        return this.patch(bugId, {
          status: run.ok ? "no_changes" : "failed",
          error: run.ok ? "" : run.error || "The agent run failed.",
          finished_at: now(),
        });
      }
      const branch = (await this.git(fix.worktree, ["branch", "--show-current"])).trim();
      if (branch !== fix.branch) throw new Error(`The worktree is on "${branch}", not on ${fix.branch}: nothing committed.`);
      const author = this.opts.author ?? { name: "Kernl Fixer", email: "fixer@kernl.local" };
      const env = {
        GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
      };
      await this.git(fix.worktree, ["-c", "core.hooksPath=/dev/null", "add", "-A"], env);
      await this.git(fix.worktree, ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", title], env);
      const sha = (await this.git(fix.worktree, ["rev-parse", "HEAD"])).trim();
      const files = (await this.git(fix.worktree, ["diff", "--name-status", `${fix.base_sha}..${sha}`]))
        .trim().split("\n").filter(Boolean)
        .map((l) => { const [status, ...p] = l.split("\t"); return { status, path: p.join(" → ") }; });
      const after = await this.repoHead();
      const moved = before.sha !== after.sha || before.branch !== after.branch;
      return this.patch(bugId, {
        status: run.ok ? "ready" : "failed",
        commit_sha: sha, files,
        error: moved
          ? `Warning: the repo's HEAD moved during the commit (${before.branch}@${before.sha.slice(0, 7)} → ${after.branch}@${after.sha.slice(0, 7)}).`
          : run.ok ? "" : run.error || "The agent run failed; its partial changes are on the branch.",
        finished_at: now(),
      });
    } catch (e) {
      return this.patch(bugId, { status: "failed", error: (e as Error).message, finished_at: now() });
    }
  }

  /** The committed diff of a ready fix (capped). */
  async diff(bugId: string, maxBytes = 200_000): Promise<string> {
    const fix = this.get(bugId);
    if (!fix || !fix.commit_sha) return "";
    const out = await this.git(this.opts.repo, ["diff", `${fix.base_sha}..${fix.commit_sha}`]);
    return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n… (diff truncated)` : out;
  }

  private async cleanup(fix: KernlFix): Promise<void> {
    if (fix.worktree && existsSync(fix.worktree)) {
      await this.git(this.opts.repo, ["worktree", "remove", "--force", fix.worktree]).catch(() => undefined);
    }
    await this.git(this.opts.repo, ["worktree", "prune"]).catch(() => undefined);
    // Only ever our own branches: fix/kernl-<hex>.
    if (/^fix\/kernl-[a-z0-9]{1,8}$/.test(fix.branch)) {
      await this.git(this.opts.repo, ["branch", "-D", fix.branch]).catch(() => undefined);
    }
  }

  /** Throw the fix away: worktree and branch. Not while it runs. */
  async discard(bugId: string): Promise<KernlFix> {
    const fix = this.get(bugId);
    if (!fix) throw new Error("This report has no fix.");
    if (ACTIVE.has(fix.status)) throw new Error("The fix is still running.");
    await this.cleanup(fix);
    return this.patch(bugId, { status: "discarded", finished_at: now() });
  }

  /**
   * Runs that ended while nobody listened (a kernel restart): finish them now.
   * A fix stuck in preparing/committing after a restart is failed.
   */
  async sweep(titleOf: (bugId: string) => string): Promise<void> {
    const rows = (this.db.prepare(
      `SELECT * FROM kernl_bug_fixes WHERE status IN ('preparing','running','committing')`,
    ).all() as Row[]).map(toFix);
    for (const fix of rows) {
      if (fix.status !== "running") {
        this.patch(fix.bug_id, { status: "failed", error: "Interrupted by a kernel restart.", finished_at: now() });
        continue;
      }
      const run = this.agents.runStatus(fix.run_id);
      if (!run || run.status === "running" || run.status === "pending" || run.status === "queued") continue;
      await this.finish(fix.bug_id, { ok: run.status === "completed", result: run.result, error: run.error }, titleOf(fix.bug_id));
    }
  }
}
