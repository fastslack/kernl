/**
 * A run goal split into what a person reads first and what is behind it.
 *
 * Goals often carry a JSON input (a ticket, a job, a form) between two pieces
 * of prose: "Ticket X. Your input: ```json {...}``` You work this ticket as…".
 * Shown as one string that is a wall of escaped JSON. This finds the object,
 * pulls a title and a few short scalar fields out of it as tags, and leaves
 * the prose around it as instructions.
 *
 * Generic on purpose: no field name is required. `title`/`subject`/`name`
 * win the headline when present; otherwise the first sentence of the prose.
 *
 * Pure — no Svelte, no DOM.
 */

import { ellipsize } from './display-format.js';

export interface GoalTag { k: string; v: string }

export interface GoalParts {
  /** One line for the row. */
  title: string;
  /** Short scalar fields of the input, for chips. */
  tags: GoalTag[];
  /** The parsed input object, when the goal had one. */
  data: Record<string, unknown> | null;
  /** The prose around the input, joined. */
  prose: string;
}

const TITLE_KEYS = ['title', 'subject', 'name', 'summary_title', 'goal', 'task'];
/** Fields that say where something lives, not what it is: never a tag. */
const LINK_RE = /^(https?:\/\/|\/|[a-z]:\\)/i;
const MAX_TAGS = 4;
const MAX_TAG_LEN = 28;

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

/** The first JSON object in `text`, fenced or bare, with the text around it. */
export function extractJsonObject(text: string): { data: Record<string, unknown>; before: string; after: string } | null {
  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text);
  if (fence) {
    try {
      const data = JSON.parse(fence[1]);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return { data, before: text.slice(0, fence.index), after: text.slice(fence.index + fence[0].length) };
      }
    } catch { /* fall through to the bare scan */ }
  }
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start);
    if (end < 0) break;
    try {
      const data = JSON.parse(text.slice(start, end + 1));
      if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
        return { data, before: text.slice(0, start), after: text.slice(end + 1) };
      }
    } catch { /* try the next brace */ }
  }
  return null;
}

function tidy(s: string): string {
  return s.replace(/```(?:json)?\s*```/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return m ? m[1] : s;
}

export function goalParts(goal: string): GoalParts {
  const raw = String(goal ?? '').trim();
  const found = extractJsonObject(raw);
  if (!found) {
    return { title: ellipsize(tidy(raw), 200), tags: [], data: null, prose: raw };
  }
  const { data } = found;
  const before = tidy(found.before).replace(/[:\s]+$/, '');
  const after = tidy(found.after);
  const prose = [before, after].filter(Boolean).join('\n\n');
  const titleKey = TITLE_KEYS.find((k) => typeof data[k] === 'string' && String(data[k]).trim());
  const title = titleKey
    ? String(data[titleKey]).trim()
    : firstSentence(before || after) || 'Run';
  const tags: GoalTag[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (tags.length >= MAX_TAGS) break;
    if (k === titleKey || k.startsWith('_')) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const s = String(v).trim();
    if (!s || s.length > MAX_TAG_LEN || LINK_RE.test(s)) continue;
    tags.push({ k, v: typeof v === 'number' && /(^|_)(issue|number|ticket|id|pr)$/i.test(k) ? `#${s}` : s });
  }
  return { title: ellipsize(title, 200), tags, data, prose };
}
