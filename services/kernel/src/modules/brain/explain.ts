/**
 * Why did Kernl act that way? — what it believed at the moment of a
 * decision, set against what is now known to have been true then.
 *
 * The two timelines of facts.ts make the comparison exact:
 *
 *   believed  facts true at T as Kernl believed them at T (asOf T, knownAt T)
 *   actual    facts true at T as Kernl believes them now  (asOf T)
 *
 * Where the two differ, the reason is one of two things, and telling them
 * apart is the point:
 *
 *   late_information  the world had changed, but Kernl only learned it after
 *                     T. The decision was right for what was known.
 *   wrong_belief      what Kernl held was later corrected as a mistake. The
 *                     stored fact itself was wrong.
 *
 * Each believed fact carries who wrote it (the provenance record of the call
 * that asserted it) and where it came from (the fact's source). The moment T
 * is given, or taken from an action: the first successful writing call that
 * named or returned `action_ref`.
 */

import type { Fact, FactStore } from "./facts.js";
import { normTime } from "./facts.js";
import type { ProvenanceRow, ProvenanceService } from "../provenance/service.js";

export type Verdict = "consistent" | "late_information" | "wrong_belief";

export interface Writer {
  actor_kind: string;
  actor_id: string;
  actor_name: string;
  run_id: string;
  tool: string;
  at: string;
}

export interface ExplainedFact {
  id: string;
  object: string;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  ended_at: string | null;
  superseded_at: string | null;
  source: string;
  source_ref: string;
  written_by: Writer | null;
}

export interface Finding {
  predicate: string;
  verdict: Verdict;
  believed: ExplainedFact[];
  actual: ExplainedFact[];
  /** When Kernl learned the difference (late_information) or corrected it (wrong_belief). */
  learned_at?: string;
  /** Days between T and learned_at. */
  lag_days?: number;
  sentence: string;
}

export interface Explanation {
  status: "explained";
  at: string;
  subject: string;
  subject_name: string;
  action: (Writer & { detail: string }) | null;
  verdict: Verdict;
  findings: Finding[];
  /** Plain sentences, the differences first. */
  summary: string[];
}

export interface Ambiguous {
  status: "ambiguous";
  candidates: Array<{ subject: string; subject_name: string }>;
}

export interface ExplainInput {
  /** A fact subject, e.g. "Person:<id>". */
  subject?: string;
  /** Or a name to find the subject by. */
  name?: string;
  predicate?: string;
  /** The moment of the decision (ISO)… */
  at?: string;
  /** …or the id of what the action produced or touched. */
  actionRef?: string;
}

const RANK: Record<Verdict, number> = { consistent: 0, late_information: 1, wrong_belief: 2 };
const DAY = 86_400_000;

const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const key = (s: string) => s.trim().toLowerCase();
const list = (fs: ExplainedFact[]) => (fs.length ? fs.map((f) => `"${f.object}"`).join(", ") : "nothing");

function toWriter(r: ProvenanceRow): Writer {
  return {
    actor_kind: r.actor_kind, actor_id: r.actor_id, actor_name: r.actor_name,
    run_id: r.run_id, tool: r.tool, at: r.at,
  };
}

/** The first successful call that touched `ref`. */
function firstCall(prov: ProvenanceService | null, ref: string): ProvenanceRow | null {
  const rows = prov?.whoTouched(ref, 200) ?? [];
  const ok = rows.filter((r) => r.ok === 1);
  return ok.length ? ok[ok.length - 1] : null;
}

export function explainBelief(
  facts: FactStore,
  prov: ProvenanceService | null,
  input: ExplainInput,
): Explanation | Ambiguous {
  // ── Whose facts ──
  let subject = input.subject?.trim() ?? "";
  if (!subject) {
    const name = input.name?.trim();
    if (!name) throw new Error("subject or name is required");
    const found = facts.findSubjects(name);
    if (found.length === 0) throw new Error(`no facts about "${name}"`);
    if (found.length > 1) return { status: "ambiguous", candidates: found };
    subject = found[0].subject;
  }

  // ── When ──
  let action: Explanation["action"] = null;
  let at: string;
  if (input.at) {
    at = normTime(input.at);
  } else if (input.actionRef) {
    const call = firstCall(prov, input.actionRef);
    if (!call) throw new Error(`no recorded action touched ${input.actionRef}`);
    at = call.at;
    action = { ...toWriter(call), detail: call.detail };
  } else {
    throw new Error("at or action_ref is required");
  }

  // ── Then vs. now ──
  const believed = facts.query({ subject, predicate: input.predicate, asOf: at, knownAt: at, limit: 500 });
  const actual = facts.query({ subject, predicate: input.predicate, asOf: at, limit: 500 });
  const writers = new Map<string, Writer | null>();
  const view = (f: Fact): ExplainedFact => {
    if (!writers.has(f.id)) {
      const c = firstCall(prov, f.id);
      writers.set(f.id, c ? toWriter(c) : null);
    }
    return {
      id: f.id, object: f.object, valid_from: f.valid_from, valid_to: f.valid_to,
      recorded_at: f.recorded_at, ended_at: f.ended_at ?? null, superseded_at: f.superseded_at,
      source: f.source, source_ref: f.source_ref, written_by: writers.get(f.id) ?? null,
    };
  };

  const predicates = [...new Set([...believed, ...actual].map((f) => f.predicate))].sort();
  const subjectName = facts.subjectName(subject);

  const findings: Finding[] = predicates.map((predicate) => {
    const b = believed.filter((f) => f.predicate === predicate).map(view);
    const a = actual.filter((f) => f.predicate === predicate).map(view);
    const bKeys = new Set(b.map((f) => key(f.object)));
    const aKeys = new Set(a.map((f) => key(f.object)));
    const label = predicate.replace(/_/g, " ");
    const same = bKeys.size === aKeys.size && [...bKeys].every((k) => aKeys.has(k));
    if (same) {
      return { predicate, verdict: "consistent", believed: b, actual: a, sentence: `${label}: Kernl believed ${list(b)}, and that was right.` };
    }

    const origin = (fs: ExplainedFact[]) => {
      const f = fs.find((x) => x.written_by || x.source);
      if (!f) return "";
      const w = f.written_by;
      const by = w ? `, written by ${w.actor_name || w.actor_id} (${w.tool}) on ${when(w.at)}` : "";
      const from = f.source ? ` from ${f.source}` : "";
      return `${by}${from}`;
    };

    const corrected = b.filter((f) => f.superseded_at);
    if (corrected.length) {
      const learned = corrected.map((f) => f.superseded_at!).sort()[0];
      return {
        predicate, verdict: "wrong_belief", believed: b, actual: a, learned_at: learned,
        lag_days: Math.max(0, Math.round((Date.parse(learned) - Date.parse(at)) / DAY)),
        sentence:
          `${label}: on ${when(at)} Kernl believed ${list(b)}${origin(b)}. That was corrected on ` +
          `${when(learned)} to ${list(a)}: the stored fact was wrong.`,
      };
    }

    // Values Kernl did not have yet, and values whose end it did not know yet.
    const learnedTimes = [
      ...a.filter((f) => !bKeys.has(key(f.object))).map((f) => f.recorded_at),
      ...b.filter((f) => !aKeys.has(key(f.object))).map((f) => f.ended_at ?? f.recorded_at),
    ].filter((t) => t > at).sort();
    const learned = learnedTimes[0] ?? at;
    const since = a.map((f) => f.valid_from).sort()[0];
    const lag = Math.max(0, Math.round((Date.parse(learned) - Date.parse(at)) / DAY));
    return {
      predicate, verdict: "late_information", believed: b, actual: a, learned_at: learned, lag_days: lag,
      sentence:
        `${label}: on ${when(at)} Kernl believed ${list(b)}${origin(b)}. In fact it was ${list(a)}` +
        `${since ? ` since ${when(since)}` : ""}, but Kernl only learned it on ${when(learned)}` +
        `${lag ? `, ${lag} day${lag === 1 ? "" : "s"} later` : ""}. The information was late, not the reasoning.`,
    };
  });

  findings.sort((x, y) => RANK[y.verdict] - RANK[x.verdict] || x.predicate.localeCompare(y.predicate));
  const verdict = findings.reduce<Verdict>((v, f) => (RANK[f.verdict] > RANK[v] ? f.verdict : v), "consistent");
  const summary: string[] = [];
  if (action) {
    summary.push(
      `${action.actor_name || action.actor_id} called ${action.tool} on ${when(action.at)}` +
      `${action.detail ? ` (${action.detail})` : ""}.`,
    );
  }
  for (const f of findings) summary.push(f.sentence);
  if (findings.length === 0) summary.push(`Kernl held no facts about ${subjectName || subject} at ${when(at)}.`);

  return { status: "explained", at, subject, subject_name: subjectName, action, verdict, findings, summary };
}
