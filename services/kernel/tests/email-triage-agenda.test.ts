// tests/email-triage-agenda.test.ts
// Triage reads the mail body, skips newsletters, extracts agenda items, and
// the email:triage driver hands attention-needed mail to the calendar and to
// the office router.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { installedHost, setHost } from "../src/sdk/host.js";
import { installTestHost } from "../src/sdk/testing.js";
import { EmailTriageService, type ClassificationResult, type GoogleEmailRow } from "../assets/extensions/people/comms/_module/email-triage-service.js";
import { commsAgentDrivers } from "../assets/extensions/people/comms/_module/agent-drivers.js";
import { AgendaWriter } from "../assets/extensions/people/comms/_module/agenda-writer.js";
import { MailOfficeDispatch } from "../assets/extensions/people/comms/_module/mail-office-dispatch.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { CommsService } from "../assets/extensions/people/comms/_module/service.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { EventBus } from "../src/core/event-bus.js";

const kernelHost = installedHost();

let db: Database;

function makeCommsTable(d: Database) {
  d.run(`CREATE TABLE communications (
    id TEXT PRIMARY KEY, channel TEXT, direction TEXT, status TEXT,
    subject TEXT, body TEXT, body_html TEXT DEFAULT '', recipients_to TEXT DEFAULT '',
    gmail_thread_id TEXT DEFAULT '', thread_id TEXT DEFAULT '', in_reply_to TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}', sent_at TEXT, created_at TEXT, updated_at TEXT
  )`);
  d.run("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)");
  d.run(`CREATE TABLE google_emails (
    gmail_id TEXT PRIMARY KEY, thread_id TEXT, from_email TEXT, from_name TEXT, to_emails TEXT,
    subject TEXT, snippet TEXT, body_text TEXT, date TEXT, labels TEXT,
    urgency TEXT, attention_needed INTEGER DEFAULT -1, ai_summary TEXT, draft_comm_id TEXT DEFAULT ''
  )`);
}

// Shaped like CommsService.fetchEmail / ingestInboundRaw rows: inbound
// email is stored with status 'archived' (= "received") and ISO UTC instants.
// Rows come already labelled (auto_label "personal") unless `meta` says
// otherwise: triage only reads mail the labeller has seen.
function insertInbound(d: Database, id: string, meta: Record<string, unknown>, extra: Partial<{ subject: string; body: string; gmail_thread_id: string; thread_id: string; sent_at: string; created_at: string }> = {}) {
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  d.prepare(`INSERT INTO communications (id, channel, direction, status, subject, body, gmail_thread_id, thread_id, metadata, sent_at, created_at, updated_at)
             VALUES (?, 'email', 'inbound', 'archived', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, extra.subject ?? `Subject ${id}`, extra.body ?? `Body of ${id}`, extra.gmail_thread_id ?? "", extra.thread_id ?? "",
      JSON.stringify({ auto_label: "personal", ...meta }), extra.sent_at ?? hourAgo, extra.created_at ?? now, now);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function row(over: Partial<GoogleEmailRow> = {}): GoogleEmailRow {
  return {
    gmail_id: "g1", thread_id: "t1", from_email: "ana@x.com", from_name: "Ana", to_emails: "", subject: "Reunión",
    snippet: "snip", body_text: "full body", date: "2026-09-24", labels: '["INBOX"]', thread_key: "t1", body_excerpt: "full body",
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  makeCommsTable(db);
});
afterEach(() => {
  setHost(kernelHost);
  db.close();
});

function stubLlm(text: string, seen?: { system?: string; user?: string }) {
  installTestHost({
    llm: () => ({
      chat: async (i: { system: string; user: string }) => {
        if (seen) { seen.system = i.system; seen.user = i.user; }
        return { text };
      },
    }) as any,
  });
}

describe("EmailTriageService.getUnclassifiedComms", () => {
  it("returns inbound mail stored as 'archived' (how ingest stores every received mail)", () => {
    insertInbound(db, "c1", {});
    expect(new EmailTriageService(db as any, {} as any).getUnclassifiedComms(10).map((r) => r.gmail_id)).toEqual(["c1"]);
  });

  it("only looks back 14 days (sent_at, else created_at)", () => {
    insertInbound(db, "fresh", {}, { sent_at: daysAgo(13) });
    insertInbound(db, "old", {}, { sent_at: daysAgo(15), created_at: daysAgo(15) });
    // Old mail fetched today still counts by its own date.
    insertInbound(db, "old-fetched-now", {}, { sent_at: daysAgo(20) });
    // No Date header: sent_at '' falls back to created_at.
    insertInbound(db, "no-date", {}, { sent_at: "" });
    const ids = new EmailTriageService(db as any, {} as any).getUnclassifiedComms(10).map((r) => r.gmail_id).sort();
    expect(ids).toEqual(["fresh", "no-date"]);
  });

  it("skips mail already triaged, outbound mail and other channels", () => {
    insertInbound(db, "done", { triage: { urgency: "low", attention_needed: 0 } });
    insertInbound(db, "todo", {});
    db.prepare("UPDATE communications SET direction = 'outbound' WHERE id = 'todo'").run();
    insertInbound(db, "wa", {});
    db.prepare("UPDATE communications SET channel = 'whatsapp' WHERE id = 'wa'").run();
    insertInbound(db, "ok", {});
    expect(new EmailTriageService(db as any, {} as any).getUnclassifiedComms(10).map((r) => r.gmail_id)).toEqual(["ok"]);
  });

  it("picks up a row inserted by the real CommsService.ingestInboundRaw", () => {
    const real = new Database(":memory:");
    try {
      real.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium', context TEXT NOT NULL DEFAULT '', due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      runMigrations(real as any, "crm", crmMigrations);
      runMigrations(real as any, "comms", commsMigrations);
      const svc = new CommsService(real as any, new EventBus());
      const { comm } = svc.ingestInboundRaw({
        from: "Ana <ana@x.com>", subject: "Propuesta", body: "Hola", message_id_header: "<m1@x>",
        received_at: new Date().toISOString(), source: "imap",
      });
      expect(comm.status).toBe("archived");
      // Not labelled yet: triage waits for the labeller.
      expect(new EmailTriageService(real as any, {} as any).getUnclassifiedComms(10)).toEqual([]);
      real.prepare("UPDATE communications SET metadata = json_set(metadata, '$.auto_label', 'personal') WHERE id = ?").run(comm.id);
      const rows = new EmailTriageService(real as any, {} as any).getUnclassifiedComms(10);
      expect(rows.map((r) => r.gmail_id)).toEqual([comm.id]);
    } finally {
      real.close();
    }
  });

  it("skips rows the auto labeller tagged as newsletter", () => {
    insertInbound(db, "c1", { auto_label: "newsletter" });
    insertInbound(db, "c2", { auto_label: "personal" });
    insertInbound(db, "c3", { auto_label: "billing" });
    const ids = new EmailTriageService(db as any, {} as any).getUnclassifiedComms(10).map((r) => r.gmail_id).sort();
    expect(ids).toEqual(["c2", "c3"]);
  });

  it("waits for the labeller: rows with no or an empty auto_label are not triaged yet", () => {
    insertInbound(db, "unlabelled", { auto_label: undefined });
    insertInbound(db, "empty", { auto_label: "" });
    insertInbound(db, "labelled", { auto_label: "other" });
    const ids = new EmailTriageService(db as any, {} as any).getUnclassifiedComms(10).map((r) => r.gmail_id);
    expect(ids).toEqual(["labelled"]);
  });

  it("derives thread_key (gmail thread, then thread, then id) and a 1500-char body excerpt", () => {
    insertInbound(db, "a", {}, { gmail_thread_id: "gt", thread_id: "tt", body: "x".repeat(2000) });
    insertInbound(db, "b", {}, { thread_id: "tt2" });
    insertInbound(db, "c", {});
    const rows = new EmailTriageService(db as any, {} as any).getUnclassifiedComms(10);
    const by = Object.fromEntries(rows.map((r) => [r.gmail_id, r]));
    expect(by.a.thread_key).toBe("gt");
    expect(by.a.body_excerpt.length).toBe(1500);
    expect(by.b.thread_key).toBe("tt2");
    expect(by.c.thread_key).toBe("c");
  });
});

describe("EmailTriageService.getUnclassified (google_emails)", () => {
  function insertGmail(id: string, date: string) {
    db.prepare(`INSERT INTO google_emails (gmail_id, thread_id, from_email, from_name, to_emails, subject, snippet, body_text, date, labels)
                VALUES (?, ?, 'ana@x.com', 'Ana', '', 's', 'snip', 'body', ?, '["INBOX"]')`).run(id, `t-${id}`, date);
  }

  it("only looks back TRIAGE_WINDOW_DAYS on google_emails.date; older rows stay unclassified", () => {
    insertGmail("fresh", daysAgo(13));
    insertGmail("old", daysAgo(15));
    const svc = new EmailTriageService(db as any, {} as any);
    expect(svc.getUnclassified(10).map((r) => r.gmail_id)).toEqual(["fresh"]);
    const old = db.prepare("SELECT attention_needed FROM google_emails WHERE gmail_id = 'old'").get() as { attention_needed: number };
    expect(old.attention_needed).toBe(-1);
  });
});

describe("EmailTriageService.classifyBatch agenda_items", () => {
  it("returns parsed agenda_items and sends the body excerpt to the model", async () => {
    const seen: { system?: string; user?: string } = {};
    stubLlm(JSON.stringify([{
      idx: 0, urgency: "high", attention_needed: true, summary: "Pide reunión",
      agenda_items: [{ kind: "appointment", title: "Call con Ana", start_at: "2099-10-02T10:00", all_day: false, confidence: "high", evidence: "el 2 de octubre a las 10" }],
    }]), seen);
    const res = await new EmailTriageService(db as any, {} as any).classifyBatch([row({ body_excerpt: "EXCERPT-MARK" })]);
    expect(res.length).toBe(1);
    expect(res[0].attention_needed).toBe(true);
    expect(res[0].agenda_items.length).toBe(1);
    expect(res[0].agenda_items[0].title).toBe("Call con Ana");
    expect(res[0].agenda_items[0].start_at).toBe("2099-10-02T10:00");
    expect(seen.user).toContain("EXCERPT-MARK");
    expect(seen.system).toContain("NOW is ");
    expect(seen.system).toContain("agenda_items");
  });

  it("keeps the classification when agenda_items is malformed", async () => {
    stubLlm(JSON.stringify([{ idx: 0, urgency: "normal", attention_needed: false, summary: "FYI", agenda_items: "tomorrow maybe" }]));
    const res = await new EmailTriageService(db as any, {} as any).classifyBatch([row()]);
    expect(res.length).toBe(1);
    expect(res[0].urgency).toBe("normal");
    expect(res[0].agenda_items).toEqual([]);
  });
});

describe("email:triage driver", () => {
  it("writes agenda items and hands the mail to the office router", async () => {
    insertInbound(db, "c1", {}, { subject: "Propuesta", gmail_thread_id: "", thread_id: "conv-1" });
    db.prepare("UPDATE communications SET metadata = json_set(metadata, '$.from', 'Ana <ana@x.com>') WHERE id = 'c1'").run();

    const triage = new EmailTriageService(db as any, {} as any);
    const item = { kind: "appointment" as const, title: "Call", start_at: "2099-10-02T10:00", all_day: false, confidence: "high" as const, evidence: "e" };
    triage.classifyBatch = async (rows: GoogleEmailRow[]): Promise<ClassificationResult[]> =>
      rows.map((r) => ({ gmail_id: r.gmail_id, urgency: "high", attention_needed: true, summary: "Pide presupuesto", agenda_items: [item] }));
    triage.generateDraftForComm = async () => "draft-1";

    const writes: Array<{ src: any; items: any[] }> = [];
    const letters: any[] = [];
    const agendaStub = {
      write: (src: any, items: any[]) => { writes.push({ src, items }); return { created: 1, updated: 0, skipped: 0, lines: ["evento «Call» 2099-10-02 10:00"] }; },
    };
    const officeStub = {
      routerName: () => "Tobias",
      drainQueued: () => 0,
      letterFor: (m: any) => { letters.push(m); return "sent" as const; },
    };

    const driver = commsAgentDrivers({
      db: () => db as any,
      service: () => null,
      triage: () => triage,
      events: () => null,
      notifier: () => null,
      agenda: () => agendaStub as any,
      office: () => officeStub as any,
    }).find((d) => d.handler === "email:triage")!;

    const out = await driver.run();

    expect(writes.length).toBe(1);
    expect(writes[0].src).toEqual({ source_table: "communications", source_id: "c1", thread_key: "conv-1", subject: "Propuesta", from: "ana@x.com" });
    expect(writes[0].items).toEqual([item]);
    expect(letters.length).toBe(1);
    expect(letters[0].source_table).toBe("communications");
    expect(letters[0].source_id).toBe("c1");
    expect(letters[0].draft_comm_id).toBe("draft-1");
    expect(letters[0].agenda.lines).toEqual(["evento «Call» 2099-10-02 10:00"]);
    expect(String(out)).toContain("1 al calendario, 1 a Tobias");
  });

  it("a Gmail letter carries the stored body excerpt and date", async () => {
    const date = daysAgo(1);
    db.prepare(`INSERT INTO google_emails (gmail_id, thread_id, from_email, from_name, to_emails, subject, snippet, body_text, date, labels)
                VALUES ('g1', 'gt-1', 'ana@x.com', 'Ana', '', 'Propuesta', 'snip', ?, ?, '["INBOX"]')`).run("B".repeat(2000), date);
    const triage = new EmailTriageService(db as any, {} as any);
    triage.classifyBatch = async (rows) =>
      rows.map((r) => ({ gmail_id: r.gmail_id, urgency: "high", attention_needed: true, summary: "s", agenda_items: [] }));
    triage.generateDraft = async () => "d-g1";
    const letters: any[] = [];
    const driver = commsAgentDrivers({
      db: () => db as any, service: () => null, triage: () => triage, events: () => null, notifier: () => null,
      agenda: () => null,
      office: () => ({ routerName: () => "Tobias", drainQueued: () => 0, letterFor: (m: any) => { letters.push(m); return "sent"; } }) as any,
    }).find((d) => d.handler === "email:triage")!;
    await driver.run();
    expect(letters.length).toBe(1);
    expect(letters[0].source_table).toBe("google_emails");
    expect(letters[0].date).toBe(date);
    expect(letters[0].body_excerpt).toBe("B".repeat(1500));
  });

  it("notifies once per day when the office cap is hit", async () => {
    insertInbound(db, "c1", {});
    insertInbound(db, "c2", {});
    const triage = new EmailTriageService(db as any, {} as any);
    triage.classifyBatch = async (rows) =>
      rows.map((r) => ({ gmail_id: r.gmail_id, urgency: "normal", attention_needed: true, summary: "s", agenda_items: [] }));
    triage.generateDraftForComm = async () => "d";
    const sent: any[] = [];
    const notifier = { send: async (m: any) => { sent.push(m); } };
    const office = { routerName: () => "Tobias", drainQueued: () => 0, letterFor: () => "capped" as const };
    const mk = () => commsAgentDrivers({
      db: () => db as any, service: () => null, triage: () => triage, events: () => null,
      notifier: () => notifier as any, agenda: () => null, office: () => office as any,
    }).find((d) => d.handler === "email:triage")!;

    const out = await mk().run();
    expect(String(out)).toContain("2 en cola por tope");
    expect(sent.filter((m) => m.title === "Tope diario de la oficina de correo").length).toBe(1);

    // Second tick the same day: the cap marker suppresses a second notice.
    db.run("UPDATE communications SET metadata = '{}'");
    await mk().run();
    expect(sent.filter((m) => m.title === "Tope diario de la oficina de correo").length).toBe(1);
  });

  it("drains queued letters even when there is nothing new to classify", async () => {
    let drains = 0;
    const office = { routerName: () => "Tobias", drainQueued: () => { drains++; return 3; }, letterFor: () => "sent" as const };
    const triage = new EmailTriageService(db as any, {} as any);
    const driver = commsAgentDrivers({
      db: () => db as any, service: () => null, triage: () => triage, events: () => null,
      notifier: () => null, agenda: () => null, office: () => office as any,
    }).find((d) => d.handler === "email:triage")!;
    const out = String(await driver.run());
    expect(drains).toBe(1);
    expect(out).toContain("No new emails to classify");
    expect(out).toContain("3 carta(s) en cola enviadas a Tobias");
  });

  it("does not throw when the calendar and agents modules are missing", async () => {
    insertInbound(db, "c1", {}, { thread_id: "conv-1" });
    const triage = new EmailTriageService(db as any, {} as any);
    const item = { kind: "deadline" as const, title: "Entrega", start_at: "2099-10-02", all_day: true, confidence: "high" as const, evidence: "e" };
    triage.classifyBatch = async (rows) =>
      rows.map((r) => ({ gmail_id: r.gmail_id, urgency: "high", attention_needed: true, summary: "s", agenda_items: [item] }));
    triage.generateDraftForComm = async () => "d1";
    const driver = commsAgentDrivers({
      db: () => db as any, service: () => null, triage: () => triage, events: () => null,
      notifier: () => null, agenda: () => null, office: () => null,
    }).find((d) => d.handler === "email:triage")!;
    const out = String(await driver.run());
    expect(out).toContain("0 al calendario, 0 a la oficina");
  });

  it("works end to end with real writer/dispatch whose services are absent", async () => {
    // Real AgendaWriter (all services null) + real MailOfficeDispatch whose
    // agents getter returns null — what index.ts builds when getModule finds nothing.
    for (const m of commsMigrations.filter((m) => m.version >= 2 && m.version <= 4)) db.exec(m.sql);
    insertInbound(db, "c1", {}, { thread_id: "conv-1" });
    const triage = new EmailTriageService(db as any, {} as any);
    const item = { kind: "appointment" as const, title: "Call", start_at: "2099-10-02T10:00", all_day: false, confidence: "high" as const, evidence: "e" };
    triage.classifyBatch = async (rows) =>
      rows.map((r) => ({ gmail_id: r.gmail_id, urgency: "high", attention_needed: true, summary: "s", agenda_items: [item] }));
    triage.generateDraftForComm = async () => "d1";
    const writer = new AgendaWriter(db as any, { events: null, tasks: null, reminders: null });
    const dispatch = new MailOfficeDispatch(db as any, () => null);
    const driver = commsAgentDrivers({
      db: () => db as any, service: () => null, triage: () => triage, events: () => null,
      notifier: () => null, agenda: () => writer, office: () => dispatch,
    }).find((d) => d.handler === "email:triage")!;
    const out = String(await driver.run());
    expect(out).toContain("0 al calendario, 0 a Tobias, 1 en cola hasta que Tobias esté disponible");
    // The agents module is not up: the letter waits as 'queued' for a later drain.
    expect(db.prepare("SELECT source_id, status FROM mail_office_letters").all()).toEqual([{ source_id: "c1", status: "queued" }]);
  });

  it("handles a repeated idx once: one agenda write, one draft, one letter", async () => {
    insertInbound(db, "c1", {}, { thread_id: "conv-1" });
    const triage = new EmailTriageService(db as any, {} as any);
    const item = { kind: "appointment" as const, title: "Call", start_at: "2099-10-02T10:00", all_day: false, confidence: "high" as const, evidence: "e" };
    triage.classifyBatch = async (rows) => {
      const r = { gmail_id: rows[0].gmail_id, urgency: "high" as const, attention_needed: true, summary: "s", agenda_items: [item] };
      return [r, { ...r, summary: "again" }];
    };
    let drafts = 0;
    triage.generateDraftForComm = async () => { drafts++; return "d1"; };
    const writes: any[] = [];
    const letters: any[] = [];
    const driver = commsAgentDrivers({
      db: () => db as any, service: () => null, triage: () => triage, events: () => null, notifier: () => null,
      agenda: () => ({ write: (src: any) => { writes.push(src); return { created: 1, updated: 0, skipped: 0, lines: [] }; } }) as any,
      office: () => ({ routerName: () => "Tobias", drainQueued: () => 0, letterFor: (m: any) => { letters.push(m); return "sent"; } }) as any,
    }).find((d) => d.handler === "email:triage")!;
    await driver.run();
    expect(writes.length).toBe(1);
    expect(drafts).toBe(1);
    expect(letters.length).toBe(1);
    expect(letters[0].summary).toBe("s");
    expect(letters[0].thread_key).toBe("conv-1");
    expect(letters[0].comm_thread_id).toBe("conv-1");
  });
});
