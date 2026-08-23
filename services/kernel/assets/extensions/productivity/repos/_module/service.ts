import { existsSync, statSync, readdirSync } from "node:fs";
import { resolve, sep as pathSep } from "node:path";
import { execFileSync } from "node:child_process";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import type { Repo, CreateRepoInput, UpdateRepoInput } from "./types.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-_]{0,62}$/;

/**
 * Best-effort sniff of the dominant language by counting top-level extensions.
 * Cheap signal — never blocks register, never trusts the result for safety.
 */
function detectLanguage(absPath: string): string {
  try {
    const entries = readdirSync(absPath, { withFileTypes: true });
    const counts: Record<string, number> = {};
    for (const e of entries) {
      if (!e.isFile()) continue;
      const dot = e.name.lastIndexOf(".");
      if (dot <= 0) continue;
      const ext = e.name.slice(dot + 1).toLowerCase();
      counts[ext] = (counts[ext] ?? 0) + 1;
    }
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) return "";
    const top = ranked[0][0];
    const map: Record<string, string> = {
      ts: "typescript", tsx: "typescript",
      js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
      py: "python", rb: "ruby", go: "go", rs: "rust",
      java: "java", kt: "kotlin", swift: "swift",
      c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
      cs: "csharp", php: "php", lua: "lua", sh: "shell",
      md: "docs",
    };
    return map[top] ?? top;
  } catch {
    return "";
  }
}

function gitProbe(absPath: string): { remote_url: string; default_branch: string } {
  let remote_url = "";
  let default_branch = "";
  try {
    remote_url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: absPath, encoding: "utf8", timeout: 3000,
    }).trim();
  } catch { /* not a git repo or no remote */ }
  try {
    // Strip the `refs/remotes/origin/` prefix.
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: absPath, encoding: "utf8", timeout: 3000,
    }).trim();
    default_branch = ref.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    // Fall back to current HEAD branch if origin/HEAD isn't set (fresh clone, no upstream).
    try {
      default_branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: absPath, encoding: "utf8", timeout: 3000,
      }).trim();
    } catch { /* not a git repo */ }
  }
  return { remote_url, default_branch };
}

export class RepoService {
  constructor(private db: SqliteDb) {}

  /** Reject names that would clash with shell flags or path traversal. */
  static validateName(name: string): string | null {
    if (!SLUG_RE.test(name)) {
      return `Invalid name: must match ${SLUG_RE.source} (lowercase, digits, dash/underscore, max 63 chars).`;
    }
    return null;
  }

  /**
   * Normalize + sanity-check a path: absolute, exists, is a directory.
   *
   * `visibleRoots` is what makes the failure honest. This check runs inside
   * the kernel's container, which sees only what was mounted into it — so a
   * perfectly real path on the operator's machine fails here, and the old
   * message ("path does not exist") told them something they knew to be
   * false. When the roots are known, say what the kernel can actually reach.
   */
  static validatePath(
    p: string,
    visibleRoots: string[] = [],
  ): { ok: true; path: string } | { ok: false; error: string } {
    if (!p) return { ok: false, error: "path is required" };
    const abs = resolve(p);
    if (abs !== p && !p.startsWith("/")) {
      // Tool callers should always pass absolute paths; we resolve relative
      // ones against the kernel CWD, which is rarely what they want.
      return { ok: false, error: `path must be absolute (got: ${p})` };
    }
    if (!existsSync(abs)) {
      const roots = visibleRoots.filter(Boolean);
      if (roots.length > 0) {
        const under = roots.some((r) => abs === r || abs.startsWith(r.replace(/\/+$/, "") + "/"));
        return {
          ok: false,
          error: under
            ? `path does not exist: ${abs}`
            : `the kernel cannot see ${abs}. It runs in a container and only has ` +
              `${roots.join(", ")} mounted, so paths outside that are invisible to it ` +
              `even when they exist on your machine. Move the checkout under one of ` +
              `those roots, or add a mount for it.`,
        };
      }
      return { ok: false, error: `path does not exist: ${abs}` };
    }
    let st;
    try { st = statSync(abs); } catch (e) { return { ok: false, error: `stat failed: ${String(e)}` }; }
    if (!st.isDirectory()) return { ok: false, error: `path is not a directory: ${abs}` };
    return { ok: true, path: abs.replace(/\/+$/, "") };
  }

  create(
    input: CreateRepoInput,
    opts?: { visibleRoots?: string[] },
  ): { ok: true; repo: Repo } | { ok: false; error: string } {
    const nameErr = RepoService.validateName(input.name);
    if (nameErr) return { ok: false, error: nameErr };

    const pathCheck = RepoService.validatePath(input.path, opts?.visibleRoots ?? []);
    if (!pathCheck.ok) return pathCheck;

    const existingByName = this.getByName(input.name);
    if (existingByName) return { ok: false, error: `repo with name "${input.name}" already exists` };

    const existingByPath = this.getByPath(pathCheck.path);
    if (existingByPath) return { ok: false, error: `repo at path "${pathCheck.path}" already registered as "${existingByPath.name}"` };

    const now = isoNow();
    const probe = gitProbe(pathCheck.path);
    const repo: Repo = {
      id: newId(),
      name: input.name,
      path: pathCheck.path,
      description: input.description ?? "",
      tags: input.tags ?? "",
      default_branch: probe.default_branch,
      remote_url: probe.remote_url,
      language: detectLanguage(pathCheck.path),
      shared: input.shared === false ? 0 : 1,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    this.db.prepare(
      `INSERT INTO repos
         (id, name, path, description, tags, default_branch, remote_url, language,
          shared, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      repo.id, repo.name, repo.path, repo.description, repo.tags,
      repo.default_branch, repo.remote_url, repo.language,
      repo.shared, repo.last_seen_at, repo.created_at, repo.updated_at,
    );

    return { ok: true, repo };
  }

  getById(id: string): Repo | undefined {
    return this.db.prepare("SELECT * FROM repos WHERE id = ? AND deleted_at IS NULL").get(id) as Repo | undefined;
  }

  getByName(name: string): Repo | undefined {
    return this.db.prepare("SELECT * FROM repos WHERE name = ? AND deleted_at IS NULL").get(name) as Repo | undefined;
  }

  getByPath(path: string): Repo | undefined {
    return this.db.prepare("SELECT * FROM repos WHERE path = ? AND deleted_at IS NULL").get(path) as Repo | undefined;
  }

  /** Resolve a repo from either its id or name. Caller-friendly. */
  resolve(ref: { id?: string; name?: string }): Repo | undefined {
    if (ref.id) return this.getById(ref.id);
    if (ref.name) return this.getByName(ref.name);
    return undefined;
  }

  // ── Access ────────────────────────────────────────────────────────
  //
  // `shared = 1` (the default, and every pre-existing row) means any agent.
  // `shared = 0` means only the agents listed in `repo_access`.
  //
  // A caller with no agent id is a human at the dashboard or a kernel-internal
  // call, and sees everything — the same convention the agents module already
  // uses ("Human calls bypass the gate"), and the only one under which the
  // dashboard can manage a repo it just made private.

  setAccess(repoId: string, agentIds: string[]): void {
    const now = isoNow();
    const unique = [...new Set(agentIds.map((a) => a.trim()).filter(Boolean))];
    const trx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM repo_access WHERE repo_id = ?").run(repoId);
      const ins = this.db.prepare(
        "INSERT OR IGNORE INTO repo_access (repo_id, agent_id, created_at) VALUES (?, ?, ?)",
      );
      for (const a of unique) ins.run(repoId, a, now);
    });
    trx();
  }

  getAccess(repoId: string): string[] {
    return (
      this.db
        .prepare("SELECT agent_id FROM repo_access WHERE repo_id = ? ORDER BY agent_id")
        .all(repoId) as Array<{ agent_id: string }>
    ).map((r) => r.agent_id);
  }

  /** May `callerAgentId` reach this repo? An empty caller is a human. */
  canAccess(repo: Pick<Repo, "id" | "shared">, callerAgentId: string): boolean {
    if (!callerAgentId) return true;
    if (repo.shared) return true;
    const row = this.db
      .prepare("SELECT 1 FROM repo_access WHERE repo_id = ? AND agent_id = ?")
      .get(repo.id, callerAgentId);
    return !!row;
  }

  /**
   * Repos this caller may reach. Filtering in SQL rather than after the fact,
   * so a private repo never rides along in a payload and gets dropped by the
   * consumer — the name and path are the sensitive part.
   */
  listForCaller(callerAgentId: string, filters?: { tag?: string; query?: string; limit?: number }): Repo[] {
    const all = this.list(filters);
    if (!callerAgentId) return all;
    const allowed = new Set(
      (
        this.db
          .prepare("SELECT repo_id FROM repo_access WHERE agent_id = ?")
          .all(callerAgentId) as Array<{ repo_id: string }>
      ).map((r) => r.repo_id),
    );
    return all.filter((r) => r.shared || allowed.has(r.id));
  }

  /**
   * Git checkouts the kernel can actually see, so the register form can offer
   * a list instead of a free-text box that fails on paths it was never able
   * to reach. Depth-limited: a repo three levels below a mounted root is
   * findable, a full filesystem walk is not worth the stat storm.
   */
  static discoverCandidates(roots: string[], maxDepth = 3): Array<{ path: string; name: string }> {
    const out: Array<{ path: string; name: string }> = [];
    const seen = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || out.length >= 200) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (entries.some((e) => e.name === ".git")) {
        const abs = dir.replace(/\/+$/, "");
        if (!seen.has(abs)) {
          seen.add(abs);
          out.push({ path: abs, name: abs.slice(abs.lastIndexOf("/") + 1) });
        }
        return; // Don't descend into a checkout looking for more checkouts.
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        walk(`${dir}/${e.name}`, depth + 1);
      }
    };
    for (const r of roots.filter(Boolean)) walk(resolve(r), 0);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  list(filters?: { tag?: string; query?: string; limit?: number }): Repo[] {
    let sql = "SELECT * FROM repos WHERE deleted_at IS NULL";
    const params: unknown[] = [];
    if (filters?.tag) {
      const needle = filters.tag.replace(/^#/, "");
      sql += " AND (' ' || REPLACE(tags, ',', ' ') || ' ') LIKE ?";
      params.push(`% ${needle} %`);
    }
    if (filters?.query) {
      sql += " AND (name LIKE ? OR description LIKE ? OR path LIKE ?)";
      const needle = `%${filters.query}%`;
      params.push(needle, needle, needle);
    }
    sql += " ORDER BY updated_at DESC";
    if (filters?.limit) { sql += " LIMIT ?"; params.push(filters.limit); }
    return this.db.prepare(sql).all(...params) as Repo[];
  }

  update(id: string, patch: UpdateRepoInput): Repo | undefined {
    const cur = this.getById(id);
    if (!cur) return undefined;
    if (patch.name !== undefined) {
      const err = RepoService.validateName(patch.name);
      if (err) throw new Error(err);
      const clash = this.getByName(patch.name);
      if (clash && clash.id !== id) throw new Error(`name "${patch.name}" already in use`);
    }
    const next: Repo = {
      ...cur,
      name: patch.name ?? cur.name,
      description: patch.description ?? cur.description,
      tags: patch.tags ?? cur.tags,
      shared: patch.shared === undefined ? cur.shared : (patch.shared ? 1 : 0),
      updated_at: isoNow(),
    };
    this.db.prepare(
      `UPDATE repos SET name = ?, description = ?, tags = ?, shared = ?, updated_at = ? WHERE id = ?`,
    ).run(next.name, next.description, next.tags, next.shared, next.updated_at, id);
    return this.getById(id);
  }

  /** Soft delete — files on disk are NEVER touched. */
  unregister(id: string): boolean {
    const res = this.db.prepare("UPDATE repos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(isoNow(), id);
    return res.changes > 0;
  }

  /** Update last_seen_at after a successful access. */
  touch(id: string): void {
    this.db.prepare("UPDATE repos SET last_seen_at = ?, updated_at = ? WHERE id = ?").run(isoNow(), isoNow(), id);
  }

  /**
   * Resolve a path RELATIVE to a repo's root and reject any traversal that
   * would escape it. Returns the absolute path on success.
   */
  static jailPath(repo: Repo, relPath: string): { ok: true; abs: string } | { ok: false; error: string } {
    const cleanRel = (relPath ?? "").replace(/^\/+/, "");
    const abs = resolve(repo.path, cleanRel);
    const root = repo.path.endsWith(pathSep) ? repo.path : repo.path + pathSep;
    if (abs !== repo.path && !abs.startsWith(root)) {
      return { ok: false, error: `path escapes repo root: ${relPath}` };
    }
    return { ok: true, abs };
  }
}
