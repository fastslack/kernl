/**
 * License types — the contract between the offline kernel and the online
 * issuer. The JWT is signed RS256; the kernel embeds the public key and
 * verifies fully offline. Refresh happens only when the user actively
 * presses "refresh" in the dashboard or `KERNEL_LICENSE_REFRESH_ON_BOOT=1`.
 *
 * SKU = product the customer paid for. Each SKU implies a set of features.
 *   "pro"   → all Pro modules locally (trading, graph-pro, agents-pro, …)
 *   "cloud" → hosted instance + auto-updates; locally the same feature set as Pro
 *   "both"  → pro+cloud bundle (same features as cloud; flag for billing only)
 *
 * Features (the granular things modules check) follow `pro:<module>` naming.
 * They are derived from the SKU server-side and embedded in the JWT — modules
 * never check the SKU directly, always `has('pro:trading')`. Adding a new Pro
 * module = updating the issuer to emit the new feature key, plus a kernel
 * version that knows about it.
 */

export type LicenseSku = "pro" | "cloud" | "both";

export interface LicenseClaim {
  /** Issuer hostname (e.g. "issuer.mtwkernel.com"). Verified against env override. */
  iss: string;
  /** Customer identifier from the payment provider (Stripe customer ID). */
  sub: string;
  /** Customer email. Surfaced in the dashboard so users see whose license this is. */
  email: string;
  /** What was purchased. */
  sku: LicenseSku;
  /** Concrete feature flags this license grants. */
  features: string[];
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. Past-tense JWTs are rejected. */
  exp: number;
  /**
   * Optional hardware fingerprint. When present, the kernel refuses to
   * accept the license on a different machine. Today we don't issue these
   * (no machine binding); the field is reserved for an opt-in family plan
   * tier where 1 license covers up to N specific machines.
   */
  machine_id?: string;
}

export type LicenseStatus =
  | "none"        // No license file present.
  | "valid"       // Loaded, signature ok, not expired.
  | "expired"     // Loaded, signature ok, but `exp` is past.
  | "invalid"     // Signature failed OR claim shape malformed.
  | "machine_mismatch"; // Claim is bound to a different machine_id.

export interface LicenseStatusReport {
  status: LicenseStatus;
  /** Present iff status is "valid" or "expired" (anything we parsed). */
  claim?: LicenseClaim;
  /** Human-readable explanation, safe to surface to the user. */
  message?: string;
}

/**
 * Service surface that every Pro module sees through `ctx.license`. Designed
 * so free modules never need to import this — they just don't call it.
 */
export interface LicenseService {
  /** True iff status is "valid" (regardless of which SKU). */
  isPro(): boolean;
  /** True iff status is "valid" AND the given feature flag is in `features`. */
  has(feature: string): boolean;
  /** Current status report. Cached after load(); call refresh() for re-validation. */
  status(): LicenseStatusReport;
  /** The active SKU, or null if no valid license. */
  sku(): LicenseSku | null;
  /**
   * The raw license JWT currently on disk, or null if none. Used to
   * authenticate downloads against the licensed store (the key IS the
   * download credential). Returns whatever was loaded — including an
   * expired token — so callers can surface a precise error.
   */
  jwt(): string | null;
  /**
   * Atomically replace the on-disk license. Returns the new status report.
   * Rejects with a typed error if the JWT fails verification.
   */
  set(jwt: string): Promise<LicenseStatusReport>;
  /** Remove the on-disk license. Service reverts to status "none". */
  clear(): Promise<void>;
  /**
   * Re-read from disk and re-verify. Use when the user pastes a key into
   * the dashboard, or after a manual `kernl license set` CLI call.
   */
  refresh(): Promise<LicenseStatusReport>;
}

export class LicenseError extends Error {
  constructor(public readonly kind: LicenseStatus, message: string) {
    super(message);
    this.name = "LicenseError";
  }
}
