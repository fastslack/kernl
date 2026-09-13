import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import type { Agent, AgentRank } from "../types.js";

/**
 * The rank ladder and who sits on it. Owns `agent_ranks`, and writes
 * `agents.rank_id` when a rank is assigned or deleted.
 *
 * `getTopAgent` needs to read the agent roster, so `AgentService` injects
 * `getAgent` and `listAgents` rather than this aggregate querying `agents`.
 */
export class AgentRanksService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private getAgent: (id: string) => Agent | undefined,
    private listAgents: (filters?: { active?: boolean }) => Agent[],
  ) {}

  createRank(input: {
    name: string;
    level: number;
    insignia?: string;
    color?: string;
    description?: string;
  }): AgentRank {
    const now = isoNow();
    const rank: AgentRank = {
      id: newId(),
      name: input.name,
      level: input.level,
      insignia: input.insignia ?? "",
      color: input.color ?? "#888888",
      description: input.description ?? "",
      active: 1,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO agent_ranks (id, name, level, insignia, color, description, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rank.id, rank.name, rank.level, rank.insignia, rank.color, rank.description, rank.active, rank.created_at, rank.updated_at);
    this.events.emit("data.changed", { module: "agents", action: "rank_created" });
    return rank;
  }

  listRanks(): AgentRank[] {
    return this.db
      .prepare("SELECT * FROM agent_ranks WHERE active = 1 ORDER BY level ASC")
      .all() as AgentRank[];
  }

  getRank(id: string): AgentRank | undefined {
    if (!id) return undefined;
    return this.db.prepare("SELECT * FROM agent_ranks WHERE id = ?").get(id) as AgentRank | undefined;
  }

  /**
   * Resolve the top agent (holder of the highest rank): the active
   * agent holding the highest-level rank. Mirrors the selection logic in
   * `top-agent-seeder.ts` so callers (e.g. Telegram routing) reach the same
   * commander the seeder created. Returns undefined if no ranks/agent exist.
   */
  getTopAgent(): Agent | undefined {
    const ranks = this.listRanks();
    if (ranks.length === 0) return undefined;
    const top = [...ranks].sort((a, b) => b.level - a.level)[0];
    if (!top) return undefined;
    return this.listAgents({ active: true }).find((a) => a.rank_id === top.id);
  }

  updateRank(
    id: string,
    updates: Partial<Pick<AgentRank, "name" | "level" | "insignia" | "color" | "description">>,
  ): AgentRank | undefined {
    const rank = this.getRank(id);
    if (!rank) return undefined;
    const name = updates.name ?? rank.name;
    const level = updates.level ?? rank.level;
    const insignia = updates.insignia ?? rank.insignia;
    const color = updates.color ?? rank.color;
    const description = updates.description ?? rank.description;
    const now = isoNow();
    this.db
      .prepare(
        "UPDATE agent_ranks SET name = ?, level = ?, insignia = ?, color = ?, description = ?, updated_at = ? WHERE id = ?",
      )
      .run(name, level, insignia, color, description, now, id);
    this.events.emit("data.changed", { module: "agents", action: "rank_updated" });
    return this.getRank(id);
  }

  deleteRank(id: string): boolean {
    const rank = this.getRank(id);
    if (!rank) return false;
    this.db.prepare("UPDATE agents SET rank_id = '' WHERE rank_id = ?").run(id);
    this.db.prepare("UPDATE agent_ranks SET active = 0 WHERE id = ?").run(id);
    this.events.emit("data.changed", { module: "agents", action: "rank_deleted" });
    return true;
  }

  assignRankToAgent(agentId: string, rankId: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    if (rankId && !this.getRank(rankId)) return false;
    this.db.prepare("UPDATE agents SET rank_id = ?, updated_at = ? WHERE id = ?").run(rankId, isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "agent_rank_changed" });
    return true;
  }
}
