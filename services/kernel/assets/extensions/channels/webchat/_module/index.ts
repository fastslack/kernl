import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { WebChatProvider } from "./webchat-provider.js";

/**
 * WebChat channel extension — registers the WebChat notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 * The HTTP server is attached via a pre-start hook in `bootstrap/http.ts`.
 */
export function createWebChatModule(): KernelModule {
  return {
    name: "ext:webchat",
    async initialize(ctx: ModuleContext) {
      ctx.notifier
        .getRegistry()
        .registerFactory("webchat", () => new WebChatProvider());
    },
    getTools(): ToolDefinition[] {
      return [];
    },
    async shutdown() {},
  };
}

export { WebChatProvider };
