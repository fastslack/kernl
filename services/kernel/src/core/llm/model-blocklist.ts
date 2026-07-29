/**
 * Persistent blocklist of (provider, model) pairs that have proven broken
 * — either the provider's catalog endpoint advertises a model the
 * inference server never actually hosts (it hangs indefinitely with
 * timeout, caso típico de NVIDIA NIM) o el modelo fue deprecated y el
 * upstream tira 404.
 *
 * Auto-populated by the POST /api/llm/chain/test endpoint when a probe
 * fails with `kind=transient` AND the error looks model-specific
 * (timeout, 404, "does not exist"). Errores generales del proveedor
 * (quota exhausted, revoked key, rate-limit) do NOT land here — those
 * affect EVERY model on the slug, not one specific model.
 *
 * The catalog exposed by GET /api/llm-providers/:slug/models filters out
 * blocked models automatically, so the /models dropdown stops offering
 * them. The UI's "Discarded models" section lets you
 * unblocking them manually if the provider starts serving them again.
 */

import type { SqliteDb } from "../db/sqlite.js";

export type BlockReason = "timeout" | "not-found" | "manual";

export interface BlockedModel {
  slug: string;
  model: string;
  blocked_at: number;       // epoch ms
  reason: BlockReason;
  error_raw: string;        // truncated to 500 chars
  /** When 1, hidden from the "Modelos descartados" management UI but
   *  still filtered from the dropdown — the user confirmed "this is
   *  dead forever, stop showing it to me." */
  permanent?: number;
}

export class ModelBlocklist {
  constructor(private readonly db: SqliteDb) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS model_blocklist (\n" +
        "  slug       TEXT NOT NULL,\n" +
        "  model      TEXT NOT NULL,\n" +
        "  blocked_at INTEGER NOT NULL,\n" +
        "  reason     TEXT NOT NULL,\n" +
        "  error_raw  TEXT NOT NULL DEFAULT '',\n" +
        "  permanent  INTEGER NOT NULL DEFAULT 0,\n" +
        "  PRIMARY KEY (slug, model)\n" +
        ")",
    );
    // Idempotent migration: add `permanent` to pre-existing tables.
    try { db.exec("ALTER TABLE model_blocklist ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0"); }
    catch { /* column already exists */ }
  }

  /** Add a (slug, model) to the blocklist. Idempotent — re-blocking the
   *  same pair just refreshes blocked_at + reason + error_raw. */
  block(slug: string, model: string, reason: BlockReason, errorRaw = ""): void {
    if (!slug || !model) return;
    this.db
      .prepare(
        "INSERT INTO model_blocklist (slug, model, blocked_at, reason, error_raw) " +
          "VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(slug, model) DO UPDATE SET " +
          "  blocked_at = excluded.blocked_at, " +
          "  reason     = excluded.reason, " +
          "  error_raw  = excluded.error_raw",
      )
      .run(slug, model, Date.now(), reason, errorRaw.slice(0, 500));
  }

  /** Remove a single (slug, model) from the blocklist. Returns true if
   *  a row was actually deleted. */
  unblock(slug: string, model: string): boolean {
    const r = this.db
      .prepare("DELETE FROM model_blocklist WHERE slug = ? AND model = ?")
      .run(slug, model);
    return (r.changes ?? 0) > 0;
  }

  /** Wipe the entire blocklist. Returns the number of rows deleted. */
  unblockAll(): number {
    const r = this.db.prepare("DELETE FROM model_blocklist").run();
    return r.changes ?? 0;
  }

  /** Is this specific (slug, model) currently blocked? */
  isBlocked(slug: string, model: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM model_blocklist WHERE slug = ? AND model = ?")
      .get(slug, model);
    return !!row;
  }

  /** All blocked models visible in the "Modelos descartados" UI.
   *  Permanent entries are filtered OUT — they're hidden but still
   *  active (the dropdown won't offer them either). Use `listAll()`
   *  if you need the full set including permanent ones. */
  list(): BlockedModel[] {
    return this.db
      .prepare(
        "SELECT slug, model, blocked_at, reason, error_raw, permanent FROM model_blocklist " +
          "WHERE permanent = 0 ORDER BY slug ASC, model ASC",
      )
      .all() as BlockedModel[];
  }

  /** Every entry, permanent or not. Useful for debugging / admin. */
  listAll(): BlockedModel[] {
    return this.db
      .prepare(
        "SELECT slug, model, blocked_at, reason, error_raw, permanent FROM model_blocklist " +
          "ORDER BY slug ASC, model ASC",
      )
      .all() as BlockedModel[];
  }

  /** Flag a (slug, model) as "permanently dismissed" — stays blocked
   *  (so the dropdown keeps hiding it) but disappears from the active
   *  "Modelos descartados" list. Idempotent — also (re)sets blocked_at
   *  + ensures the row exists. */
  markPermanent(slug: string, model: string): boolean {
    if (!slug || !model) return false;
    const r = this.db
      .prepare(
        "INSERT INTO model_blocklist (slug, model, blocked_at, reason, error_raw, permanent) " +
          "VALUES (?, ?, ?, 'manual', '', 1) " +
          "ON CONFLICT(slug, model) DO UPDATE SET permanent = 1",
      )
      .run(slug, model, Date.now());
    return (r.changes ?? 0) > 0;
  }

  /** Filter a list of model IDs down to only the unblocked ones. Used by
   *  GET /api/llm-providers/:slug/models so the dropdown never offers a
   *  proven-broken model. */
  filterAvailable(slug: string, models: string[]): string[] {
    if (models.length === 0) return models;
    const blocked = new Set(
      (
        this.db
          .prepare("SELECT model FROM model_blocklist WHERE slug = ?")
          .all(slug) as Array<{ model: string }>
      ).map((r) => r.model),
    );
    return models.filter((m) => !blocked.has(m));
  }

  /**
   * Classify a probe failure into a block decision.
   *
   * Returns the reason to block under, or null when the failure is
   * provider-wide (quota/auth/rate-limit) and shouldn't taint the
   * specific model. Centralized so the probe handler and any future
   * auto-block paths agree on the rules.
   */
  static reasonForFailure(
    errorKind: string | undefined,
    errorRaw: string | undefined,
  ): BlockReason | null {
    const raw = errorRaw ?? "";
    // Provider-wide failures — DON'T mark the model as broken.
    if (errorKind === "exhausted" || errorKind === "auth" || errorKind === "rate-limit") {
      return null;
    }
    // Model-specific: NIM lists it but the inference server hangs.
    if (/\btimeout\b|no response in/i.test(raw)) return "timeout";
    // Model-specific: deprecated / renamed / wrong path.
    if (/\b404\b|not found|does not exist|model[_ ]?not[_ ]?found/i.test(raw)) return "not-found";
    // Other transient errors (5xx, network) — could be temporary upstream
    // issues. Don't auto-block on a single probe; let the user retry.
    return null;
  }
}
