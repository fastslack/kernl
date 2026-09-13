import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import type { Agent, AgentPromptVersion } from "../types.js";

/**
 * Prompt version lineage (Autogenesis RSPL) — every system prompt an agent has
 * had, and which one is live. Owns `agent_prompt_versions`, and writes the live
 * prompt back onto `agents` when a version is activated or restored.
 *
 * `AgentService` delegates to it and injects `getAgent`, the only thing this
 * aggregate needs from the agent record itself.
 */
export class AgentPromptVersionsService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private getAgent: (id: string) => Agent | undefined,
  ) {}

  /**
   * Insert a lineage row verbatim. Public because agent creation writes the
   * first version directly, without going through `snapshotPrompt`.
   */
  writePromptVersion(v: Omit<AgentPromptVersion, "id"> & { id?: string }): AgentPromptVersion {
    const row: AgentPromptVersion = {
      id: v.id ?? newId(),
      agent_id: v.agent_id,
      version: v.version,
      system_prompt: v.system_prompt,
      goal_template: v.goal_template,
      parent_version: v.parent_version,
      source: v.source,
      note: v.note,
      active: v.active,
      created_at: v.created_at,
    };
    this.db
      .prepare(
        `INSERT INTO agent_prompt_versions
          (id, agent_id, version, system_prompt, goal_template, parent_version, source, note, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.agent_id, row.version, row.system_prompt, row.goal_template,
        row.parent_version, row.source, row.note, row.active, row.created_at,
      );
    return row;
  }

  /** Next free version number for an agent (always monotonically increasing). */
  private nextPromptVersion(agentId: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM agent_prompt_versions WHERE agent_id = ?")
      .get(agentId) as { v: number | null } | undefined;
    return (row?.v ?? 0) + 1;
  }

  /**
   * Append a new prompt version. When `activate: true` (default), any prior
   * version is deactivated and this one becomes the live snapshot. When
   * `activate: false`, the new row is saved as a candidate — useful for the
   * reflection optimizer while a candidate is being evaluated.
   */
  snapshotPrompt(
    agentId: string,
    input: {
      system_prompt: string;
      goal_template: string;
      source: AgentPromptVersion["source"];
      note?: string;
      parent_version?: number;
      activate?: boolean;
    },
  ): AgentPromptVersion | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    const parent = input.parent_version ?? (this.getActivePromptVersion(agentId)?.version ?? 0);
    const version = this.nextPromptVersion(agentId);
    const activate = input.activate !== false;
    if (activate) {
      this.db.prepare("UPDATE agent_prompt_versions SET active = 0 WHERE agent_id = ?").run(agentId);
    }
    return this.writePromptVersion({
      agent_id: agentId,
      version,
      system_prompt: input.system_prompt,
      goal_template: input.goal_template,
      parent_version: parent,
      source: input.source,
      note: input.note ?? "",
      active: activate ? 1 : 0,
      created_at: isoNow(),
    });
  }

  /**
   * Flip an existing version (by number) into the active slot without
   * creating new lineage rows. Used by the reflection optimizer's Commit
   * step to activate a previously-written candidate.
   */
  activatePromptVersion(agentId: string, version: number): AgentPromptVersion | null {
    const target = this.getPromptVersion(agentId, version);
    if (!target) return null;
    this.db.prepare("UPDATE agent_prompt_versions SET active = 0 WHERE agent_id = ?").run(agentId);
    this.db
      .prepare("UPDATE agent_prompt_versions SET active = 1 WHERE agent_id = ? AND version = ?")
      .run(agentId, version);
    this.db
      .prepare("UPDATE agents SET system_prompt = ?, goal_template = ?, updated_at = ? WHERE id = ?")
      .run(target.system_prompt, target.goal_template, isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "prompt_activated" });
    return this.getPromptVersion(agentId, version) ?? null;
  }

  listPromptVersions(agentId: string, limit = 50): AgentPromptVersion[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_prompt_versions
         WHERE agent_id = ? ORDER BY version DESC LIMIT ?`,
      )
      .all(agentId, limit) as AgentPromptVersion[];
  }

  getPromptVersion(agentId: string, version: number): AgentPromptVersion | undefined {
    return this.db
      .prepare("SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND version = ?")
      .get(agentId, version) as AgentPromptVersion | undefined;
  }

  getActivePromptVersion(agentId: string): AgentPromptVersion | undefined {
    return this.db
      .prepare("SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND active = 1")
      .get(agentId) as AgentPromptVersion | undefined;
  }

  /**
   * Restore a historical version into the live agent row. Creates a new
   * version entry (source='restore') pointing at the restored one as parent,
   * so the lineage never loses information.
   */
  restorePromptVersion(agentId: string, version: number, note = ""): AgentPromptVersion | null {
    const target = this.getPromptVersion(agentId, version);
    if (!target) return null;
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    // Apply to live agent, then record as a new version.
    this.db
      .prepare("UPDATE agents SET system_prompt = ?, goal_template = ?, updated_at = ? WHERE id = ?")
      .run(target.system_prompt, target.goal_template, isoNow(), agentId);
    const snapshot = this.snapshotPrompt(agentId, {
      system_prompt: target.system_prompt,
      goal_template: target.goal_template,
      source: "restore",
      note: note || `restored from v${version}`,
      parent_version: version,
    });
    this.events.emit("data.changed", { module: "agents", action: "prompt_restored" });
    return snapshot;
  }

  /**
   * Extremely small line-level diff for UI — not a full LCS, just a marker
   * of which lines are common/removed/added. Good enough to render a side-by-side.
   */
  diffPromptVersions(
    agentId: string,
    fromVersion: number,
    toVersion: number,
  ): { from: AgentPromptVersion; to: AgentPromptVersion; lines: Array<{ kind: "same" | "added" | "removed"; text: string }> } | null {
    const from = this.getPromptVersion(agentId, fromVersion);
    const to = this.getPromptVersion(agentId, toVersion);
    if (!from || !to) return null;
    const a = from.system_prompt.split("\n");
    const b = to.system_prompt.split("\n");
    const aSet = new Set(a);
    const bSet = new Set(b);
    const lines: Array<{ kind: "same" | "added" | "removed"; text: string }> = [];
    for (const line of a) {
      if (bSet.has(line)) lines.push({ kind: "same", text: line });
      else lines.push({ kind: "removed", text: line });
    }
    for (const line of b) {
      if (!aSet.has(line)) lines.push({ kind: "added", text: line });
    }
    return { from, to, lines };
  }
}
