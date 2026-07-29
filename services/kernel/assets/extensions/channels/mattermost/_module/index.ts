import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { MattermostProvider } from "./mattermost-provider.js";

/**
 * Mattermost channel extension — registers the Mattermost notification
 * provider factory on the kernel-wide NotificationRegistry during
 * `initialize()`. The actual provider instance is created on demand by
 * `NotificationRegistry.startAll()` (run during late-services bootstrap)
 * once the user activates the channel through the marketplace.
 */
export function createMattermostModule(): KernelModule {
  return {
    name: "ext:mattermost",
    async initialize(ctx: ModuleContext) {
      ctx.notifier
        .getRegistry()
        .registerFactory("mattermost", () => new MattermostProvider());
    },
    getTools(): ToolDefinition[] {
      return [];
    },
    async shutdown() {},
  };
}

export { MattermostProvider };
