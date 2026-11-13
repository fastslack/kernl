/**
 * Decisions the operator keeps taking the same way, and the last one taken on
 * the same subject.
 *
 * Measured on one office's 2,116 questions (5 Oct – 13 Nov 2026), replayed in
 * order with only what was known before each one:
 *
 * - The majority answer of a *category* (approve an MR, the closer is blocked)
 *   was right 86 % of the time where it was clear (≥ 70 % of ≥ 10 earlier
 *   answers): 92 % for approving an MR, 86 % for the closer. Nearest
 *   neighbours by wording alone were right 79 %. So a suggestion comes from
 *   the category, and its precision is *measured*, per office and category,
 *   against what the operator then chose.
 * - The last decision on the same subject and category matched the next one
 *   only 48 % of the time: between two questions something had changed. So it
 *   is shown, with what changed in the environment since — never applied.
 *
 * A category may be put on `auto` per office: then a question is answered by
 * its precedent, and only while the measured precision holds (≥ min_precision
 * over ≥ min_samples answers), no environment problem is open in the office,
 * and the question is not in the 1-in-10 held out so the measurement goes on.
 */
import type { SqliteDb } from "../../../core/db/sqlite.js";
import { isoNow } from "../../../core/helpers.js";
import type { AgentQuestion } from "../service.js";

export type PolicyMode = "off" | "suggest" | "auto";
export interface DecisionPolicy { flow_id: string; category: string; mode: PolicyMode; min_precision: number; min_samples: number }

export interface Suggestion {
  label: string;
  /** Index of the matching option in the question being asked; -1 if none matches. */
  option_index: number;
  /** Share of the category's earlier answers that chose it. */
  share: number;
  /** How many earlier answers it is based on. */
  samples: number;
  /** Measured: share of earlier suggestions in this category the operator then chose. Null until there are any. */
  precision: number | null;
  /** How many suggestions the precision is measured over. */
  measured: number;
  mode: PolicyMode | "holdout";
}

export interface PreviousDecision {
  question_id: string;
  label: string;
  at: string;
  answered_by: string;
  via: string;
  actor: string;
  /** Environment facts opened or closed in the office since that decision. */
  env_changes: Array<{ key: string; change: "opened" | "closed"; at: string }>;
}

/**
 * Evidence a category needs before its precedent may answer alone: a check
 * against what the question is about (an extension's records, the graph).
 * `null` when it cannot tell — which counts as no.
 *
 * Replayed on the same office with every category on auto at a 90 % bar, the
 * precedent alone would have answered 240 questions and got 13 % wrong — and
 * the wrong ones were "approve the MR" where the operator had written why not
 * (a migration that broke every deploy). The category's history cannot see
 * that; the MR's own checks can. So auto needs a condition, per category.
 */
export type AutoCondition = (
  q: Pick<AgentQuestion, "id" | "flow_id" | "category" | "subject_key" | "question">,
  /** The answer the precedent would give: the evidence has to back that answer, not just the subject. */
  answer: { label: string },
) => { ok: boolean; reason: string } | null;

export const SUGGEST_MIN_SAMPLES = 10;
export const SUGGEST_MIN_SHARE = 0.7;
const HISTORY_DAYS = 120;
const PRECISION_WINDOW = 100;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** One in ten questions is never auto-answered, so the operator keeps measuring the rule. */
export function isHoldout(questionId: string): boolean {
  let h = 0;
  for (let i = 0; i < questionId.length; i++) h = (h * 31 + questionId.charCodeAt(i)) >>> 0;
  return h % 10 === 0;
}

export class DecisionService {
  private conditions = new Map<string, AutoCondition>();

  constructor(private readonly db: SqliteDb) {}

  /** Register (or clear, with null) the evidence a category needs to be answered by its precedent. */
  setCondition(category: string, fn: AutoCondition | null): void {
    if (fn) this.conditions.set(category, fn);
    else this.conditions.delete(category);
  }

  /** The category's condition on this question: met, not met (with why), or no condition at all. */
  condition(q: Parameters<AutoCondition>[0], answer: { label: string }): { ok: boolean; reason: string } {
    const fn = this.conditions.get(q.category);
    if (!fn) return { ok: false, reason: "no condition registered for this category" };
    try {
      return fn(q, answer) ?? { ok: false, reason: "the condition could not tell" };
    } catch (err) {
      return { ok: false, reason: `the condition failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  policy(flowId: string, category: string): DecisionPolicy {
    const r = this.db
      .prepare("SELECT mode, min_precision, min_samples FROM agent_decision_policies WHERE flow_id = ? AND category = ?")
      .get(flowId, category) as { mode: PolicyMode; min_precision: number; min_samples: number } | undefined;
    return { flow_id: flowId, category, mode: r?.mode ?? "suggest", min_precision: r?.min_precision ?? 0.97, min_samples: r?.min_samples ?? 30 };
  }

  setPolicy(flowId: string, category: string, patch: Partial<Pick<DecisionPolicy, "mode" | "min_precision" | "min_samples">>): DecisionPolicy {
    const cur = this.policy(flowId, category);
    const next = { ...cur, ...patch };
    if (!["off", "suggest", "auto"].includes(next.mode)) throw new Error(`mode must be off, suggest or auto`);
    next.min_precision = Math.min(1, Math.max(0.5, Number(next.min_precision)));
    next.min_samples = Math.max(10, Math.trunc(Number(next.min_samples)));
    this.db
      .prepare(
        `INSERT INTO agent_decision_policies (flow_id, category, mode, min_precision, min_samples, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (flow_id, category) DO UPDATE SET mode = excluded.mode, min_precision = excluded.min_precision,
           min_samples = excluded.min_samples, updated_at = excluded.updated_at`,
      )
      .run(flowId, category, next.mode, next.min_precision, next.min_samples, isoNow());
    return next;
  }

  /** Categories asked in an office, most asked first. */
  categories(flowId: string): Array<{ category: string; questions: number }> {
    return this.db
      .prepare(
        `SELECT category, count(*) AS questions FROM agent_questions WHERE flow_id = ? AND category <> ''
         GROUP BY category ORDER BY questions DESC`,
      )
      .all(flowId) as Array<{ category: string; questions: number }>;
  }

  listPolicies(flowId?: string): DecisionPolicy[] {
    return (flowId
      ? this.db.prepare("SELECT * FROM agent_decision_policies WHERE flow_id = ? ORDER BY category").all(flowId)
      : this.db.prepare("SELECT * FROM agent_decision_policies ORDER BY flow_id, category").all()) as DecisionPolicy[];
  }

  /** Measured precision of this office's suggestions in a category: the last ones the operator resolved. */
  precision(flowId: string, category: string): { precision: number | null; measured: number } {
    const rows = this.db
      .prepare(
        `SELECT outcome FROM agent_question_suggestions
         WHERE flow_id = ? AND category = ? AND outcome IN ('hit','miss')
         ORDER BY resolved_at DESC LIMIT ?`,
      )
      .all(flowId, category, PRECISION_WINDOW) as Array<{ outcome: string }>;
    if (rows.length === 0) return { precision: null, measured: 0 };
    return { precision: rows.filter((r) => r.outcome === "hit").length / rows.length, measured: rows.length };
  }

  /**
   * What the category's earlier answers point to, for a question being asked.
   * Null when the question has no category, the policy is off, or the history
   * is too thin or split to point anywhere.
   */
  suggest(q: Pick<AgentQuestion, "id" | "flow_id" | "category" | "created_at" | "options">): Suggestion | null {
    if (!q.category) return null;
    const pol = this.policy(q.flow_id, q.category);
    if (pol.mode === "off") return null;
    const since = new Date(Date.parse(q.created_at) - HISTORY_DAYS * 864e5).toISOString();
    const rows = this.db
      .prepare(
        `SELECT selected_option, selected_index FROM agent_questions
         WHERE flow_id = ? AND category = ? AND status = 'answered' AND answered_by IN ('human','rule')
           AND created_at >= ? AND created_at < ? AND id <> ?`,
      )
      .all(q.flow_id, q.category, since, q.created_at, q.id) as Array<{ selected_option: string; selected_index: number }>;
    if (rows.length < SUGGEST_MIN_SAMPLES) return null;
    const counts = new Map<string, { label: string; n: number }>();
    for (const r of rows) {
      if (r.selected_index < 0 || !r.selected_option) continue; // free text: counted in the total, never suggested
      const k = norm(r.selected_option);
      const c = counts.get(k) ?? { label: r.selected_option.trim(), n: 0 };
      c.n++;
      counts.set(k, c);
    }
    const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    if (!top || top.n / rows.length < SUGGEST_MIN_SHARE) return null;
    const option_index = q.options.findIndex((o) => norm(o.label) === norm(top.label));
    const { precision, measured } = this.precision(q.flow_id, q.category);
    return {
      label: top.label, option_index, share: top.n / rows.length, samples: rows.length,
      precision, measured, mode: pol.mode === "auto" && isHoldout(q.id) ? "holdout" : pol.mode,
    };
  }

  record(q: Pick<AgentQuestion, "id" | "flow_id" | "category">, s: Suggestion): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_question_suggestions
          (question_id, flow_id, category, label, option_index, share, samples, precision, mode, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
      )
      .run(q.id, q.flow_id, q.category, s.label, s.option_index, s.share, s.samples, s.precision, s.mode, isoNow());
  }

  suggestionFor(questionId: string): (Suggestion & { outcome: string }) | null {
    const r = this.db.prepare("SELECT * FROM agent_question_suggestions WHERE question_id = ?").get(questionId) as
      | { label: string; option_index: number; share: number; samples: number; precision: number | null; mode: Suggestion["mode"]; outcome: string; flow_id: string; category: string }
      | undefined;
    if (!r) return null;
    const { measured } = this.precision(r.flow_id, r.category);
    return { label: r.label, option_index: r.option_index, share: r.share, samples: r.samples, precision: r.precision, measured, mode: r.mode, outcome: r.outcome };
  }

  /**
   * Answer the precedent alone? Only on `auto`, with an option to pick, the
   * measured precision at or above the bar over enough answers, nothing open
   * in the office's environment (a decision taken while DEV is down is not
   * the same decision), and the category's condition met on this question.
   */
  shouldAuto(q: Parameters<AutoCondition>[0], s: Suggestion, openEnvFacts: number): boolean {
    if (s.mode !== "auto" || s.option_index < 0 || openEnvFacts > 0) return false;
    const pol = this.policy(q.flow_id, q.category);
    if (s.precision === null || s.measured < pol.min_samples || s.precision < pol.min_precision) return false;
    return this.condition(q, { label: s.label }).ok;
  }

  /**
   * The question was resolved: did the operator choose what was suggested?
   * Answers the precedent gave itself, and dismissals, measure nothing.
   */
  resolve(q: Pick<AgentQuestion, "id" | "status" | "selected_option" | "selected_index" | "answered_by">): void {
    const s = this.db.prepare("SELECT label, option_index FROM agent_question_suggestions WHERE question_id = ? AND outcome = ''").get(q.id) as
      | { label: string; option_index: number }
      | undefined;
    if (!s) return;
    let outcome: string;
    if (q.status === "dismissed") outcome = "dismissed";
    else if (q.answered_by === "rule") outcome = "auto";
    else if (q.answered_by === "chief") outcome = "chief";
    else outcome = (s.option_index >= 0 && q.selected_index === s.option_index) || norm(q.selected_option) === norm(s.label) ? "hit" : "miss";
    this.db.prepare("UPDATE agent_question_suggestions SET outcome = ?, resolved_at = ? WHERE question_id = ?").run(outcome, isoNow(), q.id);
  }

  /** The last answer given in this office on the same subject and category, and what changed in the environment since. */
  previousOnSubject(q: Pick<AgentQuestion, "id" | "flow_id" | "subject_key" | "category" | "created_at">): PreviousDecision | null {
    if (!q.subject_key) return null;
    const r = this.db
      .prepare(
        `SELECT id, selected_option, answered_at, answered_by, answered_via, answered_actor FROM agent_questions
         WHERE flow_id = ? AND subject_key = ? AND category = ? AND status = 'answered' AND id <> ? AND answered_at < ?
         ORDER BY answered_at DESC LIMIT 1`,
      )
      .get(q.flow_id, q.subject_key, q.category, q.id, q.created_at) as
      | { id: string; selected_option: string; answered_at: string; answered_by: string; answered_via: string; answered_actor: string }
      | undefined;
    if (!r) return null;
    const changes = this.db
      .prepare(
        `SELECT key, 'opened' AS change, valid_from AS at FROM agent_env_facts WHERE flow_id = ? AND valid_from > ? AND valid_from <= ?
         UNION ALL
         SELECT key, 'closed' AS change, valid_to AS at FROM agent_env_facts WHERE flow_id = ? AND valid_to > ? AND valid_to <= ?
         ORDER BY at`,
      )
      .all(q.flow_id, r.answered_at, q.created_at, q.flow_id, r.answered_at, q.created_at) as PreviousDecision["env_changes"];
    return {
      question_id: r.id, label: r.selected_option, at: r.answered_at, answered_by: r.answered_by,
      via: r.answered_via, actor: r.answered_actor, env_changes: changes,
    };
  }

  /** One or two lines for the operator: the suggestion, and the last decision on the same subject. */
  hint(q: AgentQuestion, lang: "es" | "en" = "es"): string | null {
    const lines: string[] = [];
    const s = this.suggestionFor(q.id);
    if (s && s.mode !== "off") {
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const measured = s.precision === null ? "" : lang === "es"
        ? `, acertó ${pct(s.precision)} de ${s.measured}`
        : `, right ${pct(s.precision)} of ${s.measured}`;
      lines.push(lang === "es"
        ? `💡 Lo habitual: «${s.label}» (${pct(s.share)} de ${s.samples} casos${measured})`
        : `💡 Usually: "${s.label}" (${pct(s.share)} of ${s.samples} cases${measured})`);
    }
    const p = this.previousOnSubject(q);
    if (p) {
      const day = p.at.slice(0, 16).replace("T", " ");
      const env = p.env_changes.length
        ? (lang === "es" ? ` — desde entonces: ` : ` — since then: `) + p.env_changes.map((c) => `${c.key} ${c.change === "opened" ? (lang === "es" ? "se abrió" : "opened") : (lang === "es" ? "se cerró" : "closed")}`).join(", ")
        : "";
      lines.push(lang === "es" ? `↩︎ La última vez (${day}): «${p.label}»${env}` : `↩︎ Last time (${day}): "${p.label}"${env}`);
    }
    return lines.length ? lines.join("\n") : null;
  }
}
