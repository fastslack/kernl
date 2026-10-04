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

const SNAP = {
  version: "v1", generated_at: "2026-10-04T12:00:00Z",
  institutions: [{ id: "i1", name: "Clínica Sur", country: "AR", plan: "free", created_at: "2026-09-01T00:00:00Z", last_active_at: "2026-10-03T00:00:00Z",
    usage: { users: 3, practitioners: 2, encounters_30d: 120, appointments_30d: 300 },
    admin: { name: "Ana", email: "ana@sur.ar", phone: "+54" }, patients: [{ dni: "123" }] }],
  waitlist: [{ name: "Beto", email: "beto@x.ar", institution: "Consultorio X", created_at: "2026-10-01T00:00:00Z" }],
};

describe("ConnectorService", () => {
  let db: InstanceType<typeof Database>; let projects: ProjectsService; let conn: ConnectorService; let events: EventBus; let root: string;
  let pid: string; let emitted: Array<Record<string, unknown>>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    runMigrations(db, "crm", crmMigrations);
    events = new EventBus(); emitted = [];
    events.on("project:waitlist.joined", (p) => { emitted.push(p as Record<string, unknown>); });
    root = mkdtempSync(join(tmpdir(), "cn-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    pid = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.setConnector(pid, { url: "https://api.heural.test/kernl/v1", token: "tok" });
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      expect(String(url).startsWith("https://api.heural.test/kernl/v1/snapshot?since=")).toBe(true);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return new Response(JSON.stringify(SNAP), { status: 200 });
    }) as unknown as typeof fetch;
    conn = new ConnectorService(db, events, projects, fakeFetch);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("pull stores records, drops unknown fields and upserts contacts once", async () => {
    expect(await conn.pull(pid)).toEqual({ institutions: 1, waitlist: 1 });
    const inst = conn.records(pid, "institution")[0].data as Record<string, unknown>;
    expect(inst.name).toBe("Clínica Sur");
    expect("patients" in inst).toBe(false);
    const c = db.prepare("SELECT email, lead_source, project_id FROM contacts ORDER BY email").all();
    expect(c).toEqual([{ email: "ana@sur.ar", lead_source: "signup", project_id: pid }, { email: "beto@x.ar", lead_source: "waitlist", project_id: pid }]);
    await conn.pull(pid);
    expect((db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n).toBe(2);
    expect(projects.get(pid)!.last_pull_at).not.toBeNull();
  });

  it("signature over raw body; dedupe by event_id; emits project events with project_id", async () => {
    const secret = projects.connectorSecrets(pid).webhookSecret;
    const raw = `{"event_id":"e1","type":"waitlist.joined","occurred_at":"2026-10-04T12:00:00Z","data":{"name":"Caro","email":"caro@x.ar","institution":"Y","created_at":"2026-10-04T12:00:00Z"}}`;
    expect(conn.handleWebhook("heural", raw, "sha256=bad").status).toBe(401);
    expect(conn.handleWebhook("heural", JSON.stringify(JSON.parse(raw), null, 2), sign(raw, secret)).status).toBe(401);
    expect(conn.handleWebhook("heural", raw, sign(raw, secret)).status).toBe(200);
    expect(conn.handleWebhook("heural", raw, sign(raw, secret)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted.length).toBe(1);
    expect(emitted[0].project_id).toBe(pid);
    expect(emitted[0].email).toBe("caro@x.ar");
    expect(conn.handleWebhook("nope", raw, sign(raw, secret)).status).toBe(404);
    expect(projects.get(pid)!.last_webhook_at).not.toBeNull();
  });

  it("an event of an unknown type or shape is a 400, not a crash", () => {
    const secret = projects.connectorSecrets(pid).webhookSecret;
    const raw = `{"event_id":"e2","type":"patient.created","occurred_at":"x","data":{}}`;
    expect(conn.handleWebhook("heural", raw, sign(raw, secret)).status).toBe(400);
  });

  it("a snapshot out of schema is rejected whole with the field named", async () => {
    conn = new ConnectorService(db, events, projects, (async () => new Response(JSON.stringify({ version: "v1", institutions: [{ id: 1 }] }))) as unknown as typeof fetch);
    await expect(conn.pull(pid)).rejects.toThrow(/institutions\.0/);
    expect(projects.get(pid)!.connector_error).toMatch(/institutions\.0/);
    expect(conn.records(pid, "institution")).toEqual([]);
  });

  it("the next pull asks from the snapshot's generated_at minus an overlap, not from Kernl's clock", async () => {
    const urls: string[] = [];
    conn = new ConnectorService(db, events, projects, (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(SNAP)); }) as unknown as typeof fetch);
    await conn.pull(pid);
    await conn.pull(pid);
    const since = decodeURIComponent(urls[1].split("since=")[1]);
    expect(since <= "2026-10-04T12:00:00Z").toBe(true);
    expect(Date.parse("2026-10-04T12:00:00Z") - Date.parse(since)).toBeLessThanOrEqual(10 * 60_000);
  });

  it("pullAllDue skips projects pulled in the last 6 hours", async () => {
    let calls = 0;
    conn = new ConnectorService(db, events, projects, (async () => { calls++; return new Response(JSON.stringify(SNAP)); }) as unknown as typeof fetch);
    await conn.pullAllDue(new Date());
    await conn.pullAllDue(new Date());
    expect(calls).toBe(1);
    await conn.pullAllDue(new Date(Date.now() + 7 * 3600_000));
    expect(calls).toBe(2);
  });
});

describe("webhook auth exemption", () => {
  it("exempts only the project webhook prefix from the token", async () => {
    const { isWebhookPath } = await import("../src/core/auth.js");
    expect(isWebhookPath("POST", "/api/projects/webhook/heural")).toBe(true);
    expect(isWebhookPath("GET", "/api/projects/webhook/heural")).toBe(false);
    expect(isWebhookPath("PUT", "/api/projects/webhook/connector")).toBe(false);
    expect(isWebhookPath("POST", "/api/projects/webhook/heural/pull")).toBe(false);
    expect(isWebhookPath("POST", "/api/projects")).toBe(false);
    expect(isWebhookPath("POST", "/api/projects/webhook")).toBe(false);
  });

  it("reserves the slug that would collide with the webhook prefix", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const root = mkdtempSync(join(tmpdir(), "rs-"));
    const svc = new ProjectsService(db, new EventBus(), { encryptionKey: "a".repeat(64), projectsRoot: root });
    expect(() => svc.create({ slug: "webhook", name: "x", brief: { value_prop: "v", audience: "a" } })).toThrow(/reserved/);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
