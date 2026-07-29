import type { MarketplaceService } from "../service.js";
import { log } from "../../../core/logger.js";

/**
 * Install a template package — stores content in package_data, marks as installed.
 */
export function installTemplate(
  service: MarketplaceService,
  itemId: string,
): boolean {
  try {
    const item = service.getItem(itemId);
    if (!item || item.type !== "template") return false;

    service.installItem(itemId);
    log.info(`Marketplace: installed template "${item.name}"`);
    return true;
  } catch (err) {
    log.error("Template installation failed", err);
    return false;
  }
}
