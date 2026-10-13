// src/modules/panels/select.ts
import { renderTemplate } from "./template.js";

/** `$`, `$.a.b`, `$.a[key]` (key may be a `{{field}}`). No wildcards, no recursion. */
export class SelectorError extends Error {}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

export function selectPath(data: unknown, selector: string, vars: Record<string, unknown> = {}): unknown {
  const sel = renderTemplate(selector, vars).trim();
  if (sel !== "$" && !sel.startsWith("$.") && !sel.startsWith("$[")) throw new SelectorError(`selector must start with $: ${selector}`);
  if (sel.includes("..")) throw new SelectorError(`recursive selectors are not supported: ${selector}`);
  const parts: string[] = [];
  const re = /\.([^.[\]]+)|\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 1;
  while ((m = re.exec(sel)) !== null) {
    if (m.index !== consumed) throw new SelectorError(`invalid selector: ${selector}`);
    parts.push(m[1] ?? m[2]);
    consumed = m.index + m[0].length;
  }
  if (consumed !== sel.length) throw new SelectorError(`invalid selector: ${selector}`);
  let cur: unknown = data;
  for (const p of parts) {
    if (FORBIDDEN.has(p)) throw new SelectorError(`forbidden key: ${p}`);
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, p) ? (cur as Record<string, unknown>)[p] : undefined;
  }
  return cur;
}
