/**
 * Turning a tool call into something a person can read.
 *
 * The chat shows one card per tool call. The raw material is unfriendly: a name
 * like `mcp__kernel__kernel_rss_add`, an input object, and a markdown result
 * string. These helpers turn that into a label, a one-line summary, and the
 * links worth offering — the "open the thing you just made" affordance that
 * otherwise depends on the model remembering to write a URL.
 *
 * Everything here is derived from the kernel's own naming convention
 * (`kernel_{module}_{action}`, see CLAUDE.md), so a new module gets a decent
 * label for free. Only the icon and the dashboard screen need a line in a map.
 */

export interface ToolPresentation {
  /** Emoji shown before the name. Never empty. */
  icon: string;
  /** Human label, e.g. `RSS · Add`. */
  label: string;
  /** Kernel module the tool belongs to (`rss`), or null for non-kernel tools. */
  module: string | null;
}

export interface ToolLink {
  href: string;
  label: string;
}

/** Modules whose name is an acronym or reads badly when merely capitalised. */
const MODULE_NAMES: Record<string, string> = {
  rss: "RSS",
  api: "API",
  crm: "CRM",
  irc: "IRC",
  llm: "LLM",
  mcp: "MCP",
  fs: "Files",
  ext: "Extensions",
};

const MODULE_ICONS: Record<string, string> = {
  agents: "🤖",
  api: "🔌",
  brain: "🧠",
  chat: "💬",
  cinema: "🎬",
  comms: "📨",
  crm: "👤",
  email: "✉️",
  events: "📅",
  ext: "🧩",
  extensions: "🧩",
  finance: "💰",
  fs: "📁",
  goals: "🎯",
  google: "🔎",
  health: "💚",
  irc: "💬",
  issues: "🐛",
  learning: "📚",
  lights: "💡",
  linkedin: "💼",
  marketplace: "🛒",
  memory: "🧠",
  notes: "📝",
  nutrition: "🥗",
  plugins: "🧩",
  reddit: "👽",
  reminders: "⏰",
  repos: "🌿",
  rss: "📡",
  shopping: "🛍️",
  skills: "🎓",
  subscriptions: "🔁",
  tasks: "✅",
  time: "⏱️",
  training: "🏋️",
  travel: "✈️",
  triage: "🚦",
  twitter: "🐦",
  workspace: "🗂️",
  youtube: "▶️",
};

/** Tools that are not the kernel's but show up constantly in the transcript. */
const BUILTIN_ICONS: Record<string, string> = {
  Bash: "⌨️",
  Edit: "✏️",
  Glob: "🔍",
  Grep: "🔍",
  Read: "📄",
  Task: "🤖",
  ToolSearch: "🔍",
  WebFetch: "🌐",
  WebSearch: "🌐",
  Write: "✏️",
};

const DEFAULT_ICON = "🛠️";

/**
 * Kernel modules that have a dashboard screen. A module missing from here just
 * doesn't get a "view in Kernl" chip — the generic link to whatever URL the
 * result carried still shows.
 */
const MODULE_SCREENS: Record<string, ToolLink> = {
  agents: { href: "/agents", label: "Agents" },
  api: { href: "/api-registry", label: "API Registry" },
  automations: { href: "/automations", label: "Automations" },
  brain: { href: "/memory", label: "Memory" },
  comms: { href: "/mail", label: "Mail" },
  email: { href: "/mail", label: "Mail" },
  ext: { href: "/extensions", label: "Extensions" },
  extensions: { href: "/extensions", label: "Extensions" },
  files: { href: "/files", label: "Files" },
  fs: { href: "/files", label: "Files" },
  marketplace: { href: "/marketplace", label: "Marketplace" },
  memory: { href: "/memory", label: "Memory" },
  models: { href: "/settings?section=ai", label: "Models" },
  notifications: { href: "/notifications", label: "Notifications" },
  plugins: { href: "/extensions", label: "Extensions" },
  rss: { href: "/rss-registry", label: "RSS Registry" },
  skills: { href: "/skills", label: "Skills" },
  workspace: { href: "/workspace", label: "Workspace" },
};

/** Longest value we show in a card summary before cutting it. */
const SUMMARY_MAX = 40;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `list_items` → `List items` */
function humanize(s: string): string {
  return capitalize(s.replace(/_+/g, " ").trim());
}

/** `ToolSearch` → `Tool Search` */
function splitCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

export function presentTool(name: string): ToolPresentation {
  const raw = name || "";
  const mcp = raw.match(/^mcp__(.+?)__(.+)$/);
  const server = mcp ? mcp[1] : null;
  const rest = mcp ? mcp[2] : raw;

  const kernel = rest.match(/^kernel_([a-z0-9]+)_(.+)$/i);
  if (kernel) {
    const module = kernel[1].toLowerCase();
    return {
      icon: MODULE_ICONS[module] ?? DEFAULT_ICON,
      label: `${MODULE_NAMES[module] ?? capitalize(module)} · ${humanize(kernel[2])}`,
      module,
    };
  }

  const label = server
    ? `${capitalize(server)} · ${humanize(rest)}`
    : rest.includes("_")
      ? humanize(rest)
      : splitCamel(rest);

  return { icon: BUILTIN_ICONS[raw] ?? DEFAULT_ICON, label, module: null };
}

/** `https://www.opensourceprojects.dev/rss` → `opensourceprojects.dev/rss` */
function shorten(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return trimmed.length > SUMMARY_MAX ? `${trimmed.slice(0, SUMMARY_MAX - 1)}…` : trimmed;
}

/**
 * One line describing what the tool was called with. Shows the values — the
 * argument names ("name, feed_url") told a reader nothing they couldn't guess.
 * Objects and arrays are skipped rather than stringified: they never fit.
 */
export function summarizeInput(input: Record<string, unknown> | null | undefined): string {
  if (!input) return "";
  const parts: string[] = [];
  for (const value of Object.values(input)) {
    if (parts.length >= 3) break;
    if (typeof value === "string") {
      if (!value.trim()) continue;
      parts.push(shorten(value));
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
    }
  }
  return parts.join(" · ");
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g;

/**
 * URLs a tool result points at, in the order they appear. Read from the result
 * rather than from the assistant's prose, so the "open it" chip shows up
 * whatever the model chose to write afterwards.
 */
export function resultLinks(result: string | null | undefined): string[] {
  if (!result) return [];
  const found: string[] = [];
  for (const match of result.match(URL_IN_TEXT) ?? []) {
    // A URL at the end of a sentence swallows the punctuation that closed it.
    const url = match.replace(/[.,;:!?)\]}>"'*]+$/, "");
    if (!url || found.includes(url)) continue;
    found.push(url);
    if (found.length === 3) break;
  }
  return found;
}

/** Longest pretty-printed input we put in a card before cutting it. */
const INPUT_MAX = 1200;

/** The tool's arguments, pretty-printed for the expanded card. */
export function formatToolInput(input: unknown): string {
  try {
    const s = JSON.stringify(input, null, 2);
    if (s === undefined) return String(input);
    return s.length > INPUT_MAX ? `${s.slice(0, INPUT_MAX)}…` : s;
  } catch {
    return String(input);
  }
}

/** The dashboard screen for the tool's module, when there is one. */
export function kernlLink(name: string): ToolLink | null {
  const { module } = presentTool(name);
  if (!module) return null;
  return MODULE_SCREENS[module] ?? null;
}
