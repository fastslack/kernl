import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sanitizeAgentPayload } from "../src/core/prompt-sanitizer.js";

// Shipped agent definitions must always pass the same gate used at install time.
const ROOTS = ["assets", "../../../kernl-pro/assets"].filter((r) => existsSync(r));

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".json")) out.push(p);
  }
}

function collect(o: unknown, file: string, rejected: string[], count: { n: number }): void {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) { for (const x of o) collect(x, file, rejected, count); return; }
  const rec = o as Record<string, unknown>;
  if ("system_prompt" in rec || "system_prompt_i18n" in rec) {
    count.n++;
    for (const r of sanitizeAgentPayload(rec, { source: "seed-test" })) {
      rejected.push(`${file}#${String(rec.slug ?? "?")}.${r.field}: ${r.result.rule}`);
    }
  }
  for (const v of Object.values(rec)) collect(v, file, rejected, count);
}

describe("shipped agent seeds pass the prompt sanitizer", () => {
  it("rejects none of them", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);
    const rejected: string[] = [];
    const count = { n: 0 };
    for (const f of files) {
      let text: string;
      try { text = readFileSync(f, "utf8"); } catch { continue; }
      if (!text.includes("system_prompt")) continue;
      try { collect(JSON.parse(text), f, rejected, count); } catch { /* not an agent file */ }
    }
    expect(count.n).toBeGreaterThan(0);
    expect(rejected).toEqual([]);
  });
});
