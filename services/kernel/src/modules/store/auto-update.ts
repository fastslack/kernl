/**
 * Store auto-update engine.
 *
 * Checks the store catalog for newer versions of extensions that are BOTH
 * already installed AND covered by the current license, then applies each
 * upgrade in place via `ExtensionService.update()`. Installing something new
 * stays a deliberate user action via `kernel_store_install` — this engine
 * only upgrades what's already there.
 *
 * Free users (no license JWT) are a strict no-op: not even a catalog fetch
 * happens, so there's zero network chatter for anyone who hasn't bought
 * anything.
 */

import type { ExtensionService } from "../extensions/index.js";
import { fetchStoreCatalog, downloadStoreBundle } from "./client.js";
import { isNewer } from "../../core/semver.js";

export interface StoreUpdateDeps {
  storeUrl: string;
  getExtensionService: () => ExtensionService | null;
  licenseHas: (feature: string) => boolean;
  licenseJwt: () => string | null;
  /** Injectable fetch for tests; forwarded to the store client helpers. */
  fetchImpl?: typeof fetch;
}

export interface StoreUpdateResult {
  slug: string;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}

export interface StoreUpdateReport {
  checked: number;
  updated: StoreUpdateResult[];
  skipped: number;
  errors: number;
  /** Set when the catalog fetch itself failed (store outage, non-2xx, etc.) —
   *  the rest of the report is a zeroed no-op in that case since no items
   *  could even be checked. */
  catalogError?: string;
}

const EMPTY_REPORT: StoreUpdateReport = { checked: 0, updated: [], skipped: 0, errors: 0 };

/**
 * Run one pass of the store auto-update check. Never throws — a failure on
 * one item, or on the catalog fetch itself (store outage, non-2xx response),
 * is recorded in the report and the batch continues (or is skipped, for a
 * catalog-fetch failure).
 */
export async function runStoreUpdates(deps: StoreUpdateDeps): Promise<StoreUpdateReport> {
  const jwt = deps.licenseJwt();
  if (!jwt) return EMPTY_REPORT;

  const svc = deps.getExtensionService();
  if (!svc) return EMPTY_REPORT;

  let catalog;
  try {
    catalog = await fetchStoreCatalog(deps.storeUrl, deps.fetchImpl);
  } catch (e) {
    return {
      checked: 0,
      updated: [],
      skipped: 0,
      errors: 1,
      catalogError: e instanceof Error ? e.message : String(e),
    };
  }

  const report: StoreUpdateReport = { checked: 0, updated: [], skipped: 0, errors: 0 };

  for (const item of catalog) {
    if (item.type === "office") continue; // offices are blueprints, not .kernlext upgrades
    if (!deps.licenseHas(item.feature)) continue;

    const installed = svc.getBySlug(item.slug);
    if (!installed) continue; // new installs stay a deliberate kernel_store_install action

    report.checked++;

    try {
      if (!isNewer(item.version, installed.version)) {
        report.skipped++;
        continue;
      }

      const { path, downloadUrl } = await downloadStoreBundle({
        storeUrl: deps.storeUrl,
        slug: item.slug,
        licenseJwt: jwt,
        fetchImpl: deps.fetchImpl,
      });

      const applied = await svc.update(path, { type: "url", url: downloadUrl });
      report.updated.push({ slug: item.slug, from: applied.from, to: applied.to, ok: true });
    } catch (e) {
      report.errors++;
      report.updated.push({
        slug: item.slug,
        from: installed.version,
        to: item.version,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return report;
}
