import { notificationChannelModule } from "@kernl/extension-sdk";
import { WebChatProvider } from "./webchat-provider.js";

/**
 * WebChat channel extension — registers the WebChat notification provider
 * factory on the kernel-wide NotificationRegistry during `initialize()`.
 * The HTTP server is attached via a pre-start hook in `bootstrap/http.ts`.
 */
export function createWebChatModule() {
  return notificationChannelModule("ext:webchat", "webchat", () => new WebChatProvider());
}

export { WebChatProvider };
