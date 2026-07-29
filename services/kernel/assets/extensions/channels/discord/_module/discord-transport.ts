/**
 * Discord Channel Transport
 * Uses discord.js for Discord API
 */

import {
  Client,
  GatewayIntentBits,
  Message,
  TextChannel,
  DMChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
  Events,
  Partials,
} from "discord.js";
import { log } from "../../../../../src/core/logger.js";
import type {
  ChannelTransport,
  ChannelMessageHandler,
  ChannelCallbackHandler,
  ChannelMessage,
  ChannelResponse,
  ChannelStatus,
  ChannelConfig,
  ChannelAttachment,
} from "../../../../../src/channels/types.js";

export class DiscordTransport implements ChannelTransport {
  readonly platform = "discord" as const;

  private client: Client | null = null;
  private messageHandler: ChannelMessageHandler | null = null;
  private callbackHandler: ChannelCallbackHandler | null = null;
  private connected = false;
  private authenticated = false;
  private error: string | undefined;
  private botUserId: string | undefined;
  private botUsername: string | undefined;

  constructor(private config: NonNullable<ChannelConfig["discord"]>) {}

  getStatus(): ChannelStatus {
    return {
      platform: "discord",
      connected: this.connected,
      authenticated: this.authenticated,
      error: this.error,
      info: {
        botUserId: this.botUserId,
        botUsername: this.botUsername,
      },
    };
  }

  isReady(): boolean {
    return this.connected && this.authenticated;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  onCallback(handler: ChannelCallbackHandler): void {
    this.callbackHandler = handler;
  }

  async start(): Promise<void> {
    log.info("Discord: starting...");

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMessageReactions,
        ],
        partials: [Partials.Channel, Partials.Message],
      });

      // Ready event
      this.client.once(Events.ClientReady, (readyClient) => {
        this.connected = true;
        this.authenticated = true;
        this.botUserId = readyClient.user.id;
        this.botUsername = readyClient.user.username;
        log.info(`Discord: connected as ${this.botUsername} (${this.botUserId})`);
      });

      // Message event
      this.client.on(Events.MessageCreate, async (message) => {
        await this.handleMessage(message);
      });

      // Button interaction event
      this.client.on(Events.InteractionCreate, async (interaction) => {
        await this.handleInteraction(interaction);
      });

      // Error event
      this.client.on(Events.Error, (err) => {
        log.error("Discord: client error", err);
        this.error = err.message;
      });

      // Login
      await this.client.login(this.config.botToken);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      this.error = error;
      log.error(`Discord: failed to start - ${error}`);
      throw err;
    }
  }

  async stop(): Promise<void> {
    log.info("Discord: stopping...");
    
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }

    this.connected = false;
    this.authenticated = false;
    log.info("Discord: stopped");
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!this.messageHandler) return;

    // Skip bot messages
    if (message.author.bot) return;

    // Skip messages without content
    if (!message.content && message.attachments.size === 0) return;

    const userId = message.author.id;
    const channelId = message.channel.id;
    const guildId = message.guild?.id;
    const isDM = !message.guild;

    // Check user whitelist
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(userId)) {
      log.warn(`Discord: unauthorized message from ${userId}`);
      return;
    }

    // Check guild whitelist (for server messages)
    if (!isDM && guildId && this.config.allowedGuilds.length > 0) {
      if (!this.config.allowedGuilds.includes(guildId)) {
        log.debug(`Discord: ignoring message from non-whitelisted guild ${guildId}`);
        return;
      }
    }

    // Check channel whitelist
    if (this.config.allowedChannels.length > 0 && !this.config.allowedChannels.includes(channelId)) {
      // Allow DMs even if not in channel whitelist
      if (!isDM) {
        log.debug(`Discord: ignoring message from non-whitelisted channel ${channelId}`);
        return;
      }
    }

    // Check if bot is mentioned (for guild messages)
    const isMentioned = message.mentions.users.has(this.botUserId || "");
    
    // In guilds, only respond if mentioned or if it's a DM
    if (!isDM && !isMentioned) {
      return;
    }

    // Remove bot mention from text
    let text = message.content;
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
    }

    const displayName = message.member?.displayName || message.author.displayName || message.author.username;

    // Check if it's a reply
    const isReply = !!message.reference?.messageId;
    const replyToMessageId = message.reference?.messageId;

    // Build message object
    const channelMessage: ChannelMessage = {
      text,
      context: {
        messageId: message.id,
        userId,
        chatId: channelId,
        platform: "discord",
        username: message.author.username,
        displayName,
        isGroup: !isDM,
        groupName: message.guild?.name,
        isReply,
        replyToMessageId,
        raw: message,
      },
      attachments: [],
    };

    // Handle attachments
    for (const [, attachment] of message.attachments) {
      const type = this.getAttachmentType(attachment.contentType || "");
      channelMessage.attachments!.push({
        type,
        url: attachment.url,
        filename: attachment.name || undefined,
        mimeType: attachment.contentType || undefined,
      });
    }

    log.info(`Discord: message from ${displayName}: "${text.slice(0, 50)}..."`);

    try {
      // Show typing indicator
      await this.sendTyping(channelId);

      const response = await this.messageHandler(channelMessage);
      await this.sendResponse(message.channel as TextChannel | DMChannel, response, message.id);
    } catch (err) {
      log.error("Discord: handler error", err);
      await message.reply("Error processing message. Check logs.");
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;
    if (!this.callbackHandler) {
      await interaction.reply({ content: "Not configured", ephemeral: true });
      return;
    }

    const callbackData = interaction.customId;
    
    const context = {
      messageId: interaction.message.id,
      userId: interaction.user.id,
      chatId: interaction.channelId,
      platform: "discord" as const,
      username: interaction.user.username,
      displayName: interaction.user.displayName,
      isGroup: !!interaction.guild,
      groupName: interaction.guild?.name,
      isReply: false,
    };

    try {
      const response = await this.callbackHandler(callbackData, context);
      
      await interaction.update({
        content: response.text,
        components: this.buildComponents(response.buttons),
      });
    } catch (err) {
      log.error("Discord: interaction handler error", err);
      await interaction.reply({ content: "Error processing action", ephemeral: true });
    }
  }

  private getAttachmentType(mimeType: string): ChannelAttachment["type"] {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    return "document";
  }

  private buildComponents(buttons?: ChannelResponse["buttons"]): ActionRowBuilder<ButtonBuilder>[] {
    if (!buttons?.length) return [];

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    for (const row of buttons) {
      const actionRow = new ActionRowBuilder<ButtonBuilder>();
      
      for (const btn of row) {
        actionRow.addComponents(
          new ButtonBuilder()
            .setCustomId(btn.callbackData)
            .setLabel(btn.text)
            .setStyle(ButtonStyle.Primary)
        );
      }

      rows.push(actionRow);
    }

    return rows;
  }

  async send(chatId: string, response: ChannelResponse): Promise<string> {
    if (!this.client || !this.isReady()) {
      throw new Error("Discord: not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord: channel ${chatId} not found or not a text channel`);
    }

    return this.sendResponse(channel as TextChannel | DMChannel, response);
  }

  private async sendResponse(
    channel: TextChannel | DMChannel,
    response: ChannelResponse,
    replyToId?: string
  ): Promise<string> {
    const options: {
      content: string;
      components?: ActionRowBuilder<ButtonBuilder>[];
      reply?: { messageReference: string };
    } = {
      content: response.text,
    };

    // Add buttons
    const components = this.buildComponents(response.buttons);
    if (components.length > 0) {
      options.components = components;
    }

    // Reply to specific message
    if (replyToId) {
      options.reply = { messageReference: replyToId };
    }

    const result = await channel.send(options);
    return result.id;
  }

  async sendToDefault(response: ChannelResponse): Promise<string | null> {
    if (!this.config.defaultChannel) {
      log.warn("Discord: no default channel configured");
      return null;
    }
    return this.send(this.config.defaultChannel, response);
  }

  async editMessage(chatId: string, messageId: string, response: ChannelResponse): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) return;

    const textChannel = channel as TextChannel | DMChannel;
    const message = await textChannel.messages.fetch(messageId);
    
    await message.edit({
      content: response.text,
      components: this.buildComponents(response.buttons),
    });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) return;

    const textChannel = channel as TextChannel | DMChannel;
    const message = await textChannel.messages.fetch(messageId);
    
    await message.delete();
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return;

    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel | DMChannel).sendTyping();
      }
    } catch (err) {
      log.debug('Failed to send Discord typing indicator', err);
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) return;

    const textChannel = channel as TextChannel | DMChannel;
    const message = await textChannel.messages.fetch(messageId);
    
    await message.react(emoji);
  }
}
