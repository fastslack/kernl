/**
 * JSON for people: the viewer every tool call, tool result and ```json block
 * in the dashboard goes through.
 *
 * It used to be `JSON.stringify(v, null, 2)` inside a markdown fence, which
 * broke in two ways. A string holding its own fence (an agent's message body
 * with a ```json block in it) closed the outer one early and spilled the rest
 * as markdown. And every newline in a value came out as a literal `\n`, so a
 * letter between agents read as one endless line.
 *
 * What it does instead:
 *   • short objects and arrays stay on one line; big ones break into rows
 *     with an indent guide;
 *   • strings with newlines are shown as text blocks, and JSON inside them —
 *     bare or fenced — is rendered as JSON too;
 *   • a payload the server cut is repaired and flagged rather than dumped raw;
 *   • zod validation issues read as "body: Required (expected string, …)".
 *
 * Output is HTML with every key and value escaped; styles live in app.css
 * under `.jv`.
 */

import { escapeHtml } from '$shared/escape.js';

/** One line of output fits in this many characters before it breaks into rows. */
const INLINE_MAX = 72;
/** Array items shown before the rest is summarised as "+N more". */
const ARRAY_MAX = 50;
/** A one-line string longer than this is shown as a text block. */
const LONG_STRING = 120;

// ── Parsing ────────────────────────────────────────────────────────

export interface Parsed { value: unknown; truncated: boolean }

/**
 * Parse `raw` as JSON, forgiving the two shapes previews arrive in: encoded
 * twice (a JSON string of JSON) and cut by the server's preview cap. Returns
 * null when it isn't JSON at all.
 */
export function parseLoose(raw: string): Parsed | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (typeof v === 'string') {
      const inner = v.trim();
      if (inner.startsWith('{') || inner.startsWith('[')) {
        try { return { value: JSON.parse(inner), truncated: false }; } catch { /* a plain string */ }
      }
    }
    return { value: v, truncated: false };
  } catch { /* maybe cut */ }
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  const repaired = repairTruncated(s);
  return repaired === undefined ? null : { value: repaired, truncated: true };
}

/**
 * Close a JSON text that was cut short: finish the open string, drop a
 * half-written key or value, close every open bracket. Backs off to the
 * previous comma until something parses.
 */
function repairTruncated(s: string): unknown {
  let text = s;
  for (let attempt = 0; attempt < 40 && text.length > 1; attempt++) {
    const closed = closeOpen(text);
    if (closed !== null) {
      try { return JSON.parse(closed); } catch { /* back off */ }
    }
    const cut = lastSeparator(text);
    if (cut <= 0) break;
    text = text.slice(0, cut);
  }
  return undefined;
}

/** `text` with its open string and brackets closed, or null when it can't be. */
function closeOpen(text: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') { if (stack.pop() !== ch) return null; }
  }
  let out = text;
  if (inStr) out += (esc ? '\\' : '') + '"';
  // A trailing comma, colon or a key with no value can't be closed as is.
  out = out.replace(/[,:\s]+$/, '');
  if (/[{,]\s*"(?:[^"\\]|\\.)*"$/.test(out) && stack[stack.length - 1] === '}') {
    out = out.replace(/,?\s*"(?:[^"\\]|\\.)*"$/, '');
  }
  return out + stack.reverse().join('');
}

/** Index of the last top-level-ish separator outside a string, to back off to. */
function lastSeparator(text: string): number {
  let inStr = false;
  let esc = false;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === ',') last = i;
  }
  return last;
}

/**
 * A message that ends in JSON — "MCP error -32602: Invalid arguments: [...]" —
 * split into the prose and the parsed tail. Null when no tail parses.
 */
export function splitTrailingJson(s: string): { prefix: string; value: unknown } | null {
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '{' && ch !== '[') continue;
    if (i > 0 && !/[\s:=(]/.test(str[i - 1])) continue;
    try {
      const value = JSON.parse(str.slice(i).trim());
      if (value && typeof value === 'object') return { prefix: str.slice(0, i).trim(), value };
    } catch { /* keep looking */ }
  }
  return null;
}

// ── Validation issues (zod) ───────────────────────────────────────

interface Issue { code: string; message: string; path: Array<string | number>; expected?: unknown; received?: unknown }

/** The issues when `v` is a zod error list, else null. */
export function validationIssues(v: unknown): Issue[] | null {
  const list = Array.isArray(v) ? v : (v && typeof v === 'object' && Array.isArray((v as { issues?: unknown }).issues) ? (v as { issues: unknown[] }).issues : null);
  if (!list || list.length === 0) return null;
  const ok = list.every((i) => i && typeof i === 'object'
    && typeof (i as Issue).code === 'string' && typeof (i as Issue).message === 'string' && Array.isArray((i as Issue).path));
  return ok ? (list as Issue[]) : null;
}

function issueLine(i: Issue): string {
  const where = i.path.length ? i.path.join('.') : '(input)';
  const types = i.expected !== undefined ? ` (expected ${String(i.expected)}${i.received !== undefined ? `, got ${String(i.received)}` : ''})` : '';
  return `${where}: ${i.message}${types}`;
}

/** Zod issues as plain text, one per line. */
export function issuesText(v: unknown): string {
  return (validationIssues(v) ?? []).map(issueLine).join('\n');
}

// ── Rendering ──────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][\w$-]*$/;

function keyHtml(k: string): string {
  return `<span class="jv-k">${escapeHtml(IDENT.test(k) ? k : JSON.stringify(k))}</span>`;
}

function isBlockString(s: string): boolean {
  return s.includes('\n') || s.length > LONG_STRING;
}

/** The one-line text of `v`, or null when it can't or shouldn't be one line. */
function inlineText(v: unknown, budget: number): string | null {
  if (v === null) return 'null';
  if (typeof v === 'string') return isBlockString(v) ? null : JSON.stringify(v);
  if (typeof v !== 'object') return String(v);
  const entries = Array.isArray(v) ? v.map((x) => [null, x] as const) : Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return Array.isArray(v) ? '[]' : '{}';
  const parts: string[] = [];
  let len = 4;
  for (const [k, x] of entries) {
    const inner = inlineText(x, budget - len);
    if (inner === null) return null;
    const part = k === null ? inner : `${IDENT.test(k) ? k : JSON.stringify(k)}: ${inner}`;
    len += part.length + 2;
    if (len > budget) return null;
    parts.push(part);
  }
  return Array.isArray(v) ? `[${parts.join(', ')}]` : `{ ${parts.join(', ')} }`;
}

function scalarHtml(v: unknown): string {
  if (v === null) return '<span class="jv-z">null</span>';
  if (typeof v === 'string') return `<span class="jv-s">${escapeHtml(JSON.stringify(v))}</span>`;
  if (typeof v === 'number') return `<span class="jv-n">${v}</span>`;
  if (typeof v === 'boolean') return `<span class="jv-b">${v}</span>`;
  return `<span class="jv-z">${escapeHtml(String(v))}</span>`;
}

function inlineHtml(v: unknown): string {
  if (v === null || typeof v !== 'object') return scalarHtml(v);
  if (Array.isArray(v)) {
    return v.length === 0 ? '<span class="jv-p">[]</span>'
      : `<span class="jv-p">[</span>${v.map(inlineHtml).join('<span class="jv-p">, </span>')}<span class="jv-p">]</span>`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return '<span class="jv-p">{}</span>';
  return `<span class="jv-p">{ </span>${entries.map(([k, x]) => `${keyHtml(k)}<span class="jv-p">: </span>${inlineHtml(x)}`).join('<span class="jv-p">, </span>')}<span class="jv-p"> }</span>`;
}

/** A long or multi-line string: its text, with any JSON inside it rendered as JSON. */
function stringBlockHtml(s: string): string {
  const whole = s.trim();
  if (whole.startsWith('{') || whole.startsWith('[')) {
    const p = parseLoose(whole);
    if (p && typeof p.value === 'object' && p.value !== null) return valueHtml(p.value, INLINE_MAX) + (p.truncated ? CUT_NOTE : '');
  }
  const fenced = renderJsonFences(s, (html) => html);
  const pieces: string[] = [];
  let rest = fenced.text;
  // renderJsonFences returned the rendered blocks in order; interleave them.
  for (const block of fenced.blocks) {
    const at = rest.indexOf(block);
    pieces.push(textHtml(rest.slice(0, at)), block);
    rest = rest.slice(at + block.length);
  }
  pieces.push(textHtml(rest));
  return pieces.join('');
}

function textHtml(t: string): string {
  const trimmed = t.replace(/^\n+|\n+$/g, '');
  return trimmed ? `<div class="jv-text">${escapeHtml(trimmed)}</div>` : '';
}

const CUT_NOTE = '<div class="jv-cut">✂ cut by the preview — the whole payload is in HISTORY</div>';

function valueHtml(v: unknown, budget: number): string {
  const issues = validationIssues(v);
  if (issues) {
    return `<ul class="jv-issues">${issues.map((i) => `<li>${keyHtml(i.path.length ? i.path.join('.') : '(input)')}<span class="jv-p">: </span>${escapeHtml(issueLine(i).slice(issueLine(i).indexOf(': ') + 2))}</li>`).join('')}</ul>`;
  }
  if (typeof v === 'string' && isBlockString(v)) return stringBlockHtml(v);
  if (inlineText(v, budget) !== null) return inlineHtml(v);
  if (Array.isArray(v)) {
    const shown = v.slice(0, ARRAY_MAX);
    const rows = shown.map((x) => `<div class="jv-row"><span class="jv-i">·</span>${valueHtml(x, budget - 4)}</div>`);
    if (v.length > ARRAY_MAX) rows.push(`<div class="jv-row jv-more">+${v.length - ARRAY_MAX} more</div>`);
    return `<span class="jv-p">[${v.length}]</span><div class="jv-nest">${rows.join('')}</div>`;
  }
  const rows = Object.entries(v as Record<string, unknown>).map(([k, x]) => {
    const block = (typeof x === 'string' && isBlockString(x)) || (x !== null && typeof x === 'object' && inlineText(x, budget - k.length - 4) === null);
    return block
      ? `<div class="jv-row jv-row-b">${keyHtml(k)}<span class="jv-p">:</span>${valueHtml(x, budget - 4)}</div>`
      : `<div class="jv-row">${keyHtml(k)}<span class="jv-p">: </span>${inlineHtml(x)}</div>`;
  });
  return `<div class="jv-nest">${rows.join('')}</div>`;
}

/** `v` as viewer HTML, wrapped in `.jv`. `truncated` adds the cut note. */
export function jsonHtml(v: unknown, opts: { truncated?: boolean } = {}): string {
  return `<div class="jv">${valueHtml(v, INLINE_MAX)}${opts.truncated ? CUT_NOTE : ''}</div>`;
}

// ── ```json fences inside markdown ─────────────────────────────────

/**
 * Find every ```json fence in `src`, parse it with a scanner that knows where
 * the JSON value really ends (a string inside it may hold ``` and must not
 * close the fence), and swap it for `stash(html)`. Fences that don't parse
 * are left in place for the markdown pass.
 */
export function renderJsonFences(src: string, stash: (html: string) => string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  let out = '';
  let i = 0;
  const open = /```json[ \t]*\n/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const end = jsonValueEnd(src, start);
    if (end < 0) continue;
    const close = /^\s*```/.exec(src.slice(end));
    if (!close) continue;
    let value: unknown;
    try { value = JSON.parse(src.slice(start, end)); } catch { continue; }
    const placeholder = stash(jsonHtml(value));
    blocks.push(placeholder);
    out += src.slice(i, m.index) + placeholder;
    i = end + close[0].length;
    open.lastIndex = i;
  }
  return { text: out + src.slice(i), blocks };
}

/** Index just past the JSON value that starts at `from` (after whitespace), or -1. */
function jsonValueEnd(src: string, from: number): number {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  const first = src[i];
  if (first !== '{' && first !== '[') return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}
