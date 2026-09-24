import { notificationChannelModule } from "@kernl/extension-sdk";
import { SlackProvider } from "./slack-provider.js";

/**
 * Slack channel extension — registers the Slack notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 */
export function createSlackModule() {
  return notificationChannelModule("ext:slack", "slack", () => new SlackProvider());
}

export { SlackProvider };
