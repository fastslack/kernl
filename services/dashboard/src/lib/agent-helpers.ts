/**
 * Small pure helpers behind the agent surfaces: colours, glyphs, the URL and
 * JSON probing the panels do, and the text they build.
 *
 * Extracted verbatim from AgentWorld3D.svelte, where they sat between the
 * three.js scene code and the panel markup with no way to test any of them.
 * Nothing here touches the scene, the DOM or component state — anything that
 * did stayed behind.
 */

import { escapeHtml } from './sanitize.js';
import { isAbsoluteHostPath } from './host-path.js';

/** `#5b8def` → 0x5b8def, for three.js material colours. Falls back on junk. */
export function hexToNum(css: string, fallback = 0xffffff): number {
  const n = parseInt((css || '').replace('#', ''), 16);
  return Number.isFinite(n) ? n : fallback;
}

/** Map a kernel tool name to a glyph for the floating-tool-icon animation. */
export function toolGlyph(name: string): string {
  if (!name) return '🔧';
  const n = name.toLowerCase();
  if (n.includes('email') || n.includes('mail')) return '📧';
  if (n.includes('workspace')) return '💻';
  if (n.includes('files') || n.includes('fs_')) return '📁';
  if (n.includes('web')) return '🌐';
  if (n.includes('calendar') || n.includes('events')) return '📅';
  if (n.includes('tasks')) return '✅';
  if (n.includes('chat') || n.includes('comms')) return '💬';
  if (n.includes('code')) return '⌨️';
  if (n.includes('trad')) return '📈';
  if (n.includes('vault')) return '🔐';
  if (n.includes('graph') || n.includes('memory')) return '🧠';
  if (n.includes('research') || n.includes('search')) return '🔍';
  if (n.includes('agent')) return '🤝';
  return '🔧';
}

/**
 * Escape text going into a banner's HTML string. Identical to `escapeHtml` —
 * the component carried its own fifth copy of the same five replacements.
 */
export function escapeBannerText(s: string): string {
  return escapeHtml(s);
}

/**
 * Pull the first http(s) URL out of a free-text context. Used as a fallback
 * for older questions whose options don't yet carry `url`.
 */
export function firstUrlIn(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s)\]>"']+/i);
  return m ? m[0] : null;
}

/**
 * Resolve the URL an option should open: explicit `url` wins; otherwise, if
 * the option's label hints at opening a link ("open"), fall back to the first
 * URL found in the question's context.
 */
export function urlForOption(
  question: { context?: string | null },
  opt: { label: string; value?: string; url?: string },
): string | null {
  if (opt.url && /^https?:\/\//i.test(opt.url)) return opt.url;
  const labelMentionsLink = /(open|view|visit|go to)/i.test(opt.label);
  const valueMentionsLink = opt.value === 'open' || opt.value === 'view' || opt.value === 'visit';
  if (labelMentionsLink || valueMentionsLink) return firstUrlIn(question.context);
  return null;
}

/** The report an office agent filed, as far as the fixer goal is concerned. */
export interface FixerReport {
  agentName: string;
  agentId: string;
  status: string;
  ts: number;
  runId?: string;
}

/** Build the goal handed to the fixer agent when a report needs diagnosis. */
export function buildFixerGoal(report: FixerReport, body: string): string {
  return [
    `An agent run reported an issue that needs diagnosis + a fix.`,
    ``,
    `Source agent: ${report.agentName} (${report.agentId})`,
    `Run ID:       ${report.runId ?? '(unknown)'}`,
    `Status:       ${report.status}`,
    `When:         ${new Date(report.ts).toISOString()}`,
    ``,
    `--- BEGIN REPORT BODY ---`,
    body,
    `--- END REPORT BODY ---`,
    ``,
    `Please:`,
    `  1. Diagnose the root cause from the report body above.`,
    `  2. If it's a code/config/infra issue you can fix, fix it. Otherwise route to the right agent (post_to_colleague) with a clear ask.`,
    `  3. Reply with: ROOT_CAUSE, ACTION_TAKEN (or DELEGATED_TO + agent), and STATUS (fixed / in_progress / blocked).`,
  ].join('\n');
}

/** What kind of management event a row in the manager log is. */
export type MgmtKind = 'edit' | 'directive' | 'escalation';

export function mgmtKindIcon(k: MgmtKind): string {
  return k === 'edit' ? '📝' : k === 'directive' ? '📤' : '📨';
}

export function mgmtKindColor(k: MgmtKind, cross?: boolean): string {
  if (k === 'edit') return '#c67fe8';
  if (k === 'directive') return '#f0883e';
  return cross ? '#5b8def' : '#3dd6c8';
}

/** Parse a value that may already be an object, or JSON, or junk. Never throws. */
export function safeParse(raw: unknown): any {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

const EMAIL_TOOLS = new Set(['kernel_email_send', 'kernel_comms_reply', 'kernel_comms_send']);
const EMAIL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Returns the communication id for an email-send tool row, or null. `raw` is
 * the tool output/preview text (live: e.data.content_preview; history:
 * step.tool_output).
 */
export function emailCommId(toolName: string | undefined, raw: string | undefined): string | null {
  if (!toolName || !EMAIL_TOOLS.has(toolName) || !raw) return null;
  try {
    const o = JSON.parse(raw);
    const id = o?.id ?? o?.comm_id ?? o?.thread_id;
    if (id) return String(id);
  } catch { /* not JSON — fall through to UUID scan */ }
  const m = String(raw).match(EMAIL_UUID_RE);
  return m ? m[0] : null;
}

/** Where an agent's files live, and how to label that for the panel. */
export interface AgentWorkspaceInfo {
  wsId: string | null;
  cwdPath: string | null;
  cwdLabel: string;
  cwdHint: string;
}

/** The office fields that decide where a flow's agents run. */
export interface FlowHome {
  id: string;
  home_workspace_id?: string | null;
  home_repo_path?: string | null;
}

/**
 * Resolve an agent's working directory the way the claude-code executor's
 * `resolveCwd` does: an explicit absolute `__cwd_path__` (an external repo),
 * else a registered `__workspace__`, else its office's home (the git repo the
 * office was promoted to, or the office workspace), else the per-agent default.
 * Without `flows` an office agent would show a directory it never runs in.
 */
export function resolveAgentWorkspace(agent: any, flows: FlowHome[] = []): AgentWorkspaceInfo {
  const vars = safeParse(agent?.variables) || {};
  if (isAbsoluteHostPath(vars.__cwd_path__)) {
    return {
      wsId: null,
      cwdPath: vars.__cwd_path__,
      cwdLabel: vars.__cwd_path__,
      cwdHint: 'external repo (mounted RW) — files listed below',
    };
  }
  if (typeof vars.__workspace__ === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(vars.__workspace__)) {
    return {
      wsId: vars.__workspace__,
      cwdPath: null,
      cwdLabel: `data/workspaces/${vars.__workspace__}`,
      cwdHint: 'workspace registrado',
    };
  }
  const flow = agent?.flow_id ? flows.find(f => f.id === agent.flow_id) : undefined;
  if (isAbsoluteHostPath(flow?.home_repo_path)) {
    return {
      wsId: null,
      cwdPath: flow.home_repo_path,
      cwdLabel: flow.home_repo_path,
      cwdHint: 'home del office (repo git) — files listed below',
    };
  }
  if (typeof flow?.home_workspace_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(flow.home_workspace_id)) {
    return {
      wsId: flow.home_workspace_id,
      cwdPath: null,
      cwdLabel: `data/workspaces/${flow.home_workspace_id}`,
      cwdHint: 'home del office',
    };
  }
  const fallback = `agent-${agent.id}`;
  return {
    wsId: fallback,
    cwdPath: null,
    cwdLabel: `data/workspaces/${fallback}`,
    cwdHint: 'workspace default por agent id',
  };
}

/** True when the agent is backed by a Google-sync builtin handler. */
export function dependsOnGoogleAuth(a: any): boolean {
  const h = a?.builtin_handler;
  return typeof h === 'string' && h.startsWith('gsync:');
}

/** One line per recent run, for the copyable block in the draft modal. */
export function formatAgentRecentRuns(runs: any[]): string {
  return (runs || []).slice(0, 5).map((rr: any) => {
    const status = rr.status ?? '?';
    const steps = rr.steps_count ?? 0;
    const tokens = rr.tokens_used ?? 0;
    const when = String(rr.created_at ?? '').slice(0, 16).replace('T', ' ');
    const id = rr.id ? rr.id.slice(0, 8) : '?';
    return `[${status}] ${steps} steps · ${tokens} tokens · ${when} · ${id}`;
  }).join('\n');
}

/** Avatar initials: first + last for a full name, first two letters otherwise. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** One topic per line, with any bullet marker stripped. Blank lines dropped. */
export function parseMeetingTopics(raw: string): string[] {
  return raw.split('\n')
    .map(t => t.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean);
}
