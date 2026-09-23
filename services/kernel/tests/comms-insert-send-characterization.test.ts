/**
 * Characterization tests for CommsService's four communications INSERT paths
 * (create, fetchEmail, ingestInboundRaw, createReply) and the email/WhatsApp
 * send lifecycle. They pin the exact returned object (key order + values), that
 * it matches the stored row, and the status transitions around a send.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { CommsService } from "../assets/extensions/people/comms/_module/service.js";
import type { Communication } from "../assets/extensions/people/comms/_module/types.js";
import { EventBus } from "../src/core/event-bus.js";

const tasksMigration = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    context TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const COMM_KEYS = [
  "id", "channel", "direction", "status", "subject", "body", "body_html",
  "contact_id", "task_id", "account_id", "thread_id", "in_reply_to",
  "recipients_to", "recipients_cc", "recipients_bcc",
  "gmail_message_id", "gmail_thread_id",
  "scheduled_at", "sent_at", "error_message", "metadata",
  "created_at", "updated_at",
];

function expectMatchesRow(service: CommsService, comm: Communication): void {
  expect(Object.keys(comm)).toEqual(COMM_KEYS);
  const row = service.getById(comm.id) as unknown as Record<string, unknown>;
  expect(row).not.toBeNull();
  for (const key of COMM_KEYS) {
    expect({ key, value: row[key] }).toEqual({ key, value: (comm as unknown as Record<string, unknown>)[key] });
  }
}

function addContact(db: Database, id: string, email: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts (id, name, email, phone, company, notes, relationship, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "Someone", email, "", "", "", "professional", now, now);
}

function mockProvider(overrides: Record<string, unknown> = {}) {
  return {
    name: "mock",
    capabilities: { send: true, searchInbox: true, fetchEmail: true },
    send: vi.fn().mockResolvedValue({ messageId: "m-1", threadId: "t-1" }),
    searchInbox: vi.fn().mockResolvedValue([]),
    fetchEmail: vi.fn(),
    ...overrides,
  };
}

describe("CommsService insert paths (characterization)", () => {
  let db: Database;
  let service: CommsService;
  let events: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(tasksMigration);
    runMigrations(db, "crm", crmMigrations);
    runMigrations(db, "comms", commsMigrations);
    events = new EventBus();
    service = new CommsService(db, events);
  });

  afterEach(() => {
    db.close();
  });

  it("create() fills every default and returns the stored row", () => {
    const comm = service.create({});
    expectMatchesRow(service, comm);
    expect(comm).toMatchObject({
      channel: "email", direction: "outbound", status: "draft",
      subject: "", body: "", body_html: "",
      contact_id: null, task_id: null, account_id: null,
      thread_id: comm.id, in_reply_to: "",
      recipients_to: "", recipients_cc: "", recipients_bcc: "",
      gmail_message_id: "", gmail_thread_id: "",
      scheduled_at: null, sent_at: null, error_message: "", metadata: "{}",
    });
    expect(comm.created_at).toBe(comm.updated_at);
  });

  it("create() with explicit fields and sanitized html", () => {
    const account = service.addAccount({ label: "A", email: "a@x.com", provider: "resend" });
    addContact(db, "c1", "c1@x.com");
    const parent = service.create({ subject: "P" });
    const comm = service.create({
      channel: "whatsapp", direction: "inbound", subject: "S", body: "B",
      body_html: "<p>ok</p><script>bad()</script>", contact_id: "c1",
      account_id: account.id, in_reply_to: parent.id,
      recipients_cc: "cc@x.com", recipients_bcc: "bcc@x.com",
    });
    expectMatchesRow(service, comm);
    expect(comm.body_html).not.toContain("script");
    expect(comm.recipients_to).toBe("c1@x.com");
    expect(comm.thread_id).toBe(parent.id);
    expect(comm.in_reply_to).toBe(parent.id);
    expect(comm.account_id).toBe(account.id);
    expect(comm.status).toBe("draft");
  });

  it("fetchEmail() inserts an archived inbound row and dedups per account", async () => {
    const account = service.addAccount({ label: "A", email: "a@x.com", provider: "resend" });
    addContact(db, "c1", "from@x.com");
    const provider = mockProvider({
      fetchEmail: vi.fn().mockResolvedValue({
        from: "from@x.com", fromName: "From", to: "a@x.com", cc: "cc@x.com",
        subject: "Hello", body: "Body", bodyHtml: "<b>hi</b><script>x()</script>",
        date: "2026-01-02T03:04:05.000Z", messageIdHeader: "<mid@x>", threadId: "gt-1",
      }),
    });
    service.registerProvider(account.id, provider);

    const comm = await service.fetchEmail("gm-1", account.id);
    expectMatchesRow(service, comm);
    expect(comm).toMatchObject({
      channel: "email", direction: "inbound", status: "archived",
      subject: "Hello", body: "Body", contact_id: "c1", task_id: null,
      account_id: account.id, thread_id: comm.id, in_reply_to: "",
      recipients_to: "a@x.com", recipients_cc: "cc@x.com", recipients_bcc: "",
      gmail_message_id: "gm-1", gmail_thread_id: "gt-1",
      scheduled_at: null, sent_at: "2026-01-02T03:04:05.000Z", error_message: "",
    });
    expect(comm.body_html).not.toContain("script");
    expect(JSON.parse(comm.metadata)).toEqual({ from: "from@x.com", from_name: "From", message_id_header: "<mid@x>" });

    const again = await service.fetchEmail("gm-1", account.id);
    expect(again.id).toBe(comm.id);
    expect(provider.fetchEmail).toHaveBeenCalledTimes(1);
  });

  it("ingestInboundRaw() inserts, emits comms:mail:received, and dedups", () => {
    addContact(db, "c1", "sender@x.com");
    const emitted: any[] = [];
    events.on("comms:mail:received" as any, (d: any) => { emitted.push(d); });

    const { comm, isNew } = service.ingestInboundRaw({
      from: "Sender@X.com", from_name: "S", to: "me@x.com", cc: "cc@x.com",
      subject: "Hi", body: "Body", body_html: "<i>x</i>",
      message_id_header: " <m1@x> ", received_at: "2026-02-02T00:00:00.000Z",
      source: "imap", raw_headers: { a: "b" },
    });
    expect(isNew).toBe(true);
    expectMatchesRow(service, comm);
    expect(comm).toMatchObject({
      channel: "email", direction: "inbound", status: "archived",
      subject: "Hi", body: "Body", contact_id: "c1", task_id: null, account_id: null,
      thread_id: comm.id, in_reply_to: "", recipients_to: "me@x.com", recipients_cc: "cc@x.com",
      recipients_bcc: "", gmail_message_id: "extid:<m1@x>", gmail_thread_id: "",
      scheduled_at: null, sent_at: "2026-02-02T00:00:00.000Z", error_message: "",
    });
    expect(JSON.parse(comm.metadata)).toEqual({
      from: "Sender@X.com", from_name: "S", message_id_header: "<m1@x>", source: "imap", raw_headers: { a: "b" },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ count: 1, source: "imap", comm_id: comm.id, account_id: null, subject: "Hi" });

    const dup = service.ingestInboundRaw({ from: "x@y.com", message_id_header: "<m1@x>" });
    expect(dup.isNew).toBe(false);
    expect(dup.comm.id).toBe(comm.id);
  });

  it("ingestInboundRaw() defaults: no subject, synthetic key, sent_at = now", () => {
    const { comm } = service.ingestInboundRaw({ from: "a@b.com" });
    expectMatchesRow(service, comm);
    expect(comm.subject).toBe("(no subject)");
    expect(comm.gmail_message_id).toBe("synth:a@b.com::0");
    expect(comm.sent_at).toBe(comm.created_at);
    expect(comm.contact_id).toBeNull();
  });

  it("createReply() returns the stored row with inherited threading", () => {
    const parent = service.create({ subject: "Topic", body: "orig", recipients_to: "to@x.com", recipients_cc: "cc@x.com" });
    db.prepare("UPDATE communications SET gmail_thread_id = 'gt-9' WHERE id = ?").run(parent.id);
    const reply = service.createReply(parent.id, { body: "ans", reply_all: true, cc: "more@x.com" });
    expectMatchesRow(service, reply);
    expect(reply).toMatchObject({
      channel: "email", direction: "outbound", status: "draft", subject: "Re: Topic",
      body_html: "", thread_id: parent.id, in_reply_to: parent.id,
      recipients_to: "to@x.com", recipients_cc: "more@x.com, cc@x.com", recipients_bcc: "",
      gmail_message_id: "", gmail_thread_id: "gt-9", scheduled_at: null, sent_at: null, error_message: "",
    });
    expect(reply.body.startsWith("ans\n\n")).toBe(true);
    expect(JSON.parse(reply.metadata)).toEqual({ reply_to_message_id: "", quoted_text: "orig" });
  });
});

describe("CommsService send lifecycle (characterization)", () => {
  let db: Database;
  let service: CommsService;
  let events: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(tasksMigration);
    runMigrations(db, "crm", crmMigrations);
    runMigrations(db, "comms", commsMigrations);
    events = new EventBus();
    service = new CommsService(db, events);
  });

  afterEach(() => {
    db.close();
  });

  it("sendEmail() marks sending during the call, then sent with provider ids, and emits interaction", async () => {
    const account = service.addAccount({ label: "A", email: "a@x.com", provider: "resend" });
    addContact(db, "c1", "c1@x.com");
    let statusDuringSend = "";
    const provider = mockProvider({
      send: vi.fn().mockImplementation(async () => {
        statusDuringSend = service.getById(comm.id)!.status;
        return { messageId: "m-7", threadId: "t-7" };
      }),
    });
    service.registerProvider(account.id, provider);
    const comm = service.create({ subject: "Subj", body: "B", contact_id: "c1", recipients_cc: "cc@x.com" });
    db.prepare("UPDATE communications SET status = 'failed', error_message = 'old' WHERE id = ?").run(comm.id);

    const emitted: any[] = [];
    events.on("contact.interaction", (d) => { emitted.push(d); });

    const sent = await service.sendEmail(comm.id);
    expect(statusDuringSend).toBe("sending");
    expect(sent).toMatchObject({ status: "sent", gmail_message_id: "m-7", gmail_thread_id: "t-7", error_message: "" });
    expect(sent.sent_at).toBeTruthy();
    expect(provider.send).toHaveBeenCalledWith({
      to: "c1@x.com", cc: "cc@x.com", bcc: undefined, subject: "Subj", body: "B",
      bodyHtml: undefined, inReplyTo: undefined, threadId: undefined, attachments: [],
    });
    expect(emitted).toEqual([{ contactId: "c1", type: "email", summary: "Sent: Subj" }]);
  });

  it("sendEmail() marks failed with the error message and rethrows", async () => {
    const account = service.addAccount({ label: "A", email: "a@x.com", provider: "resend" });
    service.registerProvider(account.id, mockProvider({ send: vi.fn().mockRejectedValue(new Error("SMTP down")) }));
    const comm = service.create({ subject: "S", recipients_to: "t@x.com" });
    await expect(service.sendEmail(comm.id)).rejects.toThrow("SMTP down");
    const row = service.getById(comm.id)!;
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("SMTP down");
    expect(row.sent_at).toBeNull();
  });

  it("sendEmail() refuses non-sendable status and missing comm", async () => {
    const comm = service.create({ recipients_to: "t@x.com" });
    db.prepare("UPDATE communications SET status = 'sent' WHERE id = ?").run(comm.id);
    await expect(service.sendEmail(comm.id)).rejects.toThrow("Cannot send communication with status: sent");
    await expect(service.sendEmail("nope")).rejects.toThrow("Communication not found: nope");
  });

  it("sendEmail() rejects a provider without send capability", async () => {
    const account = service.addAccount({ label: "A", email: "a@x.com", provider: "resend" });
    service.registerProvider(account.id, mockProvider({ capabilities: { send: false, searchInbox: true, fetchEmail: true } }));
    const comm = service.create({ recipients_to: "t@x.com" });
    await expect(service.sendEmail(comm.id)).rejects.toThrow("Provider mock does not support sending");
    expect(service.getById(comm.id)!.status).toBe("draft");
  });

  it("the missing-provider message is identical across sendEmail/searchInbox/fetchEmail", async () => {
    const msg = "No email provider configured. Add an email account or authenticate with Google first.";
    const comm = service.create({ recipients_to: "t@x.com" });
    await expect(service.sendEmail(comm.id)).rejects.toThrow(msg);
    await expect(service.searchInbox("q")).rejects.toThrow(msg);
    await expect(service.fetchEmail("m")).rejects.toThrow(msg);
  });

  it("sendWhatsApp() marks sending during the call and failed when provider returns false", async () => {
    let statusDuringSend = "";
    const comm = service.create({ channel: "whatsapp", body: "Hi", recipients_to: "123" });
    service.setNotifier({
      getRegistry: () => ({
        getProvider: () => ({
          isReady: () => true,
          sendTo: vi.fn().mockImplementation(async () => {
            statusDuringSend = service.getById(comm.id)!.status;
            return false;
          }),
        }),
      }),
    } as any);
    await expect(service.sendWhatsApp(comm.id)).rejects.toThrow("WhatsApp provider returned false — message not delivered");
    expect(statusDuringSend).toBe("sending");
    const row = service.getById(comm.id)!;
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("WhatsApp provider returned false — message not delivered");
  });

  it("sendWhatsApp() success keeps gmail ids untouched and emits a truncated summary", async () => {
    addContact(db, "c1", "c1@x.com");
    const body = "x".repeat(100);
    const comm = service.create({ channel: "whatsapp", body, recipients_to: "123@g.us", contact_id: "c1" });
    db.prepare("UPDATE communications SET gmail_message_id = 'keep', error_message = 'old', status = 'ready' WHERE id = ?").run(comm.id);
    const sendTo = vi.fn().mockResolvedValue(true);
    service.setNotifier({ getRegistry: () => ({ getProvider: () => ({ isReady: () => true, sendTo }) }) } as any);
    const emitted: any[] = [];
    events.on("contact.interaction", (d) => { emitted.push(d); });

    const sent = await service.sendWhatsApp(comm.id);
    expect(sendTo).toHaveBeenCalledWith("123@g.us", { title: "", body });
    expect(sent).toMatchObject({ status: "sent", gmail_message_id: "keep", error_message: "" });
    expect(emitted).toEqual([{ contactId: "c1", type: "whatsapp", summary: `WhatsApp: ${"x".repeat(80)}` }]);
  });
});
