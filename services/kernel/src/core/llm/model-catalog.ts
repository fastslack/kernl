/**
 * Persistent catalog of (provider, model) pairs discovered on a schedule.
 *
 * Where `model-blocklist.ts` records models proven BROKEN, this records what
 * each provider currently ADVERTISES — so the kernel can:
 *   - notify when a brand-new model appears (MiniMax-M3 ships),
 *   - notice when a configured model disappears upstream (M2.7 deprecated →
 *     would 404 mid-run), and
 *   - keep a lightweight history of "what existed when" (first_seen / last_seen).
 *
 * Populated by the `llm:model-discovery` builtin handler (see
 * `model-discovery.ts`). Per-model `first_seen`/`last_seen`/`status` is enough
 * for the history requirement — we deliberately do NOT store a full per-run
 * snapshot table (YAGNI).
 *
 * `status` is the diff axis:
 *   - 'available' — seen in the provider's last successful listModels().
 *   - 'gone'      — was available before, absent from the latest list.
 * A model that reappears flips back to 'available' (first_seen preserved).
 */

import type { SqliteDb } from "../db/sqlite.js";
import { classifyModel } from "./model-traits.js";

export type CatalogStatus = "available" | "gone";

export interface CatalogModel {
  slug: string;
  model: string;
  first_seen: number; // epoch ms
  last_seen: number; // epoch ms
  status: CatalogStatus;
  traits: string; // JSON of ModelTraits
}

/** Delta returned by recordDiscovery, computed over the `available` set. */
export interface CatalogDelta {
  /** Models now available that weren't available before (new or returning). */
  added: string[];
  /** Models that were available before and are now absent (→ marked 'gone'). */
  removed: string[];
}

export class ModelCatalog {
  constructor(
    private readonly db: SqliteDb,
    /** Injectable clock so tests are deterministic. */
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS model_catalog (\n" +
        "  slug       TEXT NOT NULL,\n" +
        "  model      TEXT NOT NULL,\n" +
        "  first_seen INTEGER NOT NULL,\n" +
        "  last_seen  INTEGER NOT NULL,\n" +
        "  status     TEXT NOT NULL,\n" +
        "  traits     TEXT NOT NULL DEFAULT '',\n" +
        "  PRIMARY KEY (slug, model)\n" +
        ")",
    );
  }

  /**
   * Reconcile the catalog for one provider against its freshly-listed models.
   * Marks listed models 'available' (upserting new rows), and any previously
   * 'available' model now absent becomes 'gone'. Returns the delta on the
   * available set.
   *
   * IMPORTANT: only call this with a REACHABLE, non-empty list. An errored /
   * empty listModels() must skip the provider entirely — otherwise a transient
   * API hiccup marks every model 'gone'. That guard lives in the caller
   * (`discoverModels`), not here.
   */
  recordDiscovery(slug: string, models: string[]): CatalogDelta {
    const ts = this.now();
    const prevAvailable = new Set(
      (
        this.db
          .prepare("SELECT model FROM model_catalog WHERE slug = ? AND status = 'available'")
          .all(slug) as Array<{ model: string }>
      ).map((r) => r.model),
    );
    const incoming = new Set(models);

    const upsert = this.db.prepare(
      "INSERT INTO model_catalog (slug, model, first_seen, last_seen, status, traits) " +
        "VALUES (?, ?, ?, ?, 'available', ?) " +
        "ON CONFLICT(slug, model) DO UPDATE SET " +
        "  last_seen = excluded.last_seen, " +
        "  status    = 'available', " +
        "  traits    = excluded.traits",
    );
    for (const model of models) {
      const traits = JSON.stringify(classifyModel(slug, model));
      upsert.run(slug, model, ts, ts, traits);
    }

    const removed = [...prevAvailable].filter((m) => !incoming.has(m));
    const markGone = this.db.prepare(
      "UPDATE model_catalog SET status = 'gone' WHERE slug = ? AND model = ?",
    );
    for (const model of removed) markGone.run(slug, model);

    // "added" = anything now available that wasn't available before (a brand-new
    // model, or one returning from 'gone').
    const added = models.filter((m) => !prevAvailable.has(m));
    return { added, removed };
  }

  /** Is this exact (slug, model) currently recorded as 'gone'? Used to flag
   *  configured refs that point at a vanished model. Unknown pairs (never
   *  discovered) are NOT gone — we only flag what we've positively seen leave. */
  isGone(slug: string, model: string): boolean {
    const row = this.db
      .prepare("SELECT status FROM model_catalog WHERE slug = ? AND model = ?")
      .get(slug, model) as { status: CatalogStatus } | undefined;
    return row?.status === "gone";
  }

  /** Currently-available model ids for a provider (sorted). */
  availableModels(slug: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT model FROM model_catalog WHERE slug = ? AND status = 'available' ORDER BY model ASC",
        )
        .all(slug) as Array<{ model: string }>
    ).map((r) => r.model);
  }

  /** List catalog rows, optionally filtered by slug and/or status. */
  list(filter?: { slug?: string; status?: CatalogStatus }): CatalogModel[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.slug) {
      where.push("slug = ?");
      params.push(filter.slug);
    }
    if (filter?.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const sql =
      "SELECT slug, model, first_seen, last_seen, status, traits FROM model_catalog" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY slug ASC, model ASC";
    return this.db.prepare(sql).all(...params) as CatalogModel[];
  }
}
