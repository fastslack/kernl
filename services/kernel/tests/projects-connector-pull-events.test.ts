import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { ConnectorService } from "../src/modules/projects/connector-service.js";
import { EventBus } from "../src/core/event-bus.js";

// A Kernl with no public address cannot receive webhooks: it pulls the same events from {url}/events.
describe("connector: events by pull", () => {
  let db: Database; let root: string; let projects: ProjectsService; let events: EventBus; let pid: string;
  let calls: Array<{ url: string; auth: string }>; let reply: () => Response;
  const make = () => new ConnectorService(db, events, projects, (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization) });
    return reply();
  }) as never);
  const ev = (id: string, at: string) => ({ event_id: id, type: "user.signed_up", occurred_at: at, data: { user_ref: "u1", at, source: "google" } });

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    runMigrations(db, "crm", crmMigrations);
    events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "cp-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    pid = projects.create({ slug: "acme", name: "Acme", brief: { value_prop: "v", audience: "a" } }).id;
    projects.setConnector(pid, { url: "https://api.example.test/kernl/v1/", token: "tok" });
    calls = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pulls with the snapshot's token, stores each event once and moves the cursor", async () => {
    reply = () => Response.json({ events: [ev("e1", "2026-10-16T10:00:00Z"), ev("e2", "2026-10-16T11:00:00Z"), { type: "nope" }] });
    const conn = make();
    const got: unknown[] = [];
    events.on("project:user.signed_up", (p) => { got.push(p); });
    expect(await conn.pullEvents(pid)).toEqual({ events: 2, rejected: 1 });
    expect(calls[0]).toEqual({ url: "https://api.example.test/kernl/v1/events?since=1970-01-01T00%3A00%3A00Z", auth: "Bearer tok" });
    expect(conn.records(pid, "funnel_event")).toHaveLength(2);
    expect(got).toHaveLength(2);
    await conn.pullEvents(pid);
    expect(calls[1].url).toContain("since=2026-10-16T11%3A00%3A00Z");
    expect(conn.records(pid, "funnel_event")).toHaveLength(2); // same events again: deduplicated
  });

  it("uses the project's next_since when it gives one", async () => {
    reply = () => Response.json({ events: [], next_since: "2026-10-16T12:00:00Z" });
    const conn = make();
    await conn.pullEvents(pid);
    await conn.pullEvents(pid);
    expect(calls[1].url).toContain("since=2026-10-16T12%3A00%3A00Z");
  });

  it("a project without /events (404) is not an error", async () => {
    reply = () => new Response("not found", { status: 404 });
    expect(await make().pullEvents(pid)).toEqual({ events: 0, rejected: 0 });
  });
});
