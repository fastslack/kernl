import {
  TransportNotificationProvider,
  csvList,
  type ProviderCapability,
  type ConfigField,
  type ChannelTransport,
} from "@kernl/extension-sdk";

export class DiscordProvider extends TransportNotificationProvider {
  readonly id = "discord";
  readonly name = "Discord";
  readonly icon = "🎮";
  readonly capabilities: ProviderCapability[] = ["notify", "receive", "buttons", "reactions"];
  protected readonly style = { bold: "**", alert: "🚨 " };
  protected readonly requiredKeys = ["botToken"];

  getConfigSchema(): ConfigField[] {
    return [
      { key: "botToken", label: "Bot Token", type: "password", required: true, description: "Discord bot token from Developer Portal" },
      { key: "allowedUsers", label: "Allowed User IDs", type: "text", required: false, placeholder: "123456,654321" },
      { key: "allowedGuilds", label: "Allowed Guild IDs", type: "text", required: false, placeholder: "123456" },
      { key: "allowedChannels", label: "Allowed Channel IDs", type: "text", required: false, placeholder: "123456,654321" },
      { key: "defaultChannel", label: "Default Channel", type: "text", required: false, description: "Channel ID for proactive notifications" },
    ];
  }

  protected async createTransport(config: Record<string, unknown>): Promise<ChannelTransport> {
    const { DiscordTransport } = await import("./discord-transport.js");
    return new DiscordTransport({
      enabled: true,
      botToken: config.botToken as string,
      allowedUsers: csvList(config.allowedUsers),
      allowedGuilds: csvList(config.allowedGuilds),
      allowedChannels: csvList(config.allowedChannels),
      defaultChannel: (config.defaultChannel as string) || undefined,
    });
  }
}
