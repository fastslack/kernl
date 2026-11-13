/**
 * What is broken in an office's environment, and since when.
 *
 * In one office 124 questions over five weeks were about the environment — DEV
 * down, a missing credential, permissions, a failed deploy — and they came in
 * 54 incidents: each agent that hit the same problem asked again (7 questions
 * for one missing credential, across 3 issues, in three hours). Here the first
 * agent opens a fact; the next ones join it — no question — and every agent
 * that joined is woken with a letter when someone closes it.
 *
 * A fact is open from `valid_from` to `valid_to` (null while open), so a
 * decision can be read against the environment of its day.
 */
import type { SqliteDb } from "../../../core/db/sqlite.js";
import { newId, isoNow } from "../../../core/helpers.js";

export interface EnvFact {
  id: string; flow_id: string; key: string; description: string;
  valid_from: string; valid_to: string | null; opened_by: string; closed_by: string; close_note: string;
}
export interface EnvBlock { fact_id: string; agent_id: string; subject_key: string; run_id: string; note: string; created_at: string; woken_at: string | null }

/** A key is a short slug: `dev-e2e`, `credential-dev-patient-jwt`. */
export function envKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export class EnvFactsService {
  constructor(private readonly db: SqliteDb) {}

  open(flowId: string, key: string): EnvFact | null {
    return (this.db.prepare("SELECT * FROM agent_env_facts WHERE flow_id = ? AND key = ? AND valid_to IS NULL").get(flowId, envKey(key)) as EnvFact | undefined) ?? null;
  }

  listOpen(flowId?: string): EnvFact[] {
    return (flowId
      ? this.db.prepare("SELECT * FROM agent_env_facts WHERE flow_id = ? AND valid_to IS NULL ORDER BY valid_from").all(flowId)
      : this.db.prepare("SELECT * FROM agent_env_facts WHERE valid_to IS NULL ORDER BY valid_from").all()) as EnvFact[];
  }

  /** Facts of an office that were open at `at` (ISO). */
  openAt(flowId: string, at: string): EnvFact[] {
    return this.db
      .prepare("SELECT * FROM agent_env_facts WHERE flow_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from")
      .all(flowId, at, at) as EnvFact[];
  }

  history(flowId: string, limit = 50): EnvFact[] {
    return this.db.prepare("SELECT * FROM agent_env_facts WHERE flow_id = ? ORDER BY valid_from DESC LIMIT ?").all(flowId, limit) as EnvFact[];
  }

  blocks(factId: string): EnvBlock[] {
    return this.db.prepare("SELECT * FROM agent_env_blocks WHERE fact_id = ? ORDER BY created_at").all(factId) as EnvBlock[];
  }

  /**
   * Report a problem. Opens the fact, or joins the one already open with the
   * same key. Either way the reporter (an agent, on a subject) is recorded as
   * blocked by it, to be woken when it closes.
   */
  report(input: {
    flow_id: string; key: string; description?: string; by: string;
    blocked?: { agent_id: string; subject_key?: string; run_id?: string; note?: string };
  }): { fact: EnvFact; opened: boolean; blocked: number } {
    const key = envKey(input.key);
    if (!key) throw new Error("key is required");
    let fact = this.open(input.flow_id, key);
    let opened = false;
    if (!fact) {
      const now = isoNow();
      const id = newId();
      // The partial unique index keeps one open fact per key even if two agents report at once.
      const r = this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_env_facts (id, flow_id, key, description, valid_from, opened_by) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.flow_id, key, (input.description ?? "").slice(0, 2000), now, input.by);
      opened = r.changes > 0;
      fact = this.open(input.flow_id, key)!;
    }
    if (input.blocked?.agent_id) {
      this.db
        .prepare(
          `INSERT INTO agent_env_blocks (fact_id, agent_id, subject_key, run_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (fact_id, agent_id, subject_key) DO UPDATE SET run_id = excluded.run_id, note = excluded.note`,
        )
        .run(fact.id, input.blocked.agent_id, (input.blocked.subject_key ?? "").toLowerCase(), input.blocked.run_id ?? "", (input.blocked.note ?? "").slice(0, 1000), isoNow());
    }
    return { fact, opened, blocked: this.blocks(fact.id).length };
  }

  /** Close the open fact. Returns it and the blocks to wake (marked woken). Null when nothing is open under that key. */
  close(input: { flow_id: string; key: string; by: string; note?: string }): { fact: EnvFact; wake: EnvBlock[] } | null {
    const fact = this.open(input.flow_id, input.key);
    if (!fact) return null;
    const now = isoNow();
    this.db
      .prepare("UPDATE agent_env_facts SET valid_to = ?, closed_by = ?, close_note = ? WHERE id = ? AND valid_to IS NULL")
      .run(now, input.by, (input.note ?? "").slice(0, 2000), fact.id);
    const wake = (this.db.prepare("SELECT * FROM agent_env_blocks WHERE fact_id = ? AND woken_at IS NULL").all(fact.id) as EnvBlock[]);
    this.db.prepare("UPDATE agent_env_blocks SET woken_at = ? WHERE fact_id = ? AND woken_at IS NULL").run(now, fact.id);
    return { fact: { ...fact, valid_to: now, closed_by: input.by, close_note: input.note ?? "" }, wake };
  }
}
