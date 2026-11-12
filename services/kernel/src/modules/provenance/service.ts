/**
 * Who changed this? — a record of every tool call that writes, joined to the
 * ids it touched.
 *
 * Tool calls reach the kernel two ways: an MCP client (or a subprocess agent
 * over MCP HTTP) through `executeToolCall` in server.ts, and native agent runs
 * through the executor, which calls handlers directly. Both report here
 * (`recordToolCall`, a no-op until the module is up). Read-only tools are not
 * recorded: they change nothing.
 *
 * The ids come from the arguments (`id`, `*_id`, `*_ids`) and the result
 * (its `id` fields one or two levels down, or UUIDs in plain text), so
 * `whoTouched(id)` answers for a task, a contact, a fact… whatever the tool
 * named. In the graph, a native run is linked to what it touched when the
 * tool's module says which label that is: (:AgentRun)-[:TOUCHED]->(:Task).
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  /** Result text and/or structured content. */
  resultText?: string;
  structured?: unknown;
  ok: boolean;
  /** Declared side effects, when the tool definition is at hand. */
  sideEffects?: readonly string[];
  actor: { kind: "agent" | "client"; id: string; name?: string; runId?: string };
}

export interface ProvenanceRow {
  call_id: string;
  at: string;
  actor_kind: string;
  actor_id: string;
  actor_name: string;
  run_id: string;
  tool: string;
  ok: number;
  ref: string;
  detail: string;
}

/** Verbs of tools that write. Matched as a whole segment of the tool name. */
const WRITE_VERBS = new RegExp(
  "_(create|add|update|edit|set|delete|remove|archive|unarchive|complete|log|merge|assert|retract|move|assign|" +
  "send|post|reply|schedule|reschedule|cancel|import|upsert|rename|toggle|mark|link|unlink|enable|disable|" +
  "install|uninstall|approve|reject|publish|check|adjust|snooze|dismiss|restore|purge|reinforce|feedback)(_|$)",
);

export function isWriteTool(tool: string, sideEffects?: readonly string[]): boolean {
  return (sideEffects?.length ?? 0) > 0 || WRITE_VERBS.test(tool);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Ids a call named or returned; at most 20. */
export function extractRefs(args: unknown, resultText?: string, structured?: unknown): string[] {
  const out = new Set<string>();
  const take = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && v.length <= 100 && !/\s/.test(v)) out.add(v);
    else if (typeof v === "number" && Number.isInteger(v)) out.add(String(v));
  };
  const walk = (o: unknown, depth: number) => {
    if (depth > 2 || o === null || typeof o !== "object") return;
    if (Array.isArray(o)) {
      for (const x of o.slice(0, 20)) walk(x, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k.startsWith("__")) continue;
      if (k === "id" || k.endsWith("_id")) take(v);
      else if (k.endsWith("_ids") && Array.isArray(v)) v.slice(0, 20).forEach(take);
      else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(args, 0);
  if (structured && typeof structured === "object") walk(structured, 0);
  else if (resultText) {
    const t = resultText.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        walk(JSON.parse(t), 0);
      } catch {
        /* not JSON after all */
      }
    }
    for (const m of t.slice(0, 4000).match(UUID) ?? []) {
      if (out.size >= 20) break;
      out.add(m);
    }
  }
  return [...out].slice(0, 20);
}

/** Module prefix of a tool → the label its ids name in the graph. */
const TOOL_LABEL: Array<[RegExp, string]> = [
  [/^kernel_tasks_/, "Task"],
  [/^kernel_crm_/, "Person"],
  [/^kernel_notes_/, "Note"],
  [/^kernel_reminders_/, "Reminder"],
  [/^kernel_goals_/, "Goal"],
  [/^kernel_facts_/, "Fact"],
];

export class ProvenanceService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null = () => null,
    /** Clock for `at`; the demo seed replays a past timeline with it. */
    private now: () => string = isoNow,
  ) {}

  /** Store a call if its tool writes; returns how many rows were written. */
  record(call: ToolCallRecord): number {
    if (!isWriteTool(call.tool, call.sideEffects)) return 0;
    const refs = extractRefs(call.args, call.resultText, call.structured);
    const at = this.now();
    const callId = newId();
    const detail = argsPreview(call.args);
    const insert = this.db.prepare(
      `INSERT INTO tool_provenance (id, call_id, at, actor_kind, actor_id, actor_name, run_id, tool, ok, ref, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const ref of refs.length ? refs : [""]) {
        insert.run(newId(), callId, at, call.actor.kind, call.actor.id, call.actor.name ?? "", call.actor.runId ?? "",
          call.tool, call.ok ? 1 : 0, ref, detail);
      }
    })();
    if (call.ok && call.actor.runId && refs.length) void this.project(call.actor.runId, call.tool, refs, at);
    return refs.length || 1;
  }

  private async project(runId: string, tool: string, refs: string[], at: string): Promise<void> {
    const label = TOOL_LABEL.find(([re]) => re.test(tool))?.[1];
    const g = this.getGraph();
    if (!label || !g?.capabilities.cypher) return;
    try {
      // Only ids that are nodes of that label; the run node is filled in by
      // the experience-graph sync when the run finishes.
      await g.run(
        `MERGE (r:AgentRun {id: $run})
         WITH r UNWIND $refs AS ref
         MATCH (n:${label} {id: ref})
         MERGE (r)-[t:TOUCHED {tool: $tool}]->(n)
         SET t.at = $at`,
        { run: runId, refs, tool, at },
      );
    } catch (err) {
      log.debug(`provenance: graph link failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Every recorded call that named or returned `ref`, newest first. */
  whoTouched(ref: string, limit = 50): ProvenanceRow[] {
    return this.db
      .prepare(
        `SELECT call_id, at, actor_kind, actor_id, actor_name, run_id, tool, ok, ref, detail
           FROM tool_provenance WHERE ref = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(ref, limit) as ProvenanceRow[];
  }

  /** Recent writing calls, optionally by one actor, run or tool. */
  recent(q: { actorId?: string; runId?: string; tool?: string; since?: string; limit?: number } = {}): Array<
    Omit<ProvenanceRow, "ref"> & { refs: string[] }
  > {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.actorId) { where.push("actor_id = ?"); params.push(q.actorId); }
    if (q.runId) { where.push("run_id = ?"); params.push(q.runId); }
    if (q.tool) { where.push("tool = ?"); params.push(q.tool); }
    if (q.since) { where.push("at >= ?"); params.push(q.since); }
    const rows = this.db
      .prepare(
        `SELECT call_id, MIN(at) AS at, actor_kind, actor_id, actor_name, run_id, tool, ok, detail,
                group_concat(ref, ' ') AS refs
           FROM tool_provenance ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          GROUP BY call_id ORDER BY at DESC, MAX(rowid) DESC LIMIT ?`,
      )
      .all(...params, q.limit ?? 50) as Array<Omit<ProvenanceRow, "ref"> & { refs: string | null }>;
    return rows.map((r) => ({ ...r, refs: (r.refs ?? "").split(" ").filter(Boolean) }));
  }
}

/** A short, secret-free view of the arguments for the audit trail. */
function argsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k.startsWith("__") || /pass|secret|token|key|auth|cookie/i.test(k)) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s === undefined) continue;
    parts.push(`${k}=${s.length > 60 ? `${s.slice(0, 59)}…` : s}`);
    if (parts.join(", ").length > 300) break;
  }
  return parts.join(", ").slice(0, 320);
}

// ── Process-wide hook ─────────────────────────────────────────────────

let active: ProvenanceService | null = null;

export function setProvenanceService(s: ProvenanceService | null): void {
  active = s;
}

/** The running store, for readers in other modules (facts' explain). */
export function getProvenanceService(): ProvenanceService | null {
  return active;
}

/** Report a tool call from either dispatch path. Never throws. */
export function recordToolCall(call: ToolCallRecord): void {
  if (!active) return;
  try {
    active.record(call);
  } catch (err) {
    log.debug(`provenance: record failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}
