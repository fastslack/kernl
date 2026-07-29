/**
 * LLM call logger — emits a distinct, single-line marker for every LLM
 * request: when it starts, when it finishes, and when it fails.
 *
 * Format (stable, grep-friendly with `LLM` token):
 *   HH:MM:SS  ▶ LLM <slug>/<model> · <N> msgs[, <T> tools]
 *   HH:MM:SS  ✓ LLM <slug>/<model> · <ms>ms · <tokens>tk[ · <K> tool_calls]
 *   HH:MM:SS  ✗ LLM <slug>/<model> · <ms>ms · <kind>: <message>
 *
 * Verbosity (env LLM_LOG):
 *   quiet   → suppress everything
 *   normal  → start + end (default)
 *   verbose → also show first system-prompt + last user-message previews
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
  brightCyan: "\x1b[96m",
  brightGreen: "\x1b[92m",
};

type Verbosity = "quiet" | "normal" | "verbose";
const VERBOSITY: Verbosity = ((process.env.LLM_LOG ?? "normal").toLowerCase() as Verbosity);

function now(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${C.gray}${h}:${m}:${s}${C.reset}`;
}

function tag(): string {
  return `${C.bold}${C.magenta}LLM${C.reset}`;
}

function slugLabel(slug: string, model?: string): string {
  const name = `${C.cyan}${slug}${C.reset}`;
  if (!model) return name;
  return `${name}${C.gray}/${C.reset}${C.dim}${model}${C.reset}`;
}

function clip(s: string, max: number): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export interface LlmStartInfo {
  slug: string;
  model?: string;
  /** Total messages including system. */
  messageCount: number;
  /** Tool count if tools were passed. */
  toolCount?: number;
  /** Caller-supplied tag for context (e.g. agent name, eval phase). */
  caller?: string;
  /** Optional preview of the system prompt or last user msg (verbose only). */
  preview?: string;
}

export interface LlmEndInfo {
  slug: string;
  model?: string;
  durationMs: number;
  tokens?: number;
  toolCalls?: number;
  caller?: string;
  /** Truncated assistant text preview (verbose only). */
  preview?: string;
}

export interface LlmFailInfo {
  slug: string;
  model?: string;
  durationMs: number;
  /** Failure category — typically the FailureKind from llm-provider-health. */
  kind: string;
  message: string;
  caller?: string;
}

export function logLlmStart(info: LlmStartInfo): void {
  if (VERBOSITY === "quiet") return;
  const slug = slugLabel(info.slug, info.model);
  const meta: string[] = [];
  meta.push(`${C.green}${info.messageCount}${C.reset} msgs`);
  if (info.toolCount && info.toolCount > 0) {
    meta.push(`${C.green}${info.toolCount}${C.reset} tools`);
  }
  const caller = info.caller ? ` ${C.gray}[${info.caller}]${C.reset}` : "";
  const preview = (VERBOSITY === "verbose" && info.preview)
    ? `\n${C.gray}    ↳ ${clip(info.preview, 220)}${C.reset}`
    : "";
  process.stderr.write(
    `${now()} ${C.brightCyan}▶${C.reset} ${tag()} ${slug}${caller} · ${meta.join(", ")}${preview}\n`,
  );
}

export function logLlmEnd(info: LlmEndInfo): void {
  if (VERBOSITY === "quiet") return;
  const slug = slugLabel(info.slug, info.model);
  const meta: string[] = [];
  meta.push(`${C.green}${info.durationMs}${C.reset}ms`);
  if (info.tokens && info.tokens > 0) meta.push(`${C.green}${info.tokens}${C.reset}tk`);
  if (info.toolCalls && info.toolCalls > 0) meta.push(`${C.yellow}${info.toolCalls}${C.reset} tool_calls`);
  const caller = info.caller ? ` ${C.gray}[${info.caller}]${C.reset}` : "";
  const preview = (VERBOSITY === "verbose" && info.preview)
    ? `\n${C.gray}    ↳ ${clip(info.preview, 220)}${C.reset}`
    : "";
  process.stderr.write(
    `${now()} ${C.brightGreen}✓${C.reset} ${tag()} ${slug}${caller} · ${meta.join(" · ")}${preview}\n`,
  );
}

export function logLlmFail(info: LlmFailInfo): void {
  if (VERBOSITY === "quiet") return;
  const slug = slugLabel(info.slug, info.model);
  const caller = info.caller ? ` ${C.gray}[${info.caller}]${C.reset}` : "";
  const kind = `${C.yellow}${info.kind}${C.reset}`;
  const msg = clip(info.message, 200);
  process.stderr.write(
    `${now()} ${C.red}✗${C.reset} ${tag()} ${slug}${caller} · ${C.green}${info.durationMs}${C.reset}ms · ${kind}: ${C.red}${msg}${C.reset}\n`,
  );
}
