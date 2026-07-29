type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level] ?? LEVELS.info;
}

// Comma-separated substrings; info/debug messages containing any of these are dropped.
// warn/error always pass through regardless of this filter.
const quietMatchers: string[] = (process.env.LOG_QUIET_MODULES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isQuieted(level: LogLevel, msg: string): boolean {
  // errors always pass; warnings can be quieted (they are often telemetry, not bugs)
  if (level === "error") return false;
  if (quietMatchers.length === 0) return false;
  for (const m of quietMatchers) if (msg.includes(m)) return true;
  return false;
}

// ANSI color codes
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  // Level colors
  debug: "\x1b[90m",       // gray
  info: "\x1b[36m",        // cyan
  warn: "\x1b[33m",        // yellow
  error: "\x1b[31m",       // red
  // Accent colors
  time: "\x1b[90m",        // gray
  module: "\x1b[35m",      // magenta
  num: "\x1b[32m",         // green
  path: "\x1b[34m",        // blue
};

const LEVEL_TAGS: Record<LogLevel, string> = {
  debug: `${C.debug}DBG${C.reset}`,
  info:  `${C.info}INF${C.reset}`,
  warn:  `${C.warn}WRN${C.reset}`,
  error: `${C.error}${C.bold}ERR${C.reset}`,
};

function formatTime(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${C.time}${h}:${m}:${s}${C.reset}`;
}

/** Highlight numbers in a message for readability */
function highlight(msg: string): string {
  // Highlight durations like "123ms"
  msg = msg.replace(/\b(\d+(?:\.\d+)?)(ms|s|KB|MB|%)\b/g, `${C.num}$1$2${C.reset}`);
  // Highlight channel= and module= values
  msg = msg.replace(/\b(channel|module)=(\S+)/g, `$1=${C.module}$2${C.reset}`);
  return msg;
}

function write(level: LogLevel, msg: string, data?: unknown): void {
  if (LEVELS[level] < threshold) return;
  if (isQuieted(level, msg)) return;
  const payload = data !== undefined ? ` ${JSON.stringify(data)}` : "";
  const coloredMsg = level === "error" ? `${C.error}${msg}${C.reset}` :
                     level === "warn" ? `${C.warn}${msg}${C.reset}` :
                     highlight(msg);
  process.stderr.write(`${formatTime()} ${LEVEL_TAGS[level]} ${coloredMsg}${payload}\n`);
}

export const log = {
  debug: (msg: string, data?: unknown) => write("debug", msg, data),
  info: (msg: string, data?: unknown) => write("info", msg, data),
  warn: (msg: string, data?: unknown) => write("warn", msg, data),
  error: (msg: string, data?: unknown) => write("error", msg, data),
};
