import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { WhatsAppProvider } from "./whatsapp-provider.js";

/**
 * WhatsApp channel extension — registers the WhatsApp notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 * The MtwConnection injection (via `setMtwConnection()`) is done by the
 * kernel bootstrap once mtwRequest is wired up.
 */
export function createWhatsAppModule(): KernelModule {
  return {
    name: "ext:whatsapp",
    async initialize(ctx: ModuleContext) {
      ctx.notifier
        .getRegistry()
        .registerFactory("whatsapp", () => new WhatsAppProvider());
    },
    getTools(): ToolDefinition[] {
      return [];
    },
    async shutdown() {},
  };
}

export { WhatsAppProvider, setMtwConnection } from "./whatsapp-provider.js";
