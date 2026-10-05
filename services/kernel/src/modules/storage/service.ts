/**
 * StorageService — applies retention policies, measures the database and
 * compacts it.
 *
 * Policies are collected from the live module list on every call, so an
 * extension that gets enabled shows up (and one that gets disabled drops out)
 * without a restart. Settings for a policy that disappears are kept.
 */

import { unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { KernelModule, RetentionKind, RetentionPolicy, RetentionRunContext } from "../../core/types.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import {
  calibrate,
  diskFree,
  expandPolicyTables,
  fileSize,
  listStrayFiles,
  measureTables,
  type StrayFile,
  type TableSize,
} from "./sizing.js";

const DAY_MS = 86_400_000;
const DEFAULT_DAY_OPTIONS = [7, 14, 30, 60, 90, 180, 365];
const BATCH_SIZE = 5_000;
/** Safety stop: a policy that keeps returning full batches is cut after this many. */
const MAX_BATCHES = 2_000;
/** Pause between batches so the kernel's other writers get the lock. */
const BATCH_PAUSE_MS = 20;

/** Compact automatically when the free pages reach this much, … */
const AUTO_VACUUM_MIN_BYTES = 500 * 1024 * 1024;
/** … or this share of the file. */
const AUTO_VACUUM_MIN_RATIO = 0.2;

export interface PolicyView {
  id: string;
  owner: string;
  label: string;
  description: string;
  kind: RetentionKind;
  tables: string[];
  enabled: boolean;
  days: number | null;
  defaultDays: number | null;
  defaultEnabled: boolean;
  dayOptions: number[];
  customized: boolean;
  /** From the last measurement (null before the first one). */
  rows: number | null;
  bytes: number | null;
  eligibleRows: number | null;
  eligibleBytes: number | null;
  /** Present for policies whose data a collector keeps adding (catalogs). */
  capacity: CapacityView | null;
}

export interface CapacityView {
  unit: string;
  count: number;
  /** Effective ceiling; null = no limit. */
  cap: number | null;
  defaultCap: number | null;
  capOptions: number[];
  /** "capped" once count reached cap — the collector is parked. */
  status: "collecting" | "capped";
  /** Bytes one unit costs on disk, from the last measurement (0 before one). */
  bytesPerUnit: number;
}

type Setting = { enabled: boolean; days: number | null; cap: number | null };

export interface PolicyRunDetail {
  id: string;
  label: string;
  deleted: number;
  freedBytesEst: number;
  error?: string;
}

export interface RunProgress {
  trigger: "cron" | "manual";
  phase: "purge" | "vacuum";
  policy: string | null;
  /** Id of the policy being purged, so the page can highlight its row. */
  policyId: string | null;
  /** Rows deleted by the current policy so far. */
  policyDeleted: number;
  deleted: number;
  startedAt: string;
}

interface PolicySnapshot {
  id: string;
  rows: number;
  bytes: number;
  eligibleRows: number;
  eligibleBytes: number;
}

interface Owned {
  owner: string;
  policy: RetentionPolicy;
}

export class StorageService {
  private progress: RunProgress | null = null;

  constructor(
    private db: SqliteDb,
    private dbPath: string,
    private listModules: () => KernelModule[],
    private opts: { batchSize?: number } = {},
  ) {}

  // ── Policies ──────────────────────────────────────────

  private collect(): Owned[] {
    const out: Owned[] = [];
    const seen = new Set<string>();
    for (const mod of this.listModules()) {
      if (typeof mod.getRetentionPolicies !== "function") continue;
      try {
        for (const policy of mod.getRetentionPolicies() ?? []) {
          if (!policy || seen.has(policy.id)) continue;
          seen.add(policy.id);
          out.push({ owner: mod.name, policy });
        }
      } catch (err) {
        log.warn(`storage: ${mod.name}.getRetentionPolicies() threw — skipped`, err);
      }
    }
    return out;
  }

  private settings(): Map<string, Setting> {
    const rows = this.db
      .prepare("SELECT policy_id, enabled, days, cap FROM retention_settings")
      .all() as Array<{ policy_id: string; enabled: number; days: number | null; cap: number | null }>;
    return new Map(rows.map((r) => [r.policy_id, { enabled: r.enabled === 1, days: r.days, cap: r.cap }]));
  }

  private effective(p: RetentionPolicy, s?: Setting) {
    // cap: a stored 0 is "no limit" chosen by the user; NULL falls back to the default.
    const storedCap = s?.cap ?? null;
    const cap = storedCap === null ? (p.capacity?.defaultCap ?? null) : storedCap > 0 ? storedCap : null;
    return {
      enabled: s ? s.enabled : p.defaultEnabled,
      days: s && s.days !== null ? s.days : p.defaultDays,
      cap,
    };
  }

  private capacityView(p: RetentionPolicy, cap: number | null, m?: PolicySnapshot): CapacityView | null {
    if (!p.capacity) return null;
    let count = 0;
    try {
      count = p.capacity.count(this.db);
    } catch {
      /* table not created yet */
    }
    return {
      unit: p.capacity.unit,
      count,
      cap,
      defaultCap: p.capacity.defaultCap,
      capOptions: p.capacity.capOptions,
      status: cap !== null && count >= cap ? "capped" : "collecting",
      bytesPerUnit: m && m.rows > 0 ? m.bytes / m.rows : 0,
    };
  }

  private runContext(days: number | null): RetentionRunContext {
    return {
      db: this.db,
      days,
      cutoff: days === null ? null : new Date(Date.now() - days * DAY_MS).toISOString(),
      batchSize: this.opts.batchSize ?? BATCH_SIZE,
    };
  }

  listPolicies(): PolicyView[] {
    const settings = this.settings();
    const snap = this.latestSnapshot();
    const byId = new Map<string, PolicySnapshot>((snap?.policies ?? []).map((p) => [p.id, p]));
    return this.collect().map(({ owner, policy }) => {
      const s = settings.get(policy.id);
      const eff = this.effective(policy, s);
      const m = byId.get(policy.id);
      return {
        id: policy.id,
        owner,
        label: policy.label,
        description: policy.description,
        kind: policy.kind,
        tables: policy.tables,
        enabled: eff.enabled,
        days: eff.days,
        defaultDays: policy.defaultDays,
        defaultEnabled: policy.defaultEnabled,
        dayOptions: policy.dayOptions ?? DEFAULT_DAY_OPTIONS,
        customized: !!s,
        rows: m?.rows ?? null,
        bytes: m?.bytes ?? null,
        eligibleRows: m?.eligibleRows ?? null,
        eligibleBytes: m?.eligibleBytes ?? null,
        capacity: this.capacityView(policy, eff.cap, m),
      };
    });
  }

  setPolicy(id: string, patch: { enabled?: boolean; days?: number | null; cap?: number | null }): PolicyView {
    const found = this.collect().find((o) => o.policy.id === id);
    if (!found) throw new Error(`Unknown retention policy: ${id}`);
    const stored = this.settings().get(id);
    const current = this.effective(found.policy, stored);
    // Stored form: 0 = no limit, positive = ceiling, NULL = policy default.
    let cap: number | null = stored?.cap ?? null;
    if (patch.cap !== undefined) {
      if (!found.policy.capacity) throw new Error(`${id} has no capacity to limit`);
      if (patch.cap === null || patch.cap === 0) cap = 0;
      else if (!Number.isInteger(patch.cap) || patch.cap < 1) throw new Error("cap must be a positive integer or null");
      else cap = patch.cap;
    }
    const enabled = patch.enabled ?? current.enabled;
    let days = patch.days === undefined ? current.days : patch.days;
    if (found.policy.defaultDays === null) days = null;
    else if (days === null || !Number.isInteger(days) || days < 1) {
      throw new Error("days must be a positive integer");
    }
    this.db
      .prepare(
        `INSERT INTO retention_settings (policy_id, enabled, days, cap, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(policy_id) DO UPDATE SET enabled = excluded.enabled, days = excluded.days,
           cap = excluded.cap, updated_at = excluded.updated_at`,
      )
      .run(id, enabled ? 1 : 0, days, cap, isoNow());
    this.refreshPolicyEstimate(id);
    return this.listPolicies().find((p) => p.id === id)!;
  }

  resetPolicy(id: string): PolicyView | undefined {
    this.db.prepare("DELETE FROM retention_settings WHERE policy_id = ?").run(id);
    this.refreshPolicyEstimate(id);
    return this.listPolicies().find((p) => p.id === id);
  }

  /** What a policy would delete now, optionally with a different retention. */
  preview(id: string, days?: number): { rows: number; bytes: number } {
    const found = this.collect().find((o) => o.policy.id === id);
    if (!found) throw new Error(`Unknown retention policy: ${id}`);
    const eff = this.effective(found.policy, this.settings().get(id));
    const rows = found.policy.estimate(this.runContext(days ?? eff.days));
    return { rows, bytes: Math.round(rows * this.avgRowBytes(id)) };
  }

  // ── Measurement ───────────────────────────────────────

  /** Bytes per eligible row, from the last measurement of the policy's tables. */
  private avgRowBytes(policyId: string): number {
    const p = this.latestSnapshot()?.policies.find((x) => x.id === policyId);
    return p && p.rows > 0 ? p.bytes / p.rows : 0;
  }

  async measure(): Promise<StorageSnapshot> {
    const started = Date.now();
    const measured = await measureTables(this.db);
    const exact = measured.exact;
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const freelist = (this.db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    // page_count, not the file size: it includes pages still in the WAL.
    const tables = exact ? measured.tables : calibrate(measured.tables, (pageCount - freelist) * pageSize);
    const all = tables.map((t) => t.name);
    const byName = new Map(tables.map((t) => [t.name, t]));
    const settings = this.settings();

    const policies: PolicySnapshot[] = [];
    for (const { policy } of this.collect()) {
      const own = expandPolicyTables(policy.tables, all).map((n) => byName.get(n)!).filter(Boolean);
      const bytes = own.reduce((s, t) => s + t.bytes, 0);
      // Rows of the first table — the one the policy deletes from.
      const rows = byName.get(policy.tables[0])?.rows ?? 0;
      const eff = this.effective(policy, settings.get(policy.id));
      let eligibleRows = 0;
      try {
        eligibleRows = policy.estimate(this.runContext(eff.days));
      } catch (err) {
        log.warn(`storage: estimate for ${policy.id} failed`, err);
      }
      policies.push({
        id: policy.id,
        rows,
        bytes,
        eligibleRows,
        eligibleBytes: rows > 0 ? Math.round((eligibleRows * bytes) / rows) : 0,
      });
    }

    const snap: StorageSnapshot = {
      day: isoNow().slice(0, 10),
      measuredAt: isoNow(),
      dbBytes: fileSize(this.dbPath),
      walBytes: fileSize(`${this.dbPath}-wal`),
      freelistBytes: freelist * pageSize,
      diskFreeBytes: diskFree(dirname(this.dbPath)),
      exact,
      tables: tables.sort((a, b) => b.bytes - a.bytes),
      policies,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO storage_snapshots
           (day, measured_at, db_bytes, wal_bytes, freelist_bytes, disk_free_bytes, exact, tables_json, policies_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snap.day, snap.measuredAt, snap.dbBytes, snap.walBytes, snap.freelistBytes, snap.diskFreeBytes,
        exact ? 1 : 0, JSON.stringify(snap.tables), JSON.stringify(snap.policies),
      );
    log.info(`storage: measured ${tables.length} tables in ${Date.now() - started}ms (${exact ? "exact" : "estimated"})`);
    return snap;
  }

  /** Re-estimate one policy inside the latest snapshot after its settings change. */
  private refreshPolicyEstimate(id: string): void {
    const snap = this.latestSnapshot();
    const found = this.collect().find((o) => o.policy.id === id);
    if (!snap || !found) return;
    const entry = snap.policies.find((p) => p.id === id);
    if (!entry) return;
    const eff = this.effective(found.policy, this.settings().get(id));
    try {
      entry.eligibleRows = found.policy.estimate(this.runContext(eff.days));
      entry.eligibleBytes = entry.rows > 0 ? Math.round((entry.eligibleRows * entry.bytes) / entry.rows) : 0;
      this.db
        .prepare("UPDATE storage_snapshots SET policies_json = ? WHERE day = ?")
        .run(JSON.stringify(snap.policies), snap.day);
    } catch (err) {
      log.warn(`storage: re-estimate for ${id} failed`, err);
    }
  }

  latestSnapshot(): StorageSnapshot | null {
    const row = this.db
      .prepare("SELECT * FROM storage_snapshots ORDER BY day DESC LIMIT 1")
      .get() as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  history(days = 30): Array<{ day: string; dbBytes: number }> {
    const rows = this.db
      .prepare("SELECT day, db_bytes FROM storage_snapshots ORDER BY day DESC LIMIT ?")
      .all(days) as Array<{ day: string; db_bytes: number }>;
    return rows.reverse().map((r) => ({ day: r.day, dbBytes: r.db_bytes }));
  }

  // ── Cleanup ───────────────────────────────────────────

  getProgress(): RunProgress | null {
    return this.progress;
  }

  /**
   * Apply every enabled policy (or just `only`, enabled or not), then
   * checkpoint the WAL. A cron run compacts afterwards when enough space came
   * free and the disk can take it.
   */
  async run(trigger: "cron" | "manual", opts: { only?: string } = {}): Promise<RetentionRunSummary> {
    if (this.progress) throw new Error("A cleanup or compaction is already running");
    const startedAt = isoNow();
    this.progress = { trigger, phase: "purge", policy: null, policyId: null, policyDeleted: 0, deleted: 0, startedAt };
    const id = newId();
    const dbBefore = fileSize(this.dbPath);
    const details: PolicyRunDetail[] = [];
    let vacuumed = false;
    let error = "";

    try {
      const settings = this.settings();
      const targets = this.collect().filter(({ policy }) =>
        opts.only ? policy.id === opts.only : this.effective(policy, settings.get(policy.id)).enabled,
      );
      if (opts.only && targets.length === 0) throw new Error(`Unknown retention policy: ${opts.only}`);

      for (const { policy } of targets) {
        const eff = this.effective(policy, settings.get(policy.id));
        const rc = this.runContext(eff.days);
        const perRow = this.avgRowBytes(policy.id);
        this.progress.policy = policy.label;
        this.progress.policyId = policy.id;
        this.progress.policyDeleted = 0;
        let deleted = 0;
        try {
          for (let i = 0; i < MAX_BATCHES; i++) {
            const n = this.db.transaction(() => policy.purge(rc))();
            deleted += n;
            this.progress.deleted += n;
            this.progress.policyDeleted = deleted;
            if (n < rc.batchSize) break;
            await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
          }
          policy.afterPurge?.(rc, deleted);
          details.push({ id: policy.id, label: policy.label, deleted, freedBytesEst: Math.round(deleted * perRow) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`storage: policy ${policy.id} failed after ${deleted} rows: ${msg}`);
          details.push({ id: policy.id, label: policy.label, deleted, freedBytesEst: Math.round(deleted * perRow), error: msg });
        }
      }

      try {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (err) {
        log.warn("storage: WAL checkpoint failed", err);
      }

      if (trigger === "cron") {
        const check = this.compactCheck();
        if (check.recommended && check.ok) {
          this.progress.phase = "vacuum";
          this.progress.policy = null;
          this.progress.policyId = null;
          await this.vacuumNow();
          vacuumed = true;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.progress = null;
    }

    const summary: RetentionRunSummary = {
      id,
      trigger,
      startedAt,
      finishedAt: isoNow(),
      deletedRows: details.reduce((s, d) => s + d.deleted, 0),
      freedBytesEst: details.reduce((s, d) => s + d.freedBytesEst, 0),
      dbBytesBefore: dbBefore,
      dbBytesAfter: fileSize(this.dbPath),
      vacuumed,
      details,
      error,
    };
    this.db
      .prepare(
        `INSERT INTO retention_runs (id, trigger, started_at, finished_at, deleted_rows, freed_bytes_est,
           db_bytes_before, db_bytes_after, vacuumed, details_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summary.id, trigger, startedAt, summary.finishedAt, summary.deletedRows, summary.freedBytesEst,
        dbBefore, summary.dbBytesAfter, vacuumed ? 1 : 0, JSON.stringify(details), error,
      );
    if (error) throw new Error(error);
    return summary;
  }

  recentRuns(limit = 10): RetentionRunSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM retention_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as RunRow[];
    return rows.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? "",
      deletedRows: r.deleted_rows,
      freedBytesEst: r.freed_bytes_est,
      dbBytesBefore: r.db_bytes_before,
      dbBytesAfter: r.db_bytes_after,
      vacuumed: r.vacuumed === 1,
      details: safeParse<PolicyRunDetail[]>(r.details_json, []),
      error: r.error,
    }));
  }

  // ── Compaction ────────────────────────────────────────

  /**
   * Whether VACUUM is worth it and whether the disk can take it. In WAL mode
   * VACUUM writes a temp copy and then the whole result through the WAL, so
   * it needs room for roughly twice the compacted size.
   */
  compactCheck(): { recommended: boolean; ok: boolean; reclaimableBytes: number; neededBytes: number; diskFreeBytes: number; reason: CompactReason } {
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const freelist = (this.db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    const dbBytes = fileSize(this.dbPath);
    const reclaimable = freelist * pageSize;
    const compacted = Math.max(dbBytes - reclaimable, 0);
    const needed = compacted * 2 + 256 * 1024 * 1024;
    const free = diskFree(dirname(this.dbPath));
    const recommended = reclaimable >= AUTO_VACUUM_MIN_BYTES || (dbBytes > 0 && reclaimable / dbBytes >= AUTO_VACUUM_MIN_RATIO);
    const ok = free < 0 ? false : free >= needed;
    // A code, not prose: the dashboard words it in the user's language.
    const reason: CompactReason = !ok ? (free < 0 ? "no_disk_info" : "no_space") : recommended ? "worth_it" : "little";
    return { recommended, ok, reclaimableBytes: reclaimable, neededBytes: needed, diskFreeBytes: free, reason };
  }

  /**
   * VACUUM in a child process with its own connection. bun:sqlite is
   * synchronous, so running it here would freeze the kernel's event loop for
   * minutes. Writers in this process wait on busy_timeout meanwhile; at the
   * nightly slot that is acceptable, and the manual button warns about it.
   */
  async compact(): Promise<{ beforeBytes: number; afterBytes: number }> {
    if (this.progress) throw new Error("A cleanup or compaction is already running");
    const check = this.compactCheck();
    if (!check.ok) throw new Error(compactRefusal(check.reason));
    this.progress = { trigger: "manual", phase: "vacuum", policy: null, policyId: null, policyDeleted: 0, deleted: 0, startedAt: isoNow() };
    const before = fileSize(this.dbPath);
    try {
      await this.vacuumNow();
    } finally {
      this.progress = null;
    }
    return { beforeBytes: before, afterBytes: fileSize(this.dbPath) };
  }

  private async vacuumNow(): Promise<void> {
    const started = Date.now();
    const script = `
      const { Database } = require("bun:sqlite");
      const db = new Database(process.env.KERNL_VACUUM_DB);
      db.run("PRAGMA busy_timeout = 60000");
      db.run("PRAGMA temp_store = FILE");
      db.run("VACUUM");
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        KERNL_VACUUM_DB: this.dbPath,
        // Temp copy next to the DB, not in the container's small /tmp.
        SQLITE_TMPDIR: dirname(this.dbPath),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`VACUUM failed (exit ${code}): ${stderr.trim().slice(0, 300)}`);
    }
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* the child already truncated it */
    }
    log.info(`storage: VACUUM done in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  // ── Stray files ───────────────────────────────────────

  strayFiles(): StrayFile[] {
    return listStrayFiles(this.dbPath);
  }

  deleteStrayFile(name: string): { deleted: string; bytes: number } {
    // Only a name the listing itself returned — never a path from the caller.
    const match = this.strayFiles().find((f) => f.name === name);
    if (!match || basename(name) !== name) throw new Error(`Not a stray database file: ${name}`);
    unlinkSync(join(dirname(this.dbPath), match.name));
    log.info(`storage: deleted stray file ${match.name} (${match.bytes} bytes)`);
    return { deleted: match.name, bytes: match.bytes };
  }

  // ── Overview (the page's single read) ─────────────────

  overview() {
    const snapshot = this.latestSnapshot();
    const policies = this.listPolicies();
    const all = (snapshot?.tables ?? []).map((t) => t.name);
    const claimed = new Set<string>();
    const byKind: Record<RetentionKind | "unclassified", number> = {
      operational: 0, cache: 0, reference: 0, personal: 0, unclassified: 0,
    };
    for (const p of policies) {
      for (const t of expandPolicyTables(p.tables, all)) {
        if (claimed.has(t)) continue;
        claimed.add(t);
        byKind[p.kind] += snapshot?.tables.find((x) => x.name === t)?.bytes ?? 0;
      }
    }
    for (const t of snapshot?.tables ?? []) if (!claimed.has(t.name)) byKind.unclassified += t.bytes;
    const stray = this.strayFiles();
    return {
      dbPath: this.dbPath,
      dbBytes: fileSize(this.dbPath),
      walBytes: fileSize(`${this.dbPath}-wal`),
      snapshot: snapshot
        ? { measuredAt: snapshot.measuredAt, exact: snapshot.exact, freelistBytes: snapshot.freelistBytes, diskFreeBytes: snapshot.diskFreeBytes }
        : null,
      byKind,
      topTables: (snapshot?.tables ?? []).slice(0, 12),
      liberableBytes: policies.filter((p) => p.enabled).reduce((s, p) => s + (p.eligibleBytes ?? 0), 0),
      policies,
      history: this.history(30),
      runs: this.recentRuns(8),
      stray: { files: stray, totalBytes: stray.reduce((s, f) => s + f.bytes, 0) },
      compact: this.compactCheck(),
      progress: this.progress,
    };
  }
}

export type CompactReason = "worth_it" | "little" | "no_space" | "no_disk_info";

export function compactRefusal(reason: CompactReason): string {
  return reason === "no_disk_info"
    ? "Cannot read the free disk space, so compaction is not safe to start"
    : "Not enough free disk space to compact the database";
}

export interface StorageSnapshot {
  day: string;
  measuredAt: string;
  dbBytes: number;
  walBytes: number;
  freelistBytes: number;
  diskFreeBytes: number;
  exact: boolean;
  tables: TableSize[];
  policies: PolicySnapshot[];
}

export interface RetentionRunSummary {
  id: string;
  trigger: "cron" | "manual";
  startedAt: string;
  finishedAt: string;
  deletedRows: number;
  freedBytesEst: number;
  dbBytesBefore: number;
  dbBytesAfter: number;
  vacuumed: boolean;
  details: PolicyRunDetail[];
  error: string;
}

interface SnapshotRow {
  day: string;
  measured_at: string;
  db_bytes: number;
  wal_bytes: number;
  freelist_bytes: number;
  disk_free_bytes: number;
  exact: number;
  tables_json: string;
  policies_json: string;
}

interface RunRow {
  id: string;
  trigger: "cron" | "manual";
  started_at: string;
  finished_at: string | null;
  deleted_rows: number;
  freed_bytes_est: number;
  db_bytes_before: number;
  db_bytes_after: number;
  vacuumed: number;
  details_json: string;
  error: string;
}

function rowToSnapshot(r: SnapshotRow): StorageSnapshot {
  return {
    day: r.day,
    measuredAt: r.measured_at,
    dbBytes: r.db_bytes,
    walBytes: r.wal_bytes,
    freelistBytes: r.freelist_bytes,
    diskFreeBytes: r.disk_free_bytes,
    exact: r.exact === 1,
    tables: safeParse<TableSize[]>(r.tables_json, []),
    policies: safeParse<PolicySnapshot[]>(r.policies_json, []),
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
