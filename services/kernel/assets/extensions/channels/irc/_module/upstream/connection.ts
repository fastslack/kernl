/**
 * UpstreamConnection — one outbound link to an external IRC network.
 *
 * It owns registration (CAP/NICK/USER/SASL), keepalive, the reconnect policy
 * and the outbound rate limit; it does not know anything about the local
 * server. Parsed messages are handed to the manager, which does the mapping.
 *
 * The socket and the timers are injected so the whole state machine can be
 * tested without opening a port or waiting real seconds.
 */
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { parseLine, serialize, splitLines, type IrcMessage } from "../server/parser.js";

export type UpstreamState =
  | "idle"
  | "connecting"
  | "registering"
  | "connected"
  | "reconnecting"
  | "error";

export interface UpstreamSocket {
  write(data: string): void;
  end(): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onData(chunk: string): void;
  onClose(): void;
  onError(err: Error): void;
}

export type SocketFactory = (
  opts: { host: string; port: number; tls: boolean },
  handlers: SocketHandlers,
) => UpstreamSocket;

export interface UpstreamConnectionConfig {
  id: string;
  network: string;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  saslAccount: string;
  password: string;
}

export interface ConnectionDeps {
  socketFactory: SocketFactory;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  /** Jitter source, injectable for deterministic tests. */
  random?: () => number;
}

/** Reconnect delays in ms. The last one is reused for every later attempt. */
export const BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 300_000];
/**
 * How long a connection may take to get from "opening the socket" to
 * registered. A stalled TLS handshake leaves the TCP socket ESTABLISHED while
 * the secure callback never fires — without this the link would sit in
 * "connecting" forever, invisible to the backoff policy.
 *
 * Generous on purpose: the classic networks still run an ident check on
 * connect, and DALnet takes ~36s to give up on it before sending 001. A
 * tighter budget kills connections that were about to succeed.
 */
export const CONNECT_TIMEOUT_MS = 60_000;
/** One outbound message per this many ms. Classic networks kill for less. */
export const SEND_INTERVAL_MS = 500;
/** How many times to mangle the nick before giving up on 433. */
export const MAX_NICK_RETRIES = 2;

const CAPS = ["message-tags", "server-time", "multi-prefix", "away-notify"];

export class UpstreamConnection {
  state: UpstreamState = "idle";
  lastError = "";
  /** Nick actually in use upstream — may be mangled after a 433. */
  currentNick: string;

  /** Parsed lines from the network. Set by the manager. */
  onMessage: ((msg: IrcMessage) => void) | null = null;
  /** State transitions, for the UI and for persistence of last_error. */
  onState: ((state: UpstreamState, error: string) => void) | null = null;
  /** Fires once per successful registration, so the manager can rejoin. */
  onRegistered: (() => void) | null = null;

  private socket: UpstreamSocket | null = null;
  private buffer = "";
  private attempt = 0;
  private nickRetries = 0;
  private stopped = true;
  private capsRequested = false;
  private queue: string[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every open(). Handlers carry the generation they were created
   * with, so a socket we walked away from can report back late without
   * kicking off a second reconnect cycle.
   */
  private gen = 0;

  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void;
  private readonly random: () => number;

  constructor(
    public cfg: UpstreamConnectionConfig,
    private deps: ConnectionDeps,
  ) {
    this.currentNick = cfg.nick;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
    this.random = deps.random ?? Math.random;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** Close and stay closed. Does not clear stored config. */
  stop(reason = "Disconnected by user"): void {
    this.stopped = true;
    this.gen++; // whatever is in flight is no longer ours
    this.cancelReconnect();
    this.cancelConnectTimeout();
    this.stopDrain();
    this.queue = [];
    if (this.socket) {
      try {
        this.socket.write(serialize({ command: "QUIT", params: [reason] }) + "\r\n");
        this.socket.end();
      } catch {
        /* the socket is already gone; nothing to do */
      }
      this.socket = null;
    }
    this.setState("idle", "");
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  private open(): void {
    this.buffer = "";
    this.capsRequested = false;
    this.nickRetries = 0;
    this.currentNick = this.cfg.nick;
    const gen = ++this.gen;
    const fresh = (fn: () => void) => () => {
      if (gen === this.gen) fn();
    };
    this.setState("connecting", "");
    this.armConnectTimeout();
    try {
      this.socket = this.deps.socketFactory(
        { host: this.cfg.host, port: this.cfg.port, tls: this.cfg.tls },
        {
          onOpen: fresh(() => this.handleOpen()),
          onData: (chunk) => {
            if (gen === this.gen) this.handleData(chunk);
          },
          onClose: fresh(() => this.handleClose()),
          onError: (err) => {
            if (gen === this.gen) this.handleError(err);
          },
        },
      );
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Fail the attempt if it never reaches "registered" in time. */
  private armConnectTimeout(): void {
    this.cancelConnectTimeout();
    this.connectTimer = this.setTimer(() => {
      this.connectTimer = null;
      if (this.state === "connected" || this.stopped) return;
      this.lastError = `timed out after ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s in state "${this.state}"`;
      // Abandon this socket: bumping the generation makes any late callback
      // from it a no-op, so only the reconnect below drives the next attempt.
      this.gen++;
      if (this.socket) {
        try {
          this.socket.end();
        } catch {
          /* already gone */
        }
        this.socket = null;
      }
      this.stopDrain();
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);
  }

  private cancelConnectTimeout(): void {
    if (this.connectTimer) {
      this.clearTimer(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private handleOpen(): void {
    this.setState("registering", "");
    this.sendNow(`CAP LS 302`);
    this.sendNow(`NICK ${this.currentNick}`);
    // Free-text params always go in trailing form. serialize() omits the colon
    // for a single word, which is legal but upsets the older ircds this talks to.
    this.sendNow(
      `USER ${this.cfg.username || this.cfg.nick} 0 * :${this.cfg.realname || this.cfg.nick}`,
    );
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const { lines, rest } = splitLines(this.buffer);
    this.buffer = rest;
    // A line this long is not IRC. Drop it rather than grow without bound.
    if (this.buffer.length > 8192) this.buffer = "";
    for (const line of lines) {
      const msg = parseLine(line);
      if (msg) this.handleMessage(msg);
    }
  }

  private handleMessage(msg: IrcMessage): void {
    switch (msg.command.toUpperCase()) {
      case "PING":
        this.sendNow(serialize({ command: "PONG", params: [msg.params[0] ?? ""] }));
        return;
      case "CAP":
        this.handleCap(msg);
        return;
      case "AUTHENTICATE":
        if (msg.params[0] === "+") {
          const payload = Buffer.from(
            `${this.cfg.saslAccount}\0${this.cfg.saslAccount}\0${this.cfg.password}`,
            "utf8",
          ).toString("base64");
          this.sendNow(`AUTHENTICATE ${payload}`);
        }
        return;
      case "903": // SASL success
        this.sendNow("CAP END");
        return;
      case "902": // account locked
      case "904": // SASL failed
      case "905": // SASL message too long
      case "906": // SASL aborted
        // A bad password must never turn into a reconnect loop: stop and wait
        // for the user to fix the credentials.
        this.failPermanently(`SASL: ${msg.params.slice(1).join(" ") || "authentication failed"}`);
        return;
      case "001":
        this.attempt = 0;
        this.cancelConnectTimeout();
        this.setState("connected", "");
        this.startDrain();
        this.onRegistered?.();
        break;
      case "433": // ERR_NICKNAMEINUSE
        this.handleNickInUse();
        return;
      case "ERROR":
        this.lastError = msg.params.join(" ");
        break;
      default:
        break;
    }
    this.onMessage?.(msg);
  }

  private handleCap(msg: IrcMessage): void {
    const sub = (msg.params[1] ?? "").toUpperCase();
    if (sub === "LS" && !this.capsRequested) {
      this.capsRequested = true;
      const offered = (msg.params[msg.params.length - 1] ?? "").split(" ").filter(Boolean);
      const want = CAPS.filter((c) => offered.some((o) => o.split("=")[0] === c));
      const wantsSasl =
        !!this.cfg.saslAccount &&
        !!this.cfg.password &&
        offered.some((o) => o.split("=")[0] === "sasl");
      if (wantsSasl) want.push("sasl");
      if (want.length === 0) {
        this.sendNow("CAP END");
        return;
      }
      this.sendNow(`CAP REQ :${want.join(" ")}`);
      return;
    }
    if (sub === "ACK") {
      const acked = (msg.params[msg.params.length - 1] ?? "").split(" ").filter(Boolean);
      if (acked.includes("sasl")) this.sendNow("AUTHENTICATE PLAIN");
      else this.sendNow("CAP END");
      return;
    }
    if (sub === "NAK") this.sendNow("CAP END");
  }

  private handleNickInUse(): void {
    if (this.nickRetries >= MAX_NICK_RETRIES) {
      this.failPermanently(`Nick ${this.cfg.nick} is in use and mangling did not help`);
      return;
    }
    this.nickRetries++;
    this.currentNick = `${this.cfg.nick}${"_".repeat(this.nickRetries)}`;
    this.sendNow(`NICK ${this.currentNick}`);
  }

  private handleClose(): void {
    this.socket = null;
    this.stopDrain();
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private handleError(err: Error): void {
    this.lastError = err.message;
    this.socket = null;
    this.stopDrain();
    if (this.stopped) {
      this.setState("error", err.message);
      return;
    }
    this.scheduleReconnect();
  }

  /** Give up: no more retries until the user acts. */
  private failPermanently(message: string): void {
    this.stopped = true;
    this.cancelReconnect();
    this.cancelConnectTimeout();
    this.stopDrain();
    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    this.setState("error", message);
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    // ±20% jitter so many upstreams never reconnect in lockstep.
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    this.setState("reconnecting", this.lastError);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Sending ─────────────────────────────────────────────────

  /** Queue a raw line, respecting the rate limit. */
  send(line: string): void {
    this.queue.push(line);
    this.startDrain();
  }

  privmsg(target: string, text: string): void {
    this.send(`PRIVMSG ${target} :${text}`);
  }

  join(channel: string, key = ""): void {
    this.send(serialize({ command: "JOIN", params: key ? [channel, key] : [channel] }));
  }

  part(channel: string): void {
    this.send(serialize({ command: "PART", params: [channel] }));
  }

  /** Bypass the queue — registration and PONG cannot wait behind a backlog. */
  private sendNow(line: string): void {
    if (!this.socket) return;
    try {
      this.socket.write(line.endsWith("\r\n") ? line : line + "\r\n");
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private startDrain(): void {
    if (this.drainTimer || this.queue.length === 0) return;
    const tick = (): void => {
      this.drainTimer = null;
      if (this.state !== "connected" || !this.socket) return;
      const line = this.queue.shift();
      if (line !== undefined) this.sendNow(line);
      if (this.queue.length > 0) this.drainTimer = this.setTimer(tick, SEND_INTERVAL_MS);
    };
    // First message goes out immediately; the rest are paced.
    this.drainTimer = this.setTimer(tick, 0);
  }

  private stopDrain(): void {
    if (this.drainTimer) {
      this.clearTimer(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private setState(state: UpstreamState, error: string): void {
    this.state = state;
    if (error) this.lastError = error;
    this.onState?.(state, error);
  }
}

/** Minimal shape of a Bun socket — typed locally to avoid a bun-types import. */
interface BunLikeSocket {
  write(data: string): number;
  end(): void;
}
interface BunLike {
  connect(opts: {
    hostname: string;
    port: number;
    tls: boolean;
    socket: {
      open(s: BunLikeSocket): void;
      data(s: BunLikeSocket, d: Uint8Array): void;
      close(): void;
      error(s: BunLikeSocket, e: Error): void;
      connectError?(s: BunLikeSocket, e: Error): void;
    };
  }): Promise<BunLikeSocket>;
}

/**
 * Bun's native socket. Preferred because its `node:tls` compatibility layer
 * cannot complete a handshake with some servers — DALnet's nodes make it throw
 * "Cannot destructure property 'subject' from null", after which the socket
 * goes silent forever. The same host connects and registers fine here.
 */
function bunSocketFactory(bun: BunLike): SocketFactory {
  return (opts, handlers) => {
    let socket: BunLikeSocket | null = null;
    let endRequested = false;
    const decoder = new TextDecoder();
    void bun
      .connect({
        hostname: opts.host,
        port: opts.port,
        tls: opts.tls,
        socket: {
          open(s) {
            socket = s;
            if (endRequested) {
              s.end();
              return;
            }
            handlers.onOpen();
          },
          data(_s, d) {
            handlers.onData(decoder.decode(d));
          },
          close() {
            handlers.onClose();
          },
          error(_s, e) {
            handlers.onError(e);
          },
          connectError(_s, e) {
            handlers.onError(e);
          },
        },
      })
      .catch((err: unknown) =>
        handlers.onError(err instanceof Error ? err : new Error(String(err))),
      );
    return {
      write: (data: string) => {
        socket?.write(data);
      },
      end: () => {
        // The socket may not exist yet; remember so open() closes it at once.
        if (socket) socket.end();
        else endRequested = true;
      },
    };
  };
}

/** Fallback for a plain Node runtime. */
function nodeSocketFactory(): SocketFactory {
  return (opts, handlers) => {
    const socket = opts.tls
      ? tlsConnect({ host: opts.host, port: opts.port, servername: opts.host }, () =>
          handlers.onOpen(),
        )
      : netConnect({ host: opts.host, port: opts.port }, () => handlers.onOpen());
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => handlers.onData(String(chunk)));
    socket.on("close", () => handlers.onClose());
    socket.on("error", (err: Error) => handlers.onError(err));
    return {
      write: (data: string) => socket.write(data),
      end: () => socket.end(),
    };
  };
}

/** Default factory: a real TLS (or plain TCP) socket. */
export function createRealSocketFactory(): SocketFactory {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  return bun ? bunSocketFactory(bun) : nodeSocketFactory();
}
