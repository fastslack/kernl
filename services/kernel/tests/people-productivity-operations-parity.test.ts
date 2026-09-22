/**
 * The dashboard reaches the contacts, tasks, reminders and comms actions
 * through rpcOrCall: WS RPC when the bridge is up, the HTTP route otherwise.
 * The two roads used to be separate implementations — often raw SQL beside
 * the service — and answered differently for the same request. They are one
 * function each now (the extensions' operations files); these tests pin the
 * places they had drifted apart, driven through both roads. The RPC-only
 * actions (events, goals, notes, learning) are checked for the service
 * behaviour their raw SQL used to skip.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { EventBus } from "../src/core/event-bus.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import type { RpcAction } from "../src/core/mtw/rpc-handler.js";

import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { CrmService } from "../assets/extensions/people/crm/_module/service.js";
import { contactsRpcActions } from "../assets/extensions/people/crm/_module/rpc-actions.js";
import { registerContactsRoutes } from "../assets/extensions/people/crm/_module/routes.js";

import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";
import { tasksRpcActions } from "../assets/extensions/productivity/tasks/_module/rpc-actions.js";
import { registerTasksRoutes } from "../assets/extensions/productivity/tasks/_module/api-routes.js";

import { remindersMigrations } from "../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js";
import { ReminderService } from "../assets/extensions/productivity/reminders/_module/service.js";
import { remindersRpcActions } from "../assets/extensions/productivity/reminders/_module/rpc-actions.js";
import { registerRemindersRoutes } from "../assets/extensions/productivity/reminders/_module/api-routes.js";

import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { CommsService } from "../assets/extensions/people/comms/_module/service.js";
import { EmailAnalysisService } from "../assets/extensions/people/comms/_module/email-analysis-service.js";
import { commsDashboardRpcActions } from "../assets/extensions/people/comms/_module/dashboard-rpc-actions.js";
import { registerCommsDashboardRoutes } from "../assets/extensions/people/comms/_module/dashboard-routes.js";
import { registerEmailSuggestionsRoutes } from "../assets/extensions/people/comms/_module/email-suggestions-routes.js";

import { eventsMigrations } from "../assets/extensions/people/events/_module/migrations/001_events.js";
import { EventsService } from "../assets/extensions/people/events/_module/service.js";
import { eventsRpcActions } from "../assets/extensions/people/events/_module/rpc-actions.js";
import { eventsDashboardRpcActions } from "../assets/extensions/people/events/_module/dashboard-rpc-actions.js";

import { notesMigrations } from "../assets/extensions/productivity/notes/_module/migrations/001_notes.js";
import { NotesService } from "../assets/extensions/productivity/notes/_module/service.js";
import { notesRpcActions } from "../assets/extensions/productivity/notes/_module/rpc-actions.js";

import { learningMigrations } from "../assets/extensions/productivity/learning/_module/migrations/001_learning.js";
import { LearningService } from "../assets/extensions/productivity/learning/_module/service.js";
import { learningRpcActions } from "../assets/extensions/productivity/learning/_module/rpc-actions.js";

import { goalsMigrations } from "../assets/extensions/productivity/goals/_module/migrations/001_goals.js";
import { GoalsService } from "../assets/extensions/productivity/goals/_module/service.js";
import { goalsRpcActions } from "../assets/extensions/productivity/goals/_module/rpc-actions.js";

describe("people + productivity operations", () => {
  let db: InstanceType<typeof Database>;
  let crm: CrmService;
  let tasks: TaskService;
  let reminders: ReminderService;
  let comms: CommsService;
  let events: EventsService;
  let server: KernelHttpServer;
  let base = "";
  let rpc: (name: string, args?: Record<string, unknown>) => Promise<unknown>;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "tasks", tasksMigrations);
    runMigrations(db, "crm", crmMigrations);
    runMigrations(db, "reminders", remindersMigrations);
    runMigrations(db, "comms", commsMigrations);
    runMigrations(db, "events", eventsMigrations);
    runMigrations(db, "notes", notesMigrations);
    runMigrations(db, "learning", learningMigrations);
    runMigrations(db, "goals", goalsMigrations);

    const bus = new EventBus();
    crm = new CrmService(db, () => null);
    tasks = new TaskService(db, () => null);
    reminders = new ReminderService(db, () => null);
    comms = new CommsService(db, bus);
    events = new EventsService(db, bus);
    const emailAnalysis = new EmailAnalysisService(db, {} as KernelConfig);

    const actions: RpcAction[] = [
      ...contactsRpcActions(crm, bus),
      ...tasksRpcActions(tasks, bus),
      ...remindersRpcActions(reminders, bus),
      ...commsDashboardRpcActions({ commsService: comms, emailAnalysisService: emailAnalysis, events: bus }),
      ...eventsRpcActions(events),
      ...eventsDashboardRpcActions({ db, systemRegistry: undefined as never }),
      ...notesRpcActions(new NotesService(db, () => null)),
      ...learningRpcActions(new LearningService(db)),
      ...goalsRpcActions(new GoalsService(db, () => null)),
    ];
    rpc = async (name, args = {}) => {
      const action = actions.find((a) => a.name === name);
      if (!action) throw new Error(`no action ${name}`);
      return action.handler(args);
    };

    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerContactsRoutes(server, crm, bus);
    registerTasksRoutes(server, tasks, bus);
    registerRemindersRoutes(server, reminders, bus);
    registerCommsDashboardRoutes(server, db, comms, bus);
    registerEmailSuggestionsRoutes(server, emailAnalysis);
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await server.stop();
    db.close();
  });

  const http = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  // ── Contacts ────────────────────────────────────────────────

  it("contacts.update takes the service's full field set on both roads (both used to drop 7 of 13)", async () => {
    const lead = { lead_status: "qualified", lead_source: "linkedin-export", linkedin_url: "https://l.in/a", website: "https://a.example" };
    const a = crm.addContact({ name: "A" });
    expect(await rpc("contacts.update", { id: a.id, ...lead })).toEqual({ ok: true });
    const b = crm.addContact({ name: "B" });
    expect((await http("POST", "/api/contacts/update", { id: b.id, ...lead })).status).toBe(200);
    for (const id of [a.id, b.id]) expect(crm.getById(id)).toMatchObject(lead);
  });

  it("contacts.update rejects a bad enum and a missing contact alike", async () => {
    const a = crm.addContact({ name: "A" });
    const bad = await http("POST", "/api/contacts/update", { id: a.id, lead_status: "hot" });
    expect(bad.status).toBe(400);
    await expect(rpc("contacts.update", { id: a.id, lead_status: "hot" })).rejects.toThrow("Invalid lead_status");
    expect((await http("POST", "/api/contacts/update", { id: "nope", name: "X" })).status).toBe(404);
    await expect(rpc("contacts.update", { id: "nope", name: "X" })).rejects.toThrow("Contact not found");
  });

  it("contacts.delete removes a contact that has interactions (the raw DELETE hit the FK)", async () => {
    for (const road of ["rpc", "http"] as const) {
      const c = crm.addContact({ name: `C-${road}` });
      crm.logInteraction({ contact_id: c.id, type: "call", summary: "hi" });
      if (road === "rpc") await rpc("contacts.delete", { id: c.id });
      else expect((await http("POST", "/api/contacts/delete", { id: c.id })).status).toBe(200);
      expect(crm.getById(c.id)).toBeFalsy();
    }
  });

  it("contacts.list and detail answer the same shape on both roads", async () => {
    const c = crm.addContact({ name: "Zed", company: "Acme" });
    crm.logInteraction({ contact_id: c.id, type: "email", summary: "s" });
    const viaRpc = await rpc("contacts.list", { q: "Acme", limit: 20 }) as { total: number; limit: number };
    const viaHttp = await (await http("GET", "/api/contacts/all?q=Acme&limit=20")).json() as { total: number; limit: number };
    expect(viaHttp).toEqual(viaRpc as typeof viaHttp);
    expect(viaRpc.total).toBe(1);
    expect(viaRpc.limit).toBe(20);
    const d1 = await rpc("contacts.detail", { id: c.id });
    const d2 = await (await http("GET", `/api/contacts/detail?id=${c.id}`)).json();
    expect(d2).toEqual(d1 as typeof d2);
  });

  // ── Tasks ───────────────────────────────────────────────────

  it("tasks over HTTP go through the service: soft delete, recurrence on done, 404 on a missing id", async () => {
    const t = tasks.create({ title: "Water", due_date: "2026-06-24", recurrence: "FREQ=WEEKLY" });
    expect((await http("POST", "/api/tasks/update-status", { id: t.id, status: "done" })).status).toBe(200);
    expect(tasks.list({ status: "todo" }).filter((x) => x.title === "Water")).toHaveLength(1);

    const d = tasks.create({ title: "Gone" });
    expect((await http("POST", "/api/tasks/delete", { id: d.id })).status).toBe(200);
    expect(tasks.getById(d.id)!.deleted_at).toBeTruthy();
    const all = await (await http("GET", "/api/tasks/all")).json() as { tasks: Array<{ id: string }> };
    expect(all.tasks.map((x) => x.id)).not.toContain(d.id);

    expect((await http("POST", "/api/tasks/update-priority", { id: "nope", priority: "high" })).status).toBe(404);
    await expect(rpc("tasks.updatePriority", { id: "nope", priority: "high" })).rejects.toThrow("Task not found");
  });

  it("tasks.create syncs tags over HTTP too", async () => {
    const res = await http("POST", "/api/tasks/create", { title: "T", tags: "a,b" });
    const { id } = await res.json() as { id: string };
    expect(tasks.getTaskTags(id).sort()).toEqual(["a", "b"]);
  });

  // ── Reminders ───────────────────────────────────────────────

  it("reminders dismiss/snooze: same result on both roads, 404 for a missing id", async () => {
    const r1 = reminders.create({ title: "R1", trigger_at: "2026-07-01T10:00:00Z" });
    const r2 = reminders.create({ title: "R2", trigger_at: "2026-07-01T10:00:00Z" });
    await rpc("reminders.snooze", { id: r1.id, minutes: 15 });
    expect((await http("POST", "/api/reminders/snooze", { id: r2.id, minutes: 15 })).status).toBe(200);
    for (const id of [r1.id, r2.id]) expect(reminders.getById(id)!.status).toBe("snoozed");

    expect((await http("POST", "/api/reminders/dismiss", { id: "nope" })).status).toBe(404);
    await expect(rpc("reminders.dismiss", { id: "nope" })).rejects.toThrow("Reminder not found");
  });

  it("reminders.update leaves repeat alone when it is not sent", async () => {
    const r = reminders.create({ title: "R", trigger_at: "2026-07-01T10:00:00Z", repeat: "weekly" });
    await rpc("reminders.update", { id: r.id, title: "New" });
    expect(reminders.getById(r.id)).toMatchObject({ title: "New", repeat: "weekly" });
  });

  // ── Comms ───────────────────────────────────────────────────

  it("comms.update writes only the service's fields (RPC used to pass every key into SQL)", async () => {
    const c = comms.create({ subject: "S" });
    await rpc("comms.update", { id: c.id, subject: "New", created_at: "1999-01-01", "id = id; --": "x" });
    const row = comms.getById(c.id)!;
    expect(row.subject).toBe("New");
    expect(row.created_at).not.toBe("1999-01-01");

    const res = await http("PUT", "/api/dashboard/comms/update", { id: c.id, subject: "Again" });
    const body = await res.json() as { subject: string; comm: { subject: string } };
    expect(body.subject).toBe("Again");
    expect(body.comm.subject).toBe("Again");
  });

  it("comms.thread takes the `id` the page sends, and answers an array on both roads", async () => {
    const contact = crm.addContact({ name: "Ann", email: "ann@example.com" });
    const c = comms.create({ subject: "T", contact_id: contact.id });
    const viaRpc = await rpc("comms.thread", { id: c.thread_id }) as Array<{ contact_name: string }>;
    const viaHttp = await (await http("GET", `/api/dashboard/comms/thread?id=${c.thread_id}`)).json() as typeof viaRpc;
    expect(viaRpc).toHaveLength(1);
    expect(viaRpc[0].contact_name).toBe("Ann");
    expect(viaHttp).toEqual(viaRpc);
  });

  it("comms.search searches stored comms and answers an array on both roads", async () => {
    comms.create({ subject: "Quarterly report" });
    comms.create({ subject: "Lunch" });
    const viaRpc = await rpc("comms.search", { q: "report" }) as Array<{ subject: string }>;
    const viaHttp = await (await http("GET", "/api/dashboard/comms/search?q=report")).json();
    expect(viaRpc.map((r) => r.subject)).toEqual(["Quarterly report"]);
    expect(viaHttp).toEqual(viaRpc);
  });

  it("comms.create answers the comm and { ok, comm } on both roads", async () => {
    const viaRpc = await rpc("comms.create", { subject: "A", body: "b" }) as { id: string; ok: boolean; comm: { id: string } };
    const viaHttp = await (await http("POST", "/api/dashboard/comms/create", { subject: "A", body: "b" })).json() as typeof viaRpc;
    for (const r of [viaRpc, viaHttp]) {
      expect(r.ok).toBe(true);
      expect(r.comm.id).toBe(r.id);
    }
  });

  it("comms.send failures stay a 400 with the service's message", async () => {
    const c = comms.create({ subject: "no recipients" });
    const res = await http("POST", "/api/dashboard/comms/send", { id: c.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No recipients specified" });
    await expect(rpc("comms.send", { id: c.id })).rejects.toThrow("No recipients specified");
  });

  it("emailSuggestions.dismiss over HTTP reads the `id` the dashboard sends", async () => {
    const c = comms.create({ subject: "S" });
    db.prepare("INSERT INTO email_analysis_suggestions (id, comm_id, type, payload, created_at) VALUES ('s1', ?, 'task', '{}', ?)")
      .run(c.id, new Date().toISOString());
    const res = await http("POST", "/api/email-suggestions/dismiss", { id: "s1" });
    expect(res.status).toBe(200);
    expect((db.prepare("SELECT status FROM email_analysis_suggestions WHERE id = 's1'").get() as { status: string }).status).toBe("dismissed");
    expect((await http("POST", "/api/email-suggestions/dismiss", { id: "nope" })).status).toBe(404);
    const list = await rpc("emailSuggestions.list") as { total: number; count: number; available: boolean };
    expect(list).toMatchObject({ available: true, total: 0, count: 0 });
  });

  // ── RPC-only: now through their services ────────────────────

  it("events.create requires start_at instead of hitting the NOT NULL column", async () => {
    await expect(rpc("events.create", { title: "No time" })).rejects.toThrow("start_at required");
    const { id } = await rpc("events.create", { title: "Game", start_at: "2026-07-02T15:00:00Z" }) as { id: string };
    expect(events.get(id)?.type).toBe("other");
  });

  it("events.rsvp for someone new goes through invite + the waitlist rules", async () => {
    const e = events.create({ title: "Futbol", start_at: "2026-07-02T15:00:00Z", max_attendees: 1 });
    await rpc("events.rsvp", { event_id: e.id, rsvp_status: "yes", phone: "+1", name: "One" });
    await rpc("events.rsvp", { event_id: e.id, rsvp_status: "yes", phone: "+2", name: "Two" });
    const statuses = events.getAttendees(e.id).map((a) => [a.name, a.rsvp_status]);
    expect(statuses).toEqual([["One", "yes"], ["Two", "waitlist"]]);
  });

  it("dashboard.calendar honours the start/days its callers send", async () => {
    tasks.create({ title: "In window", due_date: "2030-01-02" });
    tasks.create({ title: "Outside", due_date: "2030-06-01" });
    const cal = await rpc("dashboard.calendar", { start: "2030-01-01", days: 3 }) as { days: Record<string, unknown[]> };
    expect(Object.keys(cal.days)).toContain("2030-01-02");
    expect(Object.keys(cal.days)).not.toContain("2030-06-01");
  });

  it("notes.search takes text FTS5 would choke on", async () => {
    await rpc("notes.create", { title: "Office move", body: "web-office-nl #infra" });
    const { notes } = await rpc("notes.search", { q: "#infra web-office" }) as { notes: Array<{ title: string }> };
    expect(notes.map((n) => n.title)).toEqual(["Office move"]);
  });

  it("learning.resources.create works with just a title (NULL page/hour columns used to fail)", async () => {
    const { id } = await rpc("learning.resources.create", { title: "SICP", tags: "cs, lisp" }) as { id: string };
    const { resource } = await rpc("learning.resources.detail", { id }) as { resource: { total_pages: number; tags: string } };
    expect(resource.total_pages).toBe(0);
    expect(JSON.parse(resource.tags)).toEqual(["cs", "lisp"]);
  });

  it("goals.addKeyResult refuses a goal that does not exist", async () => {
    await expect(rpc("goals.addKeyResult", { goal_id: "nope", title: "KR" })).rejects.toThrow("Goal not found");
    const { id } = await rpc("goals.create", { title: "G" }) as { id: string };
    await rpc("goals.addKeyResult", { goal_id: id, title: "KR", target_value: 10, current_value: 5 });
    const { goals } = await rpc("goals.list") as { goals: Array<{ id: string; kr_count: number; progress: number }> };
    expect(goals.find((g) => g.id === id)).toMatchObject({ kr_count: 1, progress: 50 });
  });
});
