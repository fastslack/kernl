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
import { sign } from "../src/modules/projects/connector-contract.js";
import { EventBus } from "../src/core/event-bus.js";

describe("connector funnel events", () => {
  let db: Database; let root: string; let projects: ProjectsService; let events: EventBus; let conn: ConnectorService; let secret: string;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    runMigrations(db, "crm", crmMigrations);
    events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "cf-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    const p = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } });
    secret = projects.connectorSecrets(p.id).webhookSecret;
    conn = new ConnectorService(db, events, projects, (async () => new Response("{}")) as never);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const post = (body: unknown) => { const raw = JSON.stringify(body); return conn.handleWebhook("heural", raw, sign(raw, secret)); };

  it("stores a funnel event once, strips personal fields, emits project:<type>", () => {
    const got: unknown[] = [];
    events.on("project:user.signed_up", (p) => got.push(p));
    const ev = { event_id: "e1", type: "user.signed_up", occurred_at: "2026-10-15T10:00:00Z",
      data: { user_ref: "u1", at: "2026-10-15T10:00:00Z", source: "google", specialty: "pediatría", province: "CABA", email: "x@y.com", name: "Ana" } };
    expect(post(ev).status).toBe(200);
    expect(post(ev)).toEqual({ status: 200, body: "duplicate" });
    const recs = conn.records(projects.get("heural")!.id, "funnel_event");
    expect(recs.length).toBe(1);
    expect(JSON.stringify(recs[0].data)).not.toContain("x@y.com");
    expect(JSON.stringify(recs[0].data)).not.toContain("Ana");
    expect(recs[0].data).toMatchObject({ type: "user.signed_up", user_ref: "u1", specialty: "pediatría" });
    expect(got.length).toBe(1);
    expect(JSON.stringify(got[0])).not.toContain("x@y.com");
  });

  it("accepts every funnel type and rejects a funnel event without user_ref", () => {
    for (const [i, type] of ["user.email_verified", "user.profile_completed", "professional.verified", "user.churned"].entries())
      expect(post({ event_id: `f${i}`, type, occurred_at: "2026-10-15T10:00:00Z", data: { user_ref: "u1", at: "2026-10-15T10:00:00Z" } }).status).toBe(200);
    expect(post({ event_id: "a1", type: "user.activated", occurred_at: "2026-10-15T10:00:00Z", data: { user_ref: "u1", at: "2026-10-15T10:00:00Z", rule: "first_record_7d" } }).status).toBe(200);
    expect(post({ event_id: "bad", type: "user.activated", occurred_at: "2026-10-15T10:00:00Z", data: { at: "2026-10-15T10:00:00Z" } }).status).toBe(400);
  });

  it("v1 events still work", () => {
    const inst = { id: "i1", name: "Clínica", country: "AR", plan: "free", created_at: "2026-10-01T00:00:00Z",
      usage: { users: 1, practitioners: 1, encounters_30d: 0, appointments_30d: 0 }, admin: { name: "A", email: "a@b.c" } };
    expect(post({ event_id: "v1", type: "institution.created", occurred_at: "2026-10-15T10:00:00Z", data: inst }).status).toBe(200);
    expect(conn.records(projects.get("heural")!.id, "institution").length).toBe(1);
  });
});
