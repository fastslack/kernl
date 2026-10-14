/**
 * kernel_repos_git and kernel_repos_read at a ref: what an investigating agent
 * needs (a range between branches, a log filtered by issue number, the patch,
 * a file as committed on another branch) and what it must not get (a ref that
 * git reads as an option — `--output=…` on a diff wrote a file).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { reposMigrations } from "../assets/extensions/productivity/repos/_module/migrations/001_repos.js";
import { repoAccessMigrations } from "../assets/extensions/productivity/repos/_module/migrations/002_repo_access.js";
import { RepoService } from "../assets/extensions/productivity/repos/_module/service.js";
import { repoTools } from "../assets/extensions/productivity/repos/_module/tools.js";
import { checkRef, gitArgs, showFileArgs } from "../assets/extensions/productivity/repos/_module/git-args.js";

describe("git-args: refs that git would read as options are refused", () => {
  it("accepts branches, ranges, shas and rev:path", () => {
    for (const ok of ["HEAD", "origin/stable..origin/develop", "a1b2c3d", "HEAD~3", "v1.2.0", "main...feature/x", "origin/develop:app/x.js"]) {
      expect(checkRef(ok)).toBeNull();
    }
  });
  it("refuses a leading dash, spaces and control characters", () => {
    for (const bad of ["--output=/tmp/x", "-p", "HEAD --output=x", "a\nb", "", "x".repeat(300)]) {
      expect(checkRef(bad)).not.toBeNull();
    }
  });
  it("puts --end-of-options before the ref", () => {
    const r = gitArgs({ op: "log", ref: "origin/stable..origin/develop", grep: "#2600", limit: 5 });
    expect(r.ok && r.argv).toEqual(["log", "--oneline", "--decorate", "-5", "-i", "--fixed-strings", "--grep=#2600", "--end-of-options", "origin/stable..origin/develop"]);
  });
  it("a file at a ref takes no path traversal", () => {
    expect(showFileArgs("origin/develop", "../etc/passwd").ok).toBe(false);
    expect(showFileArgs("origin/develop:x", "a.js").ok).toBe(false);
    expect(showFileArgs("origin/develop", "./app/a.js")).toEqual({ ok: true, argv: ["show", "--no-color", "--end-of-options", "origin/develop:app/a.js"] });
  });
});

describe("kernel_repos_git / kernel_repos_read on a real repo", () => {
  let db: InstanceType<typeof Database>;
  let root: string;
  let repoPath: string;
  let tools: ReturnType<typeof repoTools>;
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: repoPath,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).toString();
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name)!;
    const res = await tool.handler({ name: "app", ...args } as never) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "repos-git-"));
    repoPath = join(root, "app");
    execFileSync("git", ["init", "-q", "-b", "stable", repoPath]);
    writeFileSync(join(repoPath, "a.js"), "export const v = 1;\n");
    git("add", "a.js");
    git("commit", "-q", "-m", "#2500 First");
    git("checkout", "-q", "-b", "develop");
    writeFileSync(join(repoPath, "a.js"), "export const v = 2;\n");
    git("commit", "-q", "-am", "#2600 Second");
    git("checkout", "-q", "stable");
    db = new Database(":memory:");
    runMigrations(db as never, "repos", [...reposMigrations, ...repoAccessMigrations]);
    const service = new RepoService(db as never);
    const res = service.create({ name: "app", path: repoPath, shared: true });
    if (!res.ok) throw new Error(res.error);
    tools = repoTools(service);
  });
  afterAll(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("log over a range lists what develop has and stable does not, filtered by issue", async () => {
    const r = await call("kernel_repos_git", { op: "log", ref: "stable..develop", grep: "#2600" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("#2600 Second");
    expect(r.text).not.toContain("#2500 First");
  });

  it("show with patch returns the change itself", async () => {
    const r = await call("kernel_repos_git", { op: "show", ref: "develop", patch: true });
    expect(r.text).toContain("+export const v = 2;");
  });

  it("an option disguised as a ref is refused and writes nothing", async () => {
    const out = join(root, "pwned.txt");
    const r = await call("kernel_repos_git", { op: "diff", ref: `--output=${out}` });
    expect(r.isError).toBe(true);
    expect(existsSync(out)).toBe(false);
  });

  it("read at a ref returns the committed file, not the working tree", async () => {
    const r = await call("kernel_repos_read", { file: "a.js", ref: "develop" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("v = 2");
    const wt = await call("kernel_repos_read", { file: "a.js" });
    expect(wt.text).toContain("v = 1");
  });
});
