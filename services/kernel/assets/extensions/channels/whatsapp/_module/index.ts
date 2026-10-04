import { notificationChannelModule } from "@kernl/extension-sdk";
import { WhatsAppProvider } from "./whatsapp-provider.js";

/**
 * WhatsApp channel extension — registers the WhatsApp notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 * The MtwConnection injection (via `setMtwConnection()`) is done by the
 * kernel bootstrap once mtwRequest is wired up.
 */
export function createWhatsAppModule() {
  return notificationChannelModule("ext:whatsapp", "whatsapp", () => new WhatsAppProvider());
}

export { WhatsAppProvider, setMtwConnection } from "./whatsapp-provider.js";
