/**
 * The purchase state machine, isolated from HTTP so it can be tested directly.
 *
 *   pending ──license claimed + applied──▶ paid ──bundle installed──▶ done
 *      │                                    │
 *      └────────────── error ───────────────┴──────────────────────▶ failed
 *
 * Two rules shape everything here:
 *
 *  1. A transient failure must NOT end a purchase. The user has paid; a DNS
 *     blip while claiming the license has to leave the row `pending` so the
 *     next poll retries. Only the store's 24h claim window ends a purchase.
 *
 *  2. When the money moved but the install failed, say so precisely. "Failed"
 *     on its own reads as "you didn't get what you paid for", which would be
 *     both wrong and alarming — the license IS applied at that point, and
 *     retrying the install costs nothing.
 */

import { log } from "../../core/logger.js";
import type { LicenseService } from "../../core/license/types.js";
import { fetchLicenseBySession } from "./client.js";
import { CheckoutService, type CheckoutRow } from "./checkout-service.js";

export interface PurchaseFlowDeps {
  storeUrl: string;
  license: Pick<LicenseService, "set" | "jwt">;
  checkouts: CheckoutService;
  /** Installs the purchased slug. Injected so this stays free of the installer. */
  install: (slug: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
}

/**
 * Move `row` forward by at most one step and return its new state. Safe to call
 * repeatedly; calling it on a `done`/`failed` row is a no-op.
 *
 * Callers must serialize calls per session (the HTTP layer does this with an
 * in-flight set) — two concurrent advances of the same `paid` row would install
 * twice.
 */
export async function advanceCheckout(
  row: CheckoutRow,
  deps: PurchaseFlowDeps,
): Promise<CheckoutRow> {
  const { session_id: sessionId, slug } = row;
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (row.state === "done" || row.state === "failed") return row;

  if (CheckoutService.isExpired(row)) {
    deps.checkouts.setState(sessionId, "failed", "Checkout expired without payment.");
    return deps.checkouts.get(sessionId) ?? row;
  }

  if (row.state === "pending") {
    let claimed;
    try {
      claimed = await fetchLicenseBySession({ storeUrl: deps.storeUrl, sessionId, fetchImpl });
    } catch (err) {
      // Rule 1: stay pending, let the next poll retry.
      log.warn(`store: license claim for ${sessionId} failed: ${String(err)}`);
      return row;
    }
    if (!claimed) return row; // not paid yet

    try {
      await deps.license.set(claimed.jwt);
      log.info(`store: license applied from checkout ${sessionId} (${claimed.sku})`);
    } catch (err) {
      // A license this kernel can't verify is terminal — retrying won't help.
      deps.checkouts.setState(
        sessionId,
        "failed",
        `Payment went through, but this kernel rejected the license: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Contact support@lifekernl.com — your purchase is on file.`,
      );
      return deps.checkouts.get(sessionId) ?? row;
    }

    deps.checkouts.setState(sessionId, "paid");
    row = deps.checkouts.get(sessionId) ?? { ...row, state: "paid" };
  }

  if (row.state === "paid") {
    try {
      await deps.install(slug);
      deps.checkouts.setState(sessionId, "done");
      log.info(`store: installed ${slug} from checkout ${sessionId}`);
    } catch (err) {
      // Rule 2.
      deps.checkouts.setState(
        sessionId,
        "failed",
        `Purchase completed and your license is installed, but installing ${slug} failed: ` +
          `${err instanceof Error ? err.message : String(err)}. Retry the install from Extensions.`,
      );
    }
    return deps.checkouts.get(sessionId) ?? row;
  }

  return row;
}
