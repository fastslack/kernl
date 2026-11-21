/**
 * The kernel lets users onto the broker only when its own connection heard
 * the broker say it holds them to their permissions, and announces changed
 * modules on `changes`, the one data channel a user may subscribe to.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  brokerInfo, brokerSupportsPrincipals, clearBrokerInfo, trackBrokerFeatures,
} from "../src/core/mtw/broker-features.js";
import { MtwPublisher } from "../src/core/mtw/publisher.js";
import { EventBus } from "../src/core/event-bus.js";

afterEach(() => clearBrokerInfo());

class FakeConn extends EventEmitter {
  connected = false;
  asked: unknown[] = [];
  sent: Array<{ type: string; channel?: string; payload: { kind: string; data?: unknown } }> = [];
  constructor(private answer: () => Promise<unknown>) { super(); }
  request(msg: unknown): Promise<unknown> { this.asked.push(msg); return this.answer(); }
  send(msg: never): void { this.sent.push(msg); }
  up(): void { this.connected = true; this.emit("connected", {}); }
  down(): void { this.connected = false; this.emit("disconnected", {}); }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const info = (data: unknown) => async () => ({ type: "response", payload: { kind: "Json", data } });

describe("broker features", () => {
  it("are learned on connect and forgotten on disconnect", async () => {
    const conn = new FakeConn(info({ version: "0.6.0", features: ["principals"] }));
    trackBrokerFeatures(conn as never);
    expect(brokerSupportsPrincipals()).toBe(false);
    conn.up();
    await tick();
    expect(brokerSupportsPrincipals()).toBe(true);
    expect(brokerInfo().version).toBe("0.6.0");
    expect(conn.asked[0]).toMatchObject({ type: "request", metadata: { action: "broker.info" } });
    conn.down();
    expect(brokerSupportsPrincipals()).toBe(false);
  });

  it("stay empty with an older broker that errors or never answers", async () => {
    const erroring = new FakeConn(async () => ({ type: "error", payload: { kind: "Json", data: { error: "unknown" } } }));
    trackBrokerFeatures(erroring as never);
    erroring.up();
    await tick();
    expect(brokerSupportsPrincipals()).toBe(false);

    const silent = new FakeConn(() => Promise.reject(new Error("Request timeout")));
    trackBrokerFeatures(silent as never);
    silent.up();
    await tick();
    expect(brokerSupportsPrincipals()).toBe(false);

    const odd = new FakeConn(info({ features: "principals" }));
    trackBrokerFeatures(odd as never);
    odd.up();
    await tick();
    expect(brokerSupportsPrincipals()).toBe(false);
  });
});

describe("changes channel", () => {
  it("is subscribed and gets one note per changed module per burst, without data", async () => {
    const conn = new FakeConn(info({}));
    const events = new EventBus();
    const pub = new MtwPublisher({
      conn: conn as never, events, queryChannel: async () => ({}), periodicRefresh: false,
    });
    conn.connected = true;
    await pub.start();
    expect(conn.sent.some((m) => m.type === "subscribe" && m.channel === "changes")).toBe(true);

    events.emit("data.changed" as never, { module: "tasks" } as never);
    events.emit("data.changed" as never, { module: "tasks" } as never);
    events.emit("data.changed" as never, { module: "contacts" } as never);
    await tick(400);
    const notes = conn.sent.filter((m) => m.type === "publish" && m.channel === "changes");
    expect(notes.map((m) => (m.payload.data as { module: string }).module).sort()).toEqual(["contacts", "tasks"]);
    expect(Object.keys(notes[0].payload.data as object).sort()).toEqual(["module", "ts"]);
    pub.shutdown();
  });
});
