/**
 * Fetch, in the background, the packages that keep bundled extensions parked.
 *
 * The native packages (.deb/.rpm/.dmg/.msi) deliberately leave a handful of
 * heavy SDKs out of the payload — see the ON_DEMAND list in
 * `packaging/stage-payload.sh`. Ten bundled extensions declare one of them,
 * so on a native install they land in `installed` instead of `active` and
 * their features are simply absent: Cinema, Shop and Comms show a tab (the
 * suite stub that declares it has no packages of its own and stays active)
 * that leads to an "extension not available" screen, and the whole Tools
 * group disappears with filesystem-commander. Docker never showed any of it
 * because /app/node_modules is a full install and everything resolves.
 *
 * This closes that gap without growing the download for everyone: the packages
 * are fetched once, after boot, for the extensions that are actually shipped.
 *
 * Three properties this deliberately has:
 *
 *  - **It never blocks boot.** The HTTP server comes up at stage 9 of
 *    bootstrap, well after extensions load. Awaiting an npm install there
 *    would leave the dashboard unreachable for minutes with nothing on screen
 *    to explain it.
 *
 *  - **It does not flip any status.** Activating an extension in this process
 *    would advertise it through /api/manifest while its backend routes are
 *    not registered — `dashboardRegistry.registerAllRoutes()` has already run
 *    by then — so the page would load and every call behind it would 404.
 *    Promotion happens on the next boot, in the seeder, via
 *    `promoteIfUnblocked()`, where the extension comes up fully wired.
 *
 *  - **Failure is not an error.** Offline is the expected case for some
 *    installs. The extension stays parked exactly as it was and the next boot
 *    tries again.
 */

import { log } from "../../core/logger.js";
import { ensureExtensionPackages } from "./ensure-packages.js";
import type { ExtensionService } from "./service.js";

export interface AutoProvisionResult {
  /** Slugs whose packages were fetched — active from the next restart. */
  provisioned: string[];
  /** Slugs attempted that could not be provisioned (offline, registry error). */
  failed: Array<{ slug: string; error: string }>;
  /** True when the whole pass was skipped by configuration. */
  skipped: boolean;
}

/** Total wall-clock budget for one pass. Past this, the rest waits for the next boot. */
const DEFAULT_BUDGET_MS = 10 * 60 * 1000;

export async function autoProvisionExtensions(args: {
  service: ExtensionService;
  extensionsDir: string;
  /** Set false to skip the pass entirely (KERNEL_EXT_AUTOPROVISION=0). */
  enabled?: boolean;
  budgetMs?: number;
}): Promise<AutoProvisionResult> {
  const { service, extensionsDir } = args;
  const result: AutoProvisionResult = { provisioned: [], failed: [], skipped: false };

  if (args.enabled === false) {
    result.skipped = true;
    return result;
  }

  const targets = service.pendingPackageInstalls().map((row) => ({
    id: row.id,
    slug: row.slug,
    installPath: row.install_path,
    manifest: service.parseManifest(row),
  }));
  if (targets.length === 0) return result;

  const budgetMs = args.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  log.info(
    `Extension auto-provision: ${targets.length} bundled extension(s) waiting on packages ` +
      `(${targets.map((t) => t.slug).join(", ")}) — fetching in the background`,
  );

  // Sequential on purpose. Each of these shells out to `bun install`; running
  // ten at once turns a slow first boot into an unusable machine, and they
  // contend for the same package cache anyway.
  for (const target of targets) {
    if (Date.now() >= deadline) {
      log.warn(
        `Extension auto-provision: budget spent — ${targets.length - result.provisioned.length - result.failed.length} ` +
          `extension(s) still waiting, will retry on next start`,
      );
      break;
    }
    try {
      const { installPath, installed } = await ensureExtensionPackages({
        manifest: target.manifest,
        slug: target.slug,
        installPath: target.installPath,
        extensionsDir,
        timeoutMs: Math.max(30_000, deadline - Date.now()),
      });
      // The extension was copied out of the read-only bundle so its
      // node_modules could sit beside it; the row has to follow or the next
      // boot loads from a directory where nothing resolves.
      if (installPath !== target.installPath) {
        service.setInstallPath(target.id, installPath);
      }
      result.provisioned.push(target.slug);
      log.info(`Extension auto-provision: ${target.slug} ready (${installed.join(", ")})`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ slug: target.slug, error });
      log.warn(`Extension auto-provision: ${target.slug} not provisioned — ${error}`);
      // Record it on the row. A failure that only reaches the log leaves the
      // extension sitting in `installed` with an empty reason, so the UI shows
      // a feature that is simply absent and the operator has nothing to act
      // on — which is exactly how a parked Cinema looked like a broken build.
      try { service.setProvisionError(target.id, error); } catch { /* best effort */ }
    }
  }

  if (result.provisioned.length > 0) {
    log.info(
      `Extension auto-provision: ${result.provisioned.length} extension(s) will activate on the next restart ` +
        `(${result.provisioned.join(", ")})`,
    );
  }
  return result;
}
