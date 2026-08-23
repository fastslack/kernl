/**
 * Repo scoping and the container-path trap.
 *
 * `repos.shared` shipped in the first migration and the tool schema advertised
 * it — "If false, only the Repos Office sees this repo" — but nothing wrote a
 * 0, no UI exposed it, and no table said who the exception was for. These pin
 * the model now that it exists.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { reposMigrations } from "../assets/extensions/productivity/repos/_module/migrations/001_repos.js";
import { repoAccessMigrations } from "../assets/extensions/productivity/repos/_module/migrations/002_repo_access.js";
import { RepoService } from "../assets/extensions/productivity/repos/_module/service.js";

describe("repo access", () => {
  let db: InstanceType<typeof Database>;
  let service: RepoService;
  let root: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db as never, "repos", [...reposMigrations, ...repoAccessMigrations]);
    service = new RepoService(db as never);
    root = mkdtempSync(join(tmpdir(), "repos-test-"));
    mkdirSync(join(root, "alpha", ".git"), { recursive: true });
    mkdirSync(join(root, "nested", "beta", ".git"), { recursive: true });
    mkdirSync(join(root, "plain-dir"), { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const make = (name: string, dir: string, shared: boolean) => {
    const res = service.create({ name, path: join(root, dir), shared });
    if (!res.ok) throw new Error(res.error);
    return res.repo;
  };

  it("a shared repo is reachable by any agent — the default every install has", () => {
    const repo = make("alpha", "alpha", true);
    expect(service.canAccess(repo, "agent-1")).toBe(true);
    expect(service.canAccess(repo, "agent-2")).toBe(true);
  });

  it("a private repo is reachable only by the agents named", () => {
    const repo = make("alpha", "alpha", false);
    expect(service.canAccess(repo, "agent-1")).toBe(false);
    service.setAccess(repo.id, ["agent-1"]);
    expect(service.canAccess(repo, "agent-1")).toBe(true);
    expect(service.canAccess(repo, "agent-2")).toBe(false);
  });

  it("a caller with no agent id is a human and sees everything", () => {
    // The dashboard has to be able to manage a repo it just made private.
    const repo = make("alpha", "alpha", false);
    expect(service.canAccess(repo, "")).toBe(true);
  });

  it("setAccess replaces the list rather than appending to it", () => {
    const repo = make("alpha", "alpha", false);
    service.setAccess(repo.id, ["a", "b"]);
    service.setAccess(repo.id, ["b", "c"]);
    expect(service.getAccess(repo.id)).toEqual(["b", "c"]);
  });

  it("ignores blanks and duplicates", () => {
    const repo = make("alpha", "alpha", false);
    service.setAccess(repo.id, ["a", "a", "  ", "", " b "]);
    expect(service.getAccess(repo.id)).toEqual(["a", "b"]);
  });

  it("listForCaller drops private repos instead of returning them to be filtered", () => {
    make("alpha", "alpha", true);
    const priv = make("beta", "nested/beta", false);
    service.setAccess(priv.id, ["agent-1"]);

    expect(service.listForCaller("agent-1").map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
    expect(service.listForCaller("agent-2").map((r) => r.name)).toEqual(["alpha"]);
    expect(service.listForCaller("").map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("validatePath and the container boundary", () => {
  it("says the kernel cannot see a path outside its mounted roots", () => {
    const res = RepoService.validatePath("/home/someone/code/thing", ["/mnt/projects"]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // The old message was "path does not exist", which the operator knows to
    // be false — the path exists on their machine, just not in the container.
    expect(res.error).toContain("cannot see");
    expect(res.error).toContain("/mnt/projects");
    expect(res.error).not.toBe("path does not exist: /home/someone/code/thing");
  });

  it("still says 'does not exist' for a path under a root that really is missing", () => {
    const res = RepoService.validatePath("/mnt/projects/gone", ["/mnt/projects"]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("does not exist");
  });

  it("falls back to the plain message when no roots are known", () => {
    const res = RepoService.validatePath("/nope/nothing", []);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("does not exist");
  });
});

describe("discoverCandidates", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "repos-scan-"));
    mkdirSync(join(root, "alpha", ".git"), { recursive: true });
    mkdirSync(join(root, "nested", "beta", ".git"), { recursive: true });
    mkdirSync(join(root, "nested", "beta", "sub", ".git"), { recursive: true });
    mkdirSync(join(root, "plain-dir"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg", ".git"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds checkouts under the roots and names them by their directory", () => {
    const found = RepoService.discoverCandidates([root]);
    expect(found.map((c) => c.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("does not descend into a checkout looking for more checkouts", () => {
    expect(RepoService.discoverCandidates([root]).some((c) => c.path.endsWith("/sub"))).toBe(false);
  });

  it("skips node_modules and plain directories", () => {
    const paths = RepoService.discoverCandidates([root]).map((c) => c.path);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.endsWith("plain-dir"))).toBe(false);
  });

  it("is empty and does not throw when a root is unreadable or absent", () => {
    expect(RepoService.discoverCandidates(["/definitely/not/here"])).toEqual([]);
    expect(RepoService.discoverCandidates([])).toEqual([]);
  });
});
