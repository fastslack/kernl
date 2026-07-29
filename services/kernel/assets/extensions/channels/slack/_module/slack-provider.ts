import { log } from "../../../../../src/core/logger.js";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../../../../../src/core/notify/provider.js";
import type { ChannelTransport } from "../../../../../src/channels/types.js";

export class SlackProvider implements NotificationProvider {
  readonly id = "slack";
  readonly name = "Slack";
  readonly icon = "💼";
  readonly capabilities: ProviderCapability[] = ["notify", "receive", "buttons", "reactions"];

  private transport: ChannelTransport | null = null;
  private config: Record<string, unknown> = {};
  private ready = false;
  private error: string | undefined;

  getConfigSchema(): ConfigField[] {
    return [
      { key: "botToken", label: "Bot Token", type: "password", required: true, placeholder: "xoxb-...", description: "Slack bot token" },
      { key: "appToken", label: "App Token", type: "password", required: true, placeholder: "xapp-...", description: "Slack app-level token for Socket Mode" },
      { key: "signingSecret", label: "Signing Secret", type: "password", required: false },
      { key: "allowedUsers", label: "Allowed User IDs", type: "text", required: false, placeholder: "U123456,U654321" },
      { key: "allowedChannels", label: "Allowed Channel IDs", type: "text", required: false, placeholder: "C123456,C654321" },
      { key: "defaultChannel", label: "Default Channel", type: "text", required: false, placeholder: "C123456", description: "Channel for proactive notifications" },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!config.botToken || typeof config.botToken !== "string") errors.push("botToken is required");
    if (!config.appToken || typeof config.appToken !== "string") errors.push("appToken is required");
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    this.config = config;
  }

  async start(): Promise<void> {
    try {
      const { SlackTransport } = await import("./slack-transport.js");
      const split = (s: unknown) => typeof s === "string" ? s.split(",").map((v) => v.trim()).filter(Boolean) : [];
      this.transport = new SlackTransport({
        enabled: true,
        botToken: this.config.botToken as string,
        appToken: this.config.appToken as string,
        signingSecret: (this.config.signingSecret as string) || undefined,
        allowedUsers: split(this.config.allowedUsers),
        allowedChannels: split(this.config.allowedChannels),
        defaultChannel: (this.config.defaultChannel as string) || undefined,
      });
      await this.transport.start();
      this.ready = this.transport.isReady();
      this.error = undefined;
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
    return this.ready && this.transport !== null && this.transport.isReady();
  }

  getStatus(): ProviderStatus {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      connected: this.isReady(),
      enabled: !!this.config.botToken,
      error: this.error,
      capabilities: this.capabilities,
    };
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady() || !this.transport?.sendToDefault) return false;
    const text = this.formatPayload(payload);
    try {
      await this.transport.sendToDefault({ text });
      return true;
    } catch (err) {
      log.error("Slack notification failed", err);
      return false;
    }
  }

  async sendTo(target: string, payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady() || !this.transport) return false;
    try {
      await this.transport.send(target, { text: this.formatPayload(payload) });
      return true;
    } catch (err) {
      log.error(`Slack send to ${target} failed`, err);
      return false;
    }
  }

  async sendTest(): Promise<boolean> {
    return this.sendNotification({
      title: "Kernl — Slack test",
      body: "Slack notification channel working!",
    });
  }

  getTransport(): ChannelTransport | null {
    return this.transport;
  }

  private formatPayload(payload: NotificationPayload): string {
    const prefix = payload.priority === "high" ? ":rotating_light: " : "";
    const lines = [`${prefix}*${payload.title}*`];
    if (payload.body) lines.push(payload.body);
    return lines.join("\n");
  }
}
