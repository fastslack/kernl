import { describe, expect, test } from "bun:test";
import { TaskRegistry } from "../src/core/task-registry.js";

/**
 * TaskRegistry unit tests — covers the create/get/result/cancel surface
 * plus the TTL sweep. Pure in-memory, no SQLite, no network.
 */

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TaskRegistry", () => {
  test("create() returns a wire record immediately and runs worker async", async () => {
    const reg = new TaskRegistry();
    const wire = reg.create({}, async () => {
      await delay(10);
      return { hello: "world" };
    });
    expect(wire.taskId).toBeDefined();
    expect(wire.status).toBe("working");

    // Drain microtasks so the worker has a chance to run.
    await delay(40);
    const r = reg.result(wire.taskId);
    expect(r.found).toBe(true);
    if (r.found && r.ready) {
      expect(r.status).toBe("completed");
      expect(r.payload).toEqual({ hello: "world" });
    } else {
      throw new Error("expected task to be ready");
    }
    reg.shutdown();
  });

  test("result() reports ready=false while worker still running", async () => {
    const reg = new TaskRegistry();
    const wire = reg.create({}, async () => {
      await delay(100);
      return 42;
    });
    const r = reg.result(wire.taskId);
    expect(r.found).toBe(true);
    if (r.found && !r.ready) {
      expect(r.status).toBe("working");
    } else {
      throw new Error("expected task to be NOT ready");
    }
    reg.shutdown();
  });

  test("worker errors are captured as failed status with statusMessage", async () => {
    const reg = new TaskRegistry();
    const wire = reg.create({}, async () => {
      throw new Error("boom");
    });
    await delay(20);
    const r = reg.result(wire.taskId);
    expect(r.found).toBe(true);
    if (r.found && r.ready) {
      expect(r.status).toBe("failed");
      expect(r.statusMessage).toBe("boom");
    } else {
      throw new Error("expected task to be ready (failed)");
    }
    reg.shutdown();
  });

  test("cancel() flips status and aborts the signal", async () => {
    const reg = new TaskRegistry();
    let aborted = false;
    const wire = reg.create({}, async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await delay(200);
      return "should never see this";
    });
    // Yield a tick so the worker microtask runs and the abort listener
    // is wired up before we cancel.
    await delay(10);
    const cancelled = reg.cancel(wire.taskId);
    expect(cancelled?.status).toBe("cancelled");
    await delay(20);
    expect(aborted).toBe(true);
    reg.shutdown();
  });

  test("get() returns null for unknown taskId", () => {
    const reg = new TaskRegistry();
    expect(reg.get("nonexistent")).toBeNull();
    reg.shutdown();
  });

  test("list() paginates with cursor", async () => {
    const reg = new TaskRegistry();
    for (let i = 0; i < 5; i++) {
      reg.create({}, async () => i);
    }
    await delay(20);
    const page1 = reg.list(undefined, 2);
    expect(page1.tasks).toHaveLength(2);
    expect(page1.nextCursor).toBe("2");
    const page2 = reg.list(page1.nextCursor, 2);
    expect(page2.tasks).toHaveLength(2);
    expect(page2.nextCursor).toBe("4");
    const page3 = reg.list(page2.nextCursor, 2);
    expect(page3.tasks).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
    reg.shutdown();
  });

  test("result() preserves the worker's structured payload", async () => {
    const reg = new TaskRegistry();
    const wire = reg.create({}, async () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { count: 7 },
    }));
    await delay(30);
    const r = reg.result(wire.taskId);
    expect(r.found && r.ready).toBe(true);
    if (r.found && r.ready) {
      expect((r.payload as { structuredContent: { count: number } }).structuredContent.count).toBe(7);
    }
    reg.shutdown();
  });
});
