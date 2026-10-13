// src/lib/panels/template.ts
import type { Text } from './types.js';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export function lookup(values: Record<string, unknown>, path: string): unknown {
  let cur: unknown = values;
  for (const part of path.split('.')) {
    if (FORBIDDEN.has(part) || cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Plain text — Svelte escapes it when rendered with {text}; never use {@html} with it. */
export function renderText(tpl: string, row: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_.#-]+)\s*\}\}/g, (_m, path: string) => {
    const v = lookup(row, path);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function textOf(t: Text | undefined, locale: string): string {
  if (t === undefined) return '';
  if (typeof t === 'string') return t;
  return (locale.startsWith('en') ? t.en ?? t.es : t.es ?? t.en) ?? '';
}
