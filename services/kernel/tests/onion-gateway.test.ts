import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runMigrations } from "../src/core/db/migrations.js";
import { configMigrations } from "../src/modules/config/migrations/001_config.js";
import { OnionGateway, ONION_SERVICES_KEY } from "../src/core/peering/onion-gateway.js";

describe("OnionGateway", () => {
  let db: InstanceType<typeof Database>; let server: Server; let base: string; let gw: OnionGateway;
  let seen: Array<{ url: string; auth?: string; cookie?: string }>;
  let clock: number;

  beforeEach(async () => {
    db = new Database(":memory:");
    runMigrations(db as never, "config", configMigrations);
    seen = [];
    clock = 0;
    gw = new OnionGateway({
      sqlite: db as never,
      perMinute: 20,
      now: () => clock,
      dispatch: async (req, res) => {
        seen.push({ url: req.url ?? "", auth: req.headers.authorization, cookie: req.headers.cookie });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("kernel");
      },
    });
    server = createServer((req, res) => void gw.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => { server.close(); db.close(); });

  // fetch() would normalize `..` itself before sending; a raw request does not.
  const raw = (path: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const req = request(`${base}${path}`, { headers, path }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

  it("serves the presence card and the friends service by default, nothing else", async () => {
    expect(await raw("/.well-known/kernl")).toBe(200);
    expect(await raw("/api/peering/transfer/offer")).toBe(200);
    expect(await raw("/api/peering/persona")).toBe(200);
    for (const p of ["/", "/api/health", "/api/metrics", "/mcp", "/api/peering/friends", "/api/peering/relay",
      "/api/cinema/directories/friend-view", "/api/apple-health/push", "/api/peering/transferX"]) {
      expect(await raw(p)).toBe(404);
    }
    expect(seen.map((s) => s.url)).toEqual(["/.well-known/kernl", "/api/peering/transfer/offer", "/api/peering/persona"]);
  });

  it("normalizes the path before deciding, so dot segments cannot reach an owner route", async () => {
    expect(await raw("/api/peering/transfer/../friends")).toBe(404);
    expect(await raw("/api/peering/transfer/%2e%2e/friends")).toBe(404);
    expect(await raw("/api/peering/transfer%2f..%2ffriends")).toBe(404);
    expect(await raw("/api/peering/transfer/..%5cfriends")).toBe(404);
    expect(seen).toEqual([]);
  });

  it("hands over the normalized path and never the owner's credentials", async () => {
    await raw("/api/peering/transfer/./abc?x=1", { Authorization: "Bearer owner-token", Cookie: "s=1" });
    expect(seen).toEqual([{ url: "/api/peering/transfer/abc?x=1", auth: undefined, cookie: undefined }]);
  });

  it("opens and closes a service at the operator's word, and remembers it", async () => {
    gw.setService("cinema", true);
    gw.setService("friends", false);
    expect(await raw("/api/cinema/directories/friend-view")).toBe(200);
    expect(await raw("/api/peering/transfer/offer")).toBe(404);
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ONION_SERVICES_KEY) as { value: string };
    expect(JSON.parse(row.value)).toEqual(["cinema"]);
    expect(gw.services().find((s) => s.id === "presence")).toMatchObject({ enabled: true, locked: true });
  });

  it("refuses to unpublish the presence card or an unknown service", () => {
    expect(() => gw.setService("presence", false)).toThrow(/always published/);
    expect(() => gw.setService("mcp", true)).toThrow(/unknown service/);
  });

  it("has one budget for everyone, since Tor hides who is asking", async () => {
    for (let i = 0; i < 20; i++) await raw("/.well-known/kernl");
    expect(await raw("/.well-known/kernl")).toBe(429);
    clock += 60_000;
    expect(await raw("/.well-known/kernl")).toBe(200);
  });

  it("falls back to the defaults when the stored choice is unreadable", async () => {
    db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'not json', 'x')",
    ).run(ONION_SERVICES_KEY);
    expect(await raw("/api/peering/transfer/offer")).toBe(200);
    expect(await raw("/api/cinema/directories/friend-view")).toBe(404);
  });
});
