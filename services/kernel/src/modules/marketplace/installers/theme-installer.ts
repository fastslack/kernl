import type { MarketplaceService } from "../service.js";
import type { ThemePackage } from "../types.js";
import { log } from "../../../core/logger.js";

/**
 * Install a theme package — validates and creates theme row.
 */
export function installTheme(
  service: MarketplaceService,
  itemId: string,
): boolean {
  try {
    const item = service.getItem(itemId);
    if (!item || item.type !== "theme") return false;

    // Theme row is already created during import
    // Just activate installation status
    service.installItem(itemId);
    return true;
  } catch (err) {
    log.error("Theme installation failed", err);
    return false;
  }
}
