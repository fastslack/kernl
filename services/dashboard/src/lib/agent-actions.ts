/**
 * The steps where an agent acts on ANOTHER agent — writes to it, rewrites it,
 * teaches it, wakes it, calls it to a meeting, or hands a question up to the
 * human. These are the ones the 3D world animates (the desk-to-desk shot of a
 * colleague message, the walk-over + EDITED tag of an edit, …), so they are
 * the ones a person looks for in the LIVE log afterwards. As generic tool rows
 * they read as `mcp__kernel__kernel_agents_post_to_colleague · subject=…` with
 * the outcome cut off; here each becomes: what it did, to whom, what it said,
 * and whether it landed.
 *
 * Pure: the LIVE tab renders the result through i18n keys
 * (`agent.action.*`), so nothing in here is user-facing text except what the
 * agent itself wrote.
 */

export type AgentActionKind = 'message' | 'edit' | 'learning' | 'run' | 'meeting' | 'escalate';

export interface AgentAction {
  kind: AgentActionKind;
  /** Same glyph as the tag the 3D world pops over the desk. */
  icon: string;
  /** Who it acted on — a name when the call or its result gave one, else a short id. */
  target: string;
  /** The one line that matters: a subject, a topic, a goal, the change. */
  headline: string;
  /** Longer text the agent wrote (message body, learning, context). */
  body: string;
  outcome: 'pending' | 'ok' | 'failed';
  /** The kernel's own words for a failure; empty otherwise. */
  failure: string;
}

const KIND_BY_TOOL: Record<string, AgentActionKind> = {
  kernel_agents_post_to_colleague: 'message',
  kernel_agents_update: 'edit',
  kernel_agents_add_learning: 'learning',
  kernel_agents_run: 'run',
  kernel_agents_call_meeting: 'meeting',
  kernel_agents_questions_escalate: 'escalate',
};

/**
 * How the kernel words success for the actions where it always says the same
 * thing (modules/agents/tools.ts). Claude Code runs recorded before the
 * error flag was stored carry no flag, and their refusals — `No agent named
 * "X" found in your office` — read as plain text; for these kinds anything
 * that is not the success line is a failure.
 */
const SUCCESS: Partial<Record<AgentActionKind, RegExp>> = {
  message: /^Posted to \*\*/,
  edit: /^Agent \*\*.*\*\* updated\./,
  learning: /^Learning added \(/,
};

const ICON: Record<AgentActionKind, string> = {
  message: '📨',
  edit: '✎',
  learning: '🧠',
  run: '▶',
  meeting: '🤝',
  escalate: '⚑',
};

/** `mcp__kernel__kernel_agents_x` and `kernel_agents_x` are the same tool. */
export function bareToolName(tool: string): string {
  return tool.replace(/^mcp__.+?__/, '');
}

export function isAgentActionTool(tool: unknown): boolean {
  return bareToolName(String(tool ?? '')) in KIND_BY_TOOL;
}

/**
 * One string field out of a tool-input preview. The kernel cuts that preview
 * at 800 characters, so a message with a long body arrives as JSON with no
 * end and `JSON.parse` gives nothing — but the fields before the cut are
 * still there, and the body up to the cut is still worth showing.
 */
export function looseField(preview: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(preview);
  if (!m) return '';
  const raw = m[1].replace(/\\$/, '');
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/** Same as `looseField`, for an array of strings (`attendee_ids`). */
function looseStringArray(preview: string, key: string): string[] {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)`).exec(preview);
  if (!m) return [];
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
}

/** What the agent wrote, as one line of prose: markdown marks and runs of whitespace out. */
export function plainActionText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const shortId = (id: string) => (/^[0-9a-f]{8}-/i.test(id) ? id.slice(0, 8) : id);

/** The name a success result spells out in bold: "Posted to **Ana**'s inbox". */
function boldName(result: string): string {
  return /\*\*([^*]{1,80})\*\*/.exec(result)?.[1] ?? '';
}

/** The changed settings of an edit, as "key → value" — never the id. */
function editChanges(preview: string): string {
  let args: Record<string, unknown> | null = null;
  try { args = JSON.parse(preview); } catch { /* truncated — fall back below */ }
  const entries: Array<[string, unknown]> = args
    ? Object.entries(args)
    : [...preview.matchAll(/"([a-z_]+)"\s*:\s*("(?:[^"\\]|\\.)*"?|[^,}]+)/g)].map((m) => [m[1], m[2]]);
  return entries
    .filter(([k]) => k !== 'id' && k !== 'agent_id' && !k.startsWith('__'))
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v.replace(/^"|"$/g, '') : JSON.stringify(v);
      return `${k} → ${s.length > 40 ? s.slice(0, 39) + '…' : s}`;
    })
    .slice(0, 3)
    .join(' · ');
}

/**
 * The action a tool call took, or null when the tool is not one of them.
 * `result` is the paired tool_result's preview when it already came back;
 * `nameOf` turns an agent id into its name when the caller knows the roster.
 */
export function agentActionOf(
  tool: string,
  input: string,
  result?: { preview: string; failed: boolean },
  nameOf: (id: string) => string | undefined = () => undefined,
): AgentAction | null {
  const kind = KIND_BY_TOOL[bareToolName(tool)];
  if (!kind) return null;

  const success = SUCCESS[kind];
  const failed = !!result && (result.failed || (!!success && !success.test(result.preview.trim())));
  const outcome: AgentAction['outcome'] = !result ? 'pending' : failed ? 'failed' : 'ok';
  const failure = failed ? result!.preview.replace(/^\s*(error:\s*)?/i, '').trim() : '';
  const named = (id: string, fallbackName = '') =>
    fallbackName || (id ? nameOf(id) ?? '' : '') || (result && !result.failed ? boldName(result.preview) : '') || shortId(id);

  switch (kind) {
    case 'message':
      return {
        kind, icon: ICON[kind], outcome, failure,
        target: named(looseField(input, 'to_agent_id'), looseField(input, 'to_agent_name')),
        headline: looseField(input, 'subject'),
        body: looseField(input, 'body'),
      };
    case 'edit':
      return {
        kind, icon: ICON[kind], outcome, failure,
        target: named(looseField(input, 'id')),
        headline: editChanges(input),
        body: looseField(input, 'system_prompt'),
      };
    case 'learning':
      return {
        kind, icon: ICON[kind], outcome, failure,
        target: named(looseField(input, 'agent_id')),
        headline: looseField(input, 'type'),
        body: looseField(input, 'content'),
      };
    case 'run':
      return {
        kind, icon: ICON[kind], outcome, failure,
        target: named(looseField(input, 'agent_id')),
        headline: looseField(input, 'goal'),
        body: '',
      };
    case 'meeting': {
      const ids = looseStringArray(input, 'attendee_ids');
      return {
        kind, icon: ICON[kind], outcome, failure,
        target: ids.map((id) => nameOf(id) ?? shortId(id)).join(', '),
        headline: looseField(input, 'topic'),
        body: looseField(input, 'context'),
      };
    }
    case 'escalate':
      return {
        kind, icon: ICON[kind], outcome, failure,
        target: '',
        headline: looseField(input, 'reason'),
        body: '',
      };
  }
}
