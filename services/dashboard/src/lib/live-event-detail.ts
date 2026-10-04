/**
 * What an expanded row of the LIVE activity feed shows.
 *
 * Tool steps (call, result, thought, final, error) already open into their
 * payload — liveEventSummary renders that. Everything else in the feed (the
 * run lifecycle, self-grading, lessons learned or retired, handoffs) used to
 * be a single truncated line with nothing behind it. This turns each of those
 * events into labelled sections a person can actually read: the full text,
 * the numbers with their meaning spelled out, and the ids to chase.
 *
 * Pure — no Svelte, no DOM — so every event type is pinned by a test.
 */

import type { AgentFlowEvent } from './stores.js';

export type DetailTone = 'neutral' | 'good' | 'warn' | 'bad';

export interface DetailField {
  label: string;
  value: string;
  tone?: DetailTone;
  /** Render in monospace (ids, counts). */
  mono?: boolean;
  /** One-line explanation shown under the value. */
  hint?: string;
}

export type DetailSection =
  | { kind: 'fields'; fields: DetailField[] }
  | { kind: 'text'; label: string; body: string; tone?: DetailTone; markdown?: boolean }
  | { kind: 'list'; label: string; items: Array<{ text: string; meta?: string }>; empty?: string }
  | { kind: 'meter'; label: string; value: number; max: number; caption: string; tone: DetailTone }
  | { kind: 'note'; body: string };

export interface LiveEventDetail {
  sections: DetailSection[];
  /** Plain-text version of everything shown, for the copy button. */
  copyText: string;
}

/** Steps whose payload the feed already renders (see liveEventSummary). */
const PAYLOAD_STEPS = new Set(['tool_call', 'tool_result', 'thought', 'final', 'error']);

/** Keys that identify the event rather than describe it — never shown by the fallback. */
const ID_KEYS = new Set(['agent_id', 'agent_name', 'source_agent_id', 'target_agent_id', 'ts']);

const LEARNING_KINDS: Record<string, { label: string; hint: string }> = {
  insight: { label: 'Insight', hint: 'Something that worked — the agent will lean on it next time.' },
  avoid: { label: 'Avoid', hint: 'Something not to do again — the agent will steer clear of it.' },
  prefer: { label: 'Prefer', hint: 'A preferred way of doing things when there is a choice.' },
  pattern: { label: 'Pattern', hint: 'A recurring situation and how to handle it.' },
};

const TRIGGERS: Record<string, string> = {
  manual: 'Manual', schedule: 'Scheduled', event: 'Event', chain: 'Handoff from another agent',
};

const OUTCOMES: Record<string, string> = { success: 'Success', partial: 'Partial', failure: 'Failure' };

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}
function num(v: unknown): number | null {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
}
function pct(v: unknown): string {
  const n = num(v);
  return n === null ? '' : `${Math.round(n * 100)}%`;
}
function int(v: unknown): string {
  const n = num(v);
  return n === null ? '' : Math.round(n).toLocaleString('en-US');
}
function titleCase(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function learningKind(type: unknown) {
  const t = str(type).toLowerCase();
  return LEARNING_KINDS[t] ?? { label: titleCase(t || 'lesson'), hint: '' };
}

/** "- a\n- b", "1. a\n2. b", "a; b" → ["a", "b"]. */
export function splitIssues(raw: unknown): string[] {
  const text = str(raw);
  if (!text) return [];
  const lines = text.includes('\n') ? text.split('\n') : text.split(/;\s+/);
  return lines
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

function scoreTone(score: number, max: number): DetailTone {
  const r = score / max;
  return r >= 0.8 ? 'good' : r >= 0.6 ? 'warn' : 'bad';
}

/** Drop fields with an empty value so nothing reads "Steps: ". */
function fields(list: Array<DetailField | false | null | undefined>): DetailSection | null {
  const kept = list.filter((f): f is DetailField => !!f && f.value !== '');
  return kept.length ? { kind: 'fields', fields: kept } : null;
}

function runIdField(data: Record<string, unknown>): DetailField | null {
  const id = str(data.run_id);
  return id ? { label: 'Run ID', value: id, mono: true } : null;
}

function build(e: AgentFlowEvent, type: string): DetailSection[] | null {
  const d = e.data ?? {};
  switch (type) {
    case 'run_started': {
      const goal = str(d.goal);
      const builtin = Boolean(d.builtin);
      return [
        goal
          ? { kind: 'text', label: 'Goal', body: goal, markdown: true }
          : { kind: 'note', body: builtin ? 'Built-in run: native code, no prompt.' : 'Scheduled run with no explicit goal.' },
        fields([
          { label: 'Trigger', value: TRIGGERS[str(d.trigger_type)] ?? titleCase(str(d.trigger_type)) },
          runIdField(d),
        ]),
      ].filter(Boolean) as DetailSection[];
    }

    case 'run_completed': {
      const ok = str(d.status || 'completed') === 'completed';
      const sections: Array<DetailSection | null> = [
        fields([
          { label: 'Status', value: ok ? 'Completed' : 'Failed', tone: ok ? 'good' : 'bad' },
          { label: 'Steps', value: int(d.steps_count), mono: true },
          { label: 'Tokens', value: int(d.tokens_used), mono: true },
          runIdField(d),
        ]),
      ];
      const err = str(d.error);
      if (err) sections.push({ kind: 'text', label: 'Error', body: err, tone: 'bad' });
      const result = str(d.result_preview);
      if (result) sections.push({ kind: 'text', label: 'Result', body: result, markdown: true });
      return sections.filter(Boolean) as DetailSection[];
    }

    case 'auto_eval_started':
      return [
        { kind: 'note', body: 'The agent is grading its own run against the goal. The score and any lesson it draws from it show up next.' },
        fields([runIdField(d)]),
      ].filter(Boolean) as DetailSection[];

    case 'auto_eval_skipped':
      return [
        { kind: 'note', body: 'Self-grading was skipped for this run (nothing to grade, or grading is off for this agent).' },
        fields([runIdField(d)]),
      ].filter(Boolean) as DetailSection[];

    case 'auto_eval': {
      const score = num(d.score) ?? 0;
      const outcome = OUTCOMES[str(d.outcome).toLowerCase()] ?? titleCase(str(d.outcome) || 'Graded');
      return [
        { kind: 'meter', label: 'Self-assessed score', value: score, max: 5, caption: `${score} / 5 · ${outcome}`, tone: scoreTone(score, 5) },
        {
          kind: 'list', label: 'Issues found', items: splitIssues(d.issues).map((text) => ({ text })),
          empty: 'No issues reported — the agent judged the goal met.',
        },
        fields([
          { label: 'Grader confidence', value: pct(d.confidence), mono: true, hint: 'How sure the grader is of this score.' },
          runIdField(d),
        ]),
      ].filter(Boolean) as DetailSection[];
    }

    case 'learning_created': {
      const kind = learningKind(d.learning_type);
      return [
        { kind: 'text', label: 'Lesson', body: str(d.content) },
        fields([
          { label: 'Kind', value: kind.label, hint: kind.hint },
          { label: 'Confidence', value: pct(d.confidence), mono: true, hint: 'Lessons below the confidence floor are retired automatically.' },
          { label: 'Lesson ID', value: str(d.learning_id), mono: true },
          runIdField(d),
        ]),
      ].filter(Boolean) as DetailSection[];
    }

    case 'learning_deactivated': {
      const retired = Array.isArray(d.learnings) ? (d.learnings as Array<Record<string, unknown>>) : [];
      const note: DetailSection = {
        kind: 'note',
        body: 'Lessons are retired when their confidence drops below the floor after repeated runs that did not back them up. Retired lessons stop being added to the agent\'s prompt.',
      };
      if (retired.length === 0) {
        return [
          fields([{ label: 'Lessons retired', value: int(d.count), mono: true }, runIdField(d)]),
          note,
        ].filter(Boolean) as DetailSection[];
      }
      return [
        {
          kind: 'list', label: 'Retired lessons',
          items: retired.map((l) => ({
            text: str(l.content),
            meta: [learningKind(l.type).label, pct(l.confidence)].filter(Boolean).join(' · '),
          })),
        },
        note,
        fields([runIdField(d)]),
      ].filter(Boolean) as DetailSection[];
    }

    case 'chain_triggered':
      return [
        { kind: 'note', body: 'This run finished and handed its output to the next agent in the chain.' },
        fields([
          { label: 'From', value: str(d.source_agent_name) },
          { label: 'To', value: str(d.target_agent_name) },
          { label: 'Chain', value: str(d.chain_label) },
          { label: 'Chain ID', value: str(d.chain_id), mono: true },
          runIdField(d),
        ]),
      ].filter(Boolean) as DetailSection[];

    default:
      return fallback(d);
  }
}

/** Unknown event: show every descriptive field rather than nothing. */
function fallback(d: Record<string, unknown>): DetailSection[] | null {
  const flat: DetailField[] = [];
  const blocks: DetailSection[] = [];
  for (const [key, value] of Object.entries(d)) {
    if (ID_KEYS.has(key) || value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') {
      blocks.push({ kind: 'text', label: titleCase(key), body: '```json\n' + JSON.stringify(value, null, 2) + '\n```', markdown: true });
    } else if (key === 'run_id' || key.endsWith('_id')) {
      flat.push({ label: titleCase(key).replace(/ id$/i, ' ID'), value: String(value), mono: true });
    } else {
      const s = String(value);
      if (s.length > 120 || s.includes('\n')) blocks.push({ kind: 'text', label: titleCase(key), body: s });
      else flat.push({ label: titleCase(key), value: s, mono: typeof value === 'number' });
    }
  }
  // Only ids left (run_id) means there is nothing to read here.
  if (blocks.length === 0 && flat.every((f) => f.label === 'Run ID')) return null;
  const head = fields(flat);
  return [...blocks, ...(head ? [head] : [])];
}

function toText(sections: DetailSection[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (s.kind === 'fields') for (const f of s.fields) out.push(`${f.label}: ${f.value}`);
    else if (s.kind === 'text') out.push(`${s.label}:\n${s.body}`);
    else if (s.kind === 'list') out.push(`${s.label}:\n${s.items.length ? s.items.map((i) => `- ${i.text}${i.meta ? ` (${i.meta})` : ''}`).join('\n') : (s.empty ?? '')}`);
    else if (s.kind === 'meter') out.push(`${s.label}: ${s.caption}`);
    else out.push(s.body);
  }
  return out.join('\n\n');
}

/** Structured detail for an activity row, or null when the row has a payload
 *  renderer of its own (tool steps) or nothing worth opening. */
export function liveEventDetail(e: AgentFlowEvent): LiveEventDetail | null {
  const t = e.event.split(':').pop() ?? '';
  const type = t === 'step' ? String(e.data?.type ?? 'step') : t;
  if (PAYLOAD_STEPS.has(type)) return null;
  const sections = build(e, type);
  if (!sections || sections.length === 0) return null;
  return { sections, copyText: toText(sections) };
}
