import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { storageMigrations } from "../src/modules/storage/migrations.js";
import { StorageService } from "../src/modules/storage/service.js";
import { corePolicies } from "../src/modules/storage/core-policies.js";
import { agePolicy, retentionCap } from "../src/sdk/retention.js";
import type { KernelModule, RetentionPolicy } from "../src/core/types.js";

const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

function fakeModule(name: string, policies: () => RetentionPolicy[]): KernelModule {
  return {
    name,
    initialize: async () => {},
    getTools: () => [],
    getRetentionPolicies: policies,
    shutdown: async () => {},
  };
}

const logPolicy = (overrides: Partial<Parameters<typeof agePolicy>[0]> = {}) =>
  agePolicy({
    id: "ext.log",
    label: "Log",
    description: "test log",
    kind: "operational",
    table: "ext_log",
    dateColumn: "created_at",
    defaultDays: 10,
    defaultEnabled: true,
    ...overrides,
  });

describe("StorageService", () => {
  let db: InstanceType<typeof Database>;
  let modules: KernelModule[];
  let svc: StorageService;

  const seedLog = (n: number, ageDays: number) => {
    const ins = db.prepare("INSERT INTO ext_log (msg, created_at) VALUES (?, ?)");
    db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run(`row ${i} ${"x".repeat(50)}`, ago(ageDays));
    })();
  };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "storage", storageMigrations);
    db.run("CREATE TABLE ext_log (id INTEGER PRIMARY KEY, msg TEXT NOT NULL, created_at TEXT NOT NULL)");
    modules = [fakeModule("ext:test", () => [logPolicy()])];
    svc = new StorageService(db, ":memory:", () => modules, { batchSize: 100 });
  });

  afterEach(() => db.close());

  it("lists policies with defaults until the user changes them", () => {
    const [p] = svc.listPolicies();
    expect(p).toMatchObject({ id: "ext.log", owner: "ext:test", enabled: true, days: 10, customized: false });

    svc.setPolicy("ext.log", { days: 30, enabled: false });
    expect(svc.listPolicies()[0]).toMatchObject({ enabled: false, days: 30, customized: true });

    svc.resetPolicy("ext.log");
    expect(svc.listPolicies()[0]).toMatchObject({ enabled: true, days: 10, customized: false });
  });

  it("rejects unknown policies and bad retention", () => {
    expect(() => svc.setPolicy("nope", { days: 5 })).toThrow(/Unknown/);
    expect(() => svc.setPolicy("ext.log", { days: 0 })).toThrow(/positive/);
    expect(() => svc.setPolicy("ext.log", { days: 2.5 })).toThrow(/positive/);
  });

  it("deletes in batches until nothing is left and records the run", async () => {
    seedLog(350, 20);
    seedLog(40, 1);
    const summary = await svc.run("manual");
    expect(summary.deletedRows).toBe(350);
    expect((db.prepare("SELECT COUNT(*) n FROM ext_log").get() as { n: number }).n).toBe(40);
    const runs = svc.recentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "manual", deletedRows: 350, vacuumed: false });
  });

  it("skips disabled policies unless asked for that one", async () => {
    seedLog(10, 20);
    svc.setPolicy("ext.log", { enabled: false });
    expect((await svc.run("manual")).deletedRows).toBe(0);
    expect((await svc.run("manual", { only: "ext.log" })).deletedRows).toBe(10);
  });

  it("keeps going when one policy throws, and reports it", async () => {
    seedLog(5, 20);
    const broken: RetentionPolicy = { ...logPolicy({ id: "ext.broken" }), purge: () => { throw new Error("boom"); } };
    modules = [fakeModule("ext:test", () => [broken, logPolicy()])];
    const summary = await svc.run("manual");
    expect(summary.deletedRows).toBe(5);
    expect(summary.details.find((d) => d.id === "ext.broken")?.error).toBe("boom");
  });

  it("refuses a second run while one is in progress", async () => {
    seedLog(500, 20);
    const first = svc.run("manual");
    await expect(svc.run("manual")).rejects.toThrow(/already running/);
    await first;
  });

  it("measures tables and sizes what each policy would free", async () => {
    seedLog(300, 20);
    seedLog(100, 1);
    const snap = await svc.measure();
    expect(snap.exact).toBe(false);
    const t = snap.tables.find((x) => x.name === "ext_log")!;
    expect(t.rows).toBe(400);
    expect(t.bytes).toBeGreaterThan(400 * 50);
    // Calibrated: the tables add up to the pages in use.
    const used = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count * 4096
      - (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count * 4096;
    expect(Math.abs(snap.tables.reduce((s, x) => s + x.bytes, 0) - used)).toBeLessThan(snap.tables.length + 1);
    const p = snap.policies.find((x) => x.id === "ext.log")!;
    expect(p.eligibleRows).toBe(300);
    expect(p.eligibleBytes).toBe(Math.round((300 * p.bytes) / 400));

    // The page reads the snapshot; changing the retention re-estimates it.
    svc.setPolicy("ext.log", { days: 30 });
    expect(svc.listPolicies()[0].eligibleRows).toBe(0);

    const ov = svc.overview();
    expect(ov.byKind.operational).toBe(t.bytes);
    expect(ov.byKind.unclassified).toBeGreaterThan(0); // storage's own tables
  });

  it("drops policies of a module that went away, keeping its settings", () => {
    svc.setPolicy("ext.log", { days: 30 });
    modules = [];
    expect(svc.listPolicies()).toEqual([]);
    modules = [fakeModule("ext:test", () => [logPolicy()])];
    expect(svc.listPolicies()[0].days).toBe(30);
  });
});

describe("catalog capacity", () => {
  let db: InstanceType<typeof Database>;
  let svc: StorageService;
  const catalog = () => ({
    ...logPolicy({ id: "ext.catalog", kind: "reference", defaultEnabled: false }),
    capacity: {
      unit: "titles",
      count: (d: InstanceType<typeof Database>) => (d.prepare("SELECT COUNT(*) n FROM ext_log").get() as { n: number }).n,
      defaultCap: null,
      capOptions: [100, 1000],
    },
  });

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "storage", storageMigrations);
    db.run("CREATE TABLE ext_log (id INTEGER PRIMARY KEY, msg TEXT NOT NULL, created_at TEXT NOT NULL)");
    const ins = db.prepare("INSERT INTO ext_log (msg, created_at) VALUES ('x', ?)");
    for (let i = 0; i < 120; i++) ins.run(ago(1));
    svc = new StorageService(db, ":memory:", () => [fakeModule("ext:media", () => [catalog()])]);
  });

  afterEach(() => db.close());

  it("shows count, ceiling and whether the collector is parked", () => {
    expect(svc.listPolicies()[0].capacity).toMatchObject({ unit: "titles", count: 120, cap: null, status: "collecting" });
    svc.setPolicy("ext.catalog", { cap: 100 });
    expect(svc.listPolicies()[0].capacity).toMatchObject({ cap: 100, status: "capped" });
    svc.setPolicy("ext.catalog", { cap: null });
    expect(svc.listPolicies()[0].capacity).toMatchObject({ cap: null, status: "collecting" });
  });

  it("keeps the ceiling when other settings change, and lets the collector read it", () => {
    expect(retentionCap(db, "ext.catalog", 7)).toBe(7); // untouched → fallback
    svc.setPolicy("ext.catalog", { cap: 1000 });
    svc.setPolicy("ext.catalog", { days: 30, enabled: true });
    expect(svc.listPolicies()[0].capacity?.cap).toBe(1000);
    expect(retentionCap(db, "ext.catalog", 7)).toBe(1000);
    svc.setPolicy("ext.catalog", { cap: null });
    expect(retentionCap(db, "ext.catalog", 7)).toBe(0); // explicit "no limit" beats the fallback
  });

  it("rejects a ceiling on a policy without capacity, and bad values", () => {
    const plain = new StorageService(db, ":memory:", () => [fakeModule("ext:test", () => [logPolicy()])]);
    expect(() => plain.setPolicy("ext.log", { cap: 10 })).toThrow(/no capacity/);
    expect(() => svc.setPolicy("ext.catalog", { cap: -5 })).toThrow(/positive/);
  });

  it("reads a missing settings table as the fallback", () => {
    const bare = new Database(":memory:");
    expect(retentionCap(bare, "ext.catalog", 3)).toBe(3);
    bare.close();
  });
});

describe("core policies", () => {
  let db: InstanceType<typeof Database>;
  let svc: StorageService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "storage", storageMigrations);
    svc = new StorageService(db, ":memory:", () => [fakeModule("storage", corePolicies)]);
  });

  afterEach(() => db.close());

  it("keeps the active prompt version and the five newest of each agent", async () => {
    db.prepare(
      `INSERT INTO agents (id, name, created_at, updated_at) VALUES ('a1', 'A', ?, ?)`,
    ).run(ago(0), ago(0));
    const ins = db.prepare(
      `INSERT INTO agent_prompt_versions (id, agent_id, version, active, created_at) VALUES (?, 'a1', ?, ?, ?)`,
    );
    // v1 active (old), v2..v10 inactive and old.
    for (let v = 1; v <= 10; v++) ins.run(`v${v}`, v, v === 1 ? 1 : 0, ago(100));

    await svc.run("manual", { only: "agents.prompt-versions" });
    const left = (db.prepare("SELECT version FROM agent_prompt_versions ORDER BY version").all() as Array<{ version: number }>)
      .map((r) => r.version);
    expect(left).toEqual([1, 6, 7, 8, 9, 10]);
  });

  it("ships personal data off by default and operational data on", () => {
    const byId = new Map(svc.listPolicies().map((p) => [p.id, p]));
    expect(byId.get("agents.llm-runs")?.enabled).toBe(false);
    expect(byId.get("agents.scheduled-runs")?.enabled).toBe(true);
    for (const p of byId.values()) {
      if (p.kind === "personal" || p.kind === "reference") expect(p.enabled).toBe(false);
    }
  });
});

describe("files and compaction", () => {
  let dir: string;
  let dbPath: string;
  let db: InstanceType<typeof Database>;
  let svc: StorageService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kernl-storage-"));
    dbPath = join(dir, "kernel.db");
    db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");
    runMigrations(db, "storage", storageMigrations);
    svc = new StorageService(db, dbPath, () => []);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists stray database files but never the live one", () => {
    writeFileSync(join(dir, "kernel.pre-offices-20261004.db"), "x".repeat(1000));
    writeFileSync(join(dir, "notes.txt"), "not a db");
    const names = svc.strayFiles().map((f) => f.name);
    expect(names).toEqual(["kernel.pre-offices-20261004.db"]);
  });

  it("deletes only a listed stray file", () => {
    writeFileSync(join(dir, "old.db"), "x");
    expect(() => svc.deleteStrayFile("kernel.db")).toThrow(/Not a stray/);
    expect(() => svc.deleteStrayFile("../old.db")).toThrow(/Not a stray/);
    expect(svc.deleteStrayFile("old.db")).toEqual({ deleted: "old.db", bytes: 1 });
    expect(existsSync(join(dir, "old.db"))).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("compacts the file in a child process", async () => {
    db.run("CREATE TABLE blob_t (b BLOB)");
    const ins = db.prepare("INSERT INTO blob_t VALUES (?)");
    db.transaction(() => { for (let i = 0; i < 400; i++) ins.run(new Uint8Array(8192)); })();
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.run("DELETE FROM blob_t");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = statSync(dbPath).size;
    expect(svc.compactCheck().reclaimableBytes).toBeGreaterThan(1_000_000);

    const res = await svc.compact();
    expect(res.beforeBytes).toBe(before);
    expect(res.afterBytes).toBeLessThan(before / 4);
    expect(svc.compactCheck().reclaimableBytes).toBe(0);
  });
});
