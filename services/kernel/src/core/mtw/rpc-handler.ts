/**
 * MtwRpcHandler — receives RPC requests from browsers via mtwRequest
 * and dispatches them to registered action handlers.
 *
 * Flow:
 *   Browser sends channel.request({ action: "tasks.create", args: {...} })
 *   → mtwRequest routes to kernel (subscribed to "rpc" channel)
 *   → MtwRpcHandler dispatches to action handler
 *   → Sends response with ref_id for correlation
 *   → Emits data.changed on EventBus for real-time push
 *
 * Pattern inspired by BridgeServer.handleFrame() (toolMap dispatch).
 */

import type { MtwConnection, MtwMessage } from "@matware/mtw-request-ts-client";
import { createMessage, jsonPayload, emptyPayload } from "@matware/mtw-request-ts-client";
import { log } from "../logger.js";
import { stripInternalArgs } from "../helpers.js";
import type { EventBus } from "../event-bus.js";

export interface RpcAction {
  /** Action name, e.g. "tasks.create", "contacts.list" */
  name: string;
  /** Handler function — receives args, returns result */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface RpcHandlerOptions {
  /** WS connection to the mtwRequest broker. Optional: when the Rust bridge is
   *  off (zero-config public stack) the handler is built connection-less and
   *  serves actions over plain HTTP only. Attach a connection later with
   *  `attachConnection()` before calling `start()` to enable the WS transport. */
  conn?: MtwConnection | null;
  events: EventBus;
}

/** Modules whose mutations should NOT auto-emit data.changed (read-only actions) */
const READ_ONLY_SUFFIXES = [".list", ".detail", ".get", ".search", ".count", ".stats", ".export"];

export class MtwRpcHandler {
  private actionMap = new Map<string, RpcAction>();
  private conn: MtwConnection | null;
  private events: EventBus;

  constructor(opts: RpcHandlerOptions) {
    this.conn = opts.conn ?? null;
    this.events = opts.events;
  }

  /** Attach (or replace) the WS connection after construction — used when the
   *  handler is built connection-less for HTTP-only serving and the bridge
   *  becomes available later. Must be set before `start()`. */
  attachConnection(conn: MtwConnection): void {
    this.conn = conn;
  }

  /** Register a single action */
  register(action: RpcAction): void {
    this.actionMap.set(action.name, action);
  }

  /** Register multiple actions at once */
  registerAll(actions: RpcAction[]): void {
    for (const a of actions) {
      this.actionMap.set(a.name, a);
    }
  }

  /** Start listening on the 'rpc' channel */
  async start(): Promise<void> {
    const conn = this.conn;
    if (!conn) {
      // No WS connection (bridge off) — actions are still reachable over HTTP
      // via callAction(); there's just nothing to subscribe to.
      log.info(`RPC: no WS connection — serving ${this.actionMap.size} actions over HTTP only`);
      return;
    }
    // Subscribe to rpc channel
    conn.send(
      createMessage("subscribe", emptyPayload(), { channel: "rpc" }),
    );

    // Listen for request messages (accept both 'request' and 'publish' types for browser compatibility)
    conn.onChannel("rpc", (msg: MtwMessage) => {
      if (msg.type !== "request" && msg.type !== "publish" && msg.type !== "event") return;
      this.handleRequest(msg).catch((err) => {
        log.error("RPC: unhandled error in request handler", err);
      });
    });

    log.info(`RPC: listening on 'rpc' channel (${this.actionMap.size} actions registered)`);
  }

  private async handleRequest(msg: MtwMessage): Promise<void> {
    // Extract action and args from payload
    const payload = msg.payload.kind === "Json" ? (msg.payload.data as Record<string, unknown>) : null;
    if (!payload || typeof payload !== "object") {
      this.sendError(msg, "Invalid payload: expected JSON with { action, args }", "INVALID_PAYLOAD");
      return;
    }

    const action = typeof payload.action === "string" ? payload.action : "";
    const args = (typeof payload.args === "object" && payload.args !== null ? payload.args : {}) as Record<string, unknown>;
    // Browser includes _requestId so we can correlate the response back
    const requestId = typeof payload._requestId === "string" ? payload._requestId : msg.id;

    if (!action) {
      this.sendError(msg, "Missing 'action' field in payload", "MISSING_ACTION");
      return;
    }

    const handler = this.actionMap.get(action);
    if (!handler) {
      this.sendError(msg, `Unknown action: ${action}`, "UNKNOWN_ACTION");
      return;
    }

    try {
      const rpcT0 = Date.now();
      // Args arrive from external browser/mtwRequest clients — strip
      // kernel-internal `__`-prefixed keys for defense-in-depth consistency
      // with server.ts / bridge-server.ts. No RpcAction handler currently
      // reads a `__`-prefixed key (verified by repo-wide grep), so this is
      // behavior-preserving today.
      const result = await handler.handler(stripInternalArgs(args) as Record<string, unknown>);
      const rpcMs = Date.now() - rpcT0;

      // Send success response — use requestId from browser for correlation.
      // handleRequest only runs off a WS message, so conn is always set here.
      this.conn?.send(
        createMessage("response", jsonPayload({ ok: true, data: result }), {
          channel: "rpc",
          ref_id: requestId,
        }),
      );

      // Emit rpc_call event for ARCH 3D visualization (all actions)
      const module = action.split(".")[0];
      this.events.emit("rpc.call", { module, action, source: "rpc" });

      // Auto-emit data.changed for mutations (not read-only actions)
      const isReadOnly = READ_ONLY_SUFFIXES.some((s) => action.endsWith(s));
      if (!isReadOnly) {
        this.events.emit("data.changed", { module, action, source: "rpc" });
      }

      if (rpcMs > 100) log.info(`RPC: ${action} → ${rpcMs}ms`);
      else log.debug(`RPC: ${action} → ${rpcMs}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(msg, message, "INTERNAL", requestId);
      log.warn(`RPC: ${action} → error: ${message}`);
    }
  }

  private sendError(reqMsg: MtwMessage, error: string, code: string, overrideRefId?: string): void {
    this.conn?.send(
      createMessage("error", jsonPayload({ ok: false, error, code }), {
        channel: "rpc",
        ref_id: overrideRefId ?? reqMsg.id,
      }),
    );
  }

  /** Get count of registered actions */
  get actionCount(): number {
    return this.actionMap.size;
  }

  /**
   * Invoke a registered action directly (bypassing the mtwRequest WS transport)
   * so the kernel can serve RPC actions over plain HTTP too — needed when the
   * Rust bridge is off (e.g. the zero-config public stack). Throws on unknown
   * action; strips kernel-internal `__`-prefixed args like the WS path.
   */
  async callAction(action: string, args: Record<string, unknown>): Promise<unknown> {
    const handler = this.actionMap.get(action);
    if (!handler) throw new Error(`Unknown action: ${action}`);
    return handler.handler(stripInternalArgs(args) as Record<string, unknown>);
  }
}
