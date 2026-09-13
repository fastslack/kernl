/**
 * The LIVE timeline: turning raw agent events into one-line, human-readable
 * steps. Extracted verbatim from AgentWorld3D.svelte, where it sat among the
 * three.js scene code with no way to test any of it.
 *
 * Everything here is pure. The two functions that used to read the component's
 * `liveCurrentRunEvents` now take that array as their first argument.
 *
 * Related but deliberately separate: `tool-presentation.ts` labels a tool for
 * the chat's tool cards (icons, module names, dashboard links). This module
 * summarizes what a step *did* for the run timeline. Same subject, different
 * output — merging them would change both surfaces.
 */

import type { AgentFlowEvent } from './stores.js';
import { ellipsize } from './display-format.js';
import { sanitizePreview } from './run-format.js';
import { isAbsoluteHostPath } from './host-path.js';

export type ToolCategory =
  | 'shell' | 'fs' | 'web' | 'kernel' | 'mcp' | 'think' | 'final'
  | 'error' | 'meta' | 'tool';

export function liveStepIcon(type: string): string {
  switch (type) {
    case 'tool_call': return '🔧';
    case 'tool_result': return '📥';
    case 'thought': return '💭';
    case 'final': return '✨';
    case 'rate_limit_wait': return '⏳';
    case 'error': return '⚠️';
    case 'auto_eval_started': return '📝';
    case 'auto_eval': return '📝';
    case 'learning_created': return '💡';
    case 'learning_deactivated': return '🗑️';
    case 'chain_triggered': return '🔗';
    case 'run_started': return '▶';
    case 'run_completed': return '✅';
    default: return '•';
  }
}

export function liveStepLabel(type: string): string {
  switch (type) {
    case 'tool_call': return 'calling tool';
    case 'tool_result': return 'tool result';
    case 'thought': return 'thinking';
    case 'final': return 'finalizing';
    case 'rate_limit_wait': return 'rate limited';
    case 'error': return 'error';
    case 'auto_eval_started': return 'self-grading';
    case 'auto_eval': return 'self-eval';
    case 'learning_created': return 'lesson learned';
    case 'learning_deactivated': return 'lesson dropped';
    case 'chain_triggered': return 'handoff';
    case 'run_started': return 'run started';
    case 'run_completed': return 'run completed';
    default: return type || 'step';
  }
}

export function liveEventType(e: AgentFlowEvent): string {
  const t = e.event.split(':').pop() ?? '';
  if (t === 'step') return String(e.data.type ?? 'step');
  return t;
}

export function liveEventSummary(e: AgentFlowEvent): string {
  const t = e.event.split(':').pop() ?? '';
  if (t === 'run_started') {
    const goalTxt = String(e.data.goal ?? '').trim();
    const isBuiltin = Boolean(e.data.builtin);
    if (isBuiltin) {
      return goalTxt
        ? `Builtin run — ${goalTxt}`
        : 'Builtin run (native code, no prompt)';
    }
    return goalTxt
      ? `Started — goal: ${goalTxt}`
      : 'Started — scheduled run';
  }
  if (t === 'run_completed') {
    const st = String(e.data.status ?? 'completed');
    return st === 'completed' ? 'Run completed successfully' : `Run ${st}`;
  }
  if (t === 'chain_triggered') return `Handoff → ${String(e.data.target_agent_name ?? 'next agent')}`;
  if (t === 'auto_eval_started') return 'Self-grading…';
  if (t === 'auto_eval') {
    const score = Number(e.data.score ?? 0);
    return `Self-graded ${score}/5 — ${String(e.data.outcome ?? '')}`;
  }
  if (t === 'learning_created') return `Lesson learned: ${String(e.data.content ?? '')}`;
  if (t === 'step') {
    const st = String(e.data.type ?? '');
    const preview = String(e.data.content_preview ?? '');
    // Server already truncates previews (tool_result=2000, tool_call input=800,
    // thought/final=200). Show the full preview — truncating again here only
    // hides useful context in the LIVE tab. Full text is in HISTORY.
    if (st === 'tool_call') {
      // Preview is a JSON.stringify of the tool input. Server caps it at
      // 800 chars — for tools with bulky inputs the cut lands mid-string and
      // JSON.parse throws. Same forward-rule as tool_result: ALWAYS wrap
      // in a json code fence (so markdown can't mangle it), pretty-print
      // when it parses, mark truncated otherwise.
      const toolName = String(e.data.tool_name ?? 'tool');
      let body = preview;
      let truncated = false;
      try { body = JSON.stringify(JSON.parse(preview), null, 2); }
      catch {
        truncated = true;
        // Best-effort: at least undo basic JSON escapes so the raw text
        // has real newlines and quotes instead of literal `\n` / `\"`.
        body = preview.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
      const tag = truncated ? '\n... (truncated — full payload in HISTORY tab)' : '';
      return sanitizePreview('```json\n' + toolName + '(\n' + body + tag + '\n)\n```', preview.length, 800);
    }
    if (st === 'tool_result') {
      // Any preview that *starts* with `{` or `[` is JSON. Wrap in a `json`
      // code fence regardless of truncation so markdown can't touch it.
      // Pretty-print only when the payload parses cleanly; otherwise show
      // raw + a truncation marker.
      const trimmed = preview.trim();
      const startsWithOpen = trimmed.startsWith('{') || trimmed.startsWith('[');
      if (startsWithOpen) {
        const closesCleanly =
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'));
        let body = preview;
        let truncated = !closesCleanly;
        if (closesCleanly) {
          try { body = JSON.stringify(JSON.parse(trimmed), null, 2); }
          catch { truncated = true; /* malformed even though brackets match */ }
        }
        const tag = truncated ? '\n... (truncated — full payload in HISTORY tab)' : '';
        return sanitizePreview('```json\n' + body + tag + '\n```', preview.length, 2000);
      }
      // Prose — let formatRunOutput render markdown normally.
      return sanitizePreview(preview, preview.length, 2000);
    }
    if (st === 'thought') return sanitizePreview(preview, preview.length, 200);
    if (st === 'final') return sanitizePreview(preview, preview.length, 200);
    if (st === 'rate_limit_wait') return String(e.data.content_preview ?? 'waiting…');
    return preview || st;
  }
  return t;
}

// ── Tool action summarizer ──────────────────────────────────────────
// Turns raw tool payloads into one-line, human-friendly summaries so the
// LIVE timeline reads like a story instead of a JSON dump. Falls back to
// the tool name when the input shape is unfamiliar (extension tools, new
// MCP servers, etc.) — better to look generic than to wrap wrong.

export function toolCategory(toolName: string): ToolCategory {
  if (!toolName) return 'tool';
  if (toolName === 'Bash') return 'shell';
  if (['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'LS'].includes(toolName)) return 'fs';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'web';
  if (toolName.startsWith('kernel_')) return 'kernel';
  if (toolName.startsWith('mcp__')) return 'mcp';
  if (toolName === 'Task' || toolName === 'TodoWrite' || toolName === 'TaskCreate' || toolName === 'TaskUpdate') return 'meta';
  return 'tool';
}

export function tryParseJson(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* */ }
  // Some previews arrive double-escaped (JSON string of JSON). Try one peel.
  try {
    const inner = JSON.parse(raw);
    if (typeof inner === 'string') {
      try { return JSON.parse(inner); } catch { return inner; }
    }
  } catch { /* */ }
  return null;
}

export function basenameOf(p: string): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/**
 * Summarize a tool_call. Returns the line shown front-and-center in the
 * timeline ("Listing kernel agent tools", "Reading /src/index.ts:42", …).
 * Falls back to the raw tool name when the payload shape is unknown so
 * the user always sees *something* meaningful instead of `{}`.
 */
export function summarizeToolCall(toolName: string, inputPreview: string): string {
  const args = tryParseJson(inputPreview) as Record<string, unknown> | null;
  if (!toolName) return 'calling tool';
  if (!args || typeof args !== 'object') return toolName;
  switch (toolName) {
    case 'Bash': {
      const desc = typeof args.description === 'string' ? args.description : '';
      const cmd = typeof args.command === 'string' ? args.command : '';
      if (desc) return desc;
      return cmd ? `$ ${ellipsize(cmd, 96)}` : 'shell command';
    }
    case 'Read': {
      const p = String(args.file_path ?? '');
      const off = args.offset, lim = args.limit;
      const range = off != null || lim != null
        ? ` · L${off ?? 1}${lim != null ? '–' + (Number(off ?? 0) + Number(lim)) : '+'}`
        : '';
      return p ? `Read ${basenameOf(p)}${range}` : 'Read file';
    }
    case 'Write': {
      const p = String(args.file_path ?? '');
      return p ? `Write ${basenameOf(p)}` : 'Write file';
    }
    case 'Edit': {
      const p = String(args.file_path ?? '');
      const all = args.replace_all ? ' (replace all)' : '';
      return p ? `Edit ${basenameOf(p)}${all}` : 'Edit file';
    }
    case 'NotebookEdit': {
      const p = String(args.notebook_path ?? '');
      return p ? `Edit notebook ${basenameOf(p)}` : 'Edit notebook';
    }
    case 'Glob': {
      const pat = String(args.pattern ?? '');
      const dir = String(args.path ?? '');
      return pat ? `Find files matching ${ellipsize(pat, 60)}${dir ? ' in ' + basenameOf(dir) : ''}` : 'Glob';
    }
    case 'Grep': {
      const pat = String(args.pattern ?? '');
      const where = String(args.path ?? '');
      return pat ? `Search ${ellipsize(pat, 56)}${where ? ' in ' + basenameOf(where) : ''}` : 'Grep';
    }
    case 'LS': {
      const p = String(args.path ?? '');
      return p ? `List ${basenameOf(p)}` : 'List directory';
    }
    case 'WebFetch': {
      const u = String(args.url ?? '');
      return u ? `Fetch ${ellipsize(u, 84)}` : 'Fetch URL';
    }
    case 'WebSearch': {
      const q = String(args.query ?? '');
      return q ? `Search the web for ${ellipsize(q, 70)}` : 'Web search';
    }
    case 'Task': {
      const desc = String(args.description ?? args.subagent_type ?? '');
      return desc ? `Spawn subagent · ${ellipsize(desc, 60)}` : 'Spawn subagent';
    }
    case 'TodoWrite': return `Update task list (${Array.isArray(args.todos) ? (args.todos as unknown[]).length : '?'} items)`;
    case 'TaskCreate': return `Create task · ${ellipsize(String(args.subject ?? ''), 60)}`;
    case 'TaskUpdate': return `Update task · ${ellipsize(String(args.taskId ?? ''), 24)} → ${String(args.status ?? '')}`;
    default: {
      // Generic kernel_* / mcp__* / unknown tool: pretty-print 1-2 string
      // args (skip nested objects to keep the line tight).
      const entries = Object.entries(args).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
      if (entries.length === 0) return toolName;
      const head = entries.slice(0, 2)
        .map(([k, v]) => `${k}=${ellipsize(String(v), 40)}`)
        .join(' · ');
      return `${toolName} · ${head}`;
    }
  }
}

/**
 * Summarize a tool_result. The preview the server sends is whatever the
 * tool returned (often JSON). We aim for a one-line "N rows" / "M lines"
 * / "ok" callout so the timeline reads vertically; the full payload is
 * still available via the expand chevron.
 */
export function summarizeToolResult(toolName: string, preview: string): string {
  if (!preview) return 'no output';
  const trimmed = preview.trim();
  // JSON envelope from MCP — `{ content: [{ type:"text", text:"..." }], isError }`
  const parsed = tryParseJson(trimmed);
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).content)) {
    const arr = ((parsed as Record<string, unknown>).content as unknown[]);
    const texts: string[] = [];
    for (const it of arr) {
      if (it && typeof it === 'object' && (it as Record<string, unknown>).type === 'text') {
        texts.push(String((it as Record<string, unknown>).text ?? ''));
      }
    }
    const joined = texts.join('\n').trim();
    if (joined) return summarizeText(toolName, joined);
  }
  if (parsed && Array.isArray(parsed)) {
    return `${(parsed as unknown[]).length} items`;
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === 'string') return `error · ${ellipsize(obj.error, 70)}`;
    const keys = Object.keys(obj);
    // Single-key wrappers — show the key as a hint.
    if (keys.length === 1) return `${keys[0]} (object)`;
    return `${keys.length} fields · ${ellipsize(keys.slice(0, 4).join(', '), 60)}`;
  }
  return summarizeText(toolName, trimmed);
}

export function summarizeText(toolName: string, txt: string): string {
  const lines = txt.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return 'empty output';
  if (lines.length === 1) return ellipsize(lines[0], 100);
  // Heuristics by tool:
  //   - Grep: lines like "file:line:text" — count matches
  //   - LS / Glob: list of paths
  //   - Bash: line count + first line preview
  if (toolName === 'Grep' && lines.every(l => /:/.test(l))) {
    return `${lines.length} matches · ${ellipsize(lines[0], 80)}`;
  }
  if ((toolName === 'Glob' || toolName === 'LS') && lines.every(l => !l.includes(' ') || isAbsoluteHostPath(l))) {
    return `${lines.length} paths`;
  }
  return `${lines.length} lines · ${ellipsize(lines[0], 80)}`;
}

/**
 * Per-step summary for the LIVE timeline. Always returns a non-empty
 * string — falls back to the prose `liveEventSummary()` when the step
 * isn't a tool call/result (thoughts, finals, run events, etc.).
 */
export function liveStepSummary(e: AgentFlowEvent): string {
  const etype = liveEventType(e);
  const preview = String(e.data.content_preview ?? '');
  const toolName = String(e.data.tool_name ?? '');
  if (etype === 'tool_call') return summarizeToolCall(toolName, preview);
  if (etype === 'tool_result') return summarizeToolResult(toolName, preview);
  if (etype === 'thought') return ellipsize(preview, 140) || 'thinking…';
  if (etype === 'final') return ellipsize(preview, 140) || 'finalizing…';
  if (etype === 'rate_limit_wait') return ellipsize(preview, 140) || 'rate-limit cooldown';
  if (etype === 'error') return ellipsize(preview, 140) || 'error';
  // Run lifecycle + meta — defer to the prose helper.
  return liveEventSummary(e);
}

/** Category hint used to color-code the step row. */
export function liveStepCategory(e: AgentFlowEvent): ToolCategory {
  const etype = liveEventType(e);
  if (etype === 'thought') return 'think';
  if (etype === 'final') return 'final';
  if (etype === 'error' || etype === 'rate_limit_wait') return 'error';
  if (etype === 'tool_call' || etype === 'tool_result') {
    return toolCategory(String(e.data.tool_name ?? ''));
  }
  return 'meta';
}

// ── Meta chips: Δt + token usage ────────────────────────────────────

/**
 * Compact duration for the LIVE chips. Returns '' (not '—') on zero so the
 * markup can use `{#if str}` for conditional rendering.
 */
export function liveFmtDelta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), ss = s % 60;
  return ss === 0 ? `${m}m` : `${m}m${String(ss).padStart(2, '0')}s`;
}

/**
 * Token formatter for LIVE chips. Empty string on zero (same reason as
 * above — `fmtTokens` returns '0'). Adds M past a million tokens.
 */
export function liveFmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Δt between event `i` and the previous event in temporal order.
 * `events` is newest-first, so the previous event in time is `i + 1`.
 * Returns ms, or null when this is the oldest event in the buffer.
 */
export function liveStepDeltaMs(events: AgentFlowEvent[], i: number): number | null {
  const e = events[i];
  const prev = events[i + 1];
  if (!e || !prev) return null;
  const a = Date.parse(e.ts), b = Date.parse(prev.ts);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = a - b;
  return d >= 0 ? d : null;
}

/**
 * Tokens reported on this step. The backend emits `tokens` only on
 * thought/final today; tool_call/tool_result carry the cumulative
 * `tokens_total` instead so the chip can stay visible.
 */
export function liveStepTokens(e: AgentFlowEvent): number {
  const n = Number((e.data as Record<string, unknown>).tokens);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Cumulative tokens up to and including step `i`, as reported by the
 * backend. Scans later (older) events for the last known total when this
 * event doesn't carry one.
 */
export function liveStepTokensTotal(events: AgentFlowEvent[], i: number): number {
  for (let j = i; j < events.length; j++) {
    const v = Number((events[j].data as Record<string, unknown>).tokens_total);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/**
 * Total wall-clock elapsed for the current run — from the first event seen
 * up to (and including) the most recent one.
 */
export function runElapsedMs(events: AgentFlowEvent[]): number {
  if (events.length < 2) return 0;
  const newest = Date.parse(events[0].ts);
  const oldest = Date.parse(events[events.length - 1].ts);
  if (!Number.isFinite(newest) || !Number.isFinite(oldest)) return 0;
  const d = newest - oldest;
  return d > 0 ? d : 0;
}

/** Newest cumulative token total reported anywhere in the buffer. */
export function runTokensTotal(events: AgentFlowEvent[]): number {
  for (const e of events) {
    const v = Number((e.data as Record<string, unknown>).tokens_total);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}
