import type { OperatorChannelAdapter, OperatorMessage, SentRef } from "./types.js";
import type { TelegramProviderLike } from "../extension-seams.js";

type ProviderLike = {
  id: string; capabilities: string[]; isReady(): boolean;
  sendNotification(p: { title: string; body?: string; silent?: boolean }): Promise<boolean>;
} & Partial<TelegramProviderLike>;

/** The dashboard's provider ids: it has its own surface (the bell), never a channel here. */
const DASHBOARD_IDS = new Set(["dashboard", "dashboard-notifications"]);

/**
 * One adapter per notification provider that is running, except the dashboard
 * (it has its own surface). Telegram gets inline buttons and edit; everything
 * else is notify-only.
 */
export function buildAdapters(registry: { list(): ProviderLike[] }): OperatorChannelAdapter[] {
  return registry.list().filter((p) => !DASHBOARD_IDS.has(p.id)).map((p): OperatorChannelAdapter => {
    const transport = p.id === "telegram" ? p.getTransport?.() : null;
    const chat = p.getDefaultChatId?.() ?? null;
    if (transport && chat != null) {
      return {
        id: p.id, buttons: true, receive: true, isReady: () => p.isReady(),
        async send(m: OperatorMessage): Promise<SentRef | null> {
          const buttons = m.buttons?.map((r) => r.map((b) => ({ text: b.text, callbackData: b.data })));
          const id = await transport.send(chat, m.text, { parseMode: null, ...(m.silent ? { disableNotification: true } : {}), ...(buttons ? { buttons } : {}) });
          return id ? { target: String(chat), messageId: String(id) } : null;
        },
        async edit(ref: SentRef, text: string): Promise<void> {
          await transport.editMessage(Number(ref.target), Number(ref.messageId), text, null);
        },
      };
    }
    return {
      id: p.id, buttons: false, receive: p.capabilities.includes("receive"), isReady: () => p.isReady(),
      async send(m: OperatorMessage): Promise<SentRef | null> {
        const [title, ...rest] = m.text.split("\n");
        return (await p.sendNotification({ title, body: rest.length ? rest.join("\n") : undefined, silent: m.silent }))
          ? { target: "default", messageId: "" } : null;
      },
    };
  });
}
