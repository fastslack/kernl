import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { DiscordProvider } from "./discord-provider.js";

/**
 * Discord channel extension — registers the Discord notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 */
export function createDiscordModule(): KernelModule {
  return {
    name: "ext:discord",
    async initialize(ctx: ModuleContext) {
      ctx.notifier
        .getRegistry()
        .registerFactory("discord", () => new DiscordProvider());
    },
    getTools(): ToolDefinition[] {
      return [];
    },
    async shutdown() {},
  };
}

export { DiscordProvider };
