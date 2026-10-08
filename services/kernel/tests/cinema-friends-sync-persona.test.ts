/**
 * Persona learning is owned by the peering service (it fires after any
 * successful friend request, throttled there). The cinema friends sweep must
 * not keep a second schedule of its own.
 */
import { describe, it, expect } from "bun:test";
import { FriendsDirectorySync } from "../assets/extensions/leisure/cinema/_module/friends-sync.js";
import type { PeeringService } from "../src/sdk/types.js";

describe("friends sweep → persona", () => {
  it("leaves persona fetching to the peering service", async () => {
    const asked: string[] = [];
    const peering = {
      client: {
        get: async () => ({ ok: true, status: 200, data: { directories: [] }, via: "lan" }),
        fetchPersona: async (npub: string) => {
          asked.push(npub);
          return null;
        },
      },
      friends: { trusted: () => [{ npub: "npub1a" }, { npub: "npub1b" }] },
    } as unknown as PeeringService;
    const sync = new FriendsDirectorySync({ peering, directories: { upsertFromFriend: () => "unchanged" } as never });
    const out = await sync.syncAll();
    expect(out.every((o) => o.ok)).toBe(true);
    expect(asked).toEqual([]);
  });
});
