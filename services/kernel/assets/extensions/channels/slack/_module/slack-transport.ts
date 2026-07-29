/**
 * Slack Channel Transport
 * Uses @slack/bolt for Slack API
 */

import { App, LogLevel } from "@slack/bolt";
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

export class SlackTransport implements ChannelTransport {
  readonly platform = "slack" as const;

  private app: App | null = null;
  private messageHandler: ChannelMessageHandler | null = null;
  private callbackHandler: ChannelCallbackHandler | null = null;
  private connected = false;
  private authenticated = false;
  private error: string | undefined;
  private botUserId: string | undefined;
  private botName: string | undefined;

  constructor(private config: NonNullable<ChannelConfig["slack"]>) {}

  getStatus(): ChannelStatus {
    return {
      platform: "slack",
      connected: this.connected,
      authenticated: this.authenticated,
      error: this.error,
      info: {
        botUserId: this.botUserId,
        botName: this.botName,
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
    log.info("Slack: starting...");

    try {
      this.app = new App({
        token: this.config.botToken,
        appToken: this.config.appToken,
        socketMode: true,
        logLevel: LogLevel.WARN,
      });

      // Handle all messages
      this.app.message(async ({ message, say, client }) => {
        await this.handleMessage(message, say, client);
      });

      // Handle app mentions (@bot)
      this.app.event("app_mention", async ({ event, say, client }) => {
        await this.handleMention(event, say, client);
      });

      // Handle button actions
      this.app.action(/^callback:.*/, async ({ action, ack, body, client }) => {
        await ack();
        await this.handleAction(action, body, client);
      });

      // Handle direct messages
      this.app.event("message", async ({ event, say, client }) => {
        // Only handle DMs not caught by app.message
        if ((event as { channel_type?: string }).channel_type === "im") {
          await this.handleMessage(event, say, client);
        }
      });

      // Start the app
      await this.app.start();

      // Get bot info
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id;
      this.botName = authResult.user;

      this.connected = true;
      this.authenticated = true;
      log.info(`Slack: connected as @${this.botName} (${this.botUserId})`);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      this.error = error;
      log.error(`Slack: failed to start - ${error}`);
      throw err;
    }
  }

  async stop(): Promise<void> {
    log.info("Slack: stopping...");
    
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }

    this.connected = false;
    this.authenticated = false;
    log.info("Slack: stopped");
  }

  private async handleMessage(
    message: unknown,
    say: (text: string) => Promise<unknown>,
    client: unknown
  ): Promise<void> {
    if (!this.messageHandler) return;

    const msg = message as {
      text?: string;
      user?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      channel_type?: string;
      subtype?: string;
      bot_id?: string;
      files?: Array<{
        id: string;
        name: string;
        mimetype: string;
        url_private: string;
      }>;
    };

    // Skip bot messages and subtypes (edits, deletes, etc.)
    if (msg.bot_id || msg.subtype) return;
    if (!msg.text || !msg.user || !msg.channel || !msg.ts) return;

    // Check user whitelist
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(msg.user)) {
      log.warn(`Slack: unauthorized message from ${msg.user}`);
      return;
    }

    // Check channel whitelist
    if (this.config.allowedChannels.length > 0 && !this.config.allowedChannels.includes(msg.channel)) {
      // Allow DMs even if not in channel whitelist
      if (msg.channel_type !== "im") {
        log.debug(`Slack: ignoring message from non-whitelisted channel ${msg.channel}`);
        return;
      }
    }

    // Get user info for display name
    let displayName = msg.user;
    try {
      const slackClient = client as { users: { info: (opts: { user: string }) => Promise<{ user?: { real_name?: string; name?: string } }> } };
      const userInfo = await slackClient.users.info({ user: msg.user });
      displayName = userInfo.user?.real_name || userInfo.user?.name || msg.user;
    } catch (err) {
      log.debug('Failed to fetch Slack user info', err);
    }

    const isGroup = msg.channel_type !== "im";
    const isReply = !!msg.thread_ts && msg.thread_ts !== msg.ts;

    // Build message object
    const channelMessage: ChannelMessage = {
      text: msg.text,
      context: {
        messageId: msg.ts,
        userId: msg.user,
        chatId: msg.channel,
        platform: "slack",
        username: msg.user,
        displayName,
        isGroup,
        isReply,
        replyToMessageId: msg.thread_ts,
        raw: message,
      },
      attachments: [],
    };

    // Handle file attachments
    if (msg.files?.length) {
      for (const file of msg.files) {
        const type = this.getAttachmentType(file.mimetype);
        channelMessage.attachments!.push({
          type,
          url: file.url_private,
          filename: file.name,
          mimeType: file.mimetype,
        });
      }
    }

    log.info(`Slack: message from ${displayName}: "${msg.text.slice(0, 50)}..."`);

    try {
      const response = await this.messageHandler(channelMessage);
      
      // Use thread_ts if replying in thread
      const threadTs = msg.thread_ts || msg.ts;
      
      await this.sendResponse(msg.channel, response, threadTs);
    } catch (err) {
      log.error("Slack: handler error", err);
      await say("Error processing message. Check logs.");
    }
  }

  private async handleMention(
    event: unknown,
    say: (text: string) => Promise<unknown>,
    client: unknown
  ): Promise<void> {
    // Treat mentions same as messages
    const evt = event as { text?: string; user?: string; channel?: string; ts?: string; thread_ts?: string };
    
    // Remove bot mention from text
    let text = evt.text || "";
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
    }

    await this.handleMessage({ ...evt, text }, say, client);
  }

  private async handleAction(
    action: unknown,
    body: unknown,
    client: unknown
  ): Promise<void> {
    if (!this.callbackHandler) return;

    const act = action as { action_id?: string; value?: string };
    const bdy = body as { 
      user?: { id?: string; name?: string };
      channel?: { id?: string };
      message?: { ts?: string };
    };

    if (!act.action_id?.startsWith("callback:")) return;

    const callbackData = act.action_id.replace("callback:", "");
    
    const context = {
      messageId: bdy.message?.ts || "",
      userId: bdy.user?.id || "",
      chatId: bdy.channel?.id || "",
      platform: "slack" as const,
      username: bdy.user?.name,
      isGroup: true,
      isReply: false,
    };

    try {
      const response = await this.callbackHandler(callbackData, context);
      
      if (bdy.channel?.id) {
        await this.send(bdy.channel.id, response);
      }
    } catch (err) {
      log.error("Slack: action handler error", err);
    }
  }

  private getAttachmentType(mimeType: string): ChannelAttachment["type"] {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    return "document";
  }

  async send(chatId: string, response: ChannelResponse): Promise<string> {
    if (!this.app || !this.isReady()) {
      throw new Error("Slack: not connected");
    }

    return this.sendResponse(chatId, response);
  }

  private async sendResponse(
    channel: string,
    response: ChannelResponse,
    threadTs?: string
  ): Promise<string> {
    if (!this.app) throw new Error("Slack: not connected");

    // Build message options
    const options: {
      channel: string;
      text: string;
      thread_ts?: string;
      unfurl_links: boolean;
      blocks?: unknown[];
    } = {
      channel,
      text: response.text,
      thread_ts: threadTs,
      unfurl_links: false,
    };

    // Add blocks for rich formatting
    const blocks: unknown[] = [];
    
    // Main text block
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: response.text,
      },
    });

    // Add buttons if present
    if (response.buttons?.length) {
      const buttonElements = response.buttons.flat().map((btn) => ({
        type: "button",
        text: {
          type: "plain_text",
          text: btn.text,
        },
        action_id: `callback:${btn.callbackData}`,
      }));

      blocks.push({
        type: "actions",
        elements: buttonElements,
      });
    }

    options.blocks = blocks;

    const result = await this.app.client.chat.postMessage(options as Parameters<typeof this.app.client.chat.postMessage>[0]);

    return result.ts || "";
  }

  async sendToDefault(response: ChannelResponse): Promise<string | null> {
    if (!this.config.defaultChannel) {
      log.warn("Slack: no default channel configured");
      return null;
    }
    return this.send(this.config.defaultChannel, response);
  }

  async editMessage(chatId: string, messageId: string, response: ChannelResponse): Promise<void> {
    if (!this.app) return;

    await this.app.client.chat.update({
      channel: chatId,
      ts: messageId,
      text: response.text,
    });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.app) return;

    await this.app.client.chat.delete({
      channel: chatId,
      ts: messageId,
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    // Slack doesn't have a typing indicator API for bots
    // This is a no-op
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.app) return;

    // Remove colons from emoji name if present
    const emojiName = emoji.replace(/:/g, "");

    await this.app.client.reactions.add({
      channel: chatId,
      timestamp: messageId,
      name: emojiName,
    });
  }
}
