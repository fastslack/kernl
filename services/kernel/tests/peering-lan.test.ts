/**
 * LAN reachability: which addresses an instance advertises, and how a
 * hand-typed address lets us reach a friend whose advertised names do not
 * resolve here (mDNS from inside a container).
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { NetworkInterfaceInfo } from "node:os";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import { PeerResolver, WELL_KNOWN_PATH } from "../src/core/peering/resolver.js";
import { buildDescriptor, signDescriptor } from "../src/core/peering/descriptor.js";
import { lanReachUrls, isPrivateIPv4 } from "../src/core/peering/lan.js";
import { normalizeAddress } from "../src/core/peering/routes.js";

function iface(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null };
}

const IFACES = {
  lo: [iface("127.0.0.1", true)],
  eno1: [iface("192.168.0.136")],
  docker0: [iface("172.17.0.1")],
  "br-823e2ac3e9bc": [iface("172.17.2.1")],
  wlan0: [iface("10.0.0.5")],
  ppp0: [iface("100.64.1.2")], // CGNAT, not a LAN
};

describe("lanReachUrls", () => {
  it("native: private interface IPs first, then the mDNS name", () => {
    expect(lanReachUrls({ inDocker: false, hostname: "purma", interfaces: IFACES, port: 3086 })).toEqual([
      "http://192.168.0.136:3086",
      "http://10.0.0.5:3086",
      "http://purma.local:3086",
    ]);
  });

  it("docker without KERNEL_LAN_URL advertises nothing rather than the container name", () => {
    expect(lanReachUrls({ inDocker: true, hostname: "14604e987bde", interfaces: IFACES, port: 3087 })).toEqual([]);
  });

  it("KERNEL_LAN_URL wins, comma-separated, trailing slash trimmed", () => {
    expect(
      lanReachUrls({
        lanUrl: "http://192.168.0.136:3088/, http://purma.local:3088",
        inDocker: true,
        hostname: "x",
        interfaces: {},
        port: 3087,
      }),
    ).toEqual(["http://192.168.0.136:3088", "http://purma.local:3088"]);
  });

  it("recognises only RFC 1918 ranges", () => {
    expect(["10.1.2.3", "172.16.0.1", "172.31.9.9", "192.168.1.1"].every(isPrivateIPv4)).toBe(true);
    expect(["172.32.0.1", "100.64.0.1", "8.8.8.8", "192.168.1"].some(isPrivateIPv4)).toBe(false);
  });
});

describe("normalizeAddress", () => {
  it("accepts host:port and full origins, clears on empty, refuses paths and junk", () => {
    expect(normalizeAddress("192.168.0.9:3086")).toBe("http://192.168.0.9:3086");
    expect(normalizeAddress(" https://mac.example ")).toBe("https://mac.example");
    expect(normalizeAddress("")).toBe("");
    expect(normalizeAddress("http://192.168.0.9:3086/api")).toBeNull();
    expect(normalizeAddress("file:///etc/passwd")).toBeNull();
    expect(normalizeAddress("javascript:alert(1)")).toBeNull();
  });
});

describe("manual address", () => {
  it("is tried first and reaches a friend whose advertised .local name does not resolve", async () => {
    const store = new FriendsStore(new Database(":memory:"));
    const mac = NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));
    store.add({ npub: mac.npub(), trust: "trusted" });
    store.setManualUrl(mac.npub(), "http://192.168.0.9:3086");

    const event = signDescriptor(
      mac,
      buildDescriptor(mac, {
        name: "mac",
        version: "0",
        reach: [{ kind: "lan", url: "http://Jorges-MacBook-Pro-3.local:3086", prio: 10 }],
      }),
    );
    const calls: string[] = [];
    const resolver = new PeerResolver({
      friends: store,
      fetchImpl: async (url: string) => {
        calls.push(url);
        if (url !== "http://192.168.0.9:3086" + WELL_KNOWN_PATH) throw new Error("ENOTFOUND");
        return new Response(JSON.stringify(event), { status: 200 });
      },
      lookupPresence: async () => event,
    });

    const peer = await resolver.resolve(mac.npub());
    expect(peer?.origin).toBe("http://192.168.0.9:3086");
    expect(calls[0]).toBe("http://192.168.0.9:3086" + WELL_KNOWN_PATH);
    expect(store.get(mac.npub())?.last_error).toBe("");
  });

  it("the column is added to a database created before it existed", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE kernl_friends (
      npub TEXT PRIMARY KEY, pubkey_hex TEXT NOT NULL, petname TEXT NOT NULL DEFAULT '',
      trust TEXT NOT NULL DEFAULT 'pending', added_by TEXT NOT NULL DEFAULT 'local',
      note TEXT NOT NULL DEFAULT '', last_seen_at TEXT, last_reach TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    new FriendsStore(db);
    new FriendsStore(db); // idempotent
    const cols = (db.prepare(`PRAGMA table_info(kernl_friends)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("manual_url");
  });
});
