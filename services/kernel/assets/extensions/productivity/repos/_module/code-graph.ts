/**
 * A repo's history as a graph: which files change most, who knows them, and
 * what tends to change with what.
 *
 *   (:CodeFile {repo_id, path, commits, churn, owner, owner_share})-[:IN_REPO]->(:CodeRepo)
 *   (:CodeAuthor {email, name})-[:AUTHORED {commits, lines, last_at}]->(:CodeFile)
 *   (:CodeFile)-[:CO_CHANGED {count, conf_ab, conf_ba}]->(:CodeFile)
 *
 * Built from `git log --numstat` over a window (a year, at most a few thousand
 * commits) and rebuilt whenever HEAD moves, so it is derived data: nothing here
 * is the only copy of anything, and a new store gets it again on first use.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GraphDriver } from "@kernl/extension-sdk";

const execFileAsync = promisify(execFile);

export interface Commit {
  sha: string;
  email: string;
  name: string;
  at: string;
  files: Array<{ path: string; added: number; deleted: number }>;
}

/** Commits touching more files than this are bulk changes (formatting, renames, vendoring): they say nothing about coupling. */
export const MAX_FILES_FOR_COUPLING = 40;
const MIN_PAIR_COUNT = 2;
const PARTNERS_PER_FILE = 20;

const RS = "\x1e";
const US = "\x1f";

export function logArgs(opts: { sinceDays: number; maxCommits: number }): string[] {
  return [
    "log", "--no-merges", "--no-color", "--numstat", "-M",
    `--since=${Math.floor(opts.sinceDays)}.days`, "-n", String(Math.floor(opts.maxCommits)),
    // %aE/%aN honour .mailmap, so one person with two addresses can be one author.
    `--format=${RS}%H${US}%aE${US}%aN${US}%at`,
  ];
}

/** `src/{a => b}/x.ts` and `a.ts => b.ts` name the file as it is after the rename. */
export function renamedPath(p: string): string {
  const braced = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\/+/g, "/");
  const plain = p.split(" => ");
  return plain.length === 2 ? plain[1] : p;
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const chunk of out.split(RS)) {
    const lines = chunk.split("\n");
    const head = lines[0]?.split(US);
    if (!head || head.length < 4) continue;
    const [sha, email, name, unix] = head;
    const at = new Date(Number(unix) * 1000).toISOString();
    const files: Commit["files"] = [];
    for (const l of lines.slice(1)) {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push({ path: renamedPath(m[3]), added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
    }
    commits.push({ sha, email: email.toLowerCase(), name, at, files });
  }
  return commits;
}

export interface FileStats {
  path: string;
  commits: number;
  added: number;
  deleted: number;
  churn: number;
  last_at: string;
  owner: string;
  owner_share: number;
  authors: number;
}

export interface CodeGraphData {
  files: FileStats[];
  authors: Array<{ email: string; name: string }>;
  authored: Array<{ email: string; path: string; commits: number; lines: number; last_at: string }>;
  pairs: Array<{ a: string; b: string; count: number; conf_ab: number; conf_ba: number }>;
}

export function aggregate(commits: Commit[], opts: { exists?: (path: string) => boolean } = {}): CodeGraphData {
  const files = new Map<string, Omit<FileStats, "owner" | "owner_share" | "authors"> & { by: Map<string, { commits: number; lines: number; last_at: string }> }>();
  const names = new Map<string, string>();
  const pairs = new Map<string, number>();
  for (const c of commits) {
    if (!names.has(c.email)) names.set(c.email, c.name); // newest name wins: log is newest first
    const paths = [...new Set(c.files.map((f) => f.path))].filter((p) => !opts.exists || opts.exists(p));
    for (const f of c.files) {
      if (opts.exists && !opts.exists(f.path)) continue;
      let s = files.get(f.path);
      if (!s) {
        s = { path: f.path, commits: 0, added: 0, deleted: 0, churn: 0, last_at: c.at, by: new Map() };
        files.set(f.path, s);
      }
      s.added += f.added;
      s.deleted += f.deleted;
      s.churn += f.added + f.deleted;
      if (c.at > s.last_at) s.last_at = c.at;
      const a = s.by.get(c.email) ?? { commits: 0, lines: 0, last_at: c.at };
      a.lines += f.added + f.deleted;
      if (c.at > a.last_at) a.last_at = c.at;
      s.by.set(c.email, a);
    }
    for (const p of paths) {
      const s = files.get(p)!;
      s.commits++;
      s.by.get(c.email)!.commits++;
    }
    if (paths.length > 1 && paths.length <= MAX_FILES_FOR_COUPLING) {
      paths.sort();
      for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
          const k = `${paths[i]}\0${paths[j]}`;
          pairs.set(k, (pairs.get(k) ?? 0) + 1);
        }
      }
    }
  }

  const out: CodeGraphData = { files: [], authors: [], authored: [], pairs: [] };
  for (const s of files.values()) {
    let owner = "";
    let best = -1;
    let total = 0;
    for (const [email, a] of s.by) {
      total += a.commits;
      if (a.commits > best || (a.commits === best && email < owner)) { best = a.commits; owner = email; }
      out.authored.push({ email, path: s.path, commits: a.commits, lines: a.lines, last_at: a.last_at });
    }
    const { by, ...rest } = s;
    out.files.push({ ...rest, owner, owner_share: total ? round(best / total) : 0, authors: by.size });
  }
  for (const [email, name] of names) if (out.authored.some((a) => a.email === email)) out.authors.push({ email, name });

  // Keep the strongest partners of each file, so a hub cannot fill the graph with weak edges.
  const kept = new Set<string>();
  const byFile = new Map<string, Array<[string, number]>>();
  for (const [k, n] of pairs) {
    if (n < MIN_PAIR_COUNT) continue;
    const [a, b] = k.split("\0");
    for (const p of [a, b]) {
      const l = byFile.get(p) ?? [];
      l.push([k, n]);
      byFile.set(p, l);
    }
  }
  for (const l of byFile.values()) {
    l.sort((x, y) => y[1] - x[1]);
    for (const [k] of l.slice(0, PARTNERS_PER_FILE)) kept.add(k);
  }
  for (const k of kept) {
    const [a, b] = k.split("\0");
    const n = pairs.get(k)!;
    out.pairs.push({ a, b, count: n, conf_ab: round(n / files.get(a)!.commits), conf_ba: round(n / files.get(b)!.commits) });
  }
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

async function git(cwd: string, argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", argv, { cwd, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export interface BuildResult {
  head: string;
  commits: number;
  files: number;
  authors: number;
  pairs: number;
  rebuilt: boolean;
  ms: number;
}

export class CodeGraph {
  private building = new Map<string, Promise<BuildResult>>();

  constructor(private graph: () => GraphDriver | null | undefined) {}

  private g(): GraphDriver {
    const g = this.graph();
    if (!g?.capabilities.cypher) throw new Error("The code graph needs the graph database, and it is not available.");
    return g;
  }

  async ensureSchema(): Promise<void> {
    const g = this.g();
    await g.run("CREATE INDEX code_file_repo IF NOT EXISTS FOR (f:CodeFile) ON (f.repo_id)");
    await g.run("CREATE INDEX code_file_key IF NOT EXISTS FOR (f:CodeFile) ON (f.key)");
    await g.run("CREATE INDEX code_author_email IF NOT EXISTS FOR (a:CodeAuthor) ON (a.email)");
    await g.run("CREATE INDEX code_repo_id IF NOT EXISTS FOR (r:CodeRepo) ON (r.id)");
  }

  /** Rebuild when HEAD moved since the last build (or `force`). One build per repo at a time. */
  build(repo: { id: string; name: string; path: string }, opts: { force?: boolean; sinceDays?: number; maxCommits?: number } = {}): Promise<BuildResult> {
    const running = this.building.get(repo.id);
    if (running) return running;
    const p = this.doBuild(repo, opts).finally(() => this.building.delete(repo.id));
    this.building.set(repo.id, p);
    return p;
  }

  private async doBuild(repo: { id: string; name: string; path: string }, opts: { force?: boolean; sinceDays?: number; maxCommits?: number }): Promise<BuildResult> {
    const t0 = Date.now();
    const g = this.g();
    const head = (await git(repo.path, ["rev-parse", "HEAD"])).trim();
    const sinceDays = opts.sinceDays ?? 365;
    const maxCommits = opts.maxCommits ?? 3000;
    const prev = await g.run(
      "MATCH (r:CodeRepo {id: $id}) RETURN r.head AS head, r.since_days AS since, r.max_commits AS max, r.commits AS commits, r.files AS files, r.authors AS authors, r.pairs AS pairs",
      { id: repo.id },
    );
    const p = prev.records[0];
    if (!opts.force && p && p.get("head") === head && Number(p.get("since")) === sinceDays && Number(p.get("max")) === maxCommits) {
      return { head, commits: Number(p.get("commits")), files: Number(p.get("files")), authors: Number(p.get("authors")), pairs: Number(p.get("pairs")), rebuilt: false, ms: Date.now() - t0 };
    }

    const commits = parseLog(await git(repo.path, logArgs({ sinceDays, maxCommits })));
    const tracked = new Set((await git(repo.path, ["ls-files", "-z"])).split("\0").filter(Boolean));
    const data = aggregate(commits, { exists: (p) => tracked.has(p) });

    await this.ensureSchema();
    await g.run("MATCH (f:CodeFile {repo_id: $id}) DETACH DELETE f", { id: repo.id });
    await g.run(
      `MERGE (r:CodeRepo {id: $id})
       SET r.name = $name, r.head = $head, r.since_days = $since, r.max_commits = $max, r.built_at = $at,
           r.commits = $commits, r.files = $files, r.authors = $authors, r.pairs = $pairs`,
      { id: repo.id, name: repo.name, head, since: sinceDays, max: maxCommits, at: new Date().toISOString(),
        commits: commits.length, files: data.files.length, authors: data.authors.length, pairs: data.pairs.length },
    );
    for (const rows of chunks(data.files.map((f) => ({ ...f, key: `${repo.id}:${f.path}` })), 500)) {
      await g.run(
        `MATCH (r:CodeRepo {id: $id})
         UNWIND $rows AS row
         CREATE (f:CodeFile {key: row.key, repo_id: $id, path: row.path, name: row.path, commits: row.commits, added: row.added,
                             deleted: row.deleted, churn: row.churn, last_at: row.last_at, owner: row.owner,
                             owner_share: row.owner_share, authors: row.authors})
         CREATE (f)-[:IN_REPO]->(r)`,
        { id: repo.id, rows },
      );
    }
    for (const rows of chunks(data.authors, 500)) {
      await g.run("UNWIND $rows AS row MERGE (a:CodeAuthor {email: row.email}) SET a.name = row.name", { rows });
    }
    for (const rows of chunks(data.authored.map((a) => ({ ...a, key: `${repo.id}:${a.path}` })), 500)) {
      await g.run(
        `UNWIND $rows AS row
         MATCH (a:CodeAuthor {email: row.email})
         MATCH (f:CodeFile {key: row.key})
         CREATE (a)-[:AUTHORED {commits: row.commits, lines: row.lines, last_at: row.last_at}]->(f)`,
        { rows },
      );
    }
    for (const rows of chunks(data.pairs.map((p) => ({ ...p, ka: `${repo.id}:${p.a}`, kb: `${repo.id}:${p.b}` })), 500)) {
      await g.run(
        `UNWIND $rows AS row
         MATCH (a:CodeFile {key: row.ka})
         MATCH (b:CodeFile {key: row.kb})
         CREATE (a)-[:CO_CHANGED {count: row.count, conf_ab: row.conf_ab, conf_ba: row.conf_ba}]->(b)`,
        { rows },
      );
    }
    // Authors left with no file in any repo.
    await g.run("MATCH (a:CodeAuthor) WHERE NOT (a)-[:AUTHORED]->() DETACH DELETE a");
    return { head, commits: commits.length, files: data.files.length, authors: data.authors.length, pairs: data.pairs.length, rebuilt: true, ms: Date.now() - t0 };
  }

  async hotspots(repoId: string, opts: { prefix?: string; limit?: number } = {}) {
    const r = await this.g().run(
      `MATCH (f:CodeFile {repo_id: $id})
       WHERE $prefix = '' OR f.path STARTS WITH $prefix
       RETURN f.path AS path, f.commits AS commits, f.churn AS churn, f.authors AS authors,
              f.owner AS owner, f.owner_share AS owner_share, f.last_at AS last_at
       ORDER BY f.commits DESC, f.churn DESC LIMIT $limit`,
      { id: repoId, prefix: opts.prefix ?? "", limit: Math.floor(opts.limit ?? 20) },
    );
    return r.records.map((x) => ({
      path: x.get("path") as string,
      commits: Number(x.get("commits")),
      churn: Number(x.get("churn")),
      authors: Number(x.get("authors")),
      owner: x.get("owner") as string,
      owner_share: Number(x.get("owner_share")),
      last_at: x.get("last_at") as string,
    }));
  }

  /** Who knows a file, or everything under a directory. */
  async owners(repoId: string, path: string, limit = 10) {
    const dir = path.replace(/\/+$/, "");
    const r = await this.g().run(
      `MATCH (a:CodeAuthor)-[e:AUTHORED]->(f:CodeFile {repo_id: $id})
       WHERE $path = '' OR f.path = $path OR f.path STARTS WITH $dir
       RETURN a.email AS email, a.name AS name, sum(e.commits) AS commits, sum(e.lines) AS lines,
              count(f) AS files, max(e.last_at) AS last_at
       ORDER BY commits DESC, lines DESC LIMIT $limit`,
      { id: repoId, path: dir, dir: dir ? `${dir}/` : "", limit: Math.floor(limit) },
    );
    const rows = r.records.map((x) => ({
      email: x.get("email") as string,
      name: x.get("name") as string,
      commits: Number(x.get("commits")),
      lines: Number(x.get("lines")),
      files: Number(x.get("files")),
      last_at: x.get("last_at") as string,
    }));
    const total = rows.reduce((s, x) => s + x.commits, 0);
    return rows.map((x) => ({ ...x, share: total ? round(x.commits / total) : 0 }));
  }

  /** Files that usually change together with these, strongest first, and who knows them. */
  async impact(repoId: string, paths: string[], limit = 15) {
    const known = await this.g().run(
      "MATCH (f:CodeFile {repo_id: $id}) WHERE f.path IN $paths RETURN f.path AS path, f.commits AS commits",
      { id: repoId, paths },
    );
    const found = new Map(known.records.map((x) => [x.get("path") as string, Number(x.get("commits"))]));
    const r = await this.g().run(
      `MATCH (f:CodeFile {repo_id: $id}) WHERE f.path IN $paths
       MATCH (f)-[c:CO_CHANGED]-(g:CodeFile)
       WHERE NOT g.path IN $paths
       WITH g, f, c, CASE WHEN startNode(c) = f THEN c.conf_ab ELSE c.conf_ba END AS conf
       RETURN g.path AS path, max(conf) AS confidence, sum(c.count) AS together, collect(f.path) AS because,
              g.owner AS owner, g.commits AS commits
       ORDER BY confidence DESC, together DESC LIMIT $limit`,
      { id: repoId, paths, limit: Math.floor(limit) },
    );
    return {
      unknown: paths.filter((p) => !found.has(p)),
      related: r.records.map((x) => ({
        path: x.get("path") as string,
        confidence: Number(x.get("confidence")),
        together: Number(x.get("together")),
        because: x.get("because") as string[],
        owner: x.get("owner") as string,
        commits: Number(x.get("commits")),
      })),
    };
  }
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
