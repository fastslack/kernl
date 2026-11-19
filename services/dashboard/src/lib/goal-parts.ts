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
import { findJson } from './json-gist.js';

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

/** The first JSON object in `text`, fenced, bare or cut short, with the text around it. */
export function extractJsonObject(text: string): { data: Record<string, unknown>; before: string; after: string } | null {
  const f = findJson(text);
  return f ? { data: f.data, before: f.before, after: f.after } : null;
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

/**
 * What a run is about, in a chip's room: its input's first two short fields
 * ("web #2903") and its title. `tag` is empty for a goal with no JSON input.
 */
export function goalBadge(goal: string): { tag: string; title: string } {
  const g = goalParts(goal);
  return { tag: g.tags.slice(0, 2).map((t) => t.v).join(' '), title: g.title };
}
