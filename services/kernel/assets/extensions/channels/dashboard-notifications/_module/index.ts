import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { DashboardProvider } from "./dashboard-provider.js";

/**
 * Dashboard notifications channel extension — registers the in-app
 * dashboard notification provider factory on the NotificationRegistry.
 * The dashboard DB + broadcast function are injected via a pre-start
 * hook from `bootstrap/http.ts`.
 */
export function createDashboardNotificationsModule(): KernelModule {
  return {
    name: "ext:dashboard-notifications",
    async initialize(ctx: ModuleContext) {
      ctx.notifier
        .getRegistry()
        .registerFactory("dashboard-notifications", () => new DashboardProvider());
    },
    getTools(): ToolDefinition[] {
      return [];
    },
    async shutdown() {},
  };
}

export { DashboardProvider } from "./dashboard-provider.js";
export type { StoredNotification } from "./dashboard-provider.js";
