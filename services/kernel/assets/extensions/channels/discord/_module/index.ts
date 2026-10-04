import { notificationChannelModule } from "@kernl/extension-sdk";
import { DiscordProvider } from "./discord-provider.js";

/**
 * Discord channel extension — registers the Discord notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 */
export function createDiscordModule() {
  return notificationChannelModule("ext:discord", "discord", () => new DiscordProvider());
}

export { DiscordProvider };
