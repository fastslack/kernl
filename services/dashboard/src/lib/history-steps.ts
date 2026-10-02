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

import type { AgentFlowEvent } from './stores.js';

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
  return {
    event: 'agent:flow:step',
    data: {
      type: s.type,
      tool_name: s.tool_name ?? '',
      content_preview: stepPayload(s),
      step_number: Number(s.step_number),
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
  | { kind: 'tools'; steps: HistoryStep[]; uses: ToolUse[]; range: string };

const isTool = (s: HistoryStep) => !s.is_event && (s.type === 'tool_call' || s.type === 'tool_result');

/** "mcp__kernel__kernel_agents_inbox" → "kernel_agents_inbox". */
export function shortToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

function looksFailed(output: string): boolean {
  const t = output.trim();
  return /^(error|failed|exception)\b/i.test(t) || /"is_?error"\s*:\s*true/i.test(t) || /^\{\s*"error"/.test(t);
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
    use.ok = !looksFailed(String(s.tool_output ?? ''));
  }
  return uses;
}

/** Group consecutive tool steps (two or more) into a single row. */
export function groupHistoryRows(steps: HistoryStep[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
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
    if (isTool(s)) run.push(s);
    else { flush(); rows.push({ kind: 'step', step: s }); }
  }
  flush();
  return rows;
}
