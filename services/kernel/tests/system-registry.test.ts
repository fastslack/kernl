import { describe, it, expect, beforeEach } from "bun:test";
import { SystemRegistry } from "../src/core/system-registry.js";

describe("SystemRegistry", () => {
  let registry: SystemRegistry;

  beforeEach(() => {
    registry = new SystemRegistry();
  });

  it("registers a process and returns an id", () => {
    const id = registry.register({
      name: "Test Interval",
      type: "interval",
      module: "test",
      description: "A test interval",
      intervalMs: 5000,
    });
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("lists all registered processes", () => {
    registry.register({ name: "A", type: "interval", module: "m1", description: "d1", intervalMs: 1000 });
    registry.register({ name: "B", type: "cache", module: "m2", description: "d2", ttlMs: 5000 });

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.name).sort()).toEqual(["A", "B"]);
  });

  it("sets default status to running and runCount to 0", () => {
    const id = registry.register({ name: "X", type: "interval", module: "m", description: "d" });
    const proc = registry.get(id);
    expect(proc?.status).toBe("running");
    expect(proc?.runCount).toBe(0);
    expect(proc?.startedAt).toBeTruthy();
  });

  it("allows custom initial status", () => {
    const id = registry.register({ name: "X", type: "watcher", module: "m", description: "d", status: "idle" });
    expect(registry.get(id)?.status).toBe("idle");
  });

  it("unregisters a process", () => {
    const id = registry.register({ name: "A", type: "interval", module: "m", description: "d" });
    expect(registry.list()).toHaveLength(1);
    registry.unregister(id);
    expect(registry.list()).toHaveLength(0);
  });

  it("recordRun updates lastRunAt, runCount, and nextRunAt for intervals", () => {
    const id = registry.register({
      name: "Poller",
      type: "interval",
      module: "test",
      description: "polls stuff",
      intervalMs: 10_000,
    });

    const before = registry.get(id)!;
    expect(before.runCount).toBe(0);
    expect(before.lastRunAt).toBeUndefined();
    expect(before.nextRunAt).toBeUndefined();

    registry.recordRun(id);

    const after = registry.get(id)!;
    expect(after.runCount).toBe(1);
    expect(after.lastRunAt).toBeTruthy();
    expect(after.nextRunAt).toBeTruthy();

    // nextRunAt should be ~10s in the future
    const nextRun = new Date(after.nextRunAt!).getTime();
    const now = Date.now();
    expect(nextRun).toBeGreaterThan(now);
    expect(nextRun).toBeLessThanOrEqual(now + 11_000);
  });

  it("recordRun increments runCount on repeated calls", () => {
    const id = registry.register({ name: "A", type: "interval", module: "m", description: "d", intervalMs: 1000 });
    registry.recordRun(id);
    registry.recordRun(id);
    registry.recordRun(id);
    expect(registry.get(id)?.runCount).toBe(3);
  });

  it("recordRun does not compute nextRunAt for non-interval types", () => {
    const id = registry.register({ name: "A", type: "event-listener", module: "m", description: "d", event: "test" });
    registry.recordRun(id);
    expect(registry.get(id)?.nextRunAt).toBeUndefined();
    expect(registry.get(id)?.runCount).toBe(1);
  });

  it("recordRun is a no-op for unknown id", () => {
    // Should not throw
    registry.recordRun("nonexistent-id");
  });

  it("recordCacheHit increments runCount only", () => {
    const id = registry.register({ name: "C", type: "cache", module: "m", description: "d", ttlMs: 60000 });
    registry.recordCacheHit(id);
    registry.recordCacheHit(id);
    const proc = registry.get(id)!;
    expect(proc.runCount).toBe(2);
    expect(proc.lastRunAt).toBeUndefined();
  });

  it("recordCacheRefresh updates lastRunAt and nextRunAt based on TTL", () => {
    const id = registry.register({ name: "C", type: "cache", module: "m", description: "d", ttlMs: 30_000 });
    registry.recordCacheRefresh(id);
    const proc = registry.get(id)!;
    expect(proc.lastRunAt).toBeTruthy();
    expect(proc.nextRunAt).toBeTruthy();

    const nextExpiry = new Date(proc.nextRunAt!).getTime();
    expect(nextExpiry).toBeGreaterThan(Date.now());
    expect(nextExpiry).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it("updateStatus changes the status", () => {
    const id = registry.register({ name: "A", type: "interval", module: "m", description: "d" });
    expect(registry.get(id)?.status).toBe("running");
    registry.updateStatus(id, "stopped");
    expect(registry.get(id)?.status).toBe("stopped");
  });

  it("updateStatus is a no-op for unknown id", () => {
    registry.updateStatus("nonexistent-id", "stopped");
  });

  it("getStats aggregates correctly", () => {
    registry.register({ name: "A", type: "interval", module: "reminders", description: "d" });
    registry.register({ name: "B", type: "interval", module: "dashboard", description: "d" });
    registry.register({ name: "C", type: "event-listener", module: "dashboard", description: "d", event: "x" });
    registry.register({ name: "D", type: "cache", module: "life", description: "d", ttlMs: 1000 });
    registry.register({ name: "E", type: "watcher", module: "core", description: "d", status: "idle" });

    const stats = registry.getStats();
    expect(stats.total).toBe(5);
    expect(stats.running).toBe(4); // watcher is idle
    expect(stats.byType.interval).toBe(2);
    expect(stats.byType["event-listener"]).toBe(1);
    expect(stats.byType.cache).toBe(1);
    expect(stats.byType.watcher).toBe(1);
    expect(stats.byModule.reminders).toBe(1);
    expect(stats.byModule.dashboard).toBe(2);
    expect(stats.byModule.life).toBe(1);
    expect(stats.byModule.core).toBe(1);
  });

  it("clear removes all processes", () => {
    registry.register({ name: "A", type: "interval", module: "m", description: "d" });
    registry.register({ name: "B", type: "cache", module: "m", description: "d" });
    expect(registry.list()).toHaveLength(2);
    registry.clear();
    expect(registry.list()).toHaveLength(0);
    expect(registry.getStats().total).toBe(0);
  });

  it("get returns undefined for unknown id", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("preserves metadata when registered", () => {
    const id = registry.register({
      name: "A",
      type: "interval",
      module: "m",
      description: "d",
      metadata: { custom: "value" },
    });
    expect(registry.get(id)?.metadata).toEqual({ custom: "value" });
  });
});
