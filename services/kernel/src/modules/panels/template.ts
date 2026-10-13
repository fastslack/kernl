// src/modules/panels/template.ts
/**
 * Panel templates: `{{field}}` interpolation and one template per option.
 * Nothing is evaluated — a template can only copy values in.
 */
export type Template = string | { by: string; cases: Record<string, string> };

export class TemplateError extends Error {}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function lookup(values: Record<string, unknown>, path: string): unknown {
  let cur: unknown = values;
  for (const part of path.split(".")) {
    if (FORBIDDEN.has(part) || cur === null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function renderTemplate(t: Template, values: Record<string, unknown>): string {
  let source: string;
  if (typeof t === "string") source = t;
  else {
    const key = String(lookup(values, t.by) ?? "");
    if (!Object.prototype.hasOwnProperty.call(t.cases, key)) throw new TemplateError(`no template for ${t.by}=${key || "(empty)"}`);
    source = t.cases[key];
  }
  return source.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, path: string) => {
    const v = lookup(values, path);
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}
