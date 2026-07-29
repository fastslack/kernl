import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { SlackProvider } from "./slack-provider.js";

/**
 * Slack channel extension — registers the Slack notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 */
export function createSlackModule(): KernelModule {
  return {
    name: "ext:slack",
    async initialize(ctx: ModuleContext) {
      ctx.notifier
        .getRegistry()
        .registerFactory("slack", () => new SlackProvider());
    },
    getTools(): ToolDefinition[] {
      return [];
    },
    async shutdown() {},
  };
}

export { SlackProvider };
