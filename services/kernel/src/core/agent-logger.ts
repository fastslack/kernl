/**
 * Agent event formatter — pretty, colored, single-line output mirroring every
 * agent_event_log write. Wired from AgentService.logEvent so every structured
 * event flows to stdout without touching the scattered log.info call sites.
 *
 * Output shape (stable, grep-friendly):
 *   HH:MM:SS <icon> AGT <agent-name>· <subtype>: <detail> <meta>
 *
 * Set AGENT_LOG=quiet to suppress these lines, or AGENT_LOG=verbose to also
 * include the normally-noisy per-step thought/tool_result lines.
 */

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
};

export interface AgentLogEvent {
  run_id?: string;
  agent_id?: string;
  agent_name?: string;
  event_type: string;
  event_subtype?: string;
  detail?: string;
  raw_data?: Record<string, unknown>;
  tokens_used?: number;
  duration_ms?: number;
}

/**
 * (icon, label, color, showDetail).
 * showDetail=false → detail text is suppressed in the one-liner (used for very noisy step subtypes).
 */
const STYLE: Record<string, { icon: string; label: string; color: string; detailMax: number }> = {
  "run:started":      { icon: "▶",  label: "START",  color: C.brightCyan,   detailMax: 140 },
  "run:completed":    { icon: "✓",  label: "DONE",   color: C.brightGreen,  detailMax: 140 },
  "run:failed":       { icon: "✗",  label: "FAIL",   color: C.red,          detailMax: 200 },
  "run:auto_eval":    { icon: "⚖",  label: "EVAL",   color: C.magenta,      detailMax: 120 },
  "step:thought":     { icon: "💭", label: "think",  color: C.gray,         detailMax: 120 },
  "step:tool_call":   { icon: "🔧", label: "tool",   color: C.yellow,       detailMax: 100 },
  "step:tool_result": { icon: "⇢",  label: "  →",    color: C.dim,          detailMax: 100 },
  "step:final":       { icon: "📤", label: "final",  color: C.brightGreen,  detailMax: 160 },
  "step:error":       { icon: "⚠",  label: "error",  color: C.red,          detailMax: 200 },
  "step:rate_limit_wait": { icon: "⏳", label: "rate",  color: C.yellow,    detailMax: 80 },
  "chain:triggered":  { icon: "🔁", label: "chain",  color: C.blue,         detailMax: 140 },
};

const DEFAULT_STYLE = { icon: "•", label: "evt", color: C.white, detailMax: 140 };

function now(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${C.gray}${h}:${m}:${s}${C.reset}`;
}

function clip(s: string, max: number): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function fmtMeta(ev: AgentLogEvent): string {
  const parts: string[] = [];
  if (ev.tokens_used && ev.tokens_used > 0) parts.push(`${ev.tokens_used}tk`);
  if (ev.duration_ms && ev.duration_ms > 0) parts.push(`${ev.duration_ms}ms`);
  if (ev.run_id) parts.push(`run=${ev.run_id.slice(0, 8)}`);
  return parts.length ? `${C.gray}${parts.join(" · ")}${C.reset}` : "";
}

const VERBOSITY = (process.env.AGENT_LOG ?? "normal").toLowerCase();
const NOISY_IN_NORMAL = new Set(["step:thought", "step:tool_result"]);

export function formatAgentEvent(ev: AgentLogEvent): string | null {
  if (VERBOSITY === "quiet") return null;
  const key = `${ev.event_type}:${ev.event_subtype ?? ""}`;
  if (VERBOSITY !== "verbose" && NOISY_IN_NORMAL.has(key)) return null;

  const style = STYLE[key] ?? DEFAULT_STYLE;
  const name = ev.agent_name ? `${C.bold}${C.cyan}${ev.agent_name}${C.reset}` : `${C.gray}?${C.reset}`;
  const label = `${style.color}${style.label}${C.reset}`;
  const detail = ev.detail ? ` ${clip(ev.detail, style.detailMax)}` : "";
  const meta = fmtMeta(ev);
  const metaPart = meta ? `  ${meta}` : "";
  return `${now()} ${style.icon}  AGT ${name} · ${label}${detail}${metaPart}`;
}

export function writeAgentEvent(ev: AgentLogEvent): void {
  const line = formatAgentEvent(ev);
  if (line) process.stderr.write(line + "\n");
}
