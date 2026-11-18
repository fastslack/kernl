/**
 * Work items an office keeps from moving, and until when.
 *
 * An office orchestrator held an item for 24 hours when the operator chose to
 * keep it waiting: nobody could see the hold, who placed it or why, and
 * lifting it meant editing the orchestrator's state by hand. Here a hold
 * is a row: on a subject (`app#42`), with a reason and an owner, either open
 * until lifted (`hold`) or until a time (`snooze`). Orchestrators read the
 * active ones on every tick; the operator sees them and lifts them.
 */
import type { SqliteDb } from "../../../core/db/sqlite.js";
import { newId } from "../../../core/helpers.js";

export type HoldKind = "hold" | "snooze";

export interface SubjectHold {
  id: string; flow_id: string; subject_key: string; kind: HoldKind;
  /** When a snooze ends on its own; null for a hold. */
  until: string | null;
  reason: string; owner: string;
  /** Agent that gets a HOLD-LIFTED letter when someone lifts it; '' for none. */
  notify_agent_id: string;
  created_at: string; lifted_at: string | null; lifted_by: string;
}

const KINDS: readonly HoldKind[] = ["hold", "snooze"];

export class SubjectHoldsService {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Hold or snooze a subject. A subject has at most one active hold per office:
   * placing another replaces it (the old one is lifted by the new owner).
   */
  place(input: {
    flow_id: string; subject_key: string; kind: HoldKind; reason: string; owner: string;
    until?: string | null; minutes?: number; notify_agent_id?: string; now?: Date;
  }): SubjectHold {
    const key = input.subject_key.trim().toLowerCase();
    if (!key) throw new Error("subject_key is required");
    if (!KINDS.includes(input.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    const reason = input.reason.trim();
    if (!reason) throw new Error("reason is required: say why it is held");
    const now = input.now ?? new Date();
    let until: string | null = null;
    if (input.kind === "snooze") {
      const t = input.until ? Date.parse(input.until) : input.minutes ? now.getTime() + input.minutes * 60_000 : NaN;
      if (!Number.isFinite(t)) throw new Error("a snooze needs until (ISO time) or minutes");
      if (t <= now.getTime()) throw new Error("until is in the past");
      until = new Date(t).toISOString();
    }
    const at = now.toISOString();
    for (const h of this.active(input.flow_id, key, now)) this.lift(h.id, input.owner || "replaced", now);
    const hold: SubjectHold = {
      id: newId(), flow_id: input.flow_id, subject_key: key, kind: input.kind, until, reason,
      owner: input.owner.trim(), notify_agent_id: input.notify_agent_id ?? "", created_at: at, lifted_at: null, lifted_by: "",
    };
    this.db
      .prepare(
        `INSERT INTO agent_subject_holds (id, flow_id, subject_key, kind, until, reason, owner, notify_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hold.id, hold.flow_id, hold.subject_key, hold.kind, hold.until, hold.reason, hold.owner, hold.notify_agent_id, hold.created_at);
    return hold;
  }

  /** Lift a hold. Returns it as lifted, or null when it is unknown or no longer active. */
  lift(id: string, by: string, now: Date = new Date()): SubjectHold | null {
    const at = now.toISOString();
    const r = this.db
      .prepare(`UPDATE agent_subject_holds SET lifted_at=?, lifted_by=? WHERE id=? AND lifted_at IS NULL AND (until IS NULL OR until > ?)`)
      .run(at, by.trim(), id, at);
    return r.changes === 0 ? null : this.get(id);
  }

  get(id: string): SubjectHold | null {
    const row = this.db.prepare("SELECT * FROM agent_subject_holds WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? mapHold(row) : null;
  }

  /** Active holds: not lifted, and a snooze whose time has not come. One subject, or the whole office. */
  active(flowId: string, subjectKey?: string, now: Date = new Date()): SubjectHold[] {
    const at = now.toISOString();
    const key = subjectKey?.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_subject_holds WHERE flow_id=? ${key ? "AND subject_key=?" : ""}
         AND lifted_at IS NULL AND (until IS NULL OR until > ?) ORDER BY created_at`,
      )
      .all(...(key ? [flowId, key, at] : [flowId, at])) as Record<string, unknown>[];
    return rows.map(mapHold);
  }

  /** Every office's active holds, newest first (the operator's panel). */
  allActive(now: Date = new Date()): SubjectHold[] {
    const at = now.toISOString();
    return (this.db
      .prepare("SELECT * FROM agent_subject_holds WHERE lifted_at IS NULL AND (until IS NULL OR until > ?) ORDER BY created_at DESC")
      .all(at) as Record<string, unknown>[]).map(mapHold);
  }
}

function mapHold(r: Record<string, unknown>): SubjectHold {
  return {
    id: String(r.id), flow_id: String(r.flow_id ?? ""), subject_key: String(r.subject_key ?? ""),
    kind: String(r.kind) as HoldKind, until: r.until == null ? null : String(r.until),
    reason: String(r.reason ?? ""), owner: String(r.owner ?? ""), notify_agent_id: String(r.notify_agent_id ?? ""),
    created_at: String(r.created_at ?? ""), lifted_at: r.lifted_at == null ? null : String(r.lifted_at),
    lifted_by: String(r.lifted_by ?? ""),
  };
}
