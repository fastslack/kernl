/**
 * What an id names — an office, an agent, a run or a project — for scope checks
 * (core/scope.ts). Asked for every id in a restricted user's request and
 * every item in the response, so it answers from memory:
 *
 *   * offices and agents are few (dozens, hundreds): all of them are loaded
 *     at once and reloaded when the copy is a couple of seconds old, so a
 *     new agent is in scope almost at once;
 *   * runs are many: looked up one by one and remembered (a run never
 *     changes agent).
 *
 * Reads the agents module's tables directly. If they are not there (the
 * module failed to start), nothing is an agent, office or run, and only
 * the explicit grants stand.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { RefKind } from "../../core/scope.js";

const RELOAD_AFTER_MS = 2_000;
const MAX_RUNS_REMEMBERED = 20_000;

export class RefIndex {
  private offices = new Set<string>();
  private agents = new Map<string, string>();
  private projects = new Set<string>();
  /** officeId → the projects it works on (linked, or their home office). */
  private officeProjects = new Map<string, string[]>();
  private loadedAt = 0;
  private runs = new Map<string, { agentId: string }>();
  /** Ids that were not runs at the last look; forgotten on every reload. */
  private notRuns = new Set<string>();

  constructor(private db: SqliteDb, private nowMs: () => number = () => Date.now()) {}

  /** Forget the cached copy (tests, and right after a grant is changed). */
  invalidate(): void {
    this.loadedAt = 0;
  }

  lookup(id: string): RefKind | null {
    this.refresh();
    if (this.offices.has(id)) return { kind: "office", projects: this.officeProjects.get(id) ?? [] };
    if (this.projects.has(id)) return { kind: "project" };
    const officeId = this.agents.get(id);
    if (officeId !== undefined) return { kind: "agent", officeId };
    const run = this.run(id);
    if (run) return { kind: "run", agentId: run.agentId, officeId: this.agents.get(run.agentId) ?? "" };
    return null;
  }

  isOffice(id: string): boolean {
    this.refresh();
    return this.offices.has(id);
  }

  isAgent(id: string): boolean {
    this.refresh();
    return this.agents.has(id);
  }

  isProject(id: string): boolean {
    this.refresh();
    return this.projects.has(id);
  }

  private refresh(): void {
    const now = this.nowMs();
    if (now - this.loadedAt < RELOAD_AFTER_MS) return;
    this.loadedAt = now;
    this.notRuns.clear();
    try {
      const flows = this.db.prepare(`SELECT id FROM agent_flows`).all() as Array<{ id: string }>;
      this.offices = new Set(flows.map((f) => f.id));
    } catch {
      this.offices = new Set();
    }
    try {
      const rows = this.db.prepare(`SELECT id, flow_id FROM agents`).all() as Array<{ id: string; flow_id: string | null }>;
      this.agents = new Map(rows.map((a) => [a.id, a.flow_id ?? ""]));
    } catch {
      this.agents = new Map();
    }
    try {
      const rows = this.db.prepare(`SELECT id, home_flow_id FROM projects`).all() as Array<{ id: string; home_flow_id: string | null }>;
      this.projects = new Set(rows.map((p) => p.id));
      // An office works on a project when it is linked to it, or is its home.
      const links = new Map<string, Set<string>>();
      const link = (office: string | null, project: string) => {
        if (!office) return;
        let set = links.get(office);
        if (!set) links.set(office, (set = new Set()));
        set.add(project);
      };
      for (const p of rows) link(p.home_flow_id, p.id);
      try {
        const op = this.db.prepare(`SELECT flow_id, project_id FROM office_projects WHERE active = 1`).all() as Array<{ flow_id: string; project_id: string }>;
        for (const r of op) link(r.flow_id, r.project_id);
      } catch { /* no office links yet: homes only */ }
      this.officeProjects = new Map([...links].map(([k, v]) => [k, [...v]]));
    } catch {
      this.projects = new Set();
      this.officeProjects = new Map();
    }
  }

  private run(id: string): { agentId: string } | null {
    const hit = this.runs.get(id);
    if (hit) return hit;
    if (this.notRuns.has(id)) return null;
    let found: { agentId: string } | null = null;
    try {
      const row = this.db.prepare(`SELECT agent_id FROM agent_runs WHERE id = ?`).get(id) as { agent_id: string } | undefined;
      found = row ? { agentId: row.agent_id } : null;
    } catch {
      found = null;
    }
    if (found) {
      if (this.runs.size >= MAX_RUNS_REMEMBERED) this.runs.clear();
      this.runs.set(id, found);
    } else if (this.notRuns.size < MAX_RUNS_REMEMBERED) {
      // A miss may become a run later; the reload clears this every couple of seconds.
      this.notRuns.add(id);
    }
    return found;
  }
}
