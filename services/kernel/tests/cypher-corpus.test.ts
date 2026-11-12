import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { loadRelateClient, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

/**
 * Every Cypher statement in the kernel and its bundled extensions must run on
 * the built-in graph (Relate): it is the default driver, and a statement
 * written for Neo4j alone fails there silently — graph writes are best-effort
 * and swallow the error. This test lifts each statement out of the source and
 * asks Relate to plan it (EXPLAIN, so nothing runs).
 *
 * Neo4j-only work is exempt when it is gated on a capability Relate does not
 * advertise: Graph Data Science (`gds.*`, behind `capabilities.gds`) and
 * server administration. Statements assembled from parts at run time are
 * planned with placeholders where the parts are identifiers; the rest are
 * skipped and counted.
 */

const ROOT = resolve(import.meta.dir, "..");
const SOURCES = ["src", "assets/extensions"].map((d) => join(ROOT, d));
const START = /^\s*(CYPHER\s+\d+\s+)?(OPTIONAL\s+MATCH|MATCH|MERGE|CREATE|CALL|UNWIND|WITH|RETURN|DETACH\s+DELETE|DROP|SHOW)\b/i;
const SQL = /\b(SELECT\s|INSERT\s+INTO|DELETE\s+FROM|CREATE\s+(TABLE|TRIGGER|VIRTUAL|VIEW)|CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+\w+\s*\(|ALTER\s+TABLE|PRAGMA|UPDATE\s+\w+\s+SET|ROWID|AUTOINCREMENT)\b/i;
/** Neo4j-only, gated on capabilities the built-in graph does not claim. */
const NEO4J_ONLY = /\bgds\.|\bapoc\.|dbms\.setConfigValue/i;
const SCHEMA = /^\s*(CREATE\s+(CONSTRAINT|(VECTOR\s+|FULLTEXT\s+|TEXT\s+|RANGE\s+|POINT\s+|LOOKUP\s+)?INDEX)|DROP\s+(CONSTRAINT|INDEX)|SHOW\s)/i;

interface Statement {
  where: string;
  cypher: string;
  dynamic: boolean;
}

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "tests", "__tests__", "frontend", "backend"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.ts$/.test(name) && !/\.(test|spec|d)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

function extract(): Statement[] {
  const out: Statement[] = [];
  for (const dir of SOURCES) {
    for (const f of files(dir)) {
      const src = readFileSync(f, "utf8");
      if (!/MATCH|MERGE|CALL |CREATE /.test(src)) continue;
      const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        let text: string | null = null;
        let dynamic = false;
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
        else if (ts.isTemplateExpression(n)) {
          text = n.head.text;
          for (const sp of n.templateSpans) {
            const before = text.slice(-3);
            // A label, relationship type or property name: any identifier plans the same.
            if (/:\s*`?$/.test(before) || /\.\s*$/.test(before)) text += "Kx";
            else if (/(LIMIT|SKIP)\s*$/i.test(text.slice(-8))) text += "5";
            else {
              text += "/*dynamic*/";
              dynamic = true;
            }
            text += sp.literal.text;
          }
        }
        if (text && START.test(text) && !SQL.test(text) && /[()]/.test(text) && text.length > 12) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          out.push({ where: `${relative(ROOT, f)}:${line + 1}`, cypher: text.trim(), dynamic });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return out;
}

describe.skipIf(!relateClientInstalled())("Cypher corpus on the built-in graph", () => {
  it("plans every graph statement in the kernel and its extensions", async () => {
    const statements = extract();
    const mod = await loadRelateClient();
    const failures: string[] = [];
    let planned = 0;
    let exempt = 0;
    let dynamic = 0;
    for (const s of statements) {
      if (NEO4J_ONLY.test(s.cypher)) { exempt++; continue; }
      if (s.dynamic) { dynamic++; continue; }
      const conn = mod.Database.open(":memory:").connect();
      try {
        await conn.queryAsync(SCHEMA.test(s.cypher) ? s.cypher : `EXPLAIN ${s.cypher}`);
        planned++;
      } catch (err) {
        failures.push(`${s.where}\n    ${String((err as Error).message).split("\n")[0]}\n    ${s.cypher.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
    // Guard against the extractor silently finding nothing.
    expect(planned).toBeGreaterThan(80);
    if (failures.length) {
      throw new Error(`${failures.length} Cypher statement(s) do not run on Relate:\n  ${failures.join("\n  ")}`);
    }
    console.info(`Cypher corpus: ${planned} planned on Relate, ${exempt} Neo4j-only (GDS/admin), ${dynamic} assembled at run time`);
  }, 120_000);
});
