/**
 * CheckoutService — the local record of in-dashboard purchases.
 *
 * A purchase spans two processes and an unbounded amount of wall-clock time:
 * the user pays on Stripe's hosted page in another tab, and the license only
 * exists once Stripe's webhook reaches the issuer. This table is what lets the
 * kernel pick the thread back up — on the next poll, on the next page load, or
 * after a restart.
 *
 * State machine (see migrations for the CHECK constraint):
 *
 *   pending ──license claimed──▶ paid ──installed──▶ done
 *      │                          │
 *      └────────── error ─────────┴──────────────▶ failed
 *
 * `failed` is not terminal in practice: retrying the same slug opens a fresh
 * checkout, which is a new row.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import { isoNow } from "../../core/helpers.js";

export type CheckoutState = "pending" | "paid" | "done" | "failed";

export interface CheckoutRow {
  session_id: string;
  slug: string;
  price_id: string;
  checkout_url: string;
  state: CheckoutState;
  error: string;
  created_at: string;
  updated_at: string;
  claim_expires_at: string;
}

/** Mirrors the store's session TTL — after this we stop polling. */
const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

export class CheckoutService {
  constructor(private readonly db: SqliteDb) {}

  create(args: { sessionId: string; slug: string; priceId: string; checkoutUrl: string }): CheckoutRow {
    const now = isoNow();
    const expires = new Date(Date.now() + CLAIM_WINDOW_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO store_checkouts
           (session_id, slug, price_id, checkout_url, state, error, created_at, updated_at, claim_expires_at)
         VALUES (?, ?, ?, ?, 'pending', '', ?, ?, ?)`,
      )
      .run(args.sessionId, args.slug, args.priceId, args.checkoutUrl, now, now, expires);
    return this.get(args.sessionId)!;
  }

  get(sessionId: string): CheckoutRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM store_checkouts WHERE session_id = ?")
        .get(sessionId) as CheckoutRow | undefined) ?? null
    );
  }

  /** The most recent unfinished checkout for a slug, if any. */
  pendingForSlug(slug: string): CheckoutRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM store_checkouts
           WHERE slug = ? AND state IN ('pending','paid') AND claim_expires_at > ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(slug, isoNow()) as CheckoutRow | undefined) ?? null
    );
  }

  /** Every checkout still worth polling. Drives the dashboard's resume-on-load. */
  listOpen(): CheckoutRow[] {
    return this.db
      .prepare(
        `SELECT * FROM store_checkouts
         WHERE state IN ('pending','paid') AND claim_expires_at > ?
         ORDER BY created_at DESC`,
      )
      .all(isoNow()) as CheckoutRow[];
  }

  setState(sessionId: string, state: CheckoutState, error = ""): void {
    this.db
      .prepare("UPDATE store_checkouts SET state = ?, error = ?, updated_at = ? WHERE session_id = ?")
      .run(state, error, isoNow(), sessionId);
  }

  /**
   * Drop rows past their claim window that never completed. Called
   * opportunistically from the poll route — no scheduler needed for a table
   * that only ever holds a handful of rows.
   */
  pruneExpired(): number {
    const res = this.db
      .prepare("DELETE FROM store_checkouts WHERE state = 'pending' AND claim_expires_at <= ?")
      .run(isoNow());
    return res.changes ?? 0;
  }

  /** True when the claim window has closed on a still-unpaid checkout. */
  static isExpired(row: CheckoutRow): boolean {
    return row.state === "pending" && new Date(row.claim_expires_at).getTime() <= Date.now();
  }
}
