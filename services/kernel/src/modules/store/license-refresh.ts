/**
 * Keeps a subscription license current without anyone pasting anything.
 *
 * The issuer re-mints an All-Access license every time Stripe renews the
 * subscription, but it doesn't mail it (a monthly mail would be spam) and
 * can't push it to a kernel behind someone's router. So the kernel asks:
 * when its license is close to running out, it sends that license to the
 * issuer and installs whatever newer one comes back.
 *
 * Only a license near its expiry is ever sent. An extension bought outright
 * carries a ~100-year license and never triggers a request, so someone who
 * paid once is not phoning home twice a day for nothing.
 */

import { log } from "../../core/logger.js";
import type { LicenseService } from "../../core/license/types.js";
import { refreshLicenseAtStore } from "./client.js";

/**
 * Start asking once the license is this close to expiring. A month: a monthly
 * plan sits inside the window all the time (cheap — one request per check),
 * a yearly one enters it in its last month, and either way a kernel that is
 * offline for weeks still catches the renewal before the grace runs out.
 */
export const REFRESH_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** How often the kernel checks. Twice a day is plenty for a month-wide window. */
export const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

export type RefreshOutcome = "no-license" | "not-due" | "current" | "renewed" | "failed";

export async function refreshLicenseIfDue(deps: {
  storeUrl: string;
  license: Pick<LicenseService, "jwt" | "status" | "set">;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<RefreshOutcome> {
  const jwt = deps.license.jwt();
  const exp = deps.license.status().claim?.exp;
  if (!jwt || typeof exp !== "number") return "no-license";

  const now = deps.now ?? Math.floor(Date.now() / 1000);
  if (exp - now > REFRESH_WINDOW_SECONDS) return "not-due";

  let renewed;
  try {
    renewed = await refreshLicenseAtStore({ storeUrl: deps.storeUrl, licenseJwt: jwt, fetchImpl: deps.fetchImpl });
  } catch (err) {
    log.warn(`license: refresh at the store failed, will retry: ${String(err)}`);
    return "failed";
  }
  if (!renewed) return "current";

  try {
    await deps.license.set(renewed.jwt);
  } catch (err) {
    log.warn(`license: the store's renewed license was rejected: ${String(err)}`);
    return "failed";
  }
  log.info(`license: renewed until ${new Date(renewed.expires_at * 1000).toISOString()}`);
  return "renewed";
}
