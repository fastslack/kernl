import type { MarketplaceService } from "../service.js";
import { log } from "../../../core/logger.js";

interface SkillRegistryLike {
  install(source: { type: string; id: string }): Promise<string | null>;
  enableSkill(skillId: string): Promise<boolean>;
}

/**
 * Install an extension package — delegates to SkillRegistry.
 */
export async function installExtension(
  service: MarketplaceService,
  skillRegistry: SkillRegistryLike | null,
  itemId: string,
): Promise<boolean> {
  try {
    const item = service.getItem(itemId);
    if (!item || item.type !== "extension") return false;

    if (!skillRegistry) {
      log.warn("Marketplace: SkillRegistry not available, marking as installed only");
      service.installItem(itemId);
      return true;
    }

    // Delegate to skill registry
    const skillId = await skillRegistry.install({ type: "bundled", id: item.slug });
    if (skillId) {
      await skillRegistry.enableSkill(skillId);
    }

    service.installItem(itemId);
    return true;
  } catch (err) {
    log.error("Extension installation failed", err);
    return false;
  }
}
