import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import type { AgentChain } from "../types.js";

/**
 * Agent-to-agent chains — "when this agent finishes, run that one".
 * Owns `agent_chains` and nothing else; `AgentService` delegates to it.
 */
export class AgentChainsService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
  ) {}

  addChain(input: {
    source_agent_id: string;
    target_agent_id: string;
    label?: string;
    condition?: Record<string, unknown>;
    pass_result?: boolean;
    delay_ms?: number;
  }): AgentChain {
    if (input.source_agent_id === input.target_agent_id) {
      throw new Error("Cannot chain an agent to itself");
    }

    const now = isoNow();
    const chain: AgentChain = {
      id: newId(),
      source_agent_id: input.source_agent_id,
      target_agent_id: input.target_agent_id,
      label: input.label ?? "",
      condition: JSON.stringify(input.condition ?? {}),
      pass_result: input.pass_result !== false ? 1 : 0,
      delay_ms: input.delay_ms ?? 0,
      active: 1,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_chains (id, source_agent_id, target_agent_id, label,
         condition, pass_result, delay_ms, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chain.id, chain.source_agent_id, chain.target_agent_id,
        chain.label, chain.condition, chain.pass_result,
        chain.delay_ms, chain.active, chain.created_at,
      );

    this.events.emit("data.changed", { module: "agents", action: "chain_added" });
    return chain;
  }

  listChains(agentId?: string): AgentChain[] {
    if (agentId) {
      return this.db
        .prepare(
          `SELECT * FROM agent_chains
           WHERE (source_agent_id = ? OR target_agent_id = ?) AND active = 1
           ORDER BY created_at DESC`,
        )
        .all(agentId, agentId) as AgentChain[];
    }
    return this.db
      .prepare("SELECT * FROM agent_chains WHERE active = 1 ORDER BY created_at DESC")
      .all() as AgentChain[];
  }

  getChainsBySource(sourceId: string): AgentChain[] {
    return this.db
      .prepare("SELECT * FROM agent_chains WHERE source_agent_id = ? AND active = 1")
      .all(sourceId) as AgentChain[];
  }

  removeChain(id: string): boolean {
    const exists = this.db.prepare("SELECT id FROM agent_chains WHERE id = ?").get(id);
    if (!exists) return false;
    this.db.prepare("DELETE FROM agent_chains WHERE id = ?").run(id);
    this.events.emit("data.changed", { module: "agents", action: "chain_removed" });
    return true;
  }
}
