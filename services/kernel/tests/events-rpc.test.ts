import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { eventsMigrations } from "../assets/extensions/people/events/_module/migrations/001_events.js";
import { eventsRpcActions } from "../assets/extensions/people/events/_module/rpc-actions.js";
import type { RpcAction } from "../src/core/mtw/rpc-handler.js";

function setup() {
  const db = new Database(":memory:");
  // events.organizer_contact_id FKs to contacts (not present in this isolated
  // test DB); reschedule logic under test doesn't depend on FK enforcement.
  db.run("PRAGMA foreign_keys = OFF");
  runMigrations(db, "events", eventsMigrations);
  const actions = eventsRpcActions(db);
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const a = actions.find((x: RpcAction) => x.name === name);
    if (!a) throw new Error(`no action ${name}`);
    return Promise.resolve(a.handler(args));
  };
  // Insert directly (the events.create handler passes nulls for NOT NULL
  // columns — unrelated pre-existing issue; not under test here).
  let n = 0;
  const insert = (start_at: string, end_at: string | null): string => {
    const id = `ev-${++n}`;
    db.prepare(
      "INSERT INTO events (id, title, start_at, end_at, created_at, updated_at) VALUES (?, 'E', ?, ?, ?, ?)",
    ).run(id, start_at, end_at, start_at, start_at);
    return id;
  };
  return { db, call, insert };
}

describe("events RPC reschedule", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => { env = setup(); });
  afterEach(() => { env.db.close(); });

  it("reschedule preserves duration by shifting end_at", async () => {
    const id = env.insert("2026-07-01T09:00:00.000Z", "2026-07-01T10:00:00.000Z");
    await env.call("events.reschedule", { id, start_at: "2026-07-05T09:00:00.000Z" });
    const ev = env.db.prepare("SELECT start_at, end_at FROM events WHERE id = ?").get(id) as { start_at: string; end_at: string };
    expect(ev.start_at).toBe("2026-07-05T09:00:00.000Z");
    expect(ev.end_at).toBe("2026-07-05T10:00:00.000Z");
  });

  it("reschedule works when there is no end_at", async () => {
    const id = env.insert("2026-07-01T09:00:00.000Z", null);
    await env.call("events.reschedule", { id, start_at: "2026-07-08T09:00:00.000Z" });
    const ev = env.db.prepare("SELECT start_at, end_at FROM events WHERE id = ?").get(id) as { start_at: string; end_at: string | null };
    expect(ev.start_at).toBe("2026-07-08T09:00:00.000Z");
    expect(ev.end_at).toBeNull();
  });

  it("create works with minimal args (defaults for NOT NULL columns)", async () => {
    const { ok, id } = (await env.call("events.create", {
      title: "Quick", start_at: "2026-07-02T15:00:00.000Z",
    })) as { ok: boolean; id: string };
    expect(ok).toBe(true);
    const ev = env.db.prepare("SELECT title, duration_minutes, min_attendees FROM events WHERE id = ?").get(id) as { title: string; duration_minutes: number; min_attendees: number };
    expect(ev.title).toBe("Quick");
    expect(ev.duration_minutes).toBe(90);
    expect(ev.min_attendees).toBe(1);
  });

  it("reschedule on a missing event throws", async () => {
    await expect(env.call("events.reschedule", { id: "nope", start_at: "2026-07-08T09:00:00.000Z" })).rejects.toThrow();
  });
});
