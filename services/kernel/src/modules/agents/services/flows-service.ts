import { resolve } from "node:path";
import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import { log } from "../../../core/logger.js";
import { WORKSPACE_ROOT } from "../workspace-constants.js";
import { OFFICE_HOME_WORKSPACE_NAME } from "../office-home.js";
import type { Agent, AgentFlow } from "../types.js";

/**
 * Offices (flows) and the home directory every agent in one inherits.
 * Owns `agent_flows` and the office-home rows in `workspaces`.
 *
 * It also writes `agents.flow_id` — assigning an agent to an office, and
 * unassigning on delete — which is the one column of the agent record this
 * aggregate is responsible for. `AgentService` delegates to it.
 */
export class AgentFlowsService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private getAgent: (id: string) => Agent | undefined,
  ) {}

  createFlow(input: { name: string; description?: string; color?: string }): AgentFlow {
    const now = isoNow();
    const flow: AgentFlow = {
      id: newId(),
      name: input.name,
      description: input.description ?? "",
      color: input.color ?? "#6366f1",
      active: 1,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO agent_flows (id, name, description, color, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(flow.id, flow.name, flow.description, flow.color, flow.active, flow.created_at, flow.updated_at);
    // Every office gets a kernel-workspace home automatically (DB-only — the
    // on-disk folder convention is seeded lazily by the executor / set_repo so
    // flow creation stays test-safe). Best-effort: a failure here must not
    // block office creation.
    try {
      this.ensureOfficeHomeWorkspace(flow);
    } catch (err) {
      log.warn(`createFlow: could not create office home for "${flow.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    this.events.emit("data.changed", { module: "agents", action: "flow_created" });
    return flow;
  }

  // ── Office home (workspace / repo) ─────────────────
  //
  // See src/modules/agents/office-home.ts and migration v36. The home is the
  // directory every agent in the office inherits as cwd (unless it has its own
  // __cwd_path__ / __workspace__ override). It's a kernel workspace by default;
  // promoting to a host git repo just fills home_repo_path.

  /**
   * Make sure `flow` has a backing office-home workspace row and that
   * `home_workspace_id` points at it. Idempotent + DB-only. Returns the
   * workspace id. Mutates the passed `flow` object's home_workspace_id.
   */
  private ensureOfficeHomeWorkspace(flow: AgentFlow): string {
    if (flow.home_workspace_id) {
      const live = this.db
        .prepare("SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL")
        .get(flow.home_workspace_id);
      if (live) return flow.home_workspace_id;
    }
    // Re-link to an existing 'office-home' row if one is already there (e.g.
    // partial backfill, or the link column was cleared).
    const existing = this.db
      .prepare("SELECT id FROM workspaces WHERE owner_flow_id = ? AND name = ? AND deleted_at IS NULL")
      .get(flow.id, OFFICE_HOME_WORKSPACE_NAME) as { id: string } | undefined;
    let wsId = existing?.id;
    if (!wsId) {
      const now = isoNow();
      wsId = newId();
      this.db
        .prepare(
          `INSERT INTO workspaces (id, owner_flow_id, name, description, shared, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(wsId, flow.id, OFFICE_HOME_WORKSPACE_NAME, `Home of the ${flow.name} office`, now, now);
    }
    this.db
      .prepare("UPDATE agent_flows SET home_workspace_id = ?, updated_at = ? WHERE id = ?")
      .run(wsId, isoNow(), flow.id);
    flow.home_workspace_id = wsId;
    return wsId;
  }

  /** Public entrypoint for the backfill script. Returns the workspace id or null. */
  ensureOfficeHome(flowId: string): string | null {
    const flow = this.getFlow(flowId);
    if (!flow) return null;
    return this.ensureOfficeHomeWorkspace(flow);
  }

  /**
   * Resolve the working directory an agent in `flowId` should inherit.
   * Self-healing: if the office has no home yet, creates the workspace row.
   *   - home_repo_path set (absolute) → the host git repo.
   *   - otherwise → data/workspaces/{home_workspace_id}/.
   * Returns null if the flow doesn't exist.
   */
  resolveFlowHome(flowId: string): { path: string; kind: "git" | "workspace"; flow: AgentFlow } | null {
    if (!flowId) return null;
    const flow = this.getFlow(flowId);
    if (!flow) return null;
    if (flow.home_repo_path && flow.home_repo_path.startsWith("/")) {
      return { path: flow.home_repo_path, kind: "git", flow };
    }
    let wsId = flow.home_workspace_id;
    if (!wsId) {
      try {
        wsId = this.ensureOfficeHomeWorkspace(flow);
      } catch {
        return null;
      }
    }
    if (!wsId) return null;
    return { path: resolve(WORKSPACE_ROOT, wsId), kind: "workspace", flow };
  }

  /**
   * Promote (or revert) an office to a host git repo. Empty `repoPath` reverts
   * the office to its kernel workspace. Disk side (mkdir / git init / seed) is
   * the caller's job (the set_repo tool) — this only persists the column.
   */
  setFlowRepo(flowId: string, repoPath: string): AgentFlow | undefined {
    const flow = this.getFlow(flowId);
    if (!flow) return undefined;
    this.db
      .prepare("UPDATE agent_flows SET home_repo_path = ?, updated_at = ? WHERE id = ?")
      .run(repoPath, isoNow(), flowId);
    this.events.emit("data.changed", { module: "agents", action: "flow_repo_set" });
    return this.getFlow(flowId);
  }

  listFlows(): AgentFlow[] {
    return this.db
      .prepare("SELECT * FROM agent_flows WHERE active = 1 ORDER BY created_at DESC")
      .all() as AgentFlow[];
  }

  getFlow(id: string): AgentFlow | undefined {
    return this.db.prepare("SELECT * FROM agent_flows WHERE id = ?").get(id) as AgentFlow | undefined;
  }

  updateFlow(id: string, updates: Partial<Pick<AgentFlow, "name" | "description" | "color">>): AgentFlow | undefined {
    const flow = this.getFlow(id);
    if (!flow) return undefined;
    const name = updates.name ?? flow.name;
    const description = updates.description ?? flow.description;
    const color = updates.color ?? flow.color;
    const now = isoNow();
    this.db
      .prepare("UPDATE agent_flows SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ?")
      .run(name, description, color, now, id);
    this.events.emit("data.changed", { module: "agents", action: "flow_updated" });
    return this.getFlow(id);
  }

  deleteFlow(id: string): boolean {
    const flow = this.getFlow(id);
    if (!flow) return false;
    // Unassign agents from this flow
    this.db.prepare("UPDATE agents SET flow_id = '' WHERE flow_id = ?").run(id);
    this.db.prepare("UPDATE agent_flows SET active = 0 WHERE id = ?").run(id);
    this.events.emit("data.changed", { module: "agents", action: "flow_deleted" });
    return true;
  }

  assignAgentToFlow(agentId: string, flowId: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    if (flowId && !this.getFlow(flowId)) return false;
    this.db.prepare("UPDATE agents SET flow_id = ?, updated_at = ? WHERE id = ?").run(flowId, isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "agent_flow_changed" });
    return true;
  }
}
