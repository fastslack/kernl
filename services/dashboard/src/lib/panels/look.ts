// src/lib/panels/look.ts
/**
 * How a panel value looks: the colour a state carries, the words a raw key
 * turns into, and what kind of thing a value is (an email to write to, a
 * phone to call, a number to read at a glance). Pure, so every panel
 * component paints the same state with the same colour.
 */
import { PALETTE } from '$lib/components/bench/model.js';

const P = PALETTE;
export const RED = '#F43F5E';

// A state's colour says what it means — same bright palette as Sistema → Resumen.
const TONES: Array<[RegExp, string]> = [
  [/fail|error|block|reject|stuck|lost|perdid|vencid|overdue/i, RED],
  [/work|progress|doing|running|active|replied|respond/i, P.emerald],
  [/review|check|meeting|reuni/i, P.violet],
  [/qa|test|proposal|propuesta/i, P.gold],
  [/merg|deploy|ship|release|contact/i, P.sky],
  [/ready|approved|aprob/i, P.cyan],
  [/done|closed|complete|won|ganad/i, P.lime],
  [/queue|todo|backlog|pending|new|nuev|open|abiert/i, P.pink],
];
export const CYCLE = [P.cyan, P.violet, P.pink, P.gold, P.emerald, P.sky, P.orange, P.lime];

/** A stable colour for any name: the meaning when the word says one, else a hash into the palette. */
export function hueOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CYCLE[h % CYCLE.length];
}

export function tone(state: string): string {
  for (const [re, color] of TONES) if (re.test(state)) return color;
  return hueOf(state);
}

export const isLive = (state: string) => /work|progress|doing|running|active/i.test(state);

/** `new_with_email` → `New with email`; a `_pct` suffix moves into the value. */
export function humanize(key: string): string {
  const words = key.replace(/_pct$/i, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

export type FieldKind = 'email' | 'phone' | 'url' | 'number' | 'percent' | 'status' | 'long' | 'breakdown' | 'object' | 'text';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{7,}$/;
const URLISH = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

export function kindOf(key: string, value: unknown): FieldKind {
  if (value && typeof value === 'object') {
    const vals = Object.values(value as Record<string, unknown>);
    return !Array.isArray(value) && vals.length > 0 && vals.every((v) => typeof v === 'number') ? 'breakdown' : 'object';
  }
  const s = String(value ?? '').trim();
  if (/_pct$|percent|rate/i.test(key) && s !== '' && !Number.isNaN(Number(s))) return 'percent';
  if (typeof value === 'number' || (/^-?\d+([.,]\d+)?$/.test(s) && !/phone|tel/i.test(key))) return 'number';
  if (EMAIL.test(s)) return 'email';
  if (/phone|tel[eé]fono|tel$/i.test(key) || (PHONE.test(s) && /\d{6,}/.test(s.replace(/\D/g, '')) && s.replace(/\D/g, '').length >= 8)) return 'phone';
  if (URLISH.test(s) || /^https?:\/\//i.test(s)) return 'url';
  if (/stage|etapa|state|estado|status|vencid|overdue/i.test(key) && s.length <= 24) return 'status';
  if (s.length > 60) return 'long';
  return 'text';
}

export const hrefOf = (kind: FieldKind, value: string): string | null => {
  if (kind === 'email') return `mailto:${value}`;
  if (kind === 'phone') return `tel:${value.replace(/[^\d+]/g, '')}`;
  if (kind === 'url') return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return null;
};
