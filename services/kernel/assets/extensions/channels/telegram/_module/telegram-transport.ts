import { Bot, Context, InputFile, InlineKeyboard, type NextFunction } from "grammy";
import { log } from "../../../../../src/core/logger.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { VoiceService } from "../../../../../src/voice/service.js";
import type { InlineButton } from "../../../../../src/core/extension-seams.js";

export type { InlineButton };

/** Context from an incoming Telegram message */
export interface TelegramMessageContext {
  userId: number;
  chatId: number;
  messageId: number;
  username?: string;
  firstName?: string;
  isReply: boolean;
  replyToMessageId?: number;
}

/** Response to send back to Telegram */
export interface TelegramResponse {
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  replyToMessageId?: number;
  disableNotification?: boolean;
  inlineKeyboard?: InlineButton[][];  // Rows of buttons
}

/** Handler for incoming messages */
export type TelegramMessageHandler = (
  text: string,
  context: TelegramMessageContext,
) => Promise<TelegramResponse>;

/** Handler for callback queries (inline button presses) */
export type TelegramCallbackHandler = (
  data: string,
  context: TelegramMessageContext,
) => Promise<TelegramResponse>;

/** Handler for voice messages */
export type TelegramVoiceHandler = (
  transcription: string,
  context: TelegramMessageContext,
) => Promise<TelegramResponse>;

/**
 * Telegram transport layer using grammy.
 * Handles authentication, message routing, and sending.
 */
export class TelegramTransport {
  private bot: Bot;
  private allowedUsers: Set<number>;
  private defaultChatId: number | null;
  private messageHandler: TelegramMessageHandler | null = null;
  private callbackHandler: TelegramCallbackHandler | null = null;
  private voiceHandler: TelegramVoiceHandler | null = null;
  private voiceService: VoiceService | null = null;
  private respondWithVoice = false;
  private running = false;

  constructor(private config: KernelConfig["telegram"]) {
    if (!config.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required");
    }
    this.bot = new Bot(config.botToken);
    this.allowedUsers = new Set(config.allowedUserIds);
    this.defaultChatId = config.defaultChatId;

    this.setupMiddleware();
    this.setupHandlers();
  }

  /** Check if a user is authorized */
  private isAuthorized(userId: number): boolean {
    // If no whitelist configured, allow no one (secure by default)
    if (this.allowedUsers.size === 0) {
      return false;
    }
    return this.allowedUsers.has(userId);
  }

  /** Auth middleware - only allow whitelisted users */
  private authMiddleware = async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;
    if (!userId) {
      log.warn("Telegram: message without user ID");
      return;
    }

    if (!this.isAuthorized(userId)) {
      log.warn(`Telegram: unauthorized access attempt from user ${userId}`);
      await ctx.reply("Unauthorized. Your user ID is: " + userId);
      return;
    }

    await next();
  };

  /** Extract message context from grammy context */
  private extractContext(ctx: Context): TelegramMessageContext {
    return {
      userId: ctx.from!.id,
      chatId: ctx.chat!.id,
      messageId: ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id ?? 0,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      isReply: !!ctx.message?.reply_to_message,
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
    };
  }

  private setupMiddleware(): void {
    // Log all updates in debug mode
    this.bot.use(async (ctx, next) => {
      log.debug(`Telegram update: ${ctx.update.update_id}`);
      await next();
    });

    // Auth middleware
    this.bot.use(this.authMiddleware);
  }

  private setupHandlers(): void {
    // Text messages
    this.bot.on("message:text", async (ctx) => {
      if (!this.messageHandler) {
        await ctx.reply("Bot not ready yet.");
        return;
      }

      const text = ctx.message.text;
      const context = this.extractContext(ctx);

      log.info(`Telegram: received from ${context.username ?? context.userId}: "${text.slice(0, 50)}..."`);

      try {
        const response = await this.messageHandler(text, context);

        // Build inline keyboard if provided
        let keyboard: InlineKeyboard | undefined;
        if (response.inlineKeyboard && response.inlineKeyboard.length > 0) {
          keyboard = new InlineKeyboard();
          for (const row of response.inlineKeyboard) {
            for (const btn of row) {
              keyboard.text(btn.text, btn.callbackData);
            }
            keyboard.row();
          }
        }

        // An empty text is a sentinel: the handler already delivered the
        // reply out-of-band (e.g. the top-agent stream edits its own message),
        // so we must NOT post a duplicate.
        if (response.text) {
          await ctx.reply(response.text, {
            parse_mode: response.parseMode ?? "Markdown",
            reply_parameters: response.replyToMessageId
              ? { message_id: response.replyToMessageId }
              : undefined,
            disable_notification: response.disableNotification,
            reply_markup: keyboard,
          });
        }
      } catch (err) {
        log.error("Telegram: handler error", err);
        await ctx.reply("Error processing message. Check logs.");
      }
    });

    // Callback queries (inline buttons)
    this.bot.on("callback_query:data", async (ctx) => {
      if (!this.callbackHandler) {
        await ctx.answerCallbackQuery({ text: "Not configured" });
        return;
      }

      const data = ctx.callbackQuery.data;
      const context = this.extractContext(ctx);

      log.info(`Telegram: callback from ${context.username ?? context.userId}: "${data}"`);

      try {
        const response = await this.callbackHandler(data, context);
        await ctx.answerCallbackQuery();

        // Build inline keyboard if provided
        let keyboard: InlineKeyboard | undefined;
        if (response.inlineKeyboard && response.inlineKeyboard.length > 0) {
          keyboard = new InlineKeyboard();
          for (const row of response.inlineKeyboard) {
            for (const btn of row) {
              keyboard.text(btn.text, btn.callbackData);
            }
            keyboard.row();
          }
        }

        // Edit the original message if it exists, otherwise send new
        if (ctx.callbackQuery.message) {
          await ctx.editMessageText(response.text, {
            parse_mode: response.parseMode ?? "Markdown",
            reply_markup: keyboard,
          });
        } else {
          await ctx.reply(response.text, {
            parse_mode: response.parseMode ?? "Markdown",
            reply_markup: keyboard,
          });
        }
      } catch (err) {
        log.error("Telegram: callback handler error", err);
        await ctx.answerCallbackQuery({ text: "Error" });
      }
    });

    // Photos (future: image analysis)
    this.bot.on("message:photo", async (ctx) => {
      const caption = ctx.message.caption ?? "";
      log.info(`Telegram: photo received with caption: "${caption}"`);
      await ctx.reply("Photo received. Image processing not yet implemented.");
    });

    // Voice messages (with transcription if VoiceService available)
    this.bot.on("message:voice", async (ctx) => {
      const context = this.extractContext(ctx);
      log.info(`Telegram: voice message received from ${context.username ?? context.userId}`);

      // Check if we can transcribe
      if (!this.voiceService) {
        await ctx.reply("Voice message received. Transcription not configured.");
        return;
      }

      try {
        // Download voice file
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

        const response = await fetch(fileUrl);
        if (!response.ok) {
          throw new Error(`Failed to download voice: ${response.status}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        log.debug(`Telegram: downloaded voice file (${audioBuffer.length} bytes)`);

        // Transcribe
        const transcription = await this.voiceService.transcribe(audioBuffer);
        log.info(`Telegram: transcribed voice: "${transcription.text.slice(0, 50)}..."`);

        // If we have a voice handler, use it
        if (this.voiceHandler) {
          const textResponse = await this.voiceHandler(transcription.text, context);

          // If respond with voice is enabled, synthesize and send audio
          if (this.respondWithVoice && textResponse.text) {
            try {
              const synthesis = await this.voiceService.synthesize(textResponse.text);
              await ctx.replyWithVoice(new InputFile(synthesis.audio, "response.ogg"));
              // Also send text as caption or follow-up
              await ctx.reply(textResponse.text, {
                parse_mode: textResponse.parseMode ?? "Markdown",
              });
            } catch (synthErr) {
              log.warn("Telegram: voice synthesis failed, sending text only", synthErr);
              await ctx.reply(textResponse.text, {
                parse_mode: textResponse.parseMode ?? "Markdown",
              });
            }
          } else {
            // Just send text response
            await ctx.reply(textResponse.text, {
              parse_mode: textResponse.parseMode ?? "Markdown",
            });
          }
        } else if (this.messageHandler) {
          // Fall back to regular message handler with transcribed text
          const textResponse = await this.messageHandler(transcription.text, context);
          await ctx.reply(textResponse.text, {
            parse_mode: textResponse.parseMode ?? "Markdown",
          });
        } else {
          // Just show transcription
          await ctx.reply(`Transcription: "${transcription.text}"`);
        }
      } catch (err) {
        log.error("Telegram: voice processing error", err);
        await ctx.reply("Error processing voice message. Check logs.");
      }
    });

    // Documents
    this.bot.on("message:document", async (ctx) => {
      const doc = ctx.message.document;
      log.info(`Telegram: document received: ${doc.file_name}`);
      await ctx.reply(`Document received: ${doc.file_name}. Document processing not yet implemented.`);
    });

    // Error handler
    this.bot.catch((err) => {
      log.error("Telegram bot error", err);
    });
  }

  /** Set the handler for incoming text messages */
  onMessage(handler: TelegramMessageHandler): void {
    this.messageHandler = handler;
  }

  /** Set the handler for callback queries */
  onCallback(handler: TelegramCallbackHandler): void {
    this.callbackHandler = handler;
  }

  /** Set the handler for voice messages (receives transcription) */
  onVoice(handler: TelegramVoiceHandler): void {
    this.voiceHandler = handler;
  }

  /** Set the voice service for transcription/synthesis */
  setVoiceService(service: VoiceService, respondWithVoice = false): void {
    this.voiceService = service;
    this.respondWithVoice = respondWithVoice;
    log.info(`Telegram: voice service enabled (respond with voice: ${respondWithVoice})`);
  }

  /** Start the bot (long polling) */
  async start(): Promise<void> {
    if (this.running) {
      log.warn("Telegram: already running");
      return;
    }

    log.info("Telegram: starting bot...");

    // Get bot info
    const me = await this.bot.api.getMe();
    log.info(`Telegram: bot started as @${me.username} (${me.id})`);

    this.running = true;

    // Start long polling (non-blocking)
    this.bot.start({
      onStart: () => {
        log.info("Telegram: long polling started");
      },
    });
  }

  /** Stop the bot */
  async stop(): Promise<void> {
    if (!this.running) return;

    log.info("Telegram: stopping bot...");
    await this.bot.stop();
    this.running = false;
    log.info("Telegram: bot stopped");
  }

  /** Check if bot is running */
  get isRunning(): boolean {
    return this.running;
  }

  /** Get the default chat ID for proactive messages */
  getDefaultChatId(): number | null {
    return this.defaultChatId;
  }

  // ── Outbound messaging ─────────────────────────────────

  /** Send a text message to a chat */
  async send(
    chatId: number,
    text: string,
    options?: {
      parseMode?: "Markdown" | "MarkdownV2" | "HTML";
      disableNotification?: boolean;
      replyToMessageId?: number;
    },
  ): Promise<number> {
    const result = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: options?.parseMode ?? "Markdown",
      disable_notification: options?.disableNotification,
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
    });
    return result.message_id;
  }

  /** Send to the default chat (for proactive notifications) */
  async sendToDefault(
    text: string,
    options?: {
      parseMode?: "Markdown" | "MarkdownV2" | "HTML";
      disableNotification?: boolean;
    },
  ): Promise<number | null> {
    if (!this.defaultChatId) {
      log.warn("Telegram: no default chat ID configured");
      return null;
    }
    return this.send(this.defaultChatId, text, options);
  }

  /** Send a photo */
  async sendPhoto(
    chatId: number,
    photo: Buffer | string,
    options?: {
      caption?: string;
      parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    },
  ): Promise<number> {
    const input = typeof photo === "string" ? photo : new InputFile(photo);
    const result = await this.bot.api.sendPhoto(chatId, input, {
      caption: options?.caption,
      parse_mode: options?.parseMode,
    });
    return result.message_id;
  }

  /** Send a document/file */
  async sendDocument(
    chatId: number,
    document: Buffer | string,
    filename: string,
    options?: {
      caption?: string;
    },
  ): Promise<number> {
    const input = typeof document === "string"
      ? document
      : new InputFile(document, filename);
    const result = await this.bot.api.sendDocument(chatId, input, {
      caption: options?.caption,
    });
    return result.message_id;
  }

  /** Send a voice message */
  async sendVoice(
    chatId: number,
    audio: Buffer,
    options?: {
      caption?: string;
      duration?: number;
    },
  ): Promise<number> {
    const input = new InputFile(audio, "voice.ogg");
    const result = await this.bot.api.sendVoice(chatId, input, {
      caption: options?.caption,
      duration: options?.duration,
    });
    return result.message_id;
  }

  /** Send voice to default chat */
  async sendVoiceToDefault(
    audio: Buffer,
    options?: {
      caption?: string;
    },
  ): Promise<number | null> {
    if (!this.defaultChatId) {
      log.warn("Telegram: no default chat ID configured");
      return null;
    }
    return this.sendVoice(this.defaultChatId, audio, options);
  }

  /** Synthesize and send voice message */
  async sendTextAsVoice(
    chatId: number,
    text: string,
  ): Promise<number | null> {
    if (!this.voiceService) {
      log.warn("Telegram: voice service not configured");
      return null;
    }

    try {
      const synthesis = await this.voiceService.synthesize(text);
      return this.sendVoice(chatId, synthesis.audio);
    } catch (err) {
      log.error("Telegram: voice synthesis failed", err);
      return null;
    }
  }

  /** Edit a previously sent message */
  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: "Markdown" | "MarkdownV2" | "HTML",
  ): Promise<void> {
    await this.bot.api.editMessageText(chatId, messageId, text, {
      parse_mode: parseMode ?? "Markdown",
    });
  }

  /** Delete a message */
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId);
  }
}
