import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import { newId, isoNow } from "../../core/helpers.js";
import { encrypt, decrypt, generateKey } from "../../sdk/crypto.js";
import { parseBrief, renderBriefMarkdown, SLUG_RE, RESERVED_SLUGS } from "./brief.js";
import { buildProjectContext } from "./project-context.js";
import type { Project, ProjectBrief, ProjectLink, ProjectLinkKind, ProjectStatus, OfficeProject } from "./types.js";

interface ProjectRow {
  id: string; slug: string; name: string; status: ProjectStatus; brief: string;
  connector_url: string; connector_token: string; webhook_secret: string;
  last_pull_at: string | null; last_webhook_at: string | null; connector_error: string;
  pull_since: string | null; home_flow_id: string;
  created_at: string; updated_at: string;
}

interface OfficeProjectRow {
  flow_id: string; project_id: string; active: number; settings: string; created_at: string; updated_at: string;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id, slug: r.slug, name: r.name, status: r.status,
    brief: JSON.parse(r.brief || "{}") as ProjectBrief,
    connector_url: r.connector_url, has_connector_token: r.connector_token !== "",
    last_pull_at: r.last_pull_at, last_webhook_at: r.last_webhook_at,
    connector_error: r.connector_error, home_flow_id: r.home_flow_id ?? "", created_at: r.created_at, updated_at: r.updated_at,
  };
}

/**
 * Owns `projects`, `project_links` and `office_projects`, plus each project's
 * home on disk (data/projects/{slug}/: BRIEF.md, MEMORY.md, assets/).
 */
export class ProjectsService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private opts: { encryptionKey: string; projectsRoot: string },
  ) {}

  private row(idOrSlug: string): ProjectRow | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ? OR slug = ?").get(idOrSlug, idOrSlug) as ProjectRow | undefined;
  }

  create(input: { slug: string; name: string; brief: ProjectBrief }): Project {
    const slug = input.slug.trim();
    if (!SLUG_RE.test(slug)) throw new Error(`Invalid slug "${slug}" — lowercase letters, digits and dashes`);
    if (RESERVED_SLUGS.has(slug)) throw new Error(`Slug "${slug}" is reserved`);
    if (this.row(slug)) throw new Error(`Project "${slug}" already exists`);
    const brief = parseBrief(input.brief);
    const now = isoNow();
    const id = newId();
    this.db.prepare(
      `INSERT INTO projects (id, slug, name, status, brief, webhook_secret, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(id, slug, input.name.trim() || slug, JSON.stringify(brief), encrypt(generateKey(), this.opts.encryptionKey), now, now);
    this.events.emit("data.changed", { module: "projects", action: "created" });
    return this.get(id)!;
  }

  get(idOrSlug: string): Project | undefined {
    const r = this.row(idOrSlug);
    return r ? toProject(r) : undefined;
  }

  list(filter: { flowId?: string; status?: ProjectStatus } = {}): Project[] {
    let sql = "SELECT p.* FROM projects p";
    const params: unknown[] = [];
    if (filter.flowId) { sql += " JOIN office_projects op ON op.project_id = p.id AND op.flow_id = ?"; params.push(filter.flowId); }
    sql += " WHERE 1=1";
    if (filter.status) { sql += " AND p.status = ?"; params.push(filter.status); }
    sql += " ORDER BY p.name";
    return (this.db.prepare(sql).all(...params) as ProjectRow[]).map(toProject);
  }

  update(id: string, patch: { name?: string; status?: ProjectStatus; brief?: ProjectBrief; home_flow_id?: string }): Project {
    const cur = this.row(id);
    if (!cur) throw new Error(`Project not found: ${id}`);
    const brief = patch.brief ? JSON.stringify(parseBrief(patch.brief)) : cur.brief;
    if (patch.home_flow_id && !this.db.prepare("SELECT 1 FROM agent_flows WHERE id = ? AND active = 1").get(patch.home_flow_id)) {
      throw new Error(`Office not found: ${patch.home_flow_id}`);
    }
    this.db.prepare("UPDATE projects SET name = ?, status = ?, brief = ?, home_flow_id = ?, updated_at = ? WHERE id = ?")
      .run(patch.name?.trim() || cur.name, patch.status ?? cur.status, brief, patch.home_flow_id ?? cur.home_flow_id ?? "", isoNow(), cur.id);
    if (patch.status && patch.status !== cur.status) {
      const flows = this.db.prepare("SELECT flow_id FROM office_projects WHERE project_id = ?").all(cur.id) as Array<{ flow_id: string }>;
      for (const f of flows) this.syncOfficeSchedules(f.flow_id);
    }
    this.events.emit("data.changed", { module: "projects", action: "updated" });
    return this.get(cur.id)!;
  }

  /** Connector config. `token` undefined keeps the stored one; "" clears it. */
  setConnector(id: string, input: { url: string; token?: string }): Project {
    const cur = this.row(id);
    if (!cur) throw new Error(`Project not found: ${id}`);
    const token = input.token === undefined
      ? cur.connector_token
      : input.token === "" ? "" : encrypt(input.token, this.opts.encryptionKey);
    this.db.prepare("UPDATE projects SET connector_url = ?, connector_token = ?, updated_at = ? WHERE id = ?")
      .run(input.url.trim(), token, isoNow(), cur.id);
    return this.get(cur.id)!;
  }

  /** Decrypted connector secrets — never leave the kernel. */
  connectorSecrets(id: string): { url: string; token: string; webhookSecret: string } {
    const r = this.row(id);
    if (!r) throw new Error(`Project not found: ${id}`);
    return {
      url: r.connector_url,
      token: r.connector_token ? decrypt(r.connector_token, this.opts.encryptionKey) : "",
      webhookSecret: r.webhook_secret ? decrypt(r.webhook_secret, this.opts.encryptionKey) : "",
    };
  }

  /** Where the next pull starts, in the project's clock. */
  pullSince(id: string): string | null {
    return this.row(id)?.pull_since ?? null;
  }

  markConnector(id: string, patch: { last_pull_at?: string; last_webhook_at?: string; connector_error?: string; pull_since?: string }): void {
    const allowed = ["last_pull_at", "last_webhook_at", "connector_error", "pull_since"] as const;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of allowed) {
      if (patch[k] !== undefined) { sets.push(`${k} = ?`); params.push(patch[k]); }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  }

  link(projectId: string, kind: ProjectLinkKind, refId: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO project_links (id, project_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(newId(), projectId, kind, refId, isoNow());
  }

  unlink(projectId: string, kind: ProjectLinkKind, refId: string): void {
    this.db.prepare("DELETE FROM project_links WHERE project_id = ? AND kind = ? AND ref_id = ?").run(projectId, kind, refId);
  }

  links(projectId: string, kind?: ProjectLinkKind): ProjectLink[] {
    return (kind
      ? this.db.prepare("SELECT * FROM project_links WHERE project_id = ? AND kind = ? ORDER BY created_at").all(projectId, kind)
      : this.db.prepare("SELECT * FROM project_links WHERE project_id = ? ORDER BY kind, created_at").all(projectId)) as ProjectLink[];
  }

  assignOffice(flowId: string, projectId: string, opts: { active?: boolean; settings?: Record<string, unknown> } = {}): OfficeProject {
    const now = isoNow();
    const existing = this.db.prepare("SELECT settings FROM office_projects WHERE flow_id = ? AND project_id = ?")
      .get(flowId, projectId) as { settings: string } | undefined;
    const settings = opts.settings !== undefined ? JSON.stringify(opts.settings) : existing?.settings ?? "{}";
    this.db.prepare(
      `INSERT INTO office_projects (flow_id, project_id, active, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(flow_id, project_id) DO UPDATE SET active = excluded.active, settings = excluded.settings, updated_at = excluded.updated_at`,
    ).run(flowId, projectId, opts.active === false ? 0 : 1, settings, now, now);
    this.syncOfficeSchedules(flowId);
    this.events.emit("data.changed", { module: "projects", action: "office_assigned" });
    return this.officeProjects(flowId).find((o) => o.project_id === projectId)!;
  }

  unassignOffice(flowId: string, projectId: string): void {
    this.db.prepare("DELETE FROM office_projects WHERE flow_id = ? AND project_id = ?").run(flowId, projectId);
    this.syncOfficeSchedules(flowId);
    this.events.emit("data.changed", { module: "projects", action: "office_unassigned" });
  }

  officeProjects(flowId: string): Array<OfficeProject & { project: Project }> {
    const rows = this.db.prepare("SELECT * FROM office_projects WHERE flow_id = ?").all(flowId) as OfficeProjectRow[];
    return rows.flatMap((r) => {
      const project = this.get(r.project_id);
      return project
        ? [{ ...r, active: r.active === 1, settings: JSON.parse(r.settings || "{}") as Record<string, unknown>, project }]
        : [];
    });
  }

  /** The project an agent run works for (agent_runs.project_id), or null. */
  runProjectId(runId: string): string | null {
    if (!runId) return null;
    const r = this.db.prepare("SELECT project_id FROM agent_runs WHERE id = ?").get(runId) as { project_id: string | null } | null;
    return r?.project_id ?? null;
  }

  /**
   * Whose home a run of `flowId` for `projectId` works in, when it isn't the
   * office's own: a shared office (serves_any) working for a project that has
   * an office of its own uses THAT office's home, so the documents it writes
   * stay with the project. Null = the office's own home, as always.
   */
  homeOfficeFor(flowId: string, projectId: string): string | null {
    if (!flowId || !this.officeServesAny(flowId)) return null;
    const home = this.row(projectId)?.home_flow_id ?? "";
    if (!home || home === flowId) return null;
    const live = this.db.prepare("SELECT 1 FROM agent_flows WHERE id = ? AND active = 1").get(home);
    return live ? home : null;
  }

  /** True when the office works for any project its caller brings (office_scopes). */
  officeServesAny(flowId: string): boolean {
    const r = this.db.prepare("SELECT serves_any FROM office_scopes WHERE flow_id = ?").get(flowId) as { serves_any: number } | undefined;
    return r?.serves_any === 1;
  }

  setOfficeServesAny(flowId: string, servesAny: boolean): void {
    this.db.prepare(
      `INSERT INTO office_scopes (flow_id, serves_any, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(flow_id) DO UPDATE SET serves_any = excluded.serves_any, updated_at = excluded.updated_at`,
    ).run(flowId, servesAny ? 1 : 0, isoNow());
    this.events.emit("data.changed", { module: "projects", action: "office_scope" });
  }

  /**
   * What an office's member is told when a run has no project but the office
   * could work for several: find out which one before touching any project's
   * data. Null when the office serves one project or none — nothing to mix.
   */
  unscopedNotice(flowId: string): string | null {
    const assigned = this.officeProjects(flowId).filter((o) => o.active && o.project.status === "active");
    const any = this.officeServesAny(flowId);
    if (!any && assigned.length < 2) return null;
    const names = (any ? this.list().filter((p) => p.status === "active") : assigned.map((o) => o.project))
      .map((p) => `${p.name} (\`${p.slug}\`)`);
    return [
      "## Proyecto: sin definir",
      any
        ? "Your office is a shared service: it works for whichever project the request comes from."
        : "Your office works for several projects.",
      `This run is not tied to any of them. Projects: ${names.join(", ")}.`,
      "Before reading or writing any project's data (pipeline, deals, contacts, files), establish which project this request is about.",
      "If the message or the conversation does not say it unambiguously, ask the sender which project and stop there.",
      "Never combine figures, leads or plans of different projects in one answer.",
    ].join("\n");
  }

  officeSettings(flowId: string, projectId: string): Record<string, unknown> {
    const r = this.db.prepare("SELECT settings FROM office_projects WHERE flow_id = ? AND project_id = ?")
      .get(flowId, projectId) as { settings: string } | undefined;
    return r ? (JSON.parse(r.settings || "{}") as Record<string, unknown>) : {};
  }

  /**
   * Keep one clone of every per_project schedule template of the office's
   * agents per ACTIVE assigned project; drop clones for anything else.
   * Writes agent_schedules directly (agents v51 columns) — same DB, and this
   * module already depends on the agents tables.
   */
  syncOfficeSchedules(flowId: string): void {
    const templates = this.db.prepare(
      `SELECT s.agent_id, s.interval_ms, s.cron_expression, s.goal_override, s.next_run_at
       FROM agent_schedules s JOIN agents a ON a.id = s.agent_id
       WHERE a.flow_id = ? AND s.per_project = 1 AND s.project_id IS NULL AND s.active = 1`,
    ).all(flowId) as Array<{ agent_id: string; interval_ms: number; cron_expression: string; goal_override: string; next_run_at: string }>;
    const active = new Set((this.db.prepare(
      `SELECT op.project_id FROM office_projects op JOIN projects p ON p.id = op.project_id
       WHERE op.flow_id = ? AND op.active = 1 AND p.status = 'active'`,
    ).all(flowId) as Array<{ project_id: string }>).map((r) => r.project_id));
    const tx = this.db.transaction(() => {
      // Clones whose template is gone (renamed goal, removed schedule).
      const clones = this.db.prepare(
        `SELECT s.id, s.agent_id, s.goal_override FROM agent_schedules s JOIN agents a ON a.id = s.agent_id
         WHERE a.flow_id = ? AND s.per_project = 1 AND s.project_id IS NOT NULL`,
      ).all(flowId) as Array<{ id: string; agent_id: string; goal_override: string }>;
      const live = new Set(templates.map((t) => `${t.agent_id}\u0000${t.goal_override}`));
      for (const c of clones) {
        if (!live.has(`${c.agent_id}\u0000${c.goal_override}`)) this.db.prepare("DELETE FROM agent_schedules WHERE id = ?").run(c.id);
      }
      for (const t of templates) {
        const existing = this.db.prepare(
          `SELECT id, project_id, interval_ms, cron_expression FROM agent_schedules
           WHERE agent_id = ? AND per_project = 1 AND project_id IS NOT NULL AND goal_override = ?`,
        ).all(t.agent_id, t.goal_override) as Array<{ id: string; project_id: string; interval_ms: number; cron_expression: string }>;
        const kept: string[] = [];
        for (const e of existing) {
          // Unserved project, or the template's cadence changed → drop (re-cloned below if served).
          const stale = e.interval_ms !== t.interval_ms || e.cron_expression !== t.cron_expression;
          if (!active.has(e.project_id) || stale) this.db.prepare("DELETE FROM agent_schedules WHERE id = ?").run(e.id);
          else kept.push(e.project_id);
        }
        const have = new Set(kept);
        for (const pid of active) {
          if (have.has(pid)) continue;
          this.db.prepare(
            `INSERT INTO agent_schedules
               (id, agent_id, interval_ms, goal_override, next_run_at, last_run_at, active, cron_expression, created_at, project_id, per_project)
             VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, 1)`,
          ).run(newId(), t.agent_id, t.interval_ms, t.goal_override, t.next_run_at, t.cron_expression, isoNow(), pid);
        }
      }
    });
    tx();
  }

  /** Contacts of the project (CRM extension); 0 when the CRM is not installed. */
  leadCount(projectId: string): number {
    try {
      return (this.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE project_id = ?").get(projectId) as { n: number }).n;
    } catch {
      return 0;
    }
  }

  setOfficeSettingsSchema(flowId: string, schema: Record<string, unknown>): void {
    this.db.prepare(
      `INSERT INTO office_project_schemas (flow_id, schema) VALUES (?, ?)
       ON CONFLICT(flow_id) DO UPDATE SET schema = excluded.schema`,
    ).run(flowId, JSON.stringify(schema));
  }

  getOfficeSettingsSchema(flowId: string): Record<string, unknown> | null {
    const r = this.db.prepare("SELECT schema FROM office_project_schemas WHERE flow_id = ?").get(flowId) as { schema: string } | undefined;
    return r ? (JSON.parse(r.schema) as Record<string, unknown>) : null;
  }

  /** Re-sync every office that serves a project — run once at startup. */
  syncAllOfficeSchedules(): void {
    const flows = this.db.prepare("SELECT DISTINCT flow_id FROM office_projects").all() as Array<{ flow_id: string }>;
    for (const f of flows) this.syncOfficeSchedules(f.flow_id);
  }

  /** The seam the agents module calls from createRun (ProjectGateLike). */
  gate(): {
    resolve(idOrSlug: string): string | null;
    check(flowId: string, projectId: string): { ok: true } | { ok: false; error: string };
    context(flowId: string, projectId: string): { block: string; homeDir: string } | null;
    unscoped(flowId: string): string | null;
    homeOffice(flowId: string, projectId: string): string | null;
  } {
    return {
      resolve: (idOrSlug) => this.row(idOrSlug)?.id ?? null,
      context: (flowId, projectId) => {
        try { return buildProjectContext(this, flowId, projectId); } catch { return null; }
      },
      unscoped: (flowId) => this.unscopedNotice(flowId),
      homeOffice: (flowId, projectId) => this.homeOfficeFor(flowId, projectId),
      check: (flowId, projectId) => {
        const p = this.row(projectId);
        if (!p) return { ok: false, error: `project ${projectId} does not exist` };
        if (p.status !== "active") return { ok: false, error: `project ${p.slug} is ${p.status}` };
        const flow = this.db.prepare("SELECT name FROM agent_flows WHERE id = ?").get(flowId) as { name: string } | undefined;
        const a = this.db.prepare("SELECT active FROM office_projects WHERE flow_id = ? AND project_id = ?")
          .get(flowId, p.id) as { active: number } | undefined;
        if ((!a || a.active !== 1) && !(!a && this.officeServesAny(flowId))) {
          return { ok: false, error: `project ${p.slug} is not assigned to office ${flow?.name ?? (flowId || "(none)")}` };
        }
        return { ok: true };
      },
    };
  }

  /** Absolute home dir, seeded idempotently (never overwrites a file). */
  homeDir(project: Project): string {
    const dir = join(this.opts.projectsRoot, project.slug);
    mkdirSync(join(dir, "assets"), { recursive: true });
    const write = (p: string, c: string) => { if (!existsSync(p)) writeFileSync(p, c); };
    write(join(dir, "BRIEF.md"), renderBriefMarkdown(project.name, project.brief));
    write(join(dir, "MEMORY.md"), `# ${project.name} — Project Memory\n\nFacts every office must know about ${project.name}. One per line.\n`);
    write(join(dir, "assets", ".gitkeep"), "");
    return dir;
  }
}
