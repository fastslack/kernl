/**
 * Limits for the graph database, the Neo4j half of /system?tab=storage.
 *
 * Modules that fill the graph declare a `GraphBudget` (which sources feed it,
 * how to drop and readmit items). This service stores what the user chose,
 * measures the database on disk and asks each budget to comply — nightly,
 * after the SQLite retention, and whenever the user presses "Apply now".
 *
 * Three knobs per instance or per budget:
 *   - sources and an item ceiling, per budget: enforced by the module, which
 *     knows which of its items matter most;
 *   - a size ceiling in GB, for the whole database: a growth brake. Neo4j
 *     reuses the space of deleted records instead of shrinking its files, so
 *     deleting until the files are under the ceiling would never get there.
 *     Over the ceiling, budgets stop admitting new items; to shrink the files,
 *     lower the item ceiling and compact the store offline;
 *   - how much transaction log Neo4j keeps, applied live through
 *     `dbms.setConfigValue` (the setting is dynamic) and re-applied on boot,
 *     since a live change does not survive a Neo4j restart.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphBudget, GraphBudgetApplyResult, GraphLimits, KernelModule } from "../../core/types.js";
import { log } from "../../core/logger.js";

/** Neo4j's `db.tx_log.rotation.retention_policy` for each choice on the page. */
export const TXLOG_POLICIES = {
  min: "1 files",
  day: "1 days",
  default: "2 days 2G",
} as const;
export type TxlogChoice = keyof typeof TXLOG_POLICIES;

export const GB_OPTIONS = [1, 2, 3, 5, 10];

const GIB = 1024 ** 3;

export interface GraphDisk {
  storeBytes: number;
  txBytes: number;
}

export interface GraphBudgetView {
  id: string;
  label: string;
  unit: string;
  capOptions: number[];
  maxItems: number | null;
  excluded: string[];
  sources: Array<{ key: string; count: number }>;
  inGraph: number | null;
  keptOut: number | null;
  nodes: Record<string, number>;
  lastApply: { at: string; result?: GraphBudgetApplyResult; error?: string } | null;
}

export interface GraphOverview {
  connected: boolean;
  disk: GraphDisk | null;
  maxGb: number | null;
  gbOptions: number[];
  txlog: TxlogChoice;
  frozen: boolean;
  applying: boolean;
  budgets: GraphBudgetView[];
}

/** Size of every file under `dir`, 0 when it does not exist. */
function dirBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      total += st.isDirectory() ? dirBytes(p) : st.size;
    } catch {
      /* vanished between readdir and stat (a rotated log): skip */
    }
  }
  return total;
}

export class GraphStorageService {
  private applying = false;

  constructor(
    private readonly db: SqliteDb,
    private readonly listModules: () => KernelModule[],
    private readonly graph: () => GraphDriver | null,
    /** Where the kernel sees Neo4j's data volume, read-only (docker-compose.yml). */
    private readonly dataDir: string = process.env.NEO4J_DATA_DIR ?? "/neo4j-data",
  ) {}

  // ── Settings ───────────────────────────────────────────

  private read(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM graph_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  private write(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM graph_settings WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO graph_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private num(key: string): number | null {
    const v = this.read(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  maxGb(): number | null {
    return this.num("max_gb");
  }

  txlog(): TxlogChoice {
    const v = this.read("txlog");
    return v && v in TXLOG_POLICIES ? (v as TxlogChoice) : "default";
  }

  private excluded(budgetId: string): string[] {
    try {
      const v = JSON.parse(this.read(`${budgetId}.excluded`) ?? "[]");
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    } catch {
      return [];
    }
  }

  // ── Budgets ────────────────────────────────────────────

  budgets(): GraphBudget[] {
    const seen = new Map<string, GraphBudget>();
    for (const mod of this.listModules()) {
      if (typeof mod.getGraphBudgets !== "function") continue;
      try {
        for (const b of mod.getGraphBudgets() ?? []) if (!seen.has(b.id)) seen.set(b.id, b);
      } catch (err) {
        log.warn(`storage: ${mod.name} graph budgets failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return [...seen.values()];
  }

  /** Datastore files and transaction logs of the user database, or null when the volume is not mounted. */
  disk(): GraphDisk | null {
    const store = path.join(this.dataDir, "databases", "neo4j");
    try {
      statSync(store);
    } catch {
      return null;
    }
    return { storeBytes: dirBytes(store), txBytes: dirBytes(path.join(this.dataDir, "transactions", "neo4j")) };
  }

  /** Over the size ceiling: budgets admit nothing new. Unknown size never freezes. */
  frozen(disk: GraphDisk | null = this.disk()): boolean {
    const cap = this.maxGb();
    return cap !== null && disk !== null && disk.storeBytes + disk.txBytes >= cap * GIB;
  }

  limitsFor(budgetId: string, frozen = this.frozen()): GraphLimits {
    return { excludedSources: this.excluded(budgetId), maxItems: this.num(`${budgetId}.max_items`), frozen };
  }

  // ── Page ───────────────────────────────────────────────

  async overview(): Promise<GraphOverview> {
    const graph = this.graph();
    const connected = !!graph?.capabilities.cypher;
    const disk = this.disk();
    const budgets: GraphBudgetView[] = [];
    for (const b of this.budgets()) {
      let status: Awaited<ReturnType<GraphBudget["status"]>> | null = null;
      try {
        status = await b.status(this.db, connected ? graph : null);
      } catch (err) {
        log.warn(`storage: graph budget ${b.id} status failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      let lastApply: GraphBudgetView["lastApply"] = null;
      try {
        lastApply = JSON.parse(this.read(`${b.id}.last_apply`) ?? "null");
      } catch { /* unreadable: show none */ }
      budgets.push({
        id: b.id,
        label: b.label,
        unit: b.unit,
        capOptions: b.capOptions,
        maxItems: this.num(`${b.id}.max_items`),
        excluded: this.excluded(b.id),
        sources: b.sources(this.db),
        inGraph: status ? status.inGraph : null,
        keptOut: status ? status.keptOut : null,
        nodes: status?.nodes ?? {},
        lastApply,
      });
    }
    return {
      connected,
      disk,
      maxGb: this.maxGb(),
      gbOptions: GB_OPTIONS,
      txlog: this.txlog(),
      frozen: this.frozen(disk),
      applying: this.applying,
      budgets,
    };
  }

  set(patch: {
    maxGb?: number | null;
    txlog?: string;
    budget?: string;
    maxItems?: number | null;
    excluded?: string[];
  }): void {
    if (patch.maxGb !== undefined) {
      if (patch.maxGb !== null && !(Number.isFinite(patch.maxGb) && patch.maxGb > 0)) throw new Error("maxGb must be a positive number or null");
      this.write("max_gb", patch.maxGb === null ? null : String(patch.maxGb));
    }
    if (patch.txlog !== undefined) {
      if (!(patch.txlog in TXLOG_POLICIES)) throw new Error(`txlog must be one of ${Object.keys(TXLOG_POLICIES).join(", ")}`);
      this.write("txlog", patch.txlog);
    }
    if (patch.maxItems !== undefined || patch.excluded !== undefined) {
      const id = patch.budget;
      if (!id || !this.budgets().some((b) => b.id === id)) throw new Error(`unknown graph budget: ${id ?? "(none)"}`);
      if (patch.maxItems !== undefined) {
        if (patch.maxItems !== null && !(Number.isInteger(patch.maxItems) && patch.maxItems > 0)) throw new Error("maxItems must be a positive integer or null");
        this.write(`${id}.max_items`, patch.maxItems === null ? null : String(patch.maxItems));
      }
      if (patch.excluded !== undefined) {
        if (!Array.isArray(patch.excluded) || patch.excluded.some((s) => typeof s !== "string")) throw new Error("excluded must be a list of source keys");
        this.write(`${id}.excluded`, JSON.stringify([...new Set(patch.excluded)].sort()));
      }
    }
  }

  // ── Enforcement ────────────────────────────────────────

  /** Push the transaction-log choice to Neo4j. Best-effort: false when the graph is down. */
  async applyTxlog(): Promise<boolean> {
    const graph = this.graph();
    if (!graph?.capabilities.cypher) return false;
    await graph.run("CALL dbms.setConfigValue('db.tx_log.rotation.retention_policy', $v)", { v: TXLOG_POLICIES[this.txlog()] });
    return true;
  }

  isApplying(): boolean {
    return this.applying;
  }

  /** Make every budget comply with its limits. One line per budget, for the run log. */
  async apply(): Promise<string[]> {
    const graph = this.graph();
    if (!graph?.capabilities.cypher) return ["Graph: not connected, limits not applied."];
    if (this.applying) return ["Graph: already applying."];
    this.applying = true;
    const lines: string[] = [];
    try {
      await this.applyTxlog().catch((err) => {
        lines.push(`Graph: transaction log setting failed (${err instanceof Error ? err.message : String(err)}).`);
      });
      const frozen = this.frozen();
      for (const b of this.budgets()) {
        const at = new Date().toISOString();
        try {
          const result = await b.apply(this.db, graph, this.limitsFor(b.id, frozen));
          this.write(`${b.id}.last_apply`, JSON.stringify({ at, result }));
          lines.push(`Graph ${b.label}: ${result.removed} removed, ${result.readmitted} readmitted, ${result.orphansRemoved} orphan nodes${frozen ? " (size ceiling reached: nothing new admitted)" : ""}.`);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.write(`${b.id}.last_apply`, JSON.stringify({ at, error }));
          lines.push(`Graph ${b.label}: failed (${error}).`);
        }
      }
    } finally {
      this.applying = false;
    }
    return lines;
  }
}
