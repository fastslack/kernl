import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus } from "../src/core/event-bus.js";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("calls handler when event is emitted", async () => {
    const received: unknown[] = [];
    bus.on("test.event", (payload) => {
      received.push(payload);
    });

    await bus.emit("test.event", { msg: "hello" });
    expect(received).toEqual([{ msg: "hello" }]);
  });

  it("supports multiple handlers for the same event", async () => {
    let count = 0;
    bus.on("tick", () => { count++; });
    bus.on("tick", () => { count++; });

    await bus.emit("tick");
    expect(count).toBe(2);
  });

  it("removes handler with off()", async () => {
    let count = 0;
    const handler = () => { count++; };
    bus.on("tick", handler);
    bus.off("tick", handler);

    await bus.emit("tick");
    expect(count).toBe(0);
  });

  it("does not throw when emitting unknown event", async () => {
    await expect(bus.emit("nonexistent")).resolves.toBeUndefined();
  });

  it("catches handler errors without propagating", async () => {
    bus.on("fail", () => {
      throw new Error("boom");
    });
    bus.on("fail", () => {
      // second handler should still run
    });

    await expect(bus.emit("fail")).resolves.toBeUndefined();
  });

  it("clears all listeners", async () => {
    let count = 0;
    bus.on("a", () => { count++; });
    bus.on("b", () => { count++; });
    bus.clear();

    await bus.emit("a");
    await bus.emit("b");
    expect(count).toBe(0);
  });
});
