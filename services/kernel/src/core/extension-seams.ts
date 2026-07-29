/**
 * Structural seams the kernel core uses to talk to provider/service classes
 * that physically live in extensions.
 *
 * The rule is simple: the core declares only what it CALLS on the other side.
 * Each interface enumerates the minimum surface the kernel uses. Concrete
 * extension classes implement these naturally (no shared base class). When
 * something on the core side needs a method that isn't here, add it to the
 * relevant `*Like` — never reach back into the extension's source path.
 *
 * Why a single file: keeps the kernel's "what it knows about extensions"
 * discoverable from one place. Each section is grouped by the domain the
 * extension belongs to (notifications, channels, mesh).
 */
import type { SqliteDb } from "./db/sqlite.js";
import type { ChannelTransport } from "../channels/types.js";

// ───────────────────────────────────────────────────────────────
//  Notifications (dashboard-notifications + webchat extensions)
// ───────────────────────────────────────────────────────────────

/**
 * Row shape stored by the dashboard-notifications extension. Defined here so
 * core consumers (Notifier facade) don't have to import from the extension.
 * Extensions implementing the dashboard-notifications role MUST return rows
 * with this shape — it's part of the runtime contract.
 */
export interface StoredNotification {
  id: string;
  title: string;
  body: string;
  priority: "low" | "normal" | "high";
  source: string;
  read: number;
  created_at: string;
}

/**
 * Subset of the dashboard-notifications provider used by core (Notifier
 * facade + the HTTP pre-start hook). The provider also implements
 * `NotificationProvider`; that base contract stays in core unchanged.
 */
export interface DashboardProviderLike {
  /** Bind the SQLite DB + a broadcast callback that fans out new rows to
   *  open WebSocket clients. Wired by the HTTP bootstrap stage. */
  setDashboard(db: SqliteDb, broadcast: (n: StoredNotification) => void): void;

  getNotifications(opts?: { unreadOnly?: boolean; limit?: number }): StoredNotification[];
  getUnreadCount(): number;
  markRead(id: string): boolean;
  markAllRead(): number;
  deleteNotification(id: string): boolean;
  purgeOld(daysOld?: number): number;
}

/**
 * Subset of the webchat provider used by core (HTTP pre-start hook attaches
 * the kernel HTTP server so the provider can mount its WebSocket route on
 * the same listener instead of opening a second port).
 */
export interface WebChatProviderLike {
  setHttpServer(server: import("node:http").Server): void;
}

/**
 * Subset of the irc provider used by core (HTTP pre-start hook attaches the
 * kernel HTTP server so the IRCd can mount its IRC-over-WebSocket gateway on
 * the same listener, alongside its own TLS port). Mirrors the webchat seam.
 */
export interface IrcProviderLike {
  setHttpServer(server: import("node:http").Server): void;
}

// ───────────────────────────────────────────────────────────────
//  Channel routing (telegram, slack, discord, webchat, whatsapp)
// ───────────────────────────────────────────────────────────────

/**
 * Inline keyboard button. A core→channel contract: the orchestrator builds
 * rows of these and channel transports (today only Telegram) render them.
 * Lives in core so orchestrator/agents can reference it without importing
 * the transport, which now lives in the telegram extension.
 */
export interface InlineButton {
  text: string;
  callbackData: string;
}

/**
 * Inbound message context as message-routing.ts consumes it for Telegram.
 * Matches the shape `src/core/telegram.ts` already produces — duplicated
 * here so message-routing doesn't import the extension's provider type.
 */
export interface TelegramInboundContext {
  userId: string;
  chatId: string;
  username?: string;
}

export interface TelegramReplyLike {
  text: string;
  parseMode?: string;
  inlineKeyboard?: unknown;
}

export interface TelegramTransportLike {
  onMessage(handler: (text: string, ctx: TelegramInboundContext) => Promise<TelegramReplyLike>): void;
  onCallback(handler: (data: string, ctx: TelegramInboundContext) => Promise<TelegramReplyLike>): void;
  /** Send a message and return its message_id (used to drive streamed edits). */
  send(
    chatId: number,
    text: string,
    options?: { parseMode?: "Markdown" | "MarkdownV2" | "HTML"; disableNotification?: boolean },
  ): Promise<number>;
  /** Edit a previously sent message in place (the streaming primitive). */
  editMessage(
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: "Markdown" | "MarkdownV2" | "HTML",
  ): Promise<void>;
}

export interface TelegramProviderLike {
  getTransport(): TelegramTransportLike | null | undefined;
}

/**
 * Local-transport channel providers (slack, discord, webchat). They expose
 * a `getTransport()` that returns the unified `ChannelTransport` defined in
 * `src/channels/types.ts` — the core message-routing layer talks only to
 * the transport.
 */
export interface LocalChannelProviderLike {
  getTransport(): ChannelTransport | null | undefined;
}

/**
 * WhatsApp inbound payload as consumed by message-routing. Mirror of the
 * `InboundPayload` defined in the whatsapp extension's provider — kept
 * structural so core doesn't have to dynamic-import the extension's types.
 */
export interface WhatsAppInboundLike {
  text: string;
  chat: string;
  author: string;
  is_group?: boolean;
  group_name?: string | null;
  push_name?: string | null;
}

/**
 * Subset of the whatsapp provider used by message-routing. WhatsApp doesn't
 * run a local transport — its provider talks to a Go sidecar through the
 * mtwRequest connection, so the inbound path is `setInboundHandler` and
 * the outbound path is `sendTo`.
 */
export interface WhatsAppProviderLike {
  setInboundHandler(fn: (msg: WhatsAppInboundLike) => Promise<void> | void): void;
  sendTo(chat: string, payload: { title: string; body: string }): Promise<unknown>;
}

/**
 * Optional capability: a provider that needs the kernel-wide mtwRequest
 * connection wired in before `start()`. Today only the whatsapp provider
 * implements this. The bootstrap stage 10 (`initMtw`) registers a
 * pre-start hook that calls into this method on the provider instance.
 *
 * `unknown` for the conn shape keeps the core agnostic of the SDK type;
 * the provider casts internally to what it needs.
 */
export interface MtwConnAwareProvider {
  setMtwConnection(conn: unknown): void;
}

// ───────────────────────────────────────────────────────────────
//  Mesh
// ───────────────────────────────────────────────────────────────

/**
 * Tool descriptor returned by `MeshServiceLike.resolveLocal` — opaque to the
 * MCP server; it just forwards the (peer, remoteName) pair to `callPeerTool`.
 */
export interface MeshResolvedTool {
  peer: { peer_id: string };
  remoteName: string;
}

/**
 * Subset of the mesh extension's service used by the kernel MCP server
 * to proxy `peer:<short>:<remote_name>` tool calls to a trusted peer.
 */
export interface MeshServiceLike {
  resolveLocal(toolName: string): MeshResolvedTool | null;
  callPeerTool(opts: { peerId: string; toolName: string; arguments: unknown }): Promise<unknown>;
}
