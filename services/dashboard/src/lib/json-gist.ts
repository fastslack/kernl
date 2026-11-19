/**
 * What a JSON payload says, in chips a person reads at a glance.
 *
 * The run views get JSON everywhere: a tool's result (`{"ok":true,"result":
 * {"status":"failed",...}}`), an agent's closing answer (`{"refuse":true,
 * "reason":"..."}`), a command's argument. Shown raw it is a wall of quotes;
 * summarized as "2 fields · ok, result" it says nothing. This reads the values
 * that carry meaning (ok, status, error, a count…) as coloured chips and the
 * one long sentence (reason, message, summary…) as text.
 *
 * Tolerant: previews are cut by the server (800–2000 chars), so a payload that
 * no longer closes still gives up its scalar pairs.
 *
 * Pure — no Svelte, no DOM.
 */

export type GistTone = 'good' | 'bad' | 'warn' | undefined;
export interface GistChip { k: string; v: string; tone?: GistTone }
export interface Gist { chips: GistChip[]; text: string }

type Obj = Record<string, unknown>;

/** The end index of the balanced `{…}` starting at `start`, or -1. */
function balancedEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const PAIR = /"([A-Za-z_][\w.-]{0,40})"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g;

/** Scalar `"key": value` pairs of a JSON text that may be cut short. First one of each key wins. */
export function scalarPairs(text: string): Obj {
  const out: Obj = {};
  for (const m of text.matchAll(PAIR)) {
    if (m[1] in out) continue;
    try { out[m[1]] = JSON.parse(m[2]); } catch { /* a string cut mid-escape */ }
  }
  return out;
}

export interface FoundJson {
  data: Obj;
  /** Text before and after the object. */
  before: string;
  after: string;
  /** The object did not close (or did not parse): `data` holds its scalar pairs only. */
  partial: boolean;
}

/**
 * The first JSON object in `text` — fenced, bare, or cut short. Null when the
 * text has none (or nothing in it reads as `"key": value`).
 */
export function findJson(text: string): FoundJson | null {
  const raw = String(text ?? '');
  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(raw);
  if (fence) {
    try {
      const data = JSON.parse(fence[1]);
      if (isObj(data)) return { data, before: raw.slice(0, fence.index), after: raw.slice(fence.index + fence[0].length), partial: false };
    } catch { /* fall through */ }
  }
  let firstOpen = -1;
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    if (firstOpen < 0 && /^\{\s*"/.test(raw.slice(start, start + 40))) firstOpen = start;
    const end = balancedEnd(raw, start);
    if (end < 0) break;
    try {
      const data = JSON.parse(raw.slice(start, end + 1));
      if (isObj(data) && Object.keys(data).length > 0) return { data, before: raw.slice(0, start), after: raw.slice(end + 1), partial: false };
    } catch { /* try the next brace */ }
  }
  // Cut short: whatever pairs survived, from the first object that opens with a key.
  if (firstOpen >= 0) {
    const data = scalarPairs(raw.slice(firstOpen));
    if (Object.keys(data).length > 0) {
      const fenceStart = raw.lastIndexOf('```', firstOpen);
      const cut = fenceStart >= 0 && !raw.slice(fenceStart + 3, firstOpen).replace(/json/i, '').trim() ? fenceStart : firstOpen;
      return { data, before: raw.slice(0, cut), after: '', partial: true };
    }
  }
  return null;
}

// ── Reading the values ──────────────────────────────────────────────

/** Keys whose value says how it went, first in line. */
const LEAD = ['ok', 'success', 'passed', 'approved', 'refuse', 'status', 'state', 'outcome', 'conclusion', 'result', 'verdict', 'error'];
/** Keys worth a chip after those. */
const NEXT = ['op', 'action', 'kind', 'type', 'mode', 'count', 'total', 'found', 'matches', 'score', 'exit_code', 'code', 'repo', 'issue', 'branch', 'role', 'env'];
/** The one sentence to show as text. */
const TEXT_KEYS = ['reason', 'message', 'error', 'summary', 'comment', 'detail', 'details', 'note', 'text', 'description', 'result', 'output'];
/** Never a chip: ids and timestamps say nothing at a glance. */
const NOISE = /(^|_)(id|ids|uuid|ts|at|time|started|finished|created|updated|token|hash|sha)$/i;

const GOOD = /^(ok|pass(ed)?|success(ful)?|succeeded|done|complete(d)?|merged|ready|approved|green|true|yes)$/i;
const BAD = /^(fail(ed|ure)?|error|errored|rejected|refused|blocked|red|false|no|timeout|timed_out|crash(ed)?|cancel(l)?ed)$/i;
const WARN = /^(running|pending|queued|waiting|in_progress|partial|skipped|retry(ing)?|stale)$/i;

const NEGATIVE = new Set(['refuse', 'refused', 'error', 'failed', 'blocked', 'timeout', 'timed_out']);

function toneOf(k: string, v: unknown): GistTone {
  if (typeof v === 'boolean') {
    if (NEGATIVE.has(k)) return v ? 'bad' : 'good';
    return v ? 'good' : 'bad';
  }
  if (k === 'error') return 'bad';
  const s = String(v);
  if (GOOD.test(s)) return 'good';
  if (BAD.test(s)) return 'bad';
  if (WARN.test(s)) return 'warn';
  if (/^(exit_code|code)$/.test(k) && /^-?\d+$/.test(s)) return s === '0' ? 'good' : 'bad';
  return undefined;
}

/** Top-level scalars, then the scalars one level down (`result.status` reads as `status`). */
function flatten(d: Obj): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const take = (o: Obj) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('_') || out.has(k)) continue;
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out.set(k, v);
      else if (Array.isArray(v)) out.set(k, `${v.length} ${v.length === 1 ? 'item' : 'items'}`);
    }
  };
  take(d);
  for (const v of Object.values(d)) if (isObj(v)) take(v);
  return out;
}

function chipOf(k: string, v: unknown): GistChip {
  const tone = toneOf(k, v);
  if (typeof v === 'boolean') {
    const name = k.replace(/_/g, ' ');
    // A flag that warns when set (refuse, error…) says so with ⚠, not with a tick.
    if (NEGATIVE.has(k)) return { k: '', v: v ? `⚠ ${name}` : `no ${name}`, tone };
    return { k: '', v: `${v ? '✓' : '✗'} ${name}`, tone };
  }
  const s = String(v);
  if (/^(status|state|outcome|conclusion|result|verdict)$/.test(k)) return { k: '', v: s.replace(/_/g, ' '), tone };
  return { k: k.replace(/_/g, ' '), v: s, tone };
}

/**
 * The chips and the sentence of a JSON object. At most `max` chips; values
 * longer than a chip go to `text` (the first one under a text key).
 */
export function gistOf(d: Obj, max = 4): Gist {
  const flat = flatten(d);
  const short = (v: unknown) => String(v).length <= 32 && !String(v).includes('\n');
  const order = [...LEAD, ...NEXT].filter((k) => flat.has(k));
  const rest = [...flat.keys()].filter((k) => !order.includes(k) && !NOISE.test(k));
  const chips: GistChip[] = [];
  for (const k of [...order, ...rest]) {
    if (chips.length >= max) break;
    const v = flat.get(k);
    if (!short(v) || (NOISE.test(k) && !LEAD.includes(k))) continue;
    chips.push(chipOf(k, v));
  }
  const textKey = TEXT_KEYS.find((k) => typeof flat.get(k) === 'string' && !short(flat.get(k)));
  const text = textKey ? String(flat.get(textKey)).replace(/\s+/g, ' ').trim() : '';
  return { chips, text };
}

/**
 * A text that is (or carries) JSON, as chips plus the words around it. Null
 * when there is no JSON in it, or the JSON has nothing to show.
 */
export function textGist(text: string, max = 4): (Gist & { prose: string }) | null {
  const found = findJson(text);
  if (!found) return null;
  const g = gistOf(found.data, max);
  if (!g.chips.length && !g.text) return null;
  const prose = [found.before, found.after]
    .map((s) => s.replace(/```(?:json)?/gi, ' ').replace(/\bjson\s*$/i, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join(' ').replace(/[:\s]+$/, '');
  return { ...g, prose };
}
