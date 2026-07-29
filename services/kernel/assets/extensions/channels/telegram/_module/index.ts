import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { TelegramProvider } from "./telegram-provider.js";

/**
 * Telegram channel extension — registers the Telegram notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 * The actual provider instance is created on demand by
 * `NotificationRegistry.startAll()` once the user activates the channel
 * through the marketplace.
 */
export function createTelegramModule(): KernelModule {
  return {
    name: "ext:telegram",
    async initialize(ctx: ModuleContext) {
      ctx.notifier
        .getRegistry()
        .registerFactory("telegram", () => new TelegramProvider());
    },
    getTools(): ToolDefinition[] {
      return [];
    },
    async shutdown() {},
  };
}

export { TelegramProvider };
