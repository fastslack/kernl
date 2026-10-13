// src/lib/panels/rows.ts
import { lookup, renderText } from './template.js';

export type Row = Record<string, unknown>;

export function selectPath(data: unknown, selector: string, vars: Record<string, unknown> = {}): unknown {
  const sel = renderText(selector, vars).trim();
  if (sel === '$') return data;
  const parts: string[] = [];
  const re = /\.([^.[\]]+)|\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sel.slice(1))) !== null) parts.push(m[1] ?? m[2]);
  let cur: unknown = data;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = lookup(cur as Record<string, unknown>, p) ?? (Object.prototype.hasOwnProperty.call(cur, p) ? (cur as Row)[p] : undefined);
  }
  return cur;
}

export function toRows(data: unknown): Row[] {
  if (Array.isArray(data)) return data.filter((x) => x && typeof x === 'object') as Row[];
  if (data && typeof data === 'object') {
    return Object.entries(data as Row).map(([key, v]) => ({ key, ...(v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : { value: v }) }));
  }
  return [];
}

export function joinRows(rows: Row[], other: Row[], field: string): Row[] {
  const by = new Map<string, Row[]>();
  for (const o of other) {
    const k = String(o[field] ?? '');
    by.set(k, [...(by.get(k) ?? []), o]);
  }
  return rows.map((r) => ({ ...r, _joined: by.get(String(r[field] ?? r.key ?? '')) ?? [] }));
}

export function groupBy(rows: Row[], field: string, order: string[] = []): Array<{ column: string; rows: Row[] }> {
  const groups = new Map<string, Row[]>();
  for (const c of order) groups.set(c, []);
  for (const r of rows) {
    const c = String(r[field] ?? '—');
    groups.set(c, [...(groups.get(c) ?? []), r]);
  }
  return [...groups.entries()].map(([column, rs]) => ({ column, rows: rs }));
}
