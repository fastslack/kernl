import { log } from "../../../../../src/core/logger.js";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../../../../../src/core/notify/provider.js";
import type { ChannelTransport } from "../../../../../src/channels/types.js";

export class DiscordProvider implements NotificationProvider {
  readonly id = "discord";
  readonly name = "Discord";
  readonly icon = "🎮";
  readonly capabilities: ProviderCapability[] = ["notify", "receive", "buttons", "reactions"];

  private transport: ChannelTransport | null = null;
  private config: Record<string, unknown> = {};
  private ready = false;
  private error: string | undefined;

  getConfigSchema(): ConfigField[] {
    return [
      { key: "botToken", label: "Bot Token", type: "password", required: true, description: "Discord bot token from Developer Portal" },
      { key: "allowedUsers", label: "Allowed User IDs", type: "text", required: false, placeholder: "123456,654321" },
      { key: "allowedGuilds", label: "Allowed Guild IDs", type: "text", required: false, placeholder: "123456" },
      { key: "allowedChannels", label: "Allowed Channel IDs", type: "text", required: false, placeholder: "123456,654321" },
      { key: "defaultChannel", label: "Default Channel", type: "text", required: false, description: "Channel ID for proactive notifications" },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!config.botToken || typeof config.botToken !== "string") errors.push("botToken is required");
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    this.config = config;
  }

  async start(): Promise<void> {
    try {
      const { DiscordTransport } = await import("./discord-transport.js");
      const split = (s: unknown) => typeof s === "string" ? s.split(",").map((v) => v.trim()).filter(Boolean) : [];
      this.transport = new DiscordTransport({
        enabled: true,
        botToken: this.config.botToken as string,
        allowedUsers: split(this.config.allowedUsers),
        allowedGuilds: split(this.config.allowedGuilds),
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
      log.error("Discord notification failed", err);
      return false;
    }
  }

  async sendTo(target: string, payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady() || !this.transport) return false;
    try {
      await this.transport.send(target, { text: this.formatPayload(payload) });
      return true;
    } catch (err) {
      log.error(`Discord send to ${target} failed`, err);
      return false;
    }
  }

  async sendTest(): Promise<boolean> {
    return this.sendNotification({
      title: "Kernl — Discord test",
      body: "Discord notification channel working!",
    });
  }

  getTransport(): ChannelTransport | null {
    return this.transport;
  }

  private formatPayload(payload: NotificationPayload): string {
    const prefix = payload.priority === "high" ? "🚨 " : "";
    const lines = [`${prefix}**${payload.title}**`];
    if (payload.body) lines.push(payload.body);
    return lines.join("\n");
  }
}
