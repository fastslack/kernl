/**
 * The running peering service tells extensions whether its instance key is
 * the Social persona key (legacy continuity), so they can keep instance-level
 * public announcements off in that case.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { PeeringService } from "../src/core/peering/service.js";

function addSocialIdentity(db: Database, hex: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS social_identity (" +
      "id TEXT PRIMARY KEY, pubkey TEXT, seed_hex TEXT NOT NULL, display_name TEXT, created_at TEXT)",
  );
  const pubkey = NostrIdentity.fromEd25519Seed(Buffer.from(hex, "hex")).npub();
  db.prepare(
    "INSERT OR REPLACE INTO social_identity (id, pubkey, seed_hex, display_name, created_at) VALUES ('default', ?, ?, 'persona', ?)",
  ).run(pubkey, hex, new Date().toISOString());
}

function addKernelSeed(db: Database, hex: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS kernel_nostr_seed (" +
      "id TEXT PRIMARY KEY CHECK (id = 'default'), seed_hex TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
  db.prepare(
    "INSERT OR REPLACE INTO kernel_nostr_seed (id, seed_hex, created_at) VALUES ('default', ?, ?)",
  ).run(hex, new Date().toISOString());
}

function service(db: Database): PeeringService {
  const s = PeeringService.create({
    sqlite: db as never,
    encryptionKey: "",
    version: "test",
    port: 0,
    dataDir: "/nonexistent-kernl-test",
  });
  if (!s) throw new Error("peering did not start");
  return s;
}

afterEach(() => {
  PeeringService.current = null;
});

describe("PeeringService instance key", () => {
  it("exposes its identity and reports a key shared with the persona", () => {
    const db = new Database(":memory:");
    const seed = randomBytes(32).toString("hex");
    addKernelSeed(db, seed);
    addSocialIdentity(db, seed);
    const s = service(db);

    expect(s.instanceNostrIdentity()).toBe(s.identity);
    expect(s.instanceKeyIsShared()).toBe(true);
  });

  it("reports separate keys as not shared", () => {
    const db = new Database(":memory:");
    addKernelSeed(db, randomBytes(32).toString("hex"));
    addSocialIdentity(db, randomBytes(32).toString("hex"));

    expect(service(db).instanceKeyIsShared()).toBe(false);
  });
});

describe("shared-key warning (F5)", () => {
  async function capture<T>(fn: () => T | Promise<T>): Promise<{ out: T; warnings: string[] }> {
    const { log } = await import("../src/core/logger.js");
    const original = log.warn;
    const warnings: string[] = [];
    (log as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => {
      warnings.push(a.map(String).join(" "));
    };
    try {
      return { out: await fn(), warnings };
    } finally {
      (log as { warn: typeof original }).warn = original;
    }
  }

  it("warns at every create while the key is shared", async () => {
    const { SHARED_KEY_WARNING } = await import("../src/core/peering/service.js");
    const db = new Database(":memory:");
    const seed = randomBytes(32).toString("hex");
    addKernelSeed(db, seed);
    addSocialIdentity(db, seed);
    const first = await capture(() => service(db));
    expect(first.warnings.filter((w) => w.includes(SHARED_KEY_WARNING))).toHaveLength(1);
    expect(SHARED_KEY_WARNING).toContain("instance key equals the public persona key");
    // Next boot: still shared, still warned.
    const second = await capture(() => service(db));
    expect(second.warnings.filter((w) => w.includes(SHARED_KEY_WARNING))).toHaveLength(1);
  });

  it("does not warn with separate keys", async () => {
    const { SHARED_KEY_WARNING } = await import("../src/core/peering/service.js");
    const db = new Database(":memory:");
    addKernelSeed(db, randomBytes(32).toString("hex"));
    addSocialIdentity(db, randomBytes(32).toString("hex"));
    const { warnings } = await capture(() => service(db));
    expect(warnings.some((w) => w.includes(SHARED_KEY_WARNING))).toBe(false);
  });

  it("GET /api/peering/whoami exposes shared", async () => {
    const { KernelHttpServer } = await import("../src/core/http-server.js");
    const { registerPeeringRoutes } = await import("../src/core/peering/routes.js");
    const { FriendsStore } = await import("../src/core/peering/friends-store.js");
    let shared = true;
    const server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as never,
    });
    registerPeeringRoutes(server, {
      friends: new FriendsStore(new Database(":memory:") as never),
      resolver: {} as never,
      currentDescriptor: () => null,
      selfNpub: () => "npub1self",
      instanceKeyShared: () => shared,
    });
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/peering/whoami`;
    try {
      expect(((await (await fetch(url)).json()) as { shared: boolean }).shared).toBe(true);
      shared = false;
      expect(((await (await fetch(url)).json()) as { shared: boolean }).shared).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
