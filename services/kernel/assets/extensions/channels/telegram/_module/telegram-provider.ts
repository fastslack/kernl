import { log } from "../../../../../src/core/logger.js";
import { TelegramTransport } from "./telegram-transport.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../../../../../src/core/notify/provider.js";

/**
 * Telegram provider — wraps TelegramTransport.
 * Config (botToken, allowedUserIds, defaultChatId) comes from marketplace package_data.
 */
export class TelegramProvider implements NotificationProvider {
  readonly id = "telegram";
  readonly name = "Telegram";
  readonly icon = "✈️";
  readonly capabilities: ProviderCapability[] = ["notify", "receive", "buttons", "media", "voice"];

  private transport: TelegramTransport | null = null;
  private config: KernelConfig["telegram"] | null = null;
  private ready = false;
  private error: string | undefined;

  getConfigSchema(): ConfigField[] {
    return [
      { key: "botToken", label: "Bot Token", type: "password", required: true, placeholder: "123456:ABC-DEF...", description: "Token from @BotFather" },
      { key: "allowedUserIds", label: "Allowed User IDs", type: "text", required: false, placeholder: "123456,789012", description: "Comma-separated Telegram user IDs (empty = no one allowed)" },
      { key: "defaultChatId", label: "Default Chat ID", type: "text", required: false, placeholder: "123456", description: "Chat ID for proactive notifications" },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!config.botToken || typeof config.botToken !== "string") {
      errors.push("botToken is required");
    }
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    const allowedStr = (config.allowedUserIds as string) ?? "";
    const allowedIds = allowedStr
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));

    const defaultChat = config.defaultChatId
      ? parseInt(config.defaultChatId as string, 10)
      : null;

    this.config = {
      enabled: true,
      botToken: config.botToken as string,
      allowedUserIds: allowedIds,
      defaultChatId: isNaN(defaultChat as number) ? null : defaultChat,
    };
  }

  async start(): Promise<void> {
    if (!this.config?.botToken) throw new Error("Telegram bot token not configured");
    try {
      this.transport = new TelegramTransport(this.config);
      await this.transport.start();
      this.ready = true;
      this.error = undefined;
      log.info("TelegramProvider started");
    } catch (err) {
      this.error = String(err);
      this.ready = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready && this.transport !== null;
  }

  getStatus(): ProviderStatus {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      connected: this.ready,
      enabled: !!this.config?.botToken,
      error: this.error,
      capabilities: this.capabilities,
    };
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady() || !this.transport) return false;
    const text = this.formatPayload(payload);
    try {
      await this.transport.sendToDefault(text, { disableNotification: payload.silent });
      return true;
    } catch (err) {
      log.error("Telegram notification failed", err);
      return false;
    }
  }

  async sendTo(target: string, payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady() || !this.transport) return false;
    const chatId = parseInt(target, 10);
    if (isNaN(chatId)) return false;
    const text = this.formatPayload(payload);
    try {
      await this.transport.send(chatId, text);
      return true;
    } catch (err) {
      log.error(`Telegram send to ${target} failed`, err);
      return false;
    }
  }

  async sendTest(): Promise<boolean> {
    return this.sendNotification({
      title: "Kernl — Telegram test",
      body: "Telegram notification channel working!",
    });
  }

  /** Expose inner transport for orchestrator message routing */
  getTransport(): TelegramTransport | null {
    return this.transport;
  }

  private formatPayload(payload: NotificationPayload): string {
    const prefix = payload.priority === "high" ? "🚨 " : "";
    const lines = [`${prefix}*${payload.title}*`];
    if (payload.body) lines.push(payload.body);
    return lines.join("\n");
  }
}
