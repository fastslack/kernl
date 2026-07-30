/**
 * Install a licensed store item — the one implementation, shared by all three
 * callers: the `kernel_store_install` MCP tool, the `/api/store/install` HTTP
 * route, and the catalog registry's store install path.
 *
 * The license JWT is the download credential: the store serves a bundle only to
 * a license carrying the item's `pro:<slug>` feature. Everything here assumes
 * the caller already has one — resolving/applying licenses is not this file's
 * job.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { ExtensionService } from "../extensions/service.js";
import type { InstalledExtension } from "../extensions/types.js";
import type { AgentService } from "../agents/service.js";
import { materializeOffice, officeDefinitionFromJson } from "../agents/office-kit.js";
import {
  downloadStoreBundle,
  downloadStoreText,
  fetchStoreCatalog,
  type StoreCatalogItem,
} from "./client.js";

export const DEFAULT_STORE_URL = "https://issuer.lifekernl.com";

export type StoreInstallResult =
  | { kind: "extension"; item: StoreCatalogItem; installed: InstalledExtension }
  | { kind: "office"; item: StoreCatalogItem; officeName: string; agents: string[] };

export interface StoreInstallDeps {
  storeUrl: string;
  slug: string;
  licenseJwt: string;
  getExtensionService: () => ExtensionService | null;
  getAgentService?: () => AgentService | null;
  sqlite?: SqliteDb;
  fetchImpl?: typeof fetch;
}

/**
 * Download and install `slug`. Throws with the store's own error text on 401
 * (no/expired license), 403 (license lacks the feature) and 404 (unknown or
 * unpublished), so callers can surface it verbatim.
 */
export async function installFromStore(deps: StoreInstallDeps): Promise<StoreInstallResult> {
  const item = (await fetchStoreCatalog(deps.storeUrl, deps.fetchImpl ?? fetch)).find(
    (i) => i.slug === deps.slug,
  );
  if (!item) {
    throw new Error(`Unknown store item "${deps.slug}".`);
  }

  return item.type === "office"
    ? installOffice(item, deps)
    : installExtension(item, deps);
}

async function installExtension(
  item: StoreCatalogItem,
  deps: StoreInstallDeps,
): Promise<StoreInstallResult> {
  const service = deps.getExtensionService();
  if (!service) throw new Error("Extensions service is not available.");

  const dl = await downloadStoreBundle({
    storeUrl: deps.storeUrl,
    slug: item.slug,
    licenseJwt: deps.licenseJwt,
    fetchImpl: deps.fetchImpl,
  });

  const installed = await service.installFromBundle(dl.path, {
    type: "url",
    url: dl.downloadUrl,
  });
  return { kind: "extension", item, installed };
}

async function installOffice(
  item: StoreCatalogItem,
  deps: StoreInstallDeps,
): Promise<StoreInstallResult> {
  const service = deps.getAgentService?.() ?? null;
  if (!service) throw new Error("Agents service is not available.");
  if (!deps.sqlite) throw new Error("Office install needs a database handle.");

  const text = await downloadStoreText({
    storeUrl: deps.storeUrl,
    slug: item.slug,
    licenseJwt: deps.licenseJwt,
    fetchImpl: deps.fetchImpl,
  });

  let def;
  try {
    def = officeDefinitionFromJson(JSON.parse(text));
  } catch (e) {
    throw new Error(`Invalid office blueprint: ${e instanceof Error ? e.message : String(e)}`);
  }

  materializeOffice(deps.sqlite, service, def);
  return {
    kind: "office",
    item,
    officeName: def.name,
    agents: def.agents.map((a) => a.name),
  };
}
