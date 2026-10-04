import { notificationChannelModule } from "@kernl/extension-sdk";
import { MattermostProvider } from "./mattermost-provider.js";

/**
 * Mattermost channel extension — registers the Mattermost notification
 * provider factory on the kernel-wide NotificationRegistry during
 * `initialize()`. The actual provider instance is created on demand by
 * `NotificationRegistry.startAll()` (run during late-services bootstrap)
 * once the user activates the channel through the marketplace.
 */
export function createMattermostModule() {
  return notificationChannelModule("ext:mattermost", "mattermost", () => new MattermostProvider());
}

export { MattermostProvider };
