import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { OutboxService } from "../src/modules/projects/outbox-service.js";
import { ConnectorService } from "../src/modules/projects/connector-service.js";
import { sign } from "../src/modules/projects/connector-contract.js";
import { registerProjectsRoutes } from "../src/modules/projects/api-routes.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

const TOKEN = "t0k";
const db = new Database(":memory:");
runMigrations(db, "agents", agentsMigrations);
runMigrations(db, "projects", projectsMigrations);
runMigrations(db, "crm", crmMigrations);
const events = new EventBus();
const root = mkdtempSync(join(tmpdir(), "api-"));
const projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
const outbox = new OutboxService(db, events, projects, () => {});
const connector = new ConnectorService(db, events, projects);
const agents = new AgentService(db, events);
const sent: unknown[] = [];
outbox.registerChannel("fake", {
  validate: () => ({ ok: true }),
  preview: (p) => ({ title: "post", body: String((p as { text?: string }).text ?? "") }),
  send: async (p) => { sent.push(p); return { ref: "r1" }; },
});

const server = new KernelHttpServer({
  config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: TOKEN }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
});
registerProjectsRoutes(server, { projects, outbox, connector, flowName: (id) => agents.getFlow(id)?.name ?? id, listFlows: () => agents.listFlows() });

let base = "";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });

beforeAll(async () => {
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => { await server.stop(); db.close(); rmSync(root, { recursive: true, force: true }); });

describe("projects REST", () => {
  it("requires the token", async () => {
    const r = await fetch(`${base}/api/projects`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("creates, lists and updates a project; bad input is a 400, unknown id a 404", async () => {
    const r = await call("/api/projects", { method: "POST", body: JSON.stringify({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }) });
    expect(r.status).toBe(200);
    const list = (await (await call("/api/projects")).json()) as { projects: Array<{ slug: string; pending_drafts: number; leads: number }> };
    expect(list.projects.map((p) => p.slug)).toEqual(["heural"]);
    expect(list.projects[0].pending_drafts).toBe(0);
    const bad = await call("/api/projects", { method: "POST", body: JSON.stringify({ slug: "Bad Slug", name: "x", brief: { value_prop: "v", audience: "a" } }) });
    expect(bad.status).toBe(400);
    expect((await call("/api/projects/nope")).status).toBe(404);
    const up = await call("/api/projects/heural", { method: "PUT", body: JSON.stringify({ status: "paused" }) });
    expect(((await up.json()) as { project: { status: string } }).project.status).toBe("paused");
    await call("/api/projects/heural", { method: "PUT", body: JSON.stringify({ status: "active" }) });
  });

  it("links, assigns an office and reports both on the detail", async () => {
    const flow = agents.createFlow({ name: "Ventas" });
    await call("/api/projects/heural/links", { method: "POST", body: JSON.stringify({ kind: "social_account", ref_id: "fake:1" }) });
    await call(`/api/projects/heural/offices/${flow.id}`, { method: "PUT", body: JSON.stringify({ settings: { countries: ["AR"] } }) });
    const d = (await (await call("/api/projects/heural")).json()) as { links: unknown[]; offices: Array<{ flow_id: string; name: string; settings: unknown }> };
    expect(d.links.length).toBe(1);
    expect(d.offices).toEqual([expect.objectContaining({ flow_id: flow.id, name: "Ventas", settings: { countries: ["AR"] } })]);
    const op = (await (await call(`/api/offices/${flow.id}/projects`)).json()) as { projects: unknown[] };
    expect(op.projects.length).toBe(1);
  });

  it("never returns connector secrets in project payloads", async () => {
    await call("/api/projects/heural/connector", { method: "PUT", body: JSON.stringify({ url: "https://x.test/kernl/v1", token: "SECRET-TOKEN" }) });
    const text = await (await call("/api/projects/heural")).text();
    expect(text).not.toContain("SECRET-TOKEN");
    const ws = (await (await call("/api/projects/heural/webhook-secret")).json()) as { secret: string; path: string };
    expect(ws.secret.length).toBeGreaterThan(20);
    expect(ws.path).toBe("/api/projects/webhook/heural");
  });

  it("accepts a signed webhook without the token, refuses a bad signature", async () => {
    const secret = projects.connectorSecrets("heural").webhookSecret;
    const raw = `{"event_id":"w1","type":"waitlist.joined","occurred_at":"2026-10-04T00:00:00Z","data":{"name":"Caro","email":"caro@x.ar","created_at":"2026-10-04T00:00:00Z"}}`;
    const ok = await fetch(`${base}/api/projects/webhook/heural`, { method: "POST", body: raw, headers: { "X-Kernl-Signature": sign(raw, secret), "Content-Type": "application/json" } });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/api/projects/webhook/heural`, { method: "POST", body: raw, headers: { "X-Kernl-Signature": "sha256=00" } });
    expect(bad.status).toBe(401);
  });

  it("lists, edits, rejects and approves drafts", async () => {
    const pid = projects.get("heural")!.id;
    const a = outbox.propose({ project_id: pid, flow_id: "F", agent_id: "A", run_id: "R", channel: "fake", account_ref: "fake:1", payload: { text: "uno" } });
    const b = outbox.propose({ project_id: pid, flow_id: "F", agent_id: "A", run_id: "R", channel: "fake", account_ref: "fake:1", payload: { text: "dos" } });
    const count = (await (await call("/api/outbox/count")).json()) as { pending: number };
    expect(count.pending).toBe(2);
    const list = (await (await call(`/api/outbox?project_id=${pid}&status=draft`)).json()) as { items: Array<{ id: string; preview: { body: string } }> };
    expect(list.items.map((i) => i.preview.body).sort()).toEqual(["dos", "uno"]);
    await call(`/api/outbox/${a.id}`, { method: "PUT", body: JSON.stringify({ payload: { text: "uno editado" } }) });
    const noNote = await call(`/api/outbox/${b.id}/reject`, { method: "POST", body: JSON.stringify({ note: "" }) });
    expect(noNote.status).toBe(400);
    expect((await call(`/api/outbox/${b.id}/reject`, { method: "POST", body: JSON.stringify({ note: "no" }) })).status).toBe(200);
    const ap = (await (await call(`/api/outbox/${a.id}/approve`, { method: "POST", body: "{}" })).json()) as { item: { status: string } };
    expect(ap.item.status).toBe("sent");
    expect(sent).toEqual([{ text: "uno editado" }]);
    const again = await call(`/api/outbox/${a.id}/approve`, { method: "POST", body: "{}" });
    expect(again.status).toBe(409);
  });
});
