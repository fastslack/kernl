/** Small, strict helpers the task checks share. */

import { fold } from "./world.js";
import type { AttemptOutput, CheckResult } from "./types.js";

/**
 * The JSON a model returned: the whole text, or the first fenced or bare
 * object/array in it. Models wrap JSON in prose and fences; the bench forgives
 * the wrapper, not the JSON itself.
 */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidates = [t, fenced?.[1]?.trim() ?? ""];
  const first = Math.min(...["{", "["].map((c) => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))));
  if (Number.isFinite(first)) {
    const close = t[first] === "{" ? "}" : "]";
    candidates.push(t.slice(first, t.lastIndexOf(close) + 1));
  }
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return undefined;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Within `tol` (relative) of `want`. */
export function near(got: unknown, want: number, tol = 0.005): boolean {
  const n = typeof got === "number" ? got : typeof got === "string" ? toNumber(got) : NaN;
  if (!Number.isFinite(n)) return false;
  return want === 0 ? Math.abs(n) < 1e-9 : Math.abs(n - want) / Math.abs(want) <= tol;
}

/** "92.300", "92,300.50", "$ 92300" → number; Spanish and English separators. */
export function toNumber(s: string): number {
  let t = s.replace(/[^\d.,-]/g, "");
  if (!t) return NaN;
  t = t.replace(/[.,]+$/, "");
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the later one is the decimal separator.
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Only commas: groups of three are thousands (12,500), anything else a decimal (30,67).
    t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  } else if (lastDot >= 0) {
    // Only dots: same rule (12.500 is twelve thousand five hundred, 30.67 a decimal).
    t = /^-?\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, "") : t;
  }
  return Number(t);
}

/** Every number written in the text. */
export function numbersIn(text: string): number[] {
  return (text.match(/-?\d[\d.,]*/g) ?? []).map(toNumber).filter(Number.isFinite);
}

export const has = (text: string, ...words: string[]) => words.some((w) => fold(text).includes(fold(w)));

/** Calls to one tool. */
export const callsTo = (out: AttemptOutput, name: string) => out.calls.filter((c) => c.name === name);

/** Builds a result from weighted parts: [weight, passed, label]. */
export function parts(items: Array<[number, boolean, string]>, invalid?: string): CheckResult {
  const total = items.reduce((a, [w]) => a + w, 0) || 1;
  const score = items.reduce((a, [w, okay]) => a + (okay ? w : 0), 0) / total;
  const detail = items.map(([, okay, label]) => `${okay ? "✓" : "✗"} ${label}`).join(" · ");
  return { score: Math.round(score * 1000) / 1000, detail, ...(invalid ? { invalid } : {}) };
}

/** A JSON task's output: parsed, or an invalid result to return as is. */
export function jsonOr(out: AttemptOutput): { value: unknown } | { result: CheckResult } {
  const value = parseJsonLoose(out.text);
  if (value === undefined) return { result: { score: 0, detail: "✗ the answer is not valid JSON", invalid: "json" } };
  return { value };
}

/** "2026-10-15T09:00…" starts at that minute, whatever seconds or zone follow. */
export const atMinute = (v: unknown, want: string) => typeof v === "string" && v.replace(" ", "T").startsWith(want);
