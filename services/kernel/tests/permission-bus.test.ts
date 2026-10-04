/**
 * The chat's tool-permission prompts: Allow and Deny answer one request;
 * "Allow all" answers it, the ones already waiting in the same conversation,
 * and every later one — and nothing in other conversations.
 */
import { describe, it, expect } from "bun:test";
import { PermissionBus } from "../src/modules/chat/permission-bus.js";

describe("PermissionBus", () => {
  it("answers one request with allow or deny", async () => {
    const bus = new PermissionBus();
    const a = bus.ask({ request_id: "r1", episode_id: "e1", tool_name: "Bash" });
    expect(bus.respond("r1", { behavior: "deny", reason: "no" })).toBe(true);
    expect(await a).toEqual({ behavior: "deny", reason: "no" });
    expect(bus.allowsAll("e1")).toBe(false);
  });

  it("allow_all lets the waiting requests of that conversation through and remembers it", async () => {
    const bus = new PermissionBus();
    const first = bus.ask({ request_id: "r1", episode_id: "e1", tool_name: "Bash" });
    const second = bus.ask({ request_id: "r2", episode_id: "e1", tool_name: "Write" });
    const other = bus.ask({ request_id: "r3", episode_id: "e2", tool_name: "Bash" });

    expect(bus.respond("r1", { behavior: "allow_all" })).toBe(true);
    expect(await first).toEqual({ behavior: "allow" });
    expect(await second).toEqual({ behavior: "allow" });
    expect(bus.allowsAll("e1")).toBe(true);

    // Another conversation still asks.
    expect(bus.allowsAll("e2")).toBe(false);
    expect(bus.size()).toBe(1);
    bus.respond("r3", { behavior: "allow" });
    expect(await other).toEqual({ behavior: "allow" });
  });

  it("does not answer an unknown request", () => {
    expect(new PermissionBus().respond("nope", { behavior: "allow_all" })).toBe(false);
  });
});
