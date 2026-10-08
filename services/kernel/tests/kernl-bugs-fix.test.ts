/**
 * The fixer works on its own worktree and branch of a real git repo, and must
 * leave the repo's working tree, HEAD and current branch exactly as they were.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { KernlBugService } from "../src/modules/agents/kernl-bugs-service.js";
import { KernlFixService, buildFixGoal, type FixerAgents } from "../src/modules/agents/kernl-bugs-fix.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

let tmp: string, repo: string, root: string, db: Database, bugs: KernlBugService;
let fixes: KernlFixService;
let agents: FixerAgents & { goals: string[]; cwds: string[]; status: Record<string, { status: string; result: string; error: string }>; ready: boolean };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kernl-fix-"));
  repo = join(tmp, "kernl");
  root = join(tmp, "fixes");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "dev");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  // Another session's work in progress: must survive untouched.
  writeFileSync(join(repo, "a.ts"), "export const a = 1; // wip\n");

  db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  bugs = new KernlBugService(db, "a".repeat(64));
  agents = {
    goals: [], cwds: [], status: {}, ready: true,
    ensureFixer(cwd) { this.cwds.push(cwd); return "fixer"; },
    async run(_id, goal) { this.goals.push(goal); return `run-${this.goals.length}`; },
    runStatus(id) { return this.status[id] ?? null; },
    sandboxReady() { return this.ready; },
  };
  fixes = new KernlFixService(db, agents, { repo, root });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const newBug = (title = "Pipeline has no pagination") =>
  bugs.report({ title, area: "tools/career", diagnosis: "limit only", source: "chief" }).bug;

describe("KernlFixService", () => {
  it("runs the agent in its own worktree and commits there, leaving the repo as it was", async () => {
    const bug = newBug();
    const headBefore = git(repo, "rev-parse", "HEAD");
    const fix = await fixes.start(bug);
    expect(fix.status).toBe("running");
    expect(fix.branch).toMatch(/^fix\/kernl-[a-z0-9]{1,8}$/);
    expect(agents.cwds).toEqual([fix.worktree]);
    expect(agents.goals[0]).toContain("Pipeline has no pagination");
    expect(readFileSync(join(fix.worktree, "a.ts"), "utf8")).toBe("export const a = 1;\n");

    // The agent edits its worktree.
    writeFileSync(join(fix.worktree, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(fix.worktree, "b.test.ts"), "test\n");
    const done = await fixes.finish(bug.id, { ok: true, result: "Fixed it.", error: "" }, bug.title);

    expect(done?.status).toBe("ready");
    expect(done?.summary).toBe("Fixed it.");
    expect(done?.files).toEqual([{ status: "M", path: "a.ts" }, { status: "A", path: "b.test.ts" }]);
    expect(git(repo, "log", "-1", "--format=%s", fix.branch)).toBe(bug.title);
    // The repo: same HEAD, same branch, the other session's edit intact.
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "branch", "--show-current")).toBe("dev");
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("export const a = 1; // wip\n");
    expect(await fixes.diff(bug.id)).toContain("+export const a = 2;");
  });

  it("reports no changes when the agent changed nothing", async () => {
    const bug = newBug();
    await fixes.start(bug);
    expect((await fixes.finish(bug.id, { ok: true, result: "Not a bug.", error: "" }, bug.title))?.status).toBe("no_changes");
  });

  it("runs one fix at a time", async () => {
    await fixes.start(newBug("one"));
    await expect(fixes.start(newBug("two"))).rejects.toThrow(/one at a time/);
  });

  it("refuses closed reports and a report whose fix waits for review", async () => {
    const bug = newBug();
    await expect(fixes.start({ ...bug, status: "fixed" })).rejects.toThrow(/open report/);
    await fixes.start(bug);
    writeFileSync(join(fixes.get(bug.id)!.worktree, "a.ts"), "x\n");
    await fixes.finish(bug.id, { ok: true, result: "", error: "" }, bug.title);
    await expect(fixes.start(bug)).rejects.toThrow(/discard it first/);
  });

  it("discards worktree and branch, and the report can be fixed again", async () => {
    const bug = newBug();
    const fix = await fixes.start(bug);
    writeFileSync(join(fix.worktree, "a.ts"), "x\n");
    await fixes.finish(bug.id, { ok: true, result: "", error: "" }, bug.title);
    const gone = await fixes.discard(bug.id);
    expect(gone.status).toBe("discarded");
    expect(existsSync(fix.worktree)).toBe(false);
    expect(git(repo, "branch", "--list", fix.branch)).toBe("");
    expect((await fixes.start(bug)).status).toBe("running");
  });

  it("will not discard a running fix", async () => {
    const bug = newBug();
    await fixes.start(bug);
    await expect(fixes.discard(bug.id)).rejects.toThrow(/still running/);
  });

  it("explains what is missing before touching anything", async () => {
    agents.ready = false;
    const pre = new KernlFixService(db, agents, { repo: "", root }).preflight();
    expect(pre.ok).toBe(false);
    expect(pre.reasons.join(" ")).toMatch(/KERNL_REPO_PATH/);
    expect(pre.reasons.join(" ")).toMatch(/sandbox/);
    await expect(fixes.start(newBug())).rejects.toThrow(/sandbox/);
  });

  it("finishes runs that ended while the kernel was down", async () => {
    const bug = newBug();
    const fix = await fixes.start(bug);
    writeFileSync(join(fix.worktree, "a.ts"), "y\n");
    agents.status[fix.run_id] = { status: "completed", result: "done", error: "" };
    await fixes.sweep(() => bug.title);
    expect(fixes.get(bug.id)?.status).toBe("ready");
  });

  it("keeps a failed run's partial changes on the branch, marked failed", async () => {
    const bug = newBug();
    const fix = await fixes.start(bug);
    writeFileSync(join(fix.worktree, "a.ts"), "z\n");
    const done = await fixes.finish(bug.id, { ok: false, result: "", error: "timeout" }, bug.title);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("timeout");
    expect(done?.commit_sha).not.toBe("");
  });
});

describe("buildFixGoal", () => {
  it("carries the report and the rules", () => {
    const g = buildFixGoal({ id: "b", title: "T", area: "A", diagnosis: "D", repro: "" });
    expect(g).toContain("Bug: T");
    expect(g).toContain("Area: A");
    expect(g).toContain("Diagnosis:\nD");
    expect(g).toContain("Do not run git");
    expect(g).not.toContain("Repro:");
  });
});
