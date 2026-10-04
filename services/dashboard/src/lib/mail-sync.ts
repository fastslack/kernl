/**
 * What the /mail sync banner says about an account, decided from the
 * per-account status the kernel reports (GET /api/emails/sync-status).
 * Pure: the component only renders the view this returns.
 */

export type FetchState = "fetching" | "ok" | "error";

export interface FetchStatus {
  state: FetchState;
  started_at: string;
  finished_at?: string;
  last_success_at?: string;
  on_wire?: number;
  done?: number;
  added?: number;
  error?: string;
}

export interface AccountSync {
  account_id: string;
  email: string;
  label: string;
  provider: string;
  stored: number;
  fetch: FetchStatus | null;
}

export interface SyncReport {
  accounts: AccountSync[];
  poll_minutes: number;
  batch: number;
}

export type BannerKind = "waiting" | "connecting" | "downloading" | "error" | "empty" | "gmail_waiting";

export interface BannerView {
  kind: BannerKind;
  tone: "info" | "progress" | "error" | "ok";
  /** 0–100 while downloading, otherwise undefined. */
  percent?: number;
}

/**
 * The banner for one account, or null when the list already tells the story
 * (mail is there and the fetcher is fine). A routine re-check of an account
 * that has downloaded before stays silent — the banner would flash every few
 * minutes otherwise.
 */
export function bannerFor(a: AccountSync): BannerView | null {
  if (a.provider === "gmail") return a.stored === 0 ? { kind: "gmail_waiting", tone: "info" } : null;
  if (a.provider !== "imap_smtp") return null;

  const f = a.fetch;
  if (!f) return a.stored === 0 ? { kind: "waiting", tone: "info" } : null;
  if (f.state === "error") return { kind: "error", tone: "error" };
  if (f.state === "fetching") {
    // A routine re-check keeps showing what the last good pass found.
    if (f.last_success_at) return a.stored === 0 ? { kind: "empty", tone: "ok" } : null;
    if (!f.on_wire) return { kind: "connecting", tone: "progress" };
    return { kind: "downloading", tone: "progress", percent: Math.min(100, Math.round(((f.done ?? 0) / f.on_wire) * 100)) };
  }
  return a.stored === 0 ? { kind: "empty", tone: "ok" } : null;
}

/** An error the user fixes with a new password, rather than by waiting. */
export function isAuthError(message: string | undefined): boolean {
  return /auth|credential|password|login|LOGIN failed|invalid user/i.test(message ?? "");
}

export interface SyncSummary {
  /** Accounts whose first download hasn't finished (waiting, connecting or downloading). */
  pending: AccountSync[];
  failing: AccountSync[];
  ready: number;
}

/** The all-accounts view: one line about every IMAP account that isn't ready yet. */
export function summarize(accounts: AccountSync[]): SyncSummary {
  const pending: AccountSync[] = [];
  const failing: AccountSync[] = [];
  let ready = 0;
  for (const a of accounts) {
    if (a.provider !== "imap_smtp") continue;
    const b = bannerFor(a);
    if (b?.kind === "error") failing.push(a);
    else if (b && (b.kind === "waiting" || b.kind === "connecting" || b.kind === "downloading")) pending.push(a);
    else ready++;
  }
  return { pending, failing, ready };
}

/** Poll fast while something is moving, slowly otherwise. */
export function nextPollMs(accounts: AccountSync[]): number {
  const moving = accounts.some((a) => {
    const b = bannerFor(a);
    return b?.kind === "waiting" || b?.kind === "connecting" || b?.kind === "downloading";
  });
  return moving ? 4000 : 60000;
}
