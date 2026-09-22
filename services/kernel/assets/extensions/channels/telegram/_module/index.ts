import { notificationChannelModule } from "@kernl/extension-sdk";
import { TelegramProvider } from "./telegram-provider.js";

/**
 * Telegram channel extension — registers the Telegram notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 * The actual provider instance is created on demand by
 * `NotificationRegistry.startAll()` once the user activates the channel
 * through the marketplace.
 */
export function createTelegramModule() {
  return notificationChannelModule("ext:telegram", "telegram", () => new TelegramProvider());
}

export { TelegramProvider };
