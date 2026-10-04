import { notificationChannelModule } from "@kernl/extension-sdk";
import { DashboardProvider } from "./dashboard-provider.js";

/**
 * Dashboard notifications channel extension — registers the in-app
 * dashboard notification provider factory on the NotificationRegistry.
 * The dashboard DB + broadcast function are injected via a pre-start
 * hook from `bootstrap/http.ts`.
 */
export function createDashboardNotificationsModule() {
  return notificationChannelModule("ext:dashboard-notifications", "dashboard-notifications", () => new DashboardProvider());
}

export { DashboardProvider } from "./dashboard-provider.js";
export type { StoredNotification } from "./dashboard-provider.js";
