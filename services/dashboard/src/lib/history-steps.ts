/**
 * HISTORY rows in the shape LIVE already renders.
 *
 * A stored run comes back as its steps (agent_run_steps: the tool calls with
 * their full input and output, thoughts, finals) plus its event log (run
 * started/completed, self-grading). LIVE gets the same information as flow
 * events and already knows how to summarise and open them, so instead of a
 * second set of renderers HISTORY converts its rows into flow events.
 *
 * Pure — no Svelte, no fetch.
 */

import { isAgentActionTool } from './agent-actions.js';
import type { AgentFlowEvent } from './stores.js';
import { collapseRepeats } from './collapse-repeats.js';

export interface StoredStep {
  step_number: number | string;
  type: string;
  content?: string;
  tool_name?: string;
  tool_input?: string;
  tool_output?: string;
  created_at?: string;
}

/** A row of the HISTORY timeline: a stored step, or an event-log entry
 *  carried as the flow event LIVE showed for it. */
export interface HistoryStep extends StoredStep {
  step_number: number;
  content: string;
  tool_name: string;
  is_event?: boolean;
  event?: AgentFlowEvent;
}

export interface EventLogRow {
  event_type?: string;
  event_subtype?: string;
  detail?: string;
  raw_data?: string;
  created_at?: string;
}

/** The text LIVE's summarizers read for each step type. */
function stepPayload(s: StoredStep): string {
  if (s.type === 'tool_call') return String(s.tool_input ?? '');
  if (s.type === 'tool_result') return String(s.tool_output ?? '');
  return String(s.content ?? '');
}

/** A stored step as the flow event LIVE would have received for it. */
export function stepAsFlowEvent(s: StoredStep): AgentFlowEvent {
  const isError = storedErrorFlag(s);
  return {
    event: 'agent:flow:step',
    data: {
      type: s.type,
      tool_name: s.tool_name ?? '',
      content_preview: stepPayload(s),
      step_number: Number(s.step_number),
      ...(isError !== undefined ? { is_error: isError } : {}),
    },
    ts: s.created_at ?? '',
  };
}

function tryJson(raw: string): unknown {
  const t = raw.trim();
  if (!t || !(t.startsWith('{') || t.startsWith('['))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

function isEmptyArgs(v: unknown): boolean {
  return v !== null && typeof v === 'object' && Object.keys(v as object).length === 0;
}

export interface StepDetail {
  /** "Input" for a call, "Output" for a result, "" for text steps. */
  label: '' | 'Input' | 'Output';
  /** Markdown to render; for an empty payload, the sentence explaining it. */
  body: string;
  /** True when there was nothing to show — render `body` as a muted note. */
  empty: boolean;
}

/**
 * What an opened step shows. Unlike LIVE (which only ever sees the stream's
 * capped previews) HISTORY has the stored payload, so this shows it whole:
 * inputs and JSON outputs pretty-printed, prose as written.
 */
export function historyStepDetail(s: StoredStep): StepDetail {
  if (s.type === 'tool_call') {
    const raw = String(s.tool_input ?? '');
    const parsed = tryJson(raw);
    if (!raw.trim() || (parsed !== undefined && isEmptyArgs(parsed))) {
      return { label: 'Input', body: 'Called with no arguments.', empty: true };
    }
    const body = parsed !== undefined ? JSON.stringify(parsed, null, 2) : raw;
    return { label: 'Input', body: '```json\n' + body + '\n```', empty: false };
  }
  if (s.type === 'tool_result') {
    const raw = String(s.tool_output ?? '');
    if (!raw.trim()) return { label: 'Output', body: 'No output was recorded for this call.', empty: true };
    const parsed = tryJson(raw);
    return {
      label: 'Output',
      body: parsed !== undefined ? '```json\n' + JSON.stringify(parsed, null, 2) + '\n```' : raw,
      empty: false,
    };
  }
  return { label: '', body: String(s.content ?? ''), empty: false };
}

function parseRaw(raw: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/**
 * One event-log row → the flow events LIVE emitted for it. A self-eval row
 * also carries the lesson it drew and the lessons it retired, which LIVE saw
 * as separate events — so it fans out into up to three rows.
 */
export function eventLogToFlowEvents(row: EventLogRow, runId: string): AgentFlowEvent[] {
  const sub = String(row.event_subtype || row.event_type || 'event');
  const raw = parseRaw(row.raw_data);
  const ts = row.created_at ?? '';
  const ev = (name: string, data: Record<string, unknown>): AgentFlowEvent =>
    ({ event: `agent:flow:${name}`, data: { ...data, run_id: runId }, ts });

  if (row.event_type === 'run' && sub === 'started') return [ev('run_started', raw)];
  if (row.event_type === 'run' && (sub === 'completed' || sub === 'failed')) {
    return [ev('run_completed', { status: sub === 'failed' ? 'failed' : 'completed', ...raw })];
  }
  if (sub === 'auto_eval') {
    const out = [ev('auto_eval', {
      score: raw.score, outcome: raw.outcome, confidence: raw.confidence, issues: raw.issues ?? '',
    })];
    const l = raw.learning as Record<string, unknown> | null | undefined;
    if (l && typeof l === 'object') {
      out.push(ev('learning_created', {
        learning_id: l.id, learning_type: l.type, content: l.content, confidence: l.confidence,
      }));
    }
    const retired = Array.isArray(raw.retired_learnings) ? raw.retired_learnings : [];
    if (retired.length) out.push(ev('learning_deactivated', { count: retired.length, learnings: retired }));
    return out;
  }
  // Anything else keeps its fields; the log's own one-liner is the fallback text.
  return [ev(sub, { ...(row.detail ? { detail: row.detail } : {}), ...raw })];
}

// ── Folding runs of tool steps ──────────────────────────────────────────────
//
// A typical agent run is mostly call → result → call → result, and each of
// those rows on its own says little ("TOOL CALL ToolSearch"). Consecutive tool
// steps fold into one row listing every tool used, with whether it worked and
// what it returned; the row opens into each call's input and output.

export interface ToolUse {
  /** Tool name without the MCP server prefix. */
  name: string;
  fullName: string;
  call?: HistoryStep;
  result?: HistoryStep;
  /** False when the result reads as an error. */
  ok: boolean;
}

export type HistoryRow =
  | { kind: 'step'; step: HistoryStep }
  | { kind: 'tools'; steps: HistoryStep[]; uses: ToolUse[]; range: string }
  /** An agent acting on another agent (agent-actions.ts): its call and result, on their own. */
  | { kind: 'action'; use: ToolUse };

const isTool = (s: HistoryStep) => !s.is_event && (s.type === 'tool_call' || s.type === 'tool_result');

/** "mcp__kernel__kernel_agents_inbox" → "kernel_agents_inbox". */
export function shortToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

/**
 * A zod validation failure serialised as-is: an array of issues, each with a
 * `code` and a `message` plus `path` or `expected`/`received`. Every element
 * has to match, so an ordinary array of records is never taken for one.
 */
function isZodIssueArray(t: string): boolean {
  if (!t.startsWith('[') || !/"code"/.test(t)) return false;
  let v: unknown;
  try { v = JSON.parse(t); } catch { return false; }
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((el) => {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
    const o = el as Record<string, unknown>;
    if (typeof o.code !== 'string' || typeof o.message !== 'string') return false;
    return Array.isArray(o.path) || ('expected' in o && 'received' in o);
  });
}

/** True when a tool's output reads as an error. Only a guess: used when the
 *  step carries no `is_error` flag (runs recorded before it existed). */
export function looksFailed(output: string): boolean {
  const t = output.trim();
  return /^(error|failed|exception)\b/i.test(t) || /"is_?error"\s*:\s*true/i.test(t) || /^\{\s*"error"/.test(t)
    || isZodIssueArray(t);
}

/**
 * The recorded error flag of a stored tool_result step, if it has one. The
 * kernel keeps it in the result row's tool_input (`{"is_error": true}`);
 * older rows carry "{}" and give undefined.
 */
export function storedErrorFlag(s: StoredStep): boolean | undefined {
  if (s.type !== 'tool_result') return undefined;
  const v = tryJson(String(s.tool_input ?? ''));
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const flag = (v as Record<string, unknown>).is_error;
  return typeof flag === 'boolean' ? flag : undefined;
}

/** Whether a tool result failed: the recorded flag when there is one,
 *  otherwise the `looksFailed` guess on its output. */
export function resultFailed(flag: unknown, output: string): boolean {
  return typeof flag === 'boolean' ? flag : looksFailed(output);
}

function pairUses(steps: HistoryStep[]): ToolUse[] {
  const uses: ToolUse[] = [];
  for (const s of steps) {
    const fullName = s.tool_name || 'tool';
    if (s.type === 'tool_call') {
      uses.push({ name: shortToolName(fullName), fullName, call: s, ok: true });
      continue;
    }
    // A result closes the oldest open call of the same tool; an orphan result
    // (its call fell outside the run) still gets its own entry.
    const open = uses.find((u) => u.fullName === fullName && u.call && !u.result);
    const use = open ?? (uses.push({ name: shortToolName(fullName), fullName, ok: true }), uses[uses.length - 1]);
    use.result = s;
    use.ok = !resultFailed(storedErrorFlag(s), String(s.tool_output ?? ''));
  }
  return uses;
}

/**
 * Group consecutive tool steps (two or more) into a single row. An agent
 * acting on another agent — a colleague message, an edit, a run… — never
 * folds into such a group: it gets a row of its own, call and result paired,
 * because it is the step a person goes looking for.
 */
export function groupHistoryRows(steps: HistoryStep[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const openActions: Array<Extract<HistoryRow, { kind: 'action' }>> = [];
  let run: HistoryStep[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0].step_number, last = run[run.length - 1].step_number;
      rows.push({ kind: 'tools', steps: run, uses: pairUses(run), range: first === last ? `${first}` : `${first}–${last}` });
    } else {
      for (const s of run) rows.push({ kind: 'step', step: s });
    }
    run = [];
  };
  for (const s of steps) {
    if (isTool(s) && isAgentActionTool(s.tool_name)) {
      flush();
      const fullName = s.tool_name || 'tool';
      if (s.type === 'tool_call') {
        const row = { kind: 'action' as const, use: { name: shortToolName(fullName), fullName, call: s, ok: true } };
        rows.push(row);
        openActions.push(row);
        continue;
      }
      const ok = !resultFailed(storedErrorFlag(s), String(s.tool_output ?? ''));
      const open = openActions.find((r) => r.use.fullName === fullName && !r.use.result);
      if (open) { open.use.result = s; open.use.ok = ok; }
      else rows.push({ kind: 'action', use: { name: shortToolName(fullName), fullName, result: s, ok } });
      continue;
    }
    if (isTool(s)) run.push(s);
    else { flush(); rows.push({ kind: 'step', step: s }); }
  }
  flush();
  return rows;
}

/** One chip of a folded tool row: a run of consecutive calls to one tool. */
export interface ToolChip {
  name: string;
  fullName: string;
  /** Calls in the run. */
  count: number;
  /** Calls whose result reads as an error. */
  failed: number;
  /** Calls with no result recorded yet. */
  pending: number;
  uses: ToolUse[];
}

/**
 * Fold consecutive calls to the same tool into one chip, so 25 liveness polls
 * read `kernel_career_liveness ×25` instead of 25 chips joined by arrows. The
 * counts let the chip stay honest: a run is only a success when every call in
 * it succeeded.
 */
export function toolChips(uses: ToolUse[]): ToolChip[] {
  return collapseRepeats(uses, (u) => u.fullName).map((r) => ({
    name: r.item.name,
    fullName: r.item.fullName,
    count: r.count,
    failed: r.items.filter((u) => u.result && !u.ok).length,
    pending: r.items.filter((u) => !u.result).length,
    uses: r.items,
  }));
}
