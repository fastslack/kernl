/**
 * Rust Bridge Client — connects TO the Rust mtwRequest bridge server.
 *
 * This is the reverse of bridge-server.ts: where BridgeServer accepts
 * connections from Rust, RustBridge initiates connections TO Rust.
 * Used to delegate heavy computation (formulas, SL/TP monitoring,
 * rate limiting) to the Rust side for performance.
 *
 * Protocol (same as bridge-server.ts / mtw-bridge crate):
 *   [4 bytes: payload length (BE u32)] [N bytes: MessagePack payload]
 *
 * Request:  { id: string, tool: string, args: object }
 * Response: { id: string, result?: unknown, error?: string }
 */

import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { log } from "../logger.js";

/** Server-pushed event frame from Rust. Same wire as responses but with
 *  `type:"event"` instead of an `id`/`result` pair. The Rust side may
 *  emit these at any time; we dispatch them via {@link RustBridge.events}. */
export interface BridgeEvent {
  type: "event";
  topic: string;
  data?: unknown;
}

// Use @msgpack/msgpack (same as bridge-server.ts)
let encode: (obj: unknown) => Uint8Array;
let decode: (buf: Uint8Array) => unknown;

try {
  const msgpack = await import("@msgpack/msgpack");
  encode = msgpack.encode;
  decode = msgpack.decode;
} catch {
  encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
  decode = (buf: Uint8Array) => JSON.parse(new TextDecoder().decode(buf));
  log.debug("RustBridge: using JSON fallback (install @msgpack/msgpack for better performance)");
}

export interface RustBridgeConfig {
  /** Path to the Rust bridge Unix socket, e.g. "/tmp/mtw-rust.sock" */
  socketPath: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout: number;
  /** Whether to auto-reconnect on disconnect (default: true) */
  reconnect: boolean;
  /** Delay between reconnect attempts in milliseconds (default: 2000) */
  reconnectDelay: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let requestCounter = 0;

export class RustBridge {
  private socket: Socket | null = null;
  private connected = false;
  private shuttingDown = false;
  private pending = new Map<string, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * EventEmitter for server-pushed events from Rust. Two listening modes:
   *
   *   bridge.events.on("torrent.progress", (data) => ...)  // per-topic
   *   bridge.events.on("*", (topic, data) => ...)          // wildcard
   *
   * Topics are free-form strings agreed with the Rust side
   * (`torrent.progress`, `torrent.done`, `trading.fill`, etc).
   */
  readonly events: EventEmitter = new EventEmitter();

  constructor(private config: RustBridgeConfig) {
    // Bridge events can have many subscribers (different modules listen
    // to different topics). Bump default limit so we don't get the
    // "MaxListenersExceededWarning" once the kernel grows past 10.
    this.events.setMaxListeners(64);
  }

  /** Connect to the Rust bridge Unix socket */
  async connect(): Promise<void> {
    this.shuttingDown = false;

    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.config.socketPath, () => {
        this.connected = true;
        this.socket = socket;
        log.info(`RustBridge: connected to ${this.config.socketPath}`);
        resolve();
      });

      socket.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
      });

      socket.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;

        // Reject all pending requests
        for (const [id, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error("RustBridge: connection closed"));
        }
        this.pending.clear();
        this.buffer = Buffer.alloc(0);

        if (wasConnected) {
          log.warn("RustBridge: disconnected");
        }

        if (!this.shuttingDown && this.config.reconnect) {
          this.scheduleReconnect();
        }
      });

      socket.on("error", (err) => {
        if (!this.connected) {
          // Only log first failure, suppress reconnect noise
          if (!this.reconnectTimer) log.debug(`RustBridge: ${err.message}`);
          if (!this.shuttingDown && this.config.reconnect) {
            this.scheduleReconnect();
            resolve();
          } else {
            reject(err);
          }
        } else {
          log.warn(`RustBridge: socket error — ${err.message}`);
        }
      });
    });
  }

  /** Gracefully disconnect */
  async disconnect(): Promise<void> {
    this.shuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("RustBridge: shutting down"));
    }
    this.pending.clear();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
    log.info("RustBridge: disconnected");
  }

  /** Call a Rust tool and wait for the response */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new Error(`RustBridge: not connected (tool=${tool})`);
    }

    const id = `rb-${++requestCounter}-${Date.now()}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RustBridge: timeout after ${this.config.timeout}ms (tool=${tool})`));
      }, this.config.timeout);

      this.pending.set(id, { resolve, reject, timer });

      try {
        const payload = encode({ id, tool, args });
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(payload.length, 0);
        this.socket!.write(lenBuf);
        this.socket!.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Check if currently connected to the Rust bridge */
  isConnected(): boolean {
    return this.connected;
  }

  /** Health check — calls the _health tool on the Rust side */
  async health(): Promise<boolean> {
    try {
      const result = await this.call("_health", {}) as { status?: string };
      return result?.status === "ok";
    } catch {
      return false;
    }
  }

  /** Process complete frames from the receive buffer */
  private processBuffer(): void {
    while (this.buffer.length >= 4) {
      const payloadLen = this.buffer.readUInt32BE(0);

      // Guard against absurd frame sizes (max 10 MB)
      if (payloadLen > 10 * 1024 * 1024) {
        log.error(`RustBridge: frame too large (${payloadLen} bytes), dropping connection`);
        this.socket?.destroy();
        return;
      }

      if (this.buffer.length < 4 + payloadLen) {
        break; // Wait for more data
      }

      const payload = this.buffer.subarray(4, 4 + payloadLen);
      this.buffer = this.buffer.subarray(4 + payloadLen);

      try {
        const frame = decode(payload) as
          | { id: string; result?: unknown; error?: string }
          | BridgeEvent;

        // Server-pushed event: route by topic to the events emitter.
        // No `id` field; presence of `type === "event"` is authoritative
        // (per the bridge protocol contract with mtwRequest).
        if ((frame as BridgeEvent).type === "event") {
          const ev = frame as BridgeEvent;
          if (typeof ev.topic === "string") {
            // Per-topic listeners get the data directly.
            this.events.emit(ev.topic, ev.data);
            // Wildcard listeners get (topic, data) so a single subscriber
            // can route many topics without registering N callbacks.
            this.events.emit("*", ev.topic, ev.data);
          } else {
            log.debug("RustBridge: event frame missing topic, dropping");
          }
          continue;
        }

        const resp = frame as { id: string; result?: unknown; error?: string };
        const pending = this.pending.get(resp.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(resp.id);

          if (resp.error) {
            pending.reject(new Error(`RustBridge: ${resp.error}`));
          } else {
            pending.resolve(resp.result);
          }
        } else {
          log.debug(`RustBridge: received response for unknown id=${resp.id}`);
        }
      } catch (err) {
        log.error("RustBridge: failed to decode response", err);
      }
    }
  }

  /** Schedule a reconnection attempt */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.shuttingDown) return;

    // Silent reconnect — only log on success
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.shuttingDown) return;

      try {
        await this.connect();
      } catch {
        // connect() handles its own retry scheduling
      }
    }, this.config.reconnectDelay);
  }
}
