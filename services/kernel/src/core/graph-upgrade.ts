/**
 * The 0.5.0 graph upgrade: every install ends up on Relate, with its data,
 * and nobody has to do anything.
 *
 * Runs once per boot, after the driver rows are seeded and before the active
 * driver starts. What 0.4.x left behind decides what happens:
 *
 *   no graph (noop)          → Relate becomes active; the backfills and syncs
 *                              rebuild it from SQLite (the 0.4.x desktop app) —
 *                              unless a Neo4j answers with data in it (older
 *                              stacks wrote there through the legacy client
 *                              while the driver was noop): then it is copied.
 *   Neo4j, reachable         → the kernel starts on Neo4j as before, and the
 *                              whole graph is copied into a new Relate store in
 *                              the background (neo4j-to-relate.ts, in a child
 *                              process); counts are checked, then the kernel
 *                              switches to Relate live and catches up with what
 *                              reached Neo4j during the copy. A production graph
 *                              (~1M nodes) takes most of an hour to copy, which
 *                              the kernel no longer spends down. Neo4j is left
 *                              untouched: activating it again in /extensions
 *                              is the way back. (Every 0.4.x Docker install.)
 *   Neo4j, not reachable     → Relate becomes active anyway, so the kernel is
 *                              not left without a graph; the backfills rebuild
 *                              what SQLite holds, and what lives only in the
 *                              graph (chat memory, KNOWS, news) is merged in
 *                              from Neo4j as soon as it answers — checked on
 *                              every boot and every 30 minutes.
 *   Relate already           → nothing here.
 *
 * Size: Relate keeps the graph in memory, under a cap when one is set
 * (RELATE_LOGICAL_GRAPH_SIZE_LIMIT, or the driver's memoryLimit). Before copying, the graph's size in Relate is estimated
 * from Neo4j (estimateRelateBytes); the copy runs under 1.5× that, never below
 * the cap configured, and never above what this machine can hold (its cgroup
 * limit, or 80% of RAM). The cap chosen is saved as the relate driver's
 * memoryLimit. A copy that still runs out gets one retry at twice the cap. A
 * graph this machine cannot hold stays on Neo4j and is not tried again on
 * every boot, only once the machine (or an explicit cap) gives it more room.
 *
 * Opt-outs: KERNL_GRAPH_UPGRADE=off skips the whole step; KERNL_KEEP_NEO4J=1
 * keeps an install on Neo4j (it needs Graph Data Science, say). Without the
 * Relate client (an unsupported platform) nothing changes.
 *
 * What happened is kept in SQLite (`kernl_upgrades`, one row per step), so a
 * step that is done is never repeated and one that failed is retried.
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { totalmem } from "node:os";
import { log } from "./logger.js";
import { graphReplaced } from "./graph-backfill.js";
import type { SqliteDb } from "./db/sqlite.js";
import type { GraphDriverRegistry } from "./db-drivers/graph-driver-registry.js";
import { DEFAULT_GRAPH_SIZE_LIMIT, defaultRelatePath, operatorGraphCap, relateClientInstalled } from "./db-drivers/builtins/relate-graph-driver.js";
import {
  connectNeo4j, estimateRelateBytes, mergeGraphOnlyFromNeo4j, runNeo4jImportChild, type Neo4jSource,
} from "./db-drivers/builtins/neo4j-to-relate.js";

export const GRAPH_UPGRADE_STEP = "graph-relate-0.5.0";

export type UpgradeState = "done" | "pending-import" | "copying" | "failed" | "skipped";

export interface UpgradeRecord {
  state: UpgradeState;
  from: string;
  detail: string;
  attempts: number;
  at: string;
}

function ensureTable(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS kernl_upgrades (
    name TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    from_driver TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
  )`);
}

export function readUpgrade(db: SqliteDb, name = GRAPH_UPGRADE_STEP): UpgradeRecord | null {
  try {
    ensureTable(db);
    const r = db.prepare("SELECT state, from_driver, detail, attempts, at FROM kernl_upgrades WHERE name = ?").get(name) as
      | { state: UpgradeState; from_driver: string; detail: string; attempts: number; at: string }
      | undefined;
    return r ? { state: r.state, from: r.from_driver, detail: r.detail, attempts: r.attempts, at: r.at } : null;
  } catch {
    return null;
  }
}

function writeUpgrade(db: SqliteDb, rec: Omit<UpgradeRecord, "at">, name = GRAPH_UPGRADE_STEP): void {
  ensureTable(db);
  db.prepare(
    `INSERT INTO kernl_upgrades (name, state, from_driver, detail, attempts, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET state = excluded.state, from_driver = excluded.from_driver,
       detail = excluded.detail, attempts = excluded.attempts, at = excluded.at`,
  ).run(name, rec.state, rec.from, rec.detail.slice(0, 2000), rec.attempts, new Date().toISOString());
}

/**
 * Where the old Neo4j may be, most specific first: what was saved through
 * /extensions, the environment, then the address and password the 0.4.x
 * stacks shipped with (the compose's `neo4j` service, the native default port).
 */
export function neo4jCandidates(reg: GraphDriverRegistry): Neo4jSource[] {
  const out: Neo4jSource[] = [];
  const add = (uri: unknown, user: unknown, password: unknown) => {
    if (typeof uri !== "string" || !uri.trim() || typeof password !== "string" || !password) return;
    const s = { uri: uri.trim(), user: typeof user === "string" && user.trim() ? user.trim() : "neo4j", password };
    if (!out.some((o) => o.uri === s.uri && o.user === s.user && o.password === s.password)) out.push(s);
  };
  const saved = reg.loadConfig("neo4j");
  add(saved.uri, saved.user, saved.password);
  add(process.env.NEO4J_URI, process.env.NEO4J_USER, process.env.NEO4J_PASSWORD);
  const inDocker = existsSync("/.dockerenv") || process.env.KERNEL_IN_DOCKER === "1";
  const password = process.env.NEO4J_PASSWORD || "kernlgraph";
  if (inDocker) add("bolt://neo4j:7687", "neo4j", password);
  add("bolt://localhost:17687", "neo4j", password);
  add("bolt://localhost:7687", "neo4j", password);
  return out;
}

/** The first candidate that answers within a few seconds, or null. */
export async function findNeo4j(candidates: Neo4jSource[], timeoutMs = 4_000): Promise<Neo4jSource | null> {
  for (const c of candidates) {
    try {
      const d = await connectNeo4j(c, timeoutMs);
      await d.close().catch(() => {});
      return c;
    } catch { /* next */ }
  }
  return null;
}

/** Whether a Neo4j holds anything worth copying. */
export async function neo4jHasData(src: Neo4jSource): Promise<boolean> {
  try {
    const d = await connectNeo4j(src);
    try {
      const r = await d.executeQuery("MATCH (n) RETURN n LIMIT 1");
      return r.records.length > 0;
    } finally {
      await d.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

const isEmptyDir = (p: string) => !existsSync(p) || readdirSync(p).length === 0;

// ── Size ──────────────────────────────────────────────────────────────

const GIB = 1024 ** 3;
const UNITS: Record<string, number> = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: GIB, tb: 1e12, tib: 1024 ** 4 };

/** "2gib", "512mib", "3GB" → bytes; "none"/"0"/unparseable → null (no cap). */
export function parseSize(text: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1]) * (UNITS[(m[2] || "b").toLowerCase()] ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Bytes → the cap's spelling, rounded up to whole GiB: "4gib". */
export function formatGib(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / GIB))}gib`;
}

/** What this machine can give the graph: its cgroup memory limit when there is one (a container), else RAM; 80% of it. */
export function memoryCeilingBytes(): number {
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = Number(readFileSync(f, "utf8").trim());
      // cgroup v1 reports "no limit" as a huge number.
      if (Number.isFinite(v) && v > 0 && v < totalmem() * 4) return Math.floor(v * 0.8);
    } catch { /* not there */ }
  }
  return Math.floor(totalmem() * 0.8);
}

/**
 * How long the copy may run before it is killed. A fixed hour was too close:
 * the rehearsal against a production graph (0.95M nodes, 2.3M relationships)
 * took 53 minutes on an M-series Mac, about 1 ms per node or relationship, and
 * a server CPU can be slower. So 3 ms each, never under an hour; six hours when
 * the counts are unknown (the estimate failed), since the copy still has to finish.
 */
export function importTimeoutMs(elements: number): number {
  if (!elements) return 6 * 60 * 60_000;
  return Math.max(60 * 60_000, Math.ceil(elements * 3));
}

/**
 * The cap to copy under: 1.5× the estimate, whole GiB, at least what is
 * configured; null when even the estimate does not fit under the ceiling.
 */
export function chooseGraphLimit(estimateBytes: number, configuredBytes: number, ceilingBytes: number): number | null {
  if (estimateBytes > ceilingBytes) return null;
  const want = Math.max(configuredBytes, Math.ceil((estimateBytes * 1.5) / GIB) * GIB);
  return Math.min(want, Math.max(configuredBytes, Math.floor(ceilingBytes / GIB) * GIB || ceilingBytes));
}

const CAPACITY = /capacity exceeded|TransactionOutOfMemory/i;
const CAPACITY_TAG = /\[capacity needs=(\d+) ceiling=(\d+)\]/;

export interface UpgradeOptions {
  /** Copies Neo4j into `to` under the size cap `limit`; replaced in tests. Defaults to the child-process import. */
  importGraph?: (src: Neo4jSource, to: string, limit: string) => Promise<string>;
  /** Estimates the graph's size in Relate, in bytes; replaced in tests. */
  sizeOf?: (src: Neo4jSource) => Promise<number>;
  /** What this machine can give the graph, in bytes; replaced in tests. */
  memoryCeiling?: () => number;
  /** Finds a reachable Neo4j; replaced in tests. */
  locate?: (candidates: Neo4jSource[]) => Promise<Neo4jSource | null>;
  /** Whether a reachable Neo4j holds any node; replaced in tests. */
  hasData?: (src: Neo4jSource) => Promise<boolean>;
  relateAvailable?: () => boolean;
  storePath?: () => string;
  /**
   * Copy a reachable Neo4j after the kernel starts (default) rather than
   * before: the boot step only records the copy, runBackgroundCopy() does it.
   * False copies inline, before any driver starts.
   */
  background?: boolean;
  /** Merges the graph-only data written to Neo4j during the copy; replaced in tests. */
  mergeGraphOnly?: typeof mergeGraphOnlyFromNeo4j;
}

/**
 * Copy `src` into a fresh directory, then swap it in: a half-done copy
 * never becomes the store. On failure the install stays on `keep` (its
 * graph as it was) and the copy is tried again on the next boot.
 */
async function copyNeo4jIntoRelate(
  reg: GraphDriverRegistry, db: SqliteDb, opts: UpgradeOptions, prev: UpgradeRecord | null,
  src: Neo4jSource, from: string, keep: string,
  activate: () => Promise<void>, when: string,
): Promise<UpgradeRecord | null> {
  const storePath = (opts.storePath ?? defaultRelatePath)();
  const attempts = (prev?.attempts ?? 0) + 1;
  const staging = `${storePath}.importing`;
  rmSync(staging, { recursive: true, force: true });

  // Size the cap before copying. An explicit RELATE_LOGICAL_GRAPH_SIZE_LIMIT
  // (the operator's, not the one the Relate driver leaves in the
  // environment) is a ceiling the kernel must live under afterwards too.
  const explicit = parseSize(operatorGraphCap());
  const saved = reg.loadConfig("relate").memoryLimit;
  const configured = explicit ?? parseSize(typeof saved === "string" ? saved : null) ?? parseSize(DEFAULT_GRAPH_SIZE_LIMIT)!;
  const ceiling = explicit ?? (opts.memoryCeiling ?? memoryCeilingBytes)();
  let estimate = 0;
  let elements = 0;
  try {
    estimate = await (opts.sizeOf ?? (async (s) => {
      const e = await estimateRelateBytes(s);
      elements = e.nodes + e.relationships;
      return e.bytes;
    }))(src);
  } catch (err) {
    log.warn(`Graph upgrade: could not estimate the graph's size (${err instanceof Error ? err.message : String(err)}) — copying under ${formatGib(configured)}`);
  }
  let limit = estimate ? chooseGraphLimit(estimate, configured, ceiling) : configured;
  if (limit === null) {
    const detail = `[capacity needs=${estimate} ceiling=${ceiling}] The Neo4j graph needs about ${formatGib(estimate)} in Relate; ` +
      `this machine can give it ${formatGib(ceiling)}${explicit ? " (RELATE_LOGICAL_GRAPH_SIZE_LIMIT)" : ""}. Staying on ${keep}; ` +
      `the copy is tried again once there is more room${explicit ? " (raise RELATE_LOGICAL_GRAPH_SIZE_LIMIT)" : ""}.`;
    writeUpgrade(db, { state: "failed", from, attempts, detail });
    log.warn(`Graph upgrade: ${detail.replace(CAPACITY_TAG, "").trim()}`);
    return readUpgrade(db);
  }
  const runImport = (cap: number) => (opts.importGraph ?? ((s, to, l) =>
    runNeo4jImportChild(s, to, { onLine: (line) => log.info(`Graph upgrade: ${line}`), env: { RELATE_LOGICAL_GRAPH_SIZE_LIMIT: l }, timeoutMs: importTimeoutMs(elements) })))(src, staging, formatGib(cap));
  try {
    log.info(`Graph upgrade: copying the Neo4j graph at ${src.uri} into Relate (${storePath}) under a ${formatGib(limit)} cap` +
      `${estimate ? ` (estimated ${formatGib(estimate)})` : ""} — once, ${when}`);
    let summary: string;
    try {
      summary = await runImport(limit);
    } catch (err) {
      const bigger = Math.min(limit * 2, Math.floor(ceiling / GIB) * GIB || ceiling);
      if (!CAPACITY.test(err instanceof Error ? err.message : String(err)) || bigger <= limit) throw err;
      log.warn(`Graph upgrade: ${formatGib(limit)} was not enough — trying once more under ${formatGib(bigger)}`);
      rmSync(staging, { recursive: true, force: true });
      limit = bigger;
      summary = await runImport(limit);
    }
    if (!isEmptyDir(storePath)) {
      const aside = `${storePath}.before-0.5.0-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(storePath, aside);
      log.info(`Graph upgrade: an existing Relate store was kept aside at ${aside}`);
    } else {
      rmSync(storePath, { recursive: true, force: true });
    }
    renameSync(staging, storePath);
    // The kernel runs the graph under the cap it was copied under.
    if (!explicit && limit > configured) {
      reg.saveConfig("relate", { ...reg.loadConfig("relate"), memoryLimit: formatGib(limit) });
    }
    await activate();
    writeUpgrade(db, { state: "done", from, attempts, detail: `Copied from ${src.uri} under a ${formatGib(limit)} cap: ${summary}. Neo4j was left as it was.` });
    log.info(`Graph upgrade: Neo4j → Relate done (${summary}; cap ${formatGib(limit)})`);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    // Out of room even after the retry: like a graph that does not fit,
    // tried again only once the machine gives it more.
    const tag = CAPACITY.test(msg) ? `[capacity needs=${Math.max(estimate, limit + 1)} ceiling=${ceiling}] ` : "";
    writeUpgrade(db, { state: "failed", from, attempts, detail: `${tag}${msg}` });
    log.error(`Graph upgrade: copying Neo4j into Relate failed (attempt ${attempts}) — staying on ${keep}${tag ? "" : ", retrying next boot"}: ${msg}`);
  }
  return readUpgrade(db);
}

/** Decide and do the upgrade. Never throws: a kernel that cannot upgrade boots as it was. */
export async function upgradeGraphOnBoot(reg: GraphDriverRegistry, db: SqliteDb, opts: UpgradeOptions = {}): Promise<UpgradeRecord | null> {
  try {
    if ((process.env.KERNL_GRAPH_UPGRADE ?? "").toLowerCase() === "off") return null;
    const relateAvailable = (opts.relateAvailable ?? relateClientInstalled)();
    const active = reg.getActiveRowSlug();
    const prev = readUpgrade(db);
    if (active === "relate" || prev?.state === "done") return prev;
    if (!relateAvailable) {
      log.info("Graph upgrade: the Relate client is not installed here — staying on the current graph");
      return prev;
    }
    // A reachable Neo4j is copied after the kernel starts, on Neo4j meanwhile
    // (runBackgroundCopy); `background: false` copies it here, before any driver starts.
    const copy = (src: Neo4jSource, from: string, keep: string): Promise<UpgradeRecord | null> =>
      (opts.background ?? true)
        ? Promise.resolve(recordBackgroundCopy(reg, db, prev, src, from))
        : copyNeo4jIntoRelate(reg, db, opts, prev, src, from, keep, async () => reg.markActive("relate"), "before the kernel starts");

    // A graph too large for this machine is not copied again on every boot:
    // only once the room it had (its ceiling) grows.
    const blocked = prev?.state === "failed" ? CAPACITY_TAG.exec(prev.detail) : null;
    if (blocked) {
      const room = parseSize(operatorGraphCap()) ?? (opts.memoryCeiling ?? memoryCeilingBytes)();
      if (room <= Number(blocked[2])) {
        log.info(`Graph upgrade: waiting for more room — the graph needs about ${formatGib(Number(blocked[1]))}, this machine gives ${formatGib(room)} (staying on ${active ?? "the current graph"})`);
        return prev;
      }
    }

    // ── No graph driver → Relate ──
    // Older stacks ran with the noop driver while the legacy Neo4j client wrote
    // into a Neo4j all the same (chat memory, KNOWS). If one answers and holds
    // data, it is copied like any Neo4j install; if NEO4J_URI points at one
    // that does not answer, it is merged in later. Otherwise SQLite rebuilds it.
    if (!active || active === "noop") {
      const from = active ?? "none";
      const src = await (opts.locate ?? findNeo4j)(neo4jCandidates(reg));
      const holds = src ? await (opts.hasData ?? neo4jHasData)(src) : false;
      if (src && holds) return await copy(src, `${from}+neo4j`, /* keepOnFailure */ from);
      if (!src && (process.env.NEO4J_URI ?? "").trim() && process.env.KERNL_KEEP_NEO4J !== "1") {
        reg.markActive("relate");
        writeUpgrade(db, {
          state: "pending-import", from: `${from}+neo4j`, attempts: (prev?.attempts ?? 0) + 1,
          detail: `NEO4J_URI is set but Neo4j did not answer at upgrade time; Relate is active and rebuilt from SQLite. What lives only in Neo4j will be merged in when it answers.`,
        });
        log.warn("Graph upgrade: NEO4J_URI is set but Neo4j did not answer — Relate is active; Neo4j's own data will be merged in when it answers");
        return readUpgrade(db);
      }
      reg.markActive("relate");
      const rec = { state: "done" as const, from, detail: "Relate activated; rebuilt from SQLite by the backfills", attempts: (prev?.attempts ?? 0) + 1 };
      writeUpgrade(db, rec);
      log.info(`Graph upgrade: ${active ?? "no graph"} → Relate (the backfills rebuild it from SQLite)`);
      return readUpgrade(db);
    }

    if (active !== "neo4j") return prev; // a graph driver from an extension: the user chose it
    if (process.env.KERNL_KEEP_NEO4J === "1") {
      writeUpgrade(db, { state: "skipped", from: "neo4j", detail: "KERNL_KEEP_NEO4J=1", attempts: prev?.attempts ?? 0 });
      return readUpgrade(db);
    }

    // ── Neo4j → Relate ──
    const attempts = (prev?.attempts ?? 0) + 1;
    const src = await (opts.locate ?? findNeo4j)(neo4jCandidates(reg));
    if (!src) {
      // Not reachable: do not leave the kernel without a graph. The backfills
      // rebuild what SQLite holds; the rest is merged in when Neo4j answers.
      reg.markActive("relate");
      writeUpgrade(db, {
        state: "pending-import", from: "neo4j", attempts,
        detail: "Neo4j did not answer at upgrade time; Relate is active and rebuilt from SQLite. Chat memory, KNOWS links and the news archive will be merged in from Neo4j when it answers.",
      });
      log.warn("Graph upgrade: Neo4j did not answer — Relate is active now; what lives only in Neo4j will be merged in when it answers");
      return readUpgrade(db);
    }

    return await copy(src, "neo4j", "neo4j");
  } catch (err) {
    log.error(`Graph upgrade: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Note a copy to run once the kernel is up, and keep the kernel on Neo4j
 * until it is done. An install that was on no graph driver while its legacy
 * client wrote into this Neo4j is served from that Neo4j meanwhile.
 */
function recordBackgroundCopy(reg: GraphDriverRegistry, db: SqliteDb, prev: UpgradeRecord | null, src: Neo4jSource, from: string): UpgradeRecord | null {
  if (reg.getActiveRowSlug() !== "neo4j") {
    reg.saveConfig("neo4j", { ...reg.loadConfig("neo4j"), uri: src.uri, user: src.user, password: src.password });
    reg.markActive("neo4j");
  }
  writeUpgrade(db, {
    state: "copying", from, attempts: prev?.attempts ?? 0,
    detail: `Copying ${src.uri} into Relate while the kernel runs on Neo4j; it switches to Relate when the copy is done.`,
  });
  log.info(`Graph upgrade: starting on Neo4j; its graph is copied into Relate in the background, then the kernel switches over`);
  return readUpgrade(db);
}

let copyRunning = false;

/**
 * The copy the boot step recorded: Neo4j into a new Relate store while the
 * kernel keeps serving from Neo4j, then a live switch to Relate. What reached
 * Neo4j during the copy is caught up afterwards: the graph-only data (chat
 * memory, KNOWS, news) merged from Neo4j, and what the modules project from
 * SQLite projected again by the backfills. A no-op unless a copy is recorded.
 */
export async function runBackgroundCopy(reg: GraphDriverRegistry, db: SqliteDb, opts: UpgradeOptions = {}): Promise<UpgradeRecord | null> {
  const prev = readUpgrade(db);
  if (prev?.state !== "copying" || copyRunning) return prev;
  copyRunning = true;
  try {
    const src = await (opts.locate ?? findNeo4j)(neo4jCandidates(reg));
    if (!src) {
      log.warn("Graph upgrade: Neo4j stopped answering before the copy — staying on it; tried again on the next boot");
      return prev;
    }
    const rec = await copyNeo4jIntoRelate(reg, db, opts, prev, src, prev.from, "neo4j", async () => {
      if (!(await reg.setActive("relate"))) {
        // setActive puts the previous driver back when it was running; the row is restored either way.
        reg.markActive("neo4j");
        throw new Error("Relate did not start on the copied store — back on Neo4j");
      }
    }, "while the kernel keeps running on Neo4j");
    if (rec?.state === "done") await catchUpAfterSwitch(reg, src, opts);
    return rec;
  } catch (err) {
    log.error(`Graph upgrade: ${err instanceof Error ? err.message : String(err)}`);
    return readUpgrade(db);
  } finally {
    copyRunning = false;
  }
}

async function catchUpAfterSwitch(reg: GraphDriverRegistry, src: Neo4jSource, opts: UpgradeOptions): Promise<void> {
  const g = reg.getActive();
  if (!g?.capabilities.cypher) return;
  try {
    const r = await (opts.mergeGraphOnly ?? mergeGraphOnlyFromNeo4j)(src, (q, p) => g.run(q, p), (m) => log.info(`Graph upgrade: ${m}`));
    log.info(`Graph upgrade: caught up with what reached Neo4j during the copy (${r.nodes} nodes, ${r.relationships} relationships)`);
  } catch (err) {
    log.warn(`Graph upgrade: catching up from Neo4j after the switch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // The copy carried the markers of what was projected into Neo4j — the
    // backfills' and the experience graph's watermark — while the kernel kept
    // projecting there during the copy. Dropped, everything projected from
    // SQLite is projected again into this store.
    await g.run("MATCH (m) WHERE m:KernlGraphBackfill OR m:AgentXpSync DETACH DELETE m");
    graphReplaced();
  } catch (err) {
    log.warn(`Graph upgrade: could not queue the backfills after the switch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Start the recorded copy shortly after boot; returns a stop function. */
export function scheduleBackgroundCopy(reg: GraphDriverRegistry, db: SqliteDb, delayMs = 30_000): () => void {
  if (readUpgrade(db)?.state !== "copying") return () => {};
  const t = setTimeout(() => void runBackgroundCopy(reg, db), delayMs);
  t.unref?.();
  return () => clearTimeout(t);
}

/**
 * For an install whose Neo4j was down when it upgraded: merge what lives only
 * in the graph into the live Relate store once Neo4j answers. Called after
 * boot and on a timer; a no-op unless the upgrade is pending.
 */
export async function completePendingImport(
  reg: GraphDriverRegistry,
  db: SqliteDb,
  opts: { locate?: (c: Neo4jSource[]) => Promise<Neo4jSource | null> } = {},
): Promise<boolean> {
  const rec = readUpgrade(db);
  if (rec?.state !== "pending-import") return false;
  const g = reg.getActive();
  if (!g?.capabilities.cypher || reg.getActiveSlug() !== "relate") return false;
  const src = await (opts.locate ?? findNeo4j)(neo4jCandidates(reg));
  if (!src) return false;
  try {
    const r = await mergeGraphOnlyFromNeo4j(src, (q, p) => g.run(q, p), (m) => log.info(`Graph upgrade: ${m}`));
    writeUpgrade(db, {
      state: "done", from: "neo4j", attempts: rec.attempts + 1,
      detail: `Rebuilt from SQLite; merged ${r.nodes} graph-only nodes and ${r.relationships} relationships from ${src.uri}. Neo4j was left as it was.`,
    });
    log.info(`Graph upgrade: merged what lived only in Neo4j (${r.nodes} nodes, ${r.relationships} relationships)`);
    return true;
  } catch (err) {
    log.warn(`Graph upgrade: merging from Neo4j failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Retry a pending import after boot and every 30 minutes; returns a stop function. */
export function schedulePendingImport(reg: GraphDriverRegistry, db: SqliteDb): () => void {
  if (readUpgrade(db)?.state !== "pending-import") return () => {};
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (await completePendingImport(reg, db).catch(() => false)) stop();
  };
  const first = setTimeout(() => void tick(), 60_000);
  const every = setInterval(() => void tick(), 30 * 60_000);
  first.unref?.();
  every.unref?.();
  const stop = () => { stopped = true; clearTimeout(first); clearInterval(every); };
  return stop;
}
