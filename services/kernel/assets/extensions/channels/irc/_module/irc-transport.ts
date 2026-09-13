/**
 * IRC Channel Transport — opens a TLS listener (6697) and an IRC-over-WebSocket
 * gateway on the shared kernel HTTP server (/ws/irc), bridging each connection
 * to the IrcServer state machine.
 *
 * Implements the unified `ChannelTransport` so the kernel's message-routing can
 * treat it like slack/discord/webchat: inbound user→channel/nick messages are
 * surfaced through `onMessage`, replies go back through `send`.
 */
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import { log } from "../../../../../src/core/logger.js";
import { newId } from "../../../../../src/core/helpers.js";
import { findOnPath } from "../../../../../src/core/fs-paths.js";
import type {
  ChannelTransport,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelResponse,
} from "../../../../../src/channels/types.js";
import { IrcClient } from "./server/client.js";
import { IrcServer, type InboundEvent } from "./server/ircd.js";

export interface IrcTransportConfig {
  tlsPort: number;
  wsPath: string;
  botNick: string;
  tlsCert?: string;
  tlsKey?: string;
  dataDir: string;
}

/**
 * A WebSocket frame is already message-framed, so a frame that carries no line
 * terminator *is* one complete IRC line. Browser clients routinely send it that
 * way; without this the line would sit in the buffer forever and the session
 * would look connected while the server ignored every command.
 */
export function normalizeWsFrame(data: string): string {
  return data.endsWith("\n") ? data : data + "\r\n";
}

/** Compute the CertFP (SHA-256 hex, lowercase) of a peer certificate. */
function certFingerprint(socket: TLSSocket): string | undefined {
  const cert = socket.getPeerCertificate?.();
  if (!cert || !cert.raw || cert.raw.length === 0) return undefined;
  return createHash("sha256").update(cert.raw).digest("hex");
}

/** Ensure we have a server cert+key; self-sign via openssl if not configured. */
function ensureServerCert(cfg: IrcTransportConfig): { cert: string; key: string } | null {
  if (cfg.tlsCert && cfg.tlsKey) return { cert: cfg.tlsCert, key: cfg.tlsKey };
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    const certPath = resolve(cfg.dataDir, "server-cert.pem");
    const keyPath = resolve(cfg.dataDir, "server-key.pem");
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      // A native Windows install has no openssl on PATH, and the kernel ships
      // no in-process X.509 generator. Say how to give the listener a cert
      // instead of logging "spawn openssl ENOENT".
      if (!findOnPath("openssl")) {
        log.warn(
          "IRC: no TLS certificate configured and openssl is not on PATH, so the TLS listener stays off " +
          "(the /ws/irc WebSocket gateway still works). To enable it, paste a PEM certificate and key into " +
          `the IRC channel settings (tlsCert / tlsKey), or put server-cert.pem and server-key.pem in ${cfg.dataDir}` +
          (process.platform === "win32"
            ? ". Alternatively install OpenSSL for Windows, make sure openssl.exe is on PATH, and restart Kernl to have a self-signed pair generated."
            : "."),
        );
        return null;
      }
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath,
        "-days", "3650", "-subj", "/CN=kernl-irc",
      ], { stdio: "ignore" });
      log.info("IRC: generated self-signed server certificate");
    }
    return { cert: readFileSync(certPath, "utf-8"), key: readFileSync(keyPath, "utf-8") };
  } catch (err) {
    log.error(`IRC: could not obtain a TLS certificate (${err instanceof Error ? err.message : err}). TCP listener disabled — WS gateway still available.`);
    return null;
  }
}

export class IrcTransport implements ChannelTransport {
  readonly platform = "irc" as const;

  private tls: TlsServer | null = null;
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private started = false;
  private messageHandler: ChannelMessageHandler | null = null;

  /** Office-channel messages route here (set by the office bridge). */
  officeHandler: ((ev: InboundEvent) => void) | null = null;
  /** Bridged-channel messages route here (set by the channel bridge). */
  bridgeHandler: ((ev: InboundEvent) => void) | null = null;
  /**
   * Messages aimed at a mirrored upstream buffer route here (set by the
   * bouncer). Returns true when it took the message, which ends the dispatch:
   * chatting on DALnet is not a prompt for the kernel's agents.
   */
  upstreamHandler: ((ev: InboundEvent) => boolean) | null = null;

  constructor(
    readonly server: IrcServer,
    private cfg: IrcTransportConfig,
  ) {
    // Single inbound dispatcher: office channels → office bridge, everything
    // else → the generic kernel message handler (orchestrator).
    this.server.onMessage = (ev) => this.dispatch(ev);
  }

  getStatus(): ChannelStatus {
    const s = this.server.stats();
    return {
      platform: "irc",
      connected: this.started,
      authenticated: true,
      info: { clients: s.clients, agents: s.agents, channels: s.channels, tlsPort: this.cfg.tlsPort },
    };
  }

  isReady(): boolean {
    return this.started;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  setHttpServer(server: HttpServer): void {
    this.httpServer = server;
  }

  async start(): Promise<void> {
    const creds = ensureServerCert(this.cfg);
    if (creds) {
      this.tls = createTlsServer(
        { cert: creds.cert, key: creds.key, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.2" },
        (socket) => this.onTlsConnection(socket),
      );
      this.tls.on("error", (err) => log.error("IRC TLS server error", err));
      await new Promise<void>((res) => this.tls!.listen(this.cfg.tlsPort, () => res()));
      log.info(`IRC: TLS listener on :${this.cfg.tlsPort}`);
    }

    if (this.httpServer) {
      this.attachWs(this.httpServer);
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.tls) { this.tls.close(); this.tls = null; }
    if (this.wss) { this.wss.close(); this.wss = null; }
    this.started = false;
    log.info("IRC: stopped");
  }

  // ── TLS connections ─────────────────────────────────────────
  private onTlsConnection(socket: TLSSocket): void {
    const host = socket.remoteAddress?.replace(/^::ffff:/, "") ?? "unknown";
    const fp = certFingerprint(socket);
    const client = new IrcClient({
      host,
      certFingerprint: fp,
      sink: (line) => { try { socket.write(line + "\r\n"); } catch { /* closed */ } },
    });
    this.server.attach(client);

    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      for (const msg of client.feed(chunk)) this.server.handle(client, msg);
    });
    socket.on("close", () => this.server.disconnect(client));
    socket.on("error", () => this.server.disconnect(client));
  }

  // ── WebSocket gateway ───────────────────────────────────────
  private attachWs(httpServer: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      const url = (req as { url?: string }).url ?? "";
      if (!(url === this.cfg.wsPath || url.startsWith(this.cfg.wsPath + "?"))) return;
      this.wss!.handleUpgrade(req as never, socket as never, head as never, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });
    this.wss.on("connection", (ws: WebSocket, req: unknown) => this.onWsConnection(ws, req));
    log.info(`IRC: WebSocket gateway at ${this.cfg.wsPath}`);
  }

  private onWsConnection(ws: WebSocket, req: unknown): void {
    const host = (req as { socket?: { remoteAddress?: string } })?.socket?.remoteAddress?.replace(/^::ffff:/, "") ?? "ws";
    const client = new IrcClient({
      host,
      sink: (line) => { if (ws.readyState === ws.OPEN) ws.send(line); },
    });
    this.server.attach(client);
    ws.on("message", (data) => {
      // WS clients may batch multiple IRC lines per frame.
      for (const msg of client.feed(normalizeWsFrame(data.toString()))) {
        this.server.handle(client, msg);
      }
    });
    ws.on("close", () => this.server.disconnect(client));
    ws.on("error", () => this.server.disconnect(client));
  }

  // ── inbound dispatch ────────────────────────────────────────
  private dispatch(ev: InboundEvent): void {
    if (ev.from.isAgent) return; // never recurse on agent-injected messages
    if (this.upstreamHandler?.(ev)) return; // relayed to an external network
    if (ev.channelIsOffice && this.officeHandler) {
      this.officeHandler(ev);
      return;
    }
    if (ev.targetType === "channel" && this.bridgeHandler) {
      // Mirror to an external channel if this IRC channel is bridged.
      this.bridgeHandler(ev);
    }
    // Generic path: hand to the kernel message handler (orchestrator), then
    // post the reply back as the bot. Encrypted payloads are not introspected.
    if (!this.messageHandler || ev.encrypted) return;
    const ctx = {
      messageId: newId(),
      userId: ev.from.account ?? ev.from.nick,
      chatId: ev.targetType === "channel" ? ev.target : ev.from.nick,
      platform: "irc" as const,
      username: ev.from.nick,
      isGroup: ev.targetType === "channel",
      isReply: false,
    };
    void this.messageHandler({ text: ev.text, context: ctx })
      .then((res) => {
        if (res?.text) void this.send(ctx.chatId, res);
      })
      .catch((err) => log.error("IRC: message handler error", err));
  }

  // ── outbound ────────────────────────────────────────────────
  async send(chatId: string, response: ChannelResponse): Promise<string> {
    const id = newId();
    if (chatId.startsWith("#")) {
      this.server.postToChannel(this.cfg.botNick, chatId, response.text);
    } else {
      this.server.postToNick(this.cfg.botNick, chatId, response.text, "PRIVMSG");
    }
    return id;
  }

  async sendToDefault(response: ChannelResponse): Promise<string | null> {
    this.server.broadcastNotice(this.cfg.botNick, response.text);
    return newId();
  }
}
