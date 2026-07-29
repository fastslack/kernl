import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { NotificationRegistry } from "../src/core/notify/registry.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { marketplaceMigrations } from "../src/modules/marketplace/migrations.js";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../src/core/notify/provider.js";

// ── Fake provider for testing ─────────────────────────────────────

class FakeProvider implements NotificationProvider {
  readonly id: string;
  readonly name: string;
  readonly icon = "🧪";
  readonly capabilities: ProviderCapability[] = ["notify"];

  private ready = false;
  started = false;
  stopped = false;
  lastPayload: NotificationPayload | null = null;
  configured: Record<string, unknown> = {};
  shouldFail = false;

  constructor(id: string, name?: string) {
    this.id = id;
    this.name = name ?? id;
  }

  getConfigSchema(): ConfigField[] {
    return [
      { key: "token", label: "Token", type: "password", required: true },
    ];
  }

  validateConfig(config: Record<string, unknown>) {
    return config.token ? { valid: true } : { valid: false, errors: ["token required"] };
  }

  configure(config: Record<string, unknown>): void {
    this.configured = config;
  }

  async start(): Promise<void> {
    if (this.shouldFail) throw new Error("start failed");
    this.started = true;
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  getStatus(): ProviderStatus {
    return { id: this.id, name: this.name, icon: this.icon, connected: this.ready, enabled: true, capabilities: this.capabilities };
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    this.lastPayload = payload;
    return true;
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("NotificationRegistry", () => {
  let db: Database;
  let registry: NotificationRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db, "marketplace", marketplaceMigrations);

    registry = new NotificationRegistry();
    registry.setDb(db);
  });

  function seedChannel(slug: string, status: string = "active", packageData = "{}") {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO marketplace_items (id, type, slug, name, status, package_data, created_at, updated_at)
      VALUES (?, 'channel', ?, ?, ?, ?, ?, ?)
    `).run(slug, slug, slug, status, packageData, now, now);
  }

  it("registerFactory stores factory and getAvailableProviderIds returns slugs", () => {
    registry.registerFactory("test-a", () => new FakeProvider("test-a"));
    registry.registerFactory("test-b", () => new FakeProvider("test-b"));
    expect(registry.getAvailableProviderIds()).toEqual(["test-a", "test-b"]);
  });

  it("startAll only instantiates active marketplace channels", async () => {
    let aCreated = false;
    let bCreated = false;

    registry.registerFactory("chan-a", () => { aCreated = true; return new FakeProvider("chan-a"); });
    registry.registerFactory("chan-b", () => { bCreated = true; return new FakeProvider("chan-b"); });
    registry.registerFactory("chan-c", () => new FakeProvider("chan-c")); // no marketplace row

    seedChannel("chan-a", "active");
    seedChannel("chan-b", "installed"); // not active

    await registry.startAll();

    expect(aCreated).toBe(true);
    expect(bCreated).toBe(false); // not active in marketplace
    expect(registry.getProviderIds()).toEqual(["chan-a"]);
  });

  it("startAll configures provider from package_data", async () => {
    registry.registerFactory("configured", () => new FakeProvider("configured"));
    seedChannel("configured", "active", JSON.stringify({ token: "secret123" }));

    await registry.startAll();

    const provider = registry.getProvider("configured") as FakeProvider;
    expect(provider.configured).toEqual({ token: "secret123" });
  });

  it("startAll runs pre-start hooks before start", async () => {
    let hookCalled = false;
    registry.registerFactory("hooked", () => new FakeProvider("hooked"));
    registry.registerPreStartHook("hooked", (p) => {
      hookCalled = true;
      // Hook should run before start
      expect((p as FakeProvider).started).toBe(false);
    });
    seedChannel("hooked", "active");

    await registry.startAll();

    expect(hookCalled).toBe(true);
    expect((registry.getProvider("hooked") as FakeProvider).started).toBe(true);
  });

  it("startAll skips providers without registered factory", async () => {
    // Marketplace has a channel but no factory registered
    seedChannel("unknown-channel", "active");
    await registry.startAll();
    expect(registry.getProviderIds()).toEqual([]);
  });

  it("startAll handles provider start failure gracefully", async () => {
    registry.registerFactory("failing", () => {
      const p = new FakeProvider("failing");
      p.shouldFail = true;
      return p;
    });
    seedChannel("failing", "active");

    // Should not throw
    await registry.startAll();
    expect(registry.getProviderIds()).toEqual([]);
  });

  it("startProvider creates instance from factory and starts it", async () => {
    registry.registerFactory("manual", () => new FakeProvider("manual"));
    seedChannel("manual", "active", JSON.stringify({ token: "abc" }));

    const ok = await registry.startProvider("manual");
    expect(ok).toBe(true);
    expect(registry.getProvider("manual")).toBeDefined();
    expect((registry.getProvider("manual") as FakeProvider).configured).toEqual({ token: "abc" });
  });

  it("startProvider returns false for unknown factory", async () => {
    const ok = await registry.startProvider("nonexistent");
    expect(ok).toBe(false);
  });

  it("stopProvider stops and removes running provider", async () => {
    registry.registerFactory("stoppable", () => new FakeProvider("stoppable"));
    seedChannel("stoppable", "active");

    await registry.startAll();
    expect(registry.getProvider("stoppable")).toBeDefined();

    const ok = await registry.stopProvider("stoppable");
    expect(ok).toBe(true);
    expect(registry.getProvider("stoppable")).toBeUndefined();
  });

  it("broadcast sends to all active providers", async () => {
    registry.registerFactory("b1", () => new FakeProvider("b1"));
    registry.registerFactory("b2", () => new FakeProvider("b2"));
    seedChannel("b1", "active");
    seedChannel("b2", "active");

    await registry.startAll();

    const results = await registry.broadcast({ title: "Hello" });
    expect(results.get("b1")).toBe(true);
    expect(results.get("b2")).toBe(true);
  });

  it("send routes to specific provider", async () => {
    registry.registerFactory("target", () => new FakeProvider("target"));
    seedChannel("target", "active");
    await registry.startAll();

    const ok = await registry.send("target", { title: "Direct" });
    expect(ok).toBe(true);
    expect((registry.getProvider("target") as FakeProvider).lastPayload?.title).toBe("Direct");
  });

  it("send returns false for non-running provider", async () => {
    const ok = await registry.send("ghost", { title: "Nobody home" });
    expect(ok).toBe(false);
  });

  it("loadConfig / saveConfig round-trip via marketplace_items", () => {
    seedChannel("cfg-test", "active", JSON.stringify({ webhookUrl: "http://example.com" }));

    const loaded = registry.loadConfig("cfg-test");
    expect(loaded).toEqual({ webhookUrl: "http://example.com" });

    const saved = registry.saveConfig("cfg-test", { webhookUrl: "http://new.com", secret: "shhh" });
    expect(saved).toBe(true);

    const reloaded = registry.loadConfig("cfg-test");
    expect(reloaded).toEqual({ webhookUrl: "http://new.com", secret: "shhh" });
  });

  it("getStatuses returns all available (running + not running)", async () => {
    registry.registerFactory("running", () => new FakeProvider("running", "Running Chan"));
    registry.registerFactory("idle", () => new FakeProvider("idle", "Idle Chan"));
    seedChannel("running", "active");

    await registry.startAll();

    const statuses = registry.getStatuses();
    expect(statuses).toHaveLength(2);

    const runningStatus = statuses.find((s) => s.id === "running");
    const idleStatus = statuses.find((s) => s.id === "idle");
    expect(runningStatus?.connected).toBe(true);
    expect(idleStatus?.connected).toBe(false);
  });

  it("getConfigSchema returns schema from running or temp instance", async () => {
    registry.registerFactory("schema-test", () => new FakeProvider("schema-test"));

    // Not running — creates temp instance
    const schema = registry.getConfigSchema("schema-test");
    expect(schema).toHaveLength(1);
    expect(schema![0].key).toBe("token");
  });

  it("stopAll stops all running providers", async () => {
    registry.registerFactory("s1", () => new FakeProvider("s1"));
    registry.registerFactory("s2", () => new FakeProvider("s2"));
    seedChannel("s1", "active");
    seedChannel("s2", "active");
    await registry.startAll();

    expect(registry.getProviderIds()).toHaveLength(2);

    await registry.stopAll();
    expect(registry.getProviderIds()).toHaveLength(0);
  });

  it("hasActiveProvider reflects whether any provider is ready", async () => {
    expect(registry.hasActiveProvider).toBe(false);

    registry.registerFactory("active", () => new FakeProvider("active"));
    seedChannel("active", "active");
    await registry.startAll();

    expect(registry.hasActiveProvider).toBe(true);
  });

  it("startProvider stops existing instance before restarting", async () => {
    registry.registerFactory("restart", () => new FakeProvider("restart"));
    seedChannel("restart", "active");

    await registry.startProvider("restart");
    const first = registry.getProvider("restart") as FakeProvider;

    await registry.startProvider("restart");
    const second = registry.getProvider("restart") as FakeProvider;

    expect(first.stopped).toBe(true);
    expect(second.started).toBe(true);
    expect(first).not.toBe(second); // new instance
  });
});
