/**
 * Will this codebase's Cypher run on Relate?
 *
 *   bun scripts/relate-cypher-check.ts [dir ...] [--json] [--fail]
 *
 * Lifts every Cypher statement out of a codebase written for Neo4j and asks
 * Relate to plan it (EXPLAIN: nothing runs, no data needed). It reads string
 * literals in TypeScript/JavaScript through the TypeScript parser, string
 * literals in Python and Java with a scanner, and whole `.cypher`/`.cql`
 * files. A literal counts as Cypher when it starts with a clause
 * (MATCH, MERGE, CREATE, CALL, UNWIND, WITH, RETURN…) and is not SQL.
 *
 * Statements assembled from parts at run time are planned with placeholders
 * where the parts are identifiers (a label, a property, a LIMIT); the rest are
 * counted and skipped. Neo4j-only work (gds.*, apoc.*, server admin) is
 * counted apart: Relate does not claim it.
 *
 * Needs only `@relate/relate` and `typescript`.
 *
 * Kernl uses it as its own test (tests/cypher-corpus.test.ts): every graph
 * statement in the kernel and its extensions must keep planning on Relate.
 * Point it at any other repository to see how far that one is from moving.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";
// Standalone on purpose: it only needs the Relate client and TypeScript, so it
// can be copied into any repository (RELATE_CLIENT_MODULE points at a client
// that is not installed as @relate/relate).
async function loadRelateClient(): Promise<{ Database: { open(uri: string): { connect(): { queryAsync(q: string): Promise<unknown> } } } }> {
  const mod = await import(process.env.RELATE_CLIENT_MODULE?.trim() || "@relate/relate");
  return mod.Database ? mod : mod.default;
}

export interface CypherStatement {
  where: string;
  cypher: string;
  /** Assembled at run time from parts the checker could not stand in for. */
  dynamic: boolean;
}

export interface CheckResult {
  statements: number;
  planned: number;
  failed: Array<{ where: string; error: string; cypher: string }>;
  /** Pieces the code concatenates with others (no ending, or variables bound outside): not checkable alone. */
  fragments: number;
  /** Another engine's dialect kept beside the Neo4j queries (FalkorDB, Kuzu…), or not valid on Neo4j 5 either. */
  notNeo4j: number;
  neo4jOnly: number;
  dynamic: number;
  /** Failures grouped by the first line of Relate's error, most common first. */
  byError: Array<{ error: string; count: number }>;
}

const START = /^\s*(CYPHER\s+\d+\s+)?(OPTIONAL\s+MATCH|MATCH|MERGE|CREATE|CALL|UNWIND|WITH|RETURN|DETACH\s+DELETE|DROP|SHOW)\b/i;
const SQL = /\b(SELECT\s|INSERT\s+INTO|DELETE\s+FROM|CREATE\s+(TABLE|TRIGGER|VIRTUAL|VIEW)|CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+\w+\s*\(|ALTER\s+TABLE|PRAGMA|UPDATE\s+\w+\s+SET|ROWID|AUTOINCREMENT)\b/i;
/** Neo4j-only: Graph Data Science, APOC and server administration. */
export const NEO4J_ONLY = /\bgds\.|\bapoc\.|dbms\.setConfigValue/i;
const SCHEMA = /^\s*(CREATE\s+(CONSTRAINT|(VECTOR\s+|FULLTEXT\s+|TEXT\s+|RANGE\s+|POINT\s+|LOOKUP\s+)?INDEX)|DROP\s+(CONSTRAINT|INDEX)|SHOW\s)/i;
/** Code for other graph engines living in the same repository (multi-backend libraries). */
const OTHER_ENGINE = /(falkor|kuzu|neptune|memgraph|apache[-_]?age|nebula)/i;
/** Another engine's dialect, or syntax Neo4j 5 rejects too: not a gap between Neo4j and Relate. */
const NOT_NEO4J = /\bvecf32\s*\(|\bremoveKeyFromMap\s*\(|\bCREATE_FTS_INDEX\b|\bjoin\s*\(|CREATE\s+FULLTEXT\s+INDEX\s+FOR\s+\([^)]*\)(-\[[^\]]*\]-\(\))?\s+ON\s+\(|\bYIELD\s+\w+\s+DROP\s+INDEX\b/i;
/** Errors that mean "this is part of a larger query", not "Relate cannot run it". */
const FRAGMENT = /\(EOF\)|must conclude with RETURN|UndefinedVariable|expected a pattern at line 0, col 0/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "tests", "__tests__", "test", "frontend", "backend", "target", "venv", ".venv"]);
const CODE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);
const SCANNED = new Set([".py", ".java", ".kt", ".go", ".rb", ".cs"]);
const WHOLE = new Set([".cypher", ".cql"]);

/** A node pattern — (n), (n:Label), (:Label), (n {…}) — or a procedure call: prose has neither. */
const GRAPHY = /\(\s*[A-Za-z_]\w*\s*[:){]|\(\s*:\s*`?\w|\bCALL\s+[A-Za-z_][\w.]*\s*\(|^\s*(CREATE|DROP)\s+(CONSTRAINT|INDEX|VECTOR|FULLTEXT|RANGE|POINT|TEXT)\b|^\s*SHOW\s/i;
const looksLikeCypher = (text: string) =>
  START.test(text) && !SQL.test(text) && /[()]/.test(text) && text.length > 12 && GRAPHY.test(text);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (OTHER_ENGINE.test(name)) continue;
    const st = statSync(p);
    if (st.isDirectory()) files(p, out);
    else {
      const ext = extname(name);
      if (/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(name)) continue;
      if (CODE.has(ext) || SCANNED.has(ext) || WHOLE.has(ext)) out.push(p);
    }
  }
  return out;
}

/** String literals of a TypeScript/JavaScript file, templates with stand-ins for their holes. */
function fromCode(file: string, src: string, root: string, out: CypherStatement[]): void {
  const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
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
    if (text && looksLikeCypher(text)) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      out.push({ where: `${relative(root, file)}:${line + 1}`, cypher: text.trim(), dynamic });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** Quoted strings of other languages (Python triple quotes included), without interpolation. */
function fromScanned(file: string, src: string, root: string, out: CypherStatement[]): void {
  const re = /([rRbBfF]{0,2})("""|'''|"|')((?:\\[\s\S]|(?!\2)[\s\S])*?)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const fstring = /f/i.test(m[1]);
    let raw = m[3];
    if (m[2].length === 1 && raw.includes("\n")) continue;
    let dynamic = false;
    // A str.format() template doubles its literal braces too.
    if (fstring || /\{\{/.test(raw)) {
      // {{ }} are literal braces; {expr} is a hole: an identifier after ':' or '.', else unknown.
      raw = raw.replace(/\{\{/g, "\u0001").replace(/\}\}/g, "\u0002")
        .replace(/(\*\s*\d*\s*\.\.\s*|\*\s*)\{[^{}]+\}/g, "$13")
        .replace(/([:.]\s*`?)\{[^{}]+\}/g, "$1Kx")
        .replace(/\{[^{}]+\}/g, () => { dynamic = true; return "/*dynamic*/"; })
        .replace(/\u0001/g, "{").replace(/\u0002/g, "}");
    }
    const text = raw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'");
    if (!looksLikeCypher(text)) continue;
    if (!fstring && /%s|%\(\w+\)s|\.format\(/.test(text)) dynamic = true;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ where: `${relative(root, file)}:${line}`, cypher: text.trim(), dynamic });
  }
}

/** Every statement in `roots`, in file order. */
export function extractCypher(roots: string[], base = process.cwd()): CypherStatement[] {
  const out: CypherStatement[] = [];
  for (const dir of roots) {
    for (const f of files(dir)) {
      const src = readFileSync(f, "utf8");
      const ext = extname(f);
      if (WHOLE.has(ext)) {
        let line = 1;
        for (const part of src.split(/;\s*(?:\n|$)/)) {
          const text = part.replace(/^\s*(\/\/[^\n]*\n\s*)+/, "").trim();
          if (text && START.test(text)) out.push({ where: `${relative(base, f)}:${line}`, cypher: text, dynamic: false });
          line += part.split("\n").length - 1;
        }
        continue;
      }
      if (!/MATCH|MERGE|CALL |CREATE |UNWIND /.test(src)) continue;
      if (CODE.has(ext)) fromCode(f, src, base, out);
      else fromScanned(f, src, base, out);
    }
  }
  return out;
}

/** Ask Relate to plan each statement; nothing runs. */
export async function checkOnRelate(statements: CypherStatement[]): Promise<CheckResult> {
  const mod = await loadRelateClient();
  const failed: CheckResult["failed"] = [];
  let fragments = 0;
  let notNeo4j = 0;
  let planned = 0;
  let neo4jOnly = 0;
  let dynamic = 0;
  for (const s of statements) {
    if (NEO4J_ONLY.test(s.cypher)) { neo4jOnly++; continue; }
    if (NOT_NEO4J.test(s.cypher)) { notNeo4j++; continue; }
    if (s.dynamic) { dynamic++; continue; }
    const conn = mod.Database.open(":memory:").connect();
    try {
      await conn.queryAsync(SCHEMA.test(s.cypher) ? s.cypher : `EXPLAIN ${s.cypher}`);
      planned++;
    } catch (err) {
      const error = String((err as Error).message).split("\n")[0];
      if (FRAGMENT.test(error)) fragments++;
      else failed.push({ where: s.where, error, cypher: s.cypher });
    }
  }
  const counts = new Map<string, number>();
  for (const f of failed) {
    const key = f.error.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "…").slice(0, 120);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byError = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([error, count]) => ({ error, count }));
  return { statements: statements.length, planned, failed, fragments, notNeo4j, neo4jOnly, dynamic, byError };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const failOnError = argv.includes("--fail");
  const dirs = argv.filter((a) => !a.startsWith("--"));
  const roots = (dirs.length ? dirs : ["."]).map((d) => resolve(d));
  const statements = extractCypher(roots);
  const r = await checkOnRelate(statements);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const pct = r.planned + r.failed.length ? Math.round((100 * r.planned) / (r.planned + r.failed.length)) : 100;
    console.log(`Cypher on Relate · ${roots.map((x) => relative(process.cwd(), x) || ".").join(", ")}`);
    console.log(`  ${r.statements} statement(s) found`);
    console.log(`  ${r.planned} plan on Relate (${pct}% of those checked)`);
    console.log(`  ${r.failed.length} do not`);
    console.log(`  ${r.fragments} fragment(s) of larger queries · ${r.notNeo4j} in another engine's dialect · ${r.neo4jOnly} Neo4j-only (GDS, APOC, admin) · ${r.dynamic} assembled at run time, not checked`);
    if (r.byError.length) {
      console.log("\nWhy, most common first:");
      for (const e of r.byError.slice(0, 10)) console.log(`  ${String(e.count).padStart(4)} × ${e.error}`);
      console.log("\nWhere:");
      for (const f of r.failed.slice(0, 40)) console.log(`  ${f.where}\n      ${f.error}\n      ${f.cypher.replace(/\s+/g, " ").slice(0, 140)}`);
      if (r.failed.length > 40) console.log(`  … and ${r.failed.length - 40} more (--json for all)`);
    }
  }
  process.exit(failOnError && r.failed.length ? 1 : 0);
}
