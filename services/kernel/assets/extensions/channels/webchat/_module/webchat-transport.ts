/**
 * WebChat Channel Transport
 * WebSocket-based chat for web interfaces
 */

import { WebSocket, WebSocketServer } from "ws";
import { timingSafeEqual } from "node:crypto";
import { log } from "../../../../../src/core/logger.js";
import { newId } from "../../../../../src/core/helpers.js";

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: unknown, status: number, statusText: string): void {
  const s = socket as { write: (chunk: string) => void; destroy: () => void } | null;
  if (!s) return;
  try {
    s.write(`HTTP/1.1 ${status} ${statusText}\r\n` +
            `Connection: close\r\n` +
            `Content-Length: 0\r\n` +
            `\r\n`);
  } finally {
    s.destroy();
  }
}

function extractWsToken(url: string, headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers["authorization"];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (typeof authStr === "string") {
    const m = authStr.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const q = url.indexOf("?");
  if (q >= 0) {
    const params = new URLSearchParams(url.slice(q + 1));
    const t = params.get("token");
    if (t) return t;
  }
  return null;
}
import type {
  ChannelTransport,
  ChannelMessageHandler,
  ChannelCallbackHandler,
  ChannelMessage,
  ChannelResponse,
  ChannelStatus,
  ChannelConfig,
} from "../../../../../src/channels/types.js";

interface WebChatClient {
  id: string;
  ws: WebSocket;
  userId: string;
  authenticated: boolean;
  displayName?: string;
}

interface WebChatIncomingMessage {
  type: "message" | "callback" | "auth" | "ping";
  text?: string;
  callbackData?: string;
  apiKey?: string;
  displayName?: string;
  replyToMessageId?: string;
}

interface WebChatOutgoingMessage {
  type: "message" | "error" | "auth_required" | "auth_success" | "pong";
  messageId?: string;
  text?: string;
  buttons?: Array<{ text: string; callbackData: string }>;
  error?: string;
}

export class WebChatTransport implements ChannelTransport {
  readonly platform = "webchat" as const;

  private wss: WebSocketServer | null = null;
  private clients: Map<string, WebChatClient> = new Map();
  private messageHandler: ChannelMessageHandler | null = null;
  private callbackHandler: ChannelCallbackHandler | null = null;
  private started = false;

  constructor(private config: NonNullable<ChannelConfig["webchat"]>) {}

  getStatus(): ChannelStatus {
    return {
      platform: "webchat",
      connected: this.started,
      authenticated: true, // WebChat is always "authenticated" at transport level
      info: {
        connectedClients: this.clients.size,
      },
    };
  }

  isReady(): boolean {
    return this.started;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  onCallback(handler: ChannelCallbackHandler): void {
    this.callbackHandler = handler;
  }

  /**
   * Attach to an existing HTTP server
   * This is called from the main HTTP server setup
   */
  attachToServer(server: { on: (event: string, handler: (req: unknown, socket: unknown, head: unknown) => void) => void }, path: string = "/ws/chat"): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request: unknown, socket: unknown, head: unknown) => {
      const req = request as { url?: string; headers?: Record<string, string | string[] | undefined> };
      const url = req.url || "";

      if (!(url === path || url.startsWith(path + "?"))) return;

      // Auth gate at upgrade time. Two acceptable token sources:
      //   - Authorization: Bearer <token>
      //   - ?token=<token>  (browsers can't set custom headers on WS upgrades)
      // Token must equal the configured apiKey. If no apiKey is configured we
      // refuse the upgrade — webchat without auth is a hard footgun.
      const expected = this.config.apiKey;
      if (!expected) {
        rejectUpgrade(socket, 503, "WebChat disabled: no apiKey configured");
        return;
      }

      const presented = extractWsToken(url, req.headers ?? {});
      if (!presented || !timingSafeEqualStr(presented, expected)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }

      this.wss!.handleUpgrade(request as Parameters<typeof this.wss.handleUpgrade>[0], socket as Parameters<typeof this.wss.handleUpgrade>[1], head as Buffer, (ws) => {
        // Mark the resulting connection authenticated — the upgrade gate
        // already verified the token, no need to re-prompt over WS.
        (ws as unknown as { __preauth?: boolean }).__preauth = true;
        this.wss!.emit("connection", ws, request);
      });
    });

    this.setupWebSocketHandlers();
    this.started = true;
    log.info(`WebChat: attached to server at ${path}`);
  }

  async start(): Promise<void> {
    // If standalone mode is needed, create own server
    // For now, we expect attachToServer to be called
    log.info("WebChat: ready (call attachToServer to enable)");
  }

  async stop(): Promise<void> {
    log.info("WebChat: stopping...");

    // Close all client connections
    for (const client of this.clients.values()) {
      client.ws.close(1000, "Server shutting down");
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.started = false;
    log.info("WebChat: stopped");
  }

  private setupWebSocketHandlers(): void {
    if (!this.wss) return;

    this.wss.on("connection", (ws) => {
      const clientId = newId();
      // Preauth set by attachToServer's upgrade gate when a valid Bearer/?token
      // was presented. We trust it instead of asking the client to re-auth.
      const preauth = (ws as unknown as { __preauth?: boolean }).__preauth === true;
      const client: WebChatClient = {
        id: clientId,
        ws,
        userId: clientId, // Use client ID as user ID until authenticated
        authenticated: preauth || !this.config.requireAuth,
      };

      this.clients.set(clientId, client);
      log.info(`WebChat: client connected (${clientId}), total: ${this.clients.size}`);

      if (this.config.requireAuth && !preauth) {
        this.sendToClient(client, {
          type: "auth_required",
        });
      }

      ws.on("message", async (data) => {
        await this.handleClientMessage(client, data.toString());
      });

      ws.on("close", () => {
        this.clients.delete(clientId);
        log.info(`WebChat: client disconnected (${clientId}), total: ${this.clients.size}`);
      });

      ws.on("error", (err) => {
        log.error(`WebChat: client error (${clientId})`, err);
      });
    });
  }

  private async handleClientMessage(client: WebChatClient, data: string): Promise<void> {
    let msg: WebChatIncomingMessage;
    
    try {
      msg = JSON.parse(data);
    } catch {
      this.sendToClient(client, { type: "error", error: "Invalid JSON" });
      return;
    }

    // Handle ping
    if (msg.type === "ping") {
      this.sendToClient(client, { type: "pong" });
      return;
    }

    // Handle auth
    if (msg.type === "auth") {
      if (!this.config.requireAuth) {
        client.authenticated = true;
        if (msg.displayName) client.displayName = msg.displayName;
        this.sendToClient(client, { type: "auth_success" });
        return;
      }

      if (msg.apiKey === this.config.apiKey) {
        client.authenticated = true;
        if (msg.displayName) client.displayName = msg.displayName;
        this.sendToClient(client, { type: "auth_success" });
        log.info(`WebChat: client authenticated (${client.id})`);
      } else {
        this.sendToClient(client, { type: "error", error: "Invalid API key" });
      }
      return;
    }

    // Check authentication
    if (!client.authenticated) {
      this.sendToClient(client, { type: "auth_required" });
      return;
    }

    // Handle message
    if (msg.type === "message" && msg.text && this.messageHandler) {
      const channelMessage: ChannelMessage = {
        text: msg.text,
        context: {
          messageId: newId(),
          userId: client.userId,
          chatId: client.id,
          platform: "webchat",
          displayName: client.displayName || "Web User",
          isGroup: false,
          isReply: !!msg.replyToMessageId,
          replyToMessageId: msg.replyToMessageId,
          raw: msg,
        },
      };

      log.info(`WebChat: message from ${client.displayName || client.id}: "${msg.text.slice(0, 50)}..."`);

      try {
        const response = await this.messageHandler(channelMessage);
        this.sendToClient(client, {
          type: "message",
          messageId: newId(),
          text: response.text,
          buttons: response.buttons?.flat(),
        });
      } catch (err) {
        log.error("WebChat: handler error", err);
        this.sendToClient(client, {
          type: "error",
          error: "Error processing message",
        });
      }
      return;
    }

    // Handle callback
    if (msg.type === "callback" && msg.callbackData && this.callbackHandler) {
      const context = {
        messageId: newId(),
        userId: client.userId,
        chatId: client.id,
        platform: "webchat" as const,
        displayName: client.displayName,
        isGroup: false,
        isReply: false,
      };

      try {
        const response = await this.callbackHandler(msg.callbackData, context);
        this.sendToClient(client, {
          type: "message",
          messageId: newId(),
          text: response.text,
          buttons: response.buttons?.flat(),
        });
      } catch (err) {
        log.error("WebChat: callback handler error", err);
        this.sendToClient(client, {
          type: "error",
          error: "Error processing action",
        });
      }
      return;
    }
  }

  private sendToClient(client: WebChatClient, msg: WebChatOutgoingMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  async send(chatId: string, response: ChannelResponse): Promise<string> {
    const client = this.clients.get(chatId);
    if (!client) {
      throw new Error(`WebChat: client ${chatId} not found`);
    }

    const messageId = newId();
    this.sendToClient(client, {
      type: "message",
      messageId,
      text: response.text,
      buttons: response.buttons?.flat(),
    });

    return messageId;
  }

  async sendToDefault(response: ChannelResponse): Promise<string | null> {
    // Send to all connected clients
    const messageId = newId();
    
    for (const client of this.clients.values()) {
      if (client.authenticated) {
        this.sendToClient(client, {
          type: "message",
          messageId,
          text: response.text,
          buttons: response.buttons?.flat(),
        });
      }
    }

    return messageId;
  }

  /** Broadcast a message to all authenticated clients */
  broadcast(response: ChannelResponse): void {
    for (const client of this.clients.values()) {
      if (client.authenticated) {
        this.sendToClient(client, {
          type: "message",
          messageId: newId(),
          text: response.text,
          buttons: response.buttons?.flat(),
        });
      }
    }
  }

  /** Get number of connected clients */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Get number of authenticated clients */
  getAuthenticatedClientCount(): number {
    return Array.from(this.clients.values()).filter((c) => c.authenticated).length;
  }
}
