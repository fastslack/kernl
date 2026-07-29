import { log } from "../../../../../src/core/logger.js";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../../../../../src/core/notify/provider.js";

export class MattermostProvider implements NotificationProvider {
  readonly id = "mattermost";
  readonly name = "Mattermost";
  readonly icon = "💬";
  readonly capabilities: ProviderCapability[] = ["notify"];

  private webhookUrl = "";
  private username = "Kernl";
  private channelId = "";
  private iconUrl = "";
  private ready = false;

  getConfigSchema(): ConfigField[] {
    return [
      { key: "webhookUrl", label: "Webhook URL", type: "password", required: true, placeholder: "https://mattermost.example.com/hooks/...", description: "Incoming webhook URL from Mattermost" },
      { key: "username", label: "Bot Username", type: "text", required: false, default: "Kernl", placeholder: "Kernl" },
      { key: "channelId", label: "Channel ID", type: "text", required: false, placeholder: "Optional — override webhook channel" },
      { key: "iconUrl", label: "Icon URL", type: "text", required: false, placeholder: "https://..." },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!config.webhookUrl || typeof config.webhookUrl !== "string" || !config.webhookUrl.startsWith("http")) {
      errors.push("webhookUrl is required and must be a valid URL");
    }
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    this.webhookUrl = (config.webhookUrl as string) ?? "";
    this.username = (config.username as string) || "Kernl";
    this.channelId = (config.channelId as string) ?? "";
    this.iconUrl = (config.iconUrl as string) ?? "";
  }

  async start(): Promise<void> {
    if (!this.webhookUrl) throw new Error("Mattermost webhook URL not configured");
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready && this.webhookUrl.length > 0;
  }

  getStatus(): ProviderStatus {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      connected: this.ready,
      enabled: this.webhookUrl.length > 0,
      capabilities: this.capabilities,
    };
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady()) return false;
    const text = this.formatPayload(payload);
    try {
      await this.postWebhook(text);
      return true;
    } catch (err) {
      log.error("Mattermost notification failed", err);
      return false;
    }
  }

  async sendTest(): Promise<boolean> {
    return this.sendNotification({
      title: "Kernl — Mattermost test",
      body: "Notification channel working!",
    });
  }

  private formatPayload(payload: NotificationPayload): string {
    const prefix = payload.priority === "high" ? ":rotating_light: " : "";
    const lines = [`${prefix}**${payload.title}**`];
    if (payload.body) lines.push(payload.body);
    return lines.join("\n");
  }

  private async postWebhook(text: string): Promise<void> {
    const body: Record<string, string> = { text, username: this.username };
    if (this.channelId) body.channel = this.channelId;
    if (this.iconUrl) body.icon_url = this.iconUrl;

    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Mattermost ${res.status}: ${await res.text()}`);
  }
}
