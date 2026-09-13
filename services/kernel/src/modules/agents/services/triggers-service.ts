import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import type { EventTrigger } from "../types.js";

/**
 * Event triggers — "run this agent when that event fires".
 * Owns `agent_event_triggers`; `AgentService` delegates to it.
 */
export class AgentTriggersService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
  ) {}

  addEventTrigger(input: {
    agent_id: string;
    event_name: string;
    filter?: Record<string, unknown>;
    cooldown_ms?: number;
  }): EventTrigger {
    const now = isoNow();
    const trigger: EventTrigger = {
      id: newId(),
      agent_id: input.agent_id,
      event_name: input.event_name,
      filter: JSON.stringify(input.filter ?? {}),
      cooldown_ms: input.cooldown_ms ?? 60_000,
      last_fired: null,
      active: 1,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_event_triggers (id, agent_id, event_name, filter,
         cooldown_ms, last_fired, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trigger.id, trigger.agent_id, trigger.event_name, trigger.filter,
        trigger.cooldown_ms, trigger.last_fired, trigger.active, trigger.created_at,
      );

    this.events.emit("data.changed", { module: "agents", action: "trigger_added" });
    return trigger;
  }

  listEventTriggers(agentId?: string): EventTrigger[] {
    if (agentId) {
      return this.db
        .prepare("SELECT * FROM agent_event_triggers WHERE agent_id = ? ORDER BY created_at DESC")
        .all(agentId) as EventTrigger[];
    }
    return this.db
      .prepare("SELECT * FROM agent_event_triggers ORDER BY created_at DESC")
      .all() as EventTrigger[];
  }

  getActiveEventTriggers(): EventTrigger[] {
    return this.db
      .prepare(
        `SELECT t.* FROM agent_event_triggers t
         JOIN agents a ON t.agent_id = a.id
         WHERE t.active = 1 AND a.active = 1`,
      )
      .all() as EventTrigger[];
  }

  removeEventTrigger(id: string): boolean {
    const result = this.db.prepare("DELETE FROM agent_event_triggers WHERE id = ?").run(id);
    if (result.changes > 0) {
      this.events.emit("data.changed", { module: "agents", action: "trigger_removed" });
      return true;
    }
    return false;
  }

  updateTriggerLastFired(id: string): void {
    this.db
      .prepare("UPDATE agent_event_triggers SET last_fired = ? WHERE id = ?")
      .run(isoNow(), id);
  }
}
