/**
 * Per-account progress of comms:inbox-fetch, kept in email_fetch_status so the
 * mail view can tell "not downloaded yet" from "downloading" from "failed" from
 * "the mailbox really is empty". One row per account: the fetcher is the only
 * writer, and a missing row means it has never reached that account.
 */

import { type SqliteDb, isoNow, log } from "@kernl/extension-sdk";

/** The fetcher's cadence and per-pass size — the mail view quotes both to the user. */
export const FETCH_POLL_MINUTES = 3;
export const FETCH_BATCH = 20;

export type FetchState = "fetching" | "ok" | "error";

export interface FetchStatus {
  state: FetchState;
  /** When the current (or last) pass over this account started. */
  started_at: string;
  finished_at?: string;
  /** Last pass that finished without an error — survives a later failure. */
  last_success_at?: string;
  /** Messages the server listed this pass, and how many of them are processed. */
  on_wire?: number;
  done?: number;
  /** Messages that were new to Kernl this pass. */
  added?: number;
  error?: string;
}

export function readFetchStatus(db: SqliteDb, accountId: string): FetchStatus | null {
  try {
    const row = db.prepare("SELECT status FROM email_fetch_status WHERE account_id = ?").get(accountId) as
      { status: string } | undefined;
    return row ? (JSON.parse(row.status) as FetchStatus) : null;
  } catch {
    return null;
  }
}

/**
 * Merge `patch` into the account's status. A field set to `undefined` is
 * cleared (JSON drops it) — that's how a new pass wipes the last one's error.
 */
export function writeFetchStatus(db: SqliteDb, accountId: string, patch: Partial<FetchStatus>): void {
  try {
    const prev = readFetchStatus(db, accountId);
    const next: FetchStatus = { state: "fetching", started_at: isoNow(), ...prev, ...patch };
    db.prepare("INSERT OR REPLACE INTO email_fetch_status (account_id, status, updated_at) VALUES (?, ?, ?)")
      .run(accountId, JSON.stringify(next), isoNow());
  } catch (err) {
    log.warn(`comms: fetch status write failed for ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
