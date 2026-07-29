/**
 * Unified Channel Types
 * Common interfaces for all messaging channels (WhatsApp, Slack, Discord, Telegram, etc.)
 */

/** Supported channel platforms */
export type ChannelPlatform =
  | "telegram"
  | "whatsapp"
  | "slack"
  | "discord"
  | "webchat"
  | "irc"
  | "signal"
  | "matrix";

/** Attachment type */
export interface ChannelAttachment {
  type: "image" | "audio" | "video" | "document" | "voice";
  url?: string;
  buffer?: Buffer;
  filename?: string;
  mimeType?: string;
  caption?: string;
}

/** Inline button for interactive messages */
export interface ChannelButton {
  text: string;
  callbackData: string;
}

/** Context from an incoming message */
export interface ChannelMessageContext {
  /** Unique message ID on the platform */
  messageId: string;
  /** Platform-specific user ID */
  userId: string;
  /** Platform-specific chat/channel ID */
  chatId: string;
  /** Which platform */
  platform: ChannelPlatform;
  /** Username if available */
  username?: string;
  /** Display name */
  displayName?: string;
  /** Is this a group chat? */
  isGroup: boolean;
  /** Group name if applicable */
  groupName?: string;
  /** Is this a reply to another message? */
  isReply: boolean;
  /** ID of the message being replied to */
  replyToMessageId?: string;
  /** Raw platform-specific context */
  raw?: unknown;
}

/** Incoming message */
export interface ChannelMessage {
  text: string;
  context: ChannelMessageContext;
  attachments?: ChannelAttachment[];
}

/** Response to send */
export interface ChannelResponse {
  text: string;
  /** Platform-specific formatting (markdown, html, etc.) */
  format?: "plain" | "markdown" | "html";
  /** Reply to a specific message */
  replyToMessageId?: string;
  /** Disable notification sound */
  silent?: boolean;
  /** Attachments to send */
  attachments?: ChannelAttachment[];
  /** Interactive buttons */
  buttons?: ChannelButton[][];
}

/** Handler for incoming messages */
export type ChannelMessageHandler = (
  message: ChannelMessage,
) => Promise<ChannelResponse>;

/** Handler for button callbacks */
export type ChannelCallbackHandler = (
  data: string,
  context: ChannelMessageContext,
) => Promise<ChannelResponse>;

/** Channel status */
export interface ChannelStatus {
  platform: ChannelPlatform;
  connected: boolean;
  authenticated: boolean;
  error?: string;
  /** Platform-specific info (phone number, bot name, etc.) */
  info?: Record<string, unknown>;
}

/**
 * Base interface for all channel transports
 */
export interface ChannelTransport {
  /** Platform identifier */
  readonly platform: ChannelPlatform;
  
  /** Current connection status */
  getStatus(): ChannelStatus;
  
  /** Check if the channel is ready to send/receive */
  isReady(): boolean;
  
  /** Set the message handler */
  onMessage(handler: ChannelMessageHandler): void;
  
  /** Set the callback handler (for buttons) */
  onCallback?(handler: ChannelCallbackHandler): void;
  
  /** Start the transport (connect, authenticate) */
  start(): Promise<void>;
  
  /** Stop the transport */
  stop(): Promise<void>;
  
  /** Send a message to a chat */
  send(chatId: string, response: ChannelResponse): Promise<string>;
  
  /** Send to default chat (for notifications) */
  sendToDefault?(response: ChannelResponse): Promise<string | null>;
  
  /** Edit a previously sent message (if supported) */
  editMessage?(chatId: string, messageId: string, response: ChannelResponse): Promise<void>;
  
  /** Delete a message (if supported) */
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
  
  /** Send typing indicator (if supported) */
  sendTyping?(chatId: string): Promise<void>;
  
  /** React to a message (if supported) */
  react?(chatId: string, messageId: string, emoji: string): Promise<void>;
}

/**
 * Channel configuration
 */
export interface ChannelConfig {
  whatsapp?: {
    enabled: boolean;
    /** Path to store auth state */
    authPath: string;
    /** Allowed phone numbers (whitelist) */
    allowedNumbers: string[];
    /** Default chat for notifications */
    defaultChat?: string;
  };
  slack?: {
    enabled: boolean;
    botToken: string;
    appToken: string;
    signingSecret?: string;
    /** Allowed user IDs */
    allowedUsers: string[];
    /** Allowed channel IDs */
    allowedChannels: string[];
    /** Default channel for notifications */
    defaultChannel?: string;
  };
  discord?: {
    enabled: boolean;
    botToken: string;
    /** Allowed user IDs */
    allowedUsers: string[];
    /** Allowed guild IDs */
    allowedGuilds: string[];
    /** Allowed channel IDs */
    allowedChannels: string[];
    /** Default channel for notifications */
    defaultChannel?: string;
  };
  webchat?: {
    enabled: boolean;
    /** Require authentication */
    requireAuth: boolean;
    /** API key for webchat */
    apiKey?: string;
  };
}
