/**
 * Copy a Neo4j graph into a new Relate store — the 0.5.0 upgrade of an install
 * that ran on Neo4j (every Docker install of 0.4.x).
 *
 * SQLite is the system of record for most of what Kernl projects into the
 * graph, and the backfills rebuild it. Not all of it: chat long-term memory
 * (Memory, Episode, Concept — strength, reinforcement, gravity), the CRM's
 * KNOWS edges, the news Article archive and the cinema graph's vectors live
 * only in the graph. So an install that leaves Neo4j copies the whole graph,
 * not a projection of it.
 *
 * Reads stream over Bolt (one query per kind, records pulled as they are
 * written, so the source never has to fit in memory); writes go to the new
 * store in batches through a temporary key, as relate-store-migration.ts does
 * for Relate-to-Relate. Neo4j values become their Relate counterparts:
 * integers, temporal types (re-typed in Cypher after the write), points and
 * lists. Counts are checked at the end; a mismatch throws and the caller keeps
 * the old graph. Schema follows best-effort from SHOW CONSTRAINTS / INDEXES;
 * vector and full-text indexes are recreated by the modules that own them.
 *
 * Run it in a child process (`runNeo4jImportTask`): the Relate client cannot
 * close a store, and the kernel opens this one right after.
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { RelateModule, RelateConnection } from "./relate-graph-driver.js";

export interface Neo4jSource {
  uri: string;
  user: string;
  password: string;
  database?: string;
}

export interface Neo4jImportResult {
  nodes: number;
  relationships: number;
  schema: number;
  schemaSkipped: number;
  ms: number;
}

const TEMP_LABEL = "__KernlImport";
const TEMP_KEY = "__kernl_import";
const TEMP_INDEX = "kernl_neo4j_import";
const NODE_BATCH = 500;
const REL_BATCH = 2_000;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How a temporal property is re-typed after it lands as ISO text. */
type Temporal = "datetime" | "localdatetime" | "date" | "time" | "localtime" | "duration";

interface Converted {
  props: Record<string, unknown>;
  /** Property → the Cypher function that restores its type. */
  temporal: Record<string, Temporal>;
  /** Property → {x, y, z?, crs}: restored with point(). */
  points: Record<string, Record<string, unknown>>;
}

/** A Neo4j driver value as a plain value Relate can take, noting what needs re-typing. */
function plain(v: unknown): { value: unknown; temporal?: Temporal; point?: Record<string, unknown> } {
  if (v === null || v === undefined) return { value: null };
  if (neo4j.isInt(v)) {
    const n = v as { toNumber(): number; inSafeRange(): boolean; toString(): string };
    return { value: n.inSafeRange() ? n.toNumber() : Number(n.toString()) };
  }
  if (neo4j.isDateTime(v)) return { value: v.toString().replace(/\[[^\]]*\]$/, ""), temporal: "datetime" };
  if (neo4j.isLocalDateTime(v)) return { value: v.toString(), temporal: "localdatetime" };
  if (neo4j.isDate(v)) return { value: v.toString(), temporal: "date" };
  if (neo4j.isTime(v)) return { value: v.toString(), temporal: "time" };
  if (neo4j.isLocalTime(v)) return { value: v.toString(), temporal: "localtime" };
  if (neo4j.isDuration(v)) return { value: v.toString(), temporal: "duration" };
  if (neo4j.isPoint(v)) {
    const p = v as unknown as { x: number; y: number; z?: number; srid: unknown };
    const srid = Number(neo4j.isInt(p.srid) ? (p.srid as { toNumber(): number }).toNumber() : p.srid);
    const crs = srid === 4326 ? "WGS-84" : srid === 4979 ? "WGS-84-3D" : srid === 9157 ? "cartesian-3D" : "cartesian";
    const point: Record<string, unknown> = { x: p.x, y: p.y, crs };
    if (p.z !== undefined && p.z !== null) point.z = p.z;
    return { value: null, point };
  }
  if (Array.isArray(v)) return { value: v.map((x) => plain(x).value) };
  if (v instanceof Uint8Array) return { value: Array.from(v) };
  return { value: v };
}

function convert(props: Record<string, unknown>): Converted {
  const out: Converted = { props: {}, temporal: {}, points: {} };
  for (const [k, raw] of Object.entries(props ?? {})) {
    const c = plain(raw);
    if (c.point) {
      out.points[k] = c.point;
      continue;
    }
    out.props[k] = c.value;
    if (c.temporal) out.temporal[k] = c.temporal;
  }
  return out;
}

const q = (k: string) => `\`${k.replace(/`/g, "``")}\``;

/** SET clauses that restore temporal and point properties for one batch. */
function retype(alias: string, rows: Converted[]): string {
  const temporal = new Map<string, Temporal>();
  const points = new Set<string>();
  for (const r of rows) {
    for (const [k, t] of Object.entries(r.temporal)) temporal.set(k, t);
    for (const k of Object.keys(r.points)) points.add(k);
  }
  const sets: string[] = [];
  for (const [k, fn] of temporal) {
    sets.push(`${alias}.${q(k)} = CASE WHEN r.t[${JSON.stringify(k)}] IS NULL THEN ${alias}.${q(k)} ELSE ${fn}(${alias}.${q(k)}) END`);
  }
  for (const k of points) {
    sets.push(`${alias}.${q(k)} = CASE WHEN r.pt[${JSON.stringify(k)}] IS NULL THEN ${alias}.${q(k)} ELSE point(r.pt[${JSON.stringify(k)}]) END`);
  }
  return sets.length ? `SET ${sets.join(", ")}` : "";
}

async function countOn(conn: RelateConnection, cypher: string): Promise<number> {
  const r = await conn.queryAsync(cypher);
  return Number(r.rows?.[0]?.n ?? 0);
}

async function countNeo4j(session: Session, cypher: string): Promise<number> {
  const r = await session.run(cypher);
  return plain(r.records[0]?.get("n")).value as number;
}

/** Open a driver and prove the server answers; throws when it does not. */
export async function connectNeo4j(src: Neo4jSource, timeoutMs = 8_000): Promise<Driver> {
  const driver = neo4j.driver(src.uri, neo4j.auth.basic(src.user, src.password), {
    connectionTimeout: timeoutMs,
    maxConnectionPoolSize: 2,
    disableLosslessIntegers: false,
  });
  try {
    await driver.verifyConnectivity({ database: src.database });
    return driver;
  } catch (err) {
    await driver.close().catch(() => {});
    throw err;
  }
}

/**
 * What a graph takes in Relate's logical size, per element — measured on
 * Relate 1.0.1 by filling a store under a small cap until it refused more:
 * a node with a few short properties ~510 bytes, a 384-dimension embedding
 * ~3,440 more, a relationship ~416.
 */
export const RELATE_BYTES = { node: 512, rel: 420 } as const;

export interface RelateSizeEstimate {
  nodes: number;
  relationships: number;
  /** Average characters of a node's / relationship's properties as text (a sample). */
  nodePropChars: number;
  relPropChars: number;
  bytes: number;
}

/**
 * Average length of property maps printed as text — what the estimate scales.
 * Driver integers count as the number they hold and temporal values as their
 * ISO text, so the size does not depend on how the driver boxes them.
 */
export function averagePrintedChars(maps: unknown[]): number {
  if (maps.length === 0) return 0;
  // Before stringifying: the driver's Integer has a toJSON of its own that a replacer would only see the output of.
  const plain = (v: unknown): unknown => {
    if (typeof v === "bigint") return Number(v);
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === "object") {
      const o = v as { toNumber?: () => number; toString?: () => string; constructor?: { name?: string } };
      if (typeof o.toNumber === "function") return o.toNumber();
      if (o.constructor && o.constructor.name !== "Object" && typeof o.toString === "function") return o.toString();
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
    }
    return v;
  };
  let total = 0;
  for (const m of maps) total += JSON.stringify(plain(m ?? {})).length;
  return total / maps.length;
}

/**
 * How much of Relate's size cap a Neo4j graph will take once copied: counts
 * from Neo4j, plus a sample of how large the properties are. A property list
 * prints at ~20 characters a float against ~9 bytes stored, and strings are
 * cheaper still, so half the printed size errs on the large side — which is
 * the side to err on for a cap.
 */
export async function estimateRelateBytes(src: Neo4jSource): Promise<RelateSizeEstimate> {
  const driver = await connectNeo4j(src);
  const session = driver.session({ database: src.database, defaultAccessMode: neo4j.session.READ });
  try {
    const nodes = await countNeo4j(session, "MATCH (n) RETURN count(n) AS n");
    const relationships = await countNeo4j(session, "MATCH ()-[r]->() RETURN count(r) AS n");
    // Measured here, not in Cypher: Neo4j 5 refuses toString() of a map
    // ("expected Boolean, Float, … but was Map"), which Relate accepts — the
    // estimate failed against the very graph it exists for.
    const avg = async (q: string) => averagePrintedChars((await session.run(q)).records.map((r) => r.get("p")));
    const nodePropChars = nodes ? await avg("MATCH (n) WITH n LIMIT 5000 RETURN properties(n) AS p") : 0;
    const relPropChars = relationships ? await avg("MATCH ()-[r]->() WITH r LIMIT 5000 RETURN properties(r) AS p") : 0;
    const bytes = Math.ceil(nodes * (RELATE_BYTES.node + nodePropChars / 2) + relationships * (RELATE_BYTES.rel + relPropChars / 2));
    return { nodes, relationships, nodePropChars, relPropChars, bytes };
  } finally {
    await session.close().catch(() => {});
    await driver.close().catch(() => {});
  }
}

export async function importNeo4jIntoRelate(
  mod: RelateModule,
  src: Neo4jSource,
  toPath: string,
  log: (msg: string) => void = () => {},
): Promise<Neo4jImportResult> {
  const t0 = Date.now();
  const driver = await connectNeo4j(src);
  const session = driver.session({ database: src.database, defaultAccessMode: neo4j.session.READ, fetchSize: 1_000 });
  const dstDb = mod.Database.open(toPath);
  const dst = dstDb.connect();
  try {
    const totalNodes = await countNeo4j(session, "MATCH (n) RETURN count(n) AS n");
    const totalRels = await countNeo4j(session, "MATCH ()-[r]->() RETURN count(r) AS n");
    log(`copying ${totalNodes} nodes and ${totalRels} relationships from ${src.uri}`);
    await dst.queryAsync(`CREATE INDEX ${TEMP_INDEX} IF NOT EXISTS FOR (n:${TEMP_LABEL}) ON (n.${TEMP_KEY})`);

    // Nodes, streamed.
    let copied = 0;
    let batch: Array<{ id: string; labels: string[] } & Converted> = [];
    const flushNodes = async () => {
      if (!batch.length) return;
      const rows = batch.map((b) => ({ id: b.id, labels: b.labels.filter((l) => IDENT.test(l)), p: b.props, t: b.temporal, pt: b.points }));
      await dst.queryAsync(
        `UNWIND $rows AS r
         CREATE (n:${TEMP_LABEL})
         SET n = r.p
         SET n.${TEMP_KEY} = r.id
         ${retype("n", batch)}
         WITH n, r WHERE size(r.labels) > 0
         SET n:$(r.labels)`,
        { rows },
      );
      copied += batch.length;
      batch = [];
      if (copied % 20_000 < NODE_BATCH) log(`  ${copied}/${totalNodes} nodes`);
    };
    const nodeResult = session.run("MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props");
    for await (const rec of nodeResult) {
      batch.push({ id: String(rec.get("id")), labels: rec.get("labels") as string[], ...convert(rec.get("props") as Record<string, unknown>) });
      if (batch.length >= NODE_BATCH) await flushNodes();
    }
    await flushNodes();

    // Relationships, streamed and wired through the temporary key.
    let wired = 0;
    let rbatch: Array<{ a: string; b: string; t: string } & Converted> = [];
    const flushRels = async () => {
      if (!rbatch.length) return;
      const rows = rbatch.map((r) => ({ a: r.a, b: r.b, type: r.t, p: r.props, t: r.temporal, pt: r.points }));
      await dst.queryAsync(
        `UNWIND $rows AS r
         MATCH (a:${TEMP_LABEL} {${TEMP_KEY}: r.a})
         MATCH (b:${TEMP_LABEL} {${TEMP_KEY}: r.b})
         CREATE (a)-[x:$(r.type)]->(b)
         SET x = r.p
         ${retype("x", rbatch)}`,
        { rows },
      );
      wired += rbatch.length;
      rbatch = [];
    };
    const relResult = session.run(
      "MATCH (a)-[r]->(b) RETURN elementId(a) AS a, elementId(b) AS b, type(r) AS t, properties(r) AS p",
    );
    for await (const rec of relResult) {
      rbatch.push({ a: String(rec.get("a")), b: String(rec.get("b")), t: String(rec.get("t")), ...convert(rec.get("p") as Record<string, unknown>) });
      if (rbatch.length >= REL_BATCH) await flushRels();
    }
    await flushRels();

    for (;;) {
      const r = await dst.queryAsync(
        `MATCH (n:${TEMP_LABEL}) WITH n LIMIT 5000 REMOVE n:${TEMP_LABEL}, n.${TEMP_KEY} RETURN count(n) AS n`,
      );
      if (Number(r.rows?.[0]?.n ?? 0) === 0) break;
    }
    await dst.queryAsync(`DROP INDEX ${TEMP_INDEX} IF EXISTS`);

    // Schema, best-effort: uniqueness and range indexes carry over; vector and
    // full-text ones are recreated by their modules on start.
    let schema = 0;
    let schemaSkipped = 0;
    const statements: string[] = [];
    try {
      for (const r of (await session.run("SHOW CONSTRAINTS YIELD createStatement RETURN createStatement")).records) {
        statements.push(String(r.get("createStatement")));
      }
      for (const r of (await session.run("SHOW INDEXES YIELD name, type, owningConstraint, createStatement RETURN name, type, owningConstraint, createStatement")).records) {
        if (r.get("owningConstraint") || ["LOOKUP", "VECTOR", "FULLTEXT"].includes(String(r.get("type")))) continue;
        statements.push(String(r.get("createStatement")));
      }
    } catch { /* an edition without SHOW: the modules recreate their schema */ }
    for (const s of statements) {
      try {
        await dst.queryAsync(s.replace(/^CREATE (CONSTRAINT|INDEX) (\S+) /i, "CREATE $1 $2 IF NOT EXISTS ").replace(/IF NOT EXISTS IF NOT EXISTS/i, "IF NOT EXISTS").replace(/\s+OPTIONS\s+\{[\s\S]*\}\s*$/i, ""));
        schema++;
      } catch {
        schemaSkipped++;
      }
    }

    const gotNodes = await countOn(dst, "MATCH (n) RETURN count(n) AS n");
    const gotRels = await countOn(dst, "MATCH ()-[r]->() RETURN count(r) AS n");
    if (gotNodes !== totalNodes || gotRels !== totalRels || copied !== totalNodes || wired !== totalRels) {
      throw new Error(`Neo4j import incomplete: nodes ${gotNodes}/${totalNodes}, relationships ${gotRels}/${totalRels}`);
    }
    dstDb.checkpoint();
    return { nodes: gotNodes, relationships: gotRels, schema, schemaSkipped, ms: Date.now() - t0 };
  } finally {
    await session.close().catch(() => {});
    await driver.close().catch(() => {});
  }
}

/**
 * What lives only in the graph, keyed so it can be merged into a store that
 * was already rebuilt from SQLite — for an install whose Neo4j was down when
 * it upgraded and comes back later.
 */
export const GRAPH_ONLY_NODES: Array<{ label: string; key: string }> = [
  { label: "Memory", key: "id" },
  { label: "Episode", key: "id" },
  { label: "Concept", key: "label_lower" },
  { label: "Article", key: "link" },
];
/** Relationships whose endpoints are graph-only nodes or CRM people, matched by their keys. */
export const GRAPH_ONLY_RELS = [
  "KNOWS", "HAS_MEMORY", "FOLLOWED_BY", "EXPRESSES", "DISCUSSES", "MENTIONS", "ABOUT_TASK", "REFERENCES",
  "SAME_DOMAIN", "SAME_COMPANY",
];
const KEY_OF: Record<string, string> = Object.fromEntries([
  ...GRAPH_ONLY_NODES.map((n) => [n.label, n.key]),
  ["Person", "id"], ["Task", "id"], ["Note", "id"],
]);

export interface MergeResult { nodes: number; relationships: number; ms: number }

/**
 * Merge what lives only in Neo4j into a live store, through any graph runner
 * (the kernel's active Relate driver). Idempotent: MERGE on each label's key.
 */
export async function mergeGraphOnlyFromNeo4j(
  src: Neo4jSource,
  run: (cypher: string, params?: Record<string, unknown>) => Promise<unknown>,
  log: (msg: string) => void = () => {},
): Promise<MergeResult> {
  const t0 = Date.now();
  const driver = await connectNeo4j(src);
  const session = driver.session({ database: src.database, defaultAccessMode: neo4j.session.READ, fetchSize: 1_000 });
  let nodes = 0;
  let rels = 0;
  try {
    for (const { label, key } of GRAPH_ONLY_NODES) {
      let batch: Converted[] = [];
      const flush = async () => {
        if (!batch.length) return;
        await run(
          `UNWIND $rows AS r MERGE (n:${label} {${q(key)}: r.p[${JSON.stringify(key)}]}) SET n += r.p ${retype("n", batch)}`,
          { rows: batch.map((b) => ({ p: b.props, t: b.temporal, pt: b.points })) },
        );
        nodes += batch.length;
        batch = [];
      };
      const res = session.run(`MATCH (n:${label}) WHERE n.${q(key)} IS NOT NULL RETURN properties(n) AS p`);
      for await (const rec of res) {
        batch.push(convert(rec.get("p") as Record<string, unknown>));
        if (batch.length >= NODE_BATCH) await flush();
      }
      await flush();
    }
    for (const type of GRAPH_ONLY_RELS) {
      const res = session.run(
        `MATCH (a)-[r:${type}]->(b)
         RETURN labels(a) AS la, properties(a) AS pa, labels(b) AS lb, properties(b) AS pb, properties(r) AS p`,
      );
      const groups = new Map<string, Array<{ ka: unknown; kb: unknown } & Converted>>();
      for await (const rec of res) {
        const la = (rec.get("la") as string[]).find((l) => KEY_OF[l]);
        const lb = (rec.get("lb") as string[]).find((l) => KEY_OF[l]);
        if (!la || !lb) continue;
        const pa = convert(rec.get("pa") as Record<string, unknown>).props;
        const pb = convert(rec.get("pb") as Record<string, unknown>).props;
        const ka = pa[KEY_OF[la]], kb = pb[KEY_OF[lb]];
        if (ka === undefined || kb === undefined) continue;
        const g = `${la}|${lb}`;
        groups.set(g, [...(groups.get(g) ?? []), { ka, kb, ...convert(rec.get("p") as Record<string, unknown>) }]);
      }
      for (const [g, list] of groups) {
        const [la, lb] = g.split("|");
        for (let i = 0; i < list.length; i += REL_BATCH) {
          const chunk = list.slice(i, i + REL_BATCH);
          await run(
            `UNWIND $rows AS r
             MATCH (a:${la} {${q(KEY_OF[la])}: r.ka}), (b:${lb} {${q(KEY_OF[lb])}: r.kb})
             MERGE (a)-[x:${type}]->(b) SET x += r.p ${retype("x", chunk)}`,
            { rows: chunk.map((c) => ({ ka: c.ka, kb: c.kb, p: c.props, t: c.temporal, pt: c.points })) },
          );
          rels += chunk.length;
        }
      }
    }
    log(`merged ${nodes} graph-only nodes and ${rels} relationships from ${src.uri}`);
    return { nodes, relationships: rels, ms: Date.now() - t0 };
  } finally {
    await session.close().catch(() => {});
    await driver.close().catch(() => {});
  }
}

// ── One-off import in a child process ────────────────────────────────

export const NEO4J_IMPORT_TASK = "neo4j-import";

/**
 * Runs the kernel entry point again as a child that only imports the graph,
 * then exits. The password travels in the child's environment only.
 * `entry` defaults to the running kernel's own entry point.
 */
export function runNeo4jImportChild(
  src: Neo4jSource,
  to: string,
  opts: { entry?: string; onLine?: (line: string) => void; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
  // Imported lazily so the module stays loadable where child_process is not wanted.
  return import("node:child_process").then(({ spawn }) => new Promise<string>((resolve, reject) => {
    const entry = opts.entry ?? process.argv[1];
    if (!entry) return reject(new Error("cannot locate the kernel entry point to run the import"));
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        KERNL_INTERNAL_TASK: NEO4J_IMPORT_TASK,
        KERNL_N2R_URI: src.uri,
        KERNL_N2R_USER: src.user,
        KERNL_N2R_PASSWORD: src.password,
        KERNL_N2R_DATABASE: src.database ?? "",
        KERNL_N2R_TO: to,
        // The child's environment is real: Relate reads its size cap from it
        // when the store opens (an assignment to process.env in this process
        // does not reach the engine).
        ...(opts.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
      for (const line of String(d).split("\n")) if (line.trim()) opts.onLine?.(line.trim());
    });
    child.stderr?.on("data", (d) => { err += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60 * 60_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim().split("\n").at(-1) ?? "");
      else reject(new Error(`import exited with ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
  }));
}

/** The child side: called from the entry point when KERNL_INTERNAL_TASK says so. */
export async function runNeo4jImportTask(): Promise<void> {
  const src: Neo4jSource = {
    uri: process.env.KERNL_N2R_URI ?? "",
    user: process.env.KERNL_N2R_USER ?? "",
    password: process.env.KERNL_N2R_PASSWORD ?? "",
    database: process.env.KERNL_N2R_DATABASE || undefined,
  };
  const to = process.env.KERNL_N2R_TO ?? "";
  try {
    const { loadRelateClient } = await import("./relate-graph-driver.js");
    const r = await importNeo4jIntoRelate(await loadRelateClient(), src, to, (m) => process.stdout.write(`${m}\n`));
    process.stdout.write(`${r.nodes} nodes, ${r.relationships} relationships, ${r.schema} schema statements in ${r.ms} ms\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  }
}
