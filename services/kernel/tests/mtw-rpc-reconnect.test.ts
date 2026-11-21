/**
 * The kernel must boot without the mtwRequest broker and pick it up later:
 * the RPC handler subscribes to "rpc" on every (re)connection instead of
 * once at start, and never throws while the socket is down.
 */
import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { MtwRpcHandler } from "../src/core/mtw/rpc-handler.js";
import { EventBus } from "../src/core/event-bus.js";
import { bridgeFlag } from "../src/core/config.js";

class FakeConn extends EventEmitter {
  connected = false;
  sent: Array<{ type: string; channel?: string; ref_id?: string }> = [];
  private channelHandlers = new Map<string, (msg: unknown) => void>();

  send(msg: { type: string; channel?: string; ref_id?: string }): void {
    if (!this.connected) throw new Error("Client is not connected");
    this.sent.push(msg);
  }
  onChannel(channel: string, fn: (msg: unknown) => void): void {
    this.channelHandlers.set(channel, fn);
  }
  deliver(channel: string, msg: unknown): void {
    this.channelHandlers.get(channel)?.(msg);
  }
  up(): void { this.connected = true; this.emit("connected", {}); }
  down(): void { this.connected = false; this.emit("disconnected", {}); }
  subscribes(): number { return this.sent.filter((m) => m.type === "subscribe" && m.channel === "rpc").length; }
}

function handler(conn: FakeConn): MtwRpcHandler {
  const rpc = new MtwRpcHandler({ conn: conn as never, events: new EventBus() });
  rpc.register({ name: "demo.echo", handler: async (args) => args });
  return rpc;
}

const request = (id: string) => ({
  id, type: "publish", channel: "rpc", timestamp: 0,
  payload: { kind: "Json", data: { action: "demo.echo", args: { x: 1 }, _requestId: id } },
});

describe("RPC over the broker", () => {
  it("starts while the broker is down and subscribes once it comes up", async () => {
    const conn = new FakeConn();
    await handler(conn).start();
    expect(conn.subscribes()).toBe(0);
    conn.up();
    expect(conn.subscribes()).toBe(1);
  });

  it("subscribes again after every reconnect", async () => {
    const conn = new FakeConn();
    conn.connected = true;
    await handler(conn).start();
    expect(conn.subscribes()).toBe(1);
    conn.down();
    conn.up();
    conn.down();
    conn.up();
    expect(conn.subscribes()).toBe(3);
  });

  it("answers requests, and drops a reply when the socket is gone", async () => {
    const conn = new FakeConn();
    conn.connected = true;
    await handler(conn).start();
    conn.deliver("rpc", request("r1"));
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.sent.some((m) => m.type === "response" && m.ref_id === "r1")).toBe(true);

    conn.down();
    conn.deliver("rpc", request("r2"));
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.sent.some((m) => m.ref_id === "r2")).toBe(false);
  });
});


describe("bridge switches", () => {
  it("are on unless switched off, and off by default for a stdio-only kernel", () => {
    expect(bridgeFlag(undefined, undefined)).toBe(true);
    expect(bridgeFlag(undefined, "http")).toBe(true);
    expect(bridgeFlag(undefined, "both")).toBe(true);
    expect(bridgeFlag(undefined, "stdio")).toBe(false);
    expect(bridgeFlag("true", "stdio")).toBe(true);
    expect(bridgeFlag("false", "http")).toBe(false);
    expect(bridgeFlag(" 0 ", undefined)).toBe(false);
    expect(bridgeFlag("yes", "stdio")).toBe(true);
  });
});
