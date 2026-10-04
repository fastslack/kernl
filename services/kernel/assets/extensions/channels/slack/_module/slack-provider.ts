import {
  TransportNotificationProvider,
  csvList,
  type ProviderCapability,
  type ConfigField,
  type ChannelTransport,
} from "@kernl/extension-sdk";

export class SlackProvider extends TransportNotificationProvider {
  readonly id = "slack";
  readonly name = "Slack";
  readonly icon = "💼";
  readonly capabilities: ProviderCapability[] = ["notify", "receive", "buttons", "reactions"];
  protected readonly style = { bold: "*", alert: ":rotating_light: " };
  protected readonly requiredKeys = ["botToken", "appToken"];

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

  protected async createTransport(config: Record<string, unknown>): Promise<ChannelTransport> {
    const { SlackTransport } = await import("./slack-transport.js");
    return new SlackTransport({
      enabled: true,
      botToken: config.botToken as string,
      appToken: config.appToken as string,
      signingSecret: (config.signingSecret as string) || undefined,
      allowedUsers: csvList(config.allowedUsers),
      allowedChannels: csvList(config.allowedChannels),
      defaultChannel: (config.defaultChannel as string) || undefined,
    });
  }
}
