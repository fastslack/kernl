import type { SqliteDb } from "../../../core/db/sqlite.js";
import { newId, isoNow } from "../../../core/helpers.js";
import { writeAgentEvent } from "../../../core/agent-logger.js";

/**
 * The agent event log — every structured event a run emits.
 * Owns `agent_event_log`; `AgentService` delegates to it.
 */
export class AgentEventLogService {
  constructor(private db: SqliteDb) {}

  logEvent(data: {
    run_id?: string;
    agent_id?: string;
    agent_name?: string;
    event_type: string;
    event_subtype?: string;
    detail?: string;
    raw_data?: Record<string, unknown>;
    tokens_used?: number;
    duration_ms?: number;
  }): void {
    const id = newId();
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO agent_event_log (id, run_id, agent_id, agent_name, event_type, event_subtype, detail, raw_data, tokens_used, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.run_id ?? "",
        data.agent_id ?? "",
        data.agent_name ?? "",
        data.event_type,
        data.event_subtype ?? "",
        data.detail ?? "",
        JSON.stringify(data.raw_data ?? {}),
        data.tokens_used ?? 0,
        data.duration_ms ?? 0,
        now,
      );

    // Mirror every structured event to stdout in pretty colored form.
    writeAgentEvent(data);
  }

  getEventLog(opts?: {
    run_id?: string;
    agent_id?: string;
    event_type?: string;
    limit?: number;
    offset?: number;
    since?: string;
  }): unknown[] {
    let sql = "SELECT * FROM agent_event_log WHERE 1=1";
    const params: unknown[] = [];

    if (opts?.run_id) { sql += " AND run_id = ?"; params.push(opts.run_id); }
    if (opts?.agent_id) { sql += " AND agent_id = ?"; params.push(opts.agent_id); }
    if (opts?.event_type) { sql += " AND event_type = ?"; params.push(opts.event_type); }
    if (opts?.since) { sql += " AND created_at >= ?"; params.push(opts.since); }

    sql += " ORDER BY created_at DESC";

    const limit = opts?.limit ?? 200;
    const offset = opts?.offset ?? 0;
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params);
  }

  getEventLogCount(opts?: {
    run_id?: string;
    agent_id?: string;
    event_type?: string;
    since?: string;
  }): number {
    let sql = "SELECT COUNT(*) as cnt FROM agent_event_log WHERE 1=1";
    const params: unknown[] = [];

    if (opts?.run_id) { sql += " AND run_id = ?"; params.push(opts.run_id); }
    if (opts?.agent_id) { sql += " AND agent_id = ?"; params.push(opts.agent_id); }
    if (opts?.event_type) { sql += " AND event_type = ?"; params.push(opts.event_type); }
    if (opts?.since) { sql += " AND created_at >= ?"; params.push(opts.since); }

    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  clearEventLog(opts?: { before?: string; agent_id?: string }): number {
    let sql = "DELETE FROM agent_event_log WHERE 1=1";
    const params: unknown[] = [];

    if (opts?.before) { sql += " AND created_at < ?"; params.push(opts.before); }
    if (opts?.agent_id) { sql += " AND agent_id = ?"; params.push(opts.agent_id); }

    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }
}
