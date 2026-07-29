import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { CommsService } from "../assets/extensions/people/comms/_module/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { buildMimeMessage } from "../assets/extensions/people/comms/_module/mime-builder.js";
import { queryComms } from "../assets/extensions/people/comms/_module/dashboard-queries.js";
import {
  renderTemplate,
  extractVariables,
  detectTemplateVariables,
} from "../assets/extensions/people/comms/_module/template-engine.js";
import {
  parseEmailAddress,
  parseEmailName,
  extractHeader,
  extractGmailBody,
  stripHtml,
  quoteBody,
  parseMetadata,
} from "../assets/extensions/people/comms/_module/gmail-helpers.js";

// Minimal tasks table for FK
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

describe("CommsService", () => {
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

  // ── Create ──────────────────────────────────────────

  it("creates a draft with defaults", () => {
    const comm = service.create({});
    expect(comm.channel).toBe("email");
    expect(comm.direction).toBe("outbound");
    expect(comm.status).toBe("draft");
    expect(comm.id).toBeTruthy();
    expect(comm.thread_id).toBe(comm.id);
  });

  it("creates a draft with custom fields", () => {
    const comm = service.create({
      channel: "whatsapp",
      subject: "Test",
      body: "Hello",
      recipients_to: "someone@example.com",
    });
    expect(comm.channel).toBe("whatsapp");
    expect(comm.subject).toBe("Test");
    expect(comm.body).toBe("Hello");
    expect(comm.recipients_to).toBe("someone@example.com");
  });

  it("auto-fills recipients from contact email", () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, relationship, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "Alice", "alice@example.com", "", "", "", "professional", now, now);

    const comm = service.create({ contact_id: "c1" });
    expect(comm.recipients_to).toBe("alice@example.com");
    expect(comm.contact_id).toBe("c1");
  });

  it("inherits thread_id when replying", () => {
    const first = service.create({ subject: "Original" });
    const reply = service.create({ in_reply_to: first.id, subject: "Re: Original" });
    expect(reply.thread_id).toBe(first.id);
    expect(reply.in_reply_to).toBe(first.id);
  });

  // ── Update ──────────────────────────────────────────

  it("updates a draft", () => {
    const comm = service.create({});
    const updated = service.update(comm.id, { subject: "Updated", body: "New body" });
    expect(updated?.subject).toBe("Updated");
    expect(updated?.body).toBe("New body");
  });

  it("returns null when updating non-existent comm", () => {
    const result = service.update("nonexistent", { subject: "X" });
    expect(result).toBeNull();
  });

  it("blocks editing of sent communications", () => {
    const comm = service.create({});
    db.prepare("UPDATE communications SET status = 'sent' WHERE id = ?").run(comm.id);
    const result = service.update(comm.id, { subject: "Nope" });
    expect(result).toBeNull();
  });

  it("allows status changes on sent communications", () => {
    const comm = service.create({});
    db.prepare("UPDATE communications SET status = 'sent' WHERE id = ?").run(comm.id);
    const result = service.update(comm.id, { status: "archived" });
    expect(result?.status).toBe("archived");
  });

  // ── Get ─────────────────────────────────────────────

  it("gets communication by ID", () => {
    const comm = service.create({ subject: "Test" });
    const found = service.getById(comm.id);
    expect(found?.subject).toBe("Test");
  });

  it("returns null for nonexistent ID", () => {
    expect(service.getById("nope")).toBeNull();
  });

  it("gets communication with details", () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, relationship, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "Bob", "bob@test.com", "", "", "", "professional", now, now);

    const comm = service.create({ contact_id: "c1", subject: "With details" });
    const details = service.getWithDetails(comm.id);
    expect(details).not.toBeNull();
    expect(details?.contact?.name).toBe("Bob");
    expect(details?.attachments).toHaveLength(0);
  });

  // ── List ────────────────────────────────────────────

  it("lists all communications", () => {
    service.create({ channel: "email", subject: "A" });
    service.create({ channel: "whatsapp", subject: "B" });
    const all = service.list();
    expect(all).toHaveLength(2);
  });

  it("filters by channel", () => {
    service.create({ channel: "email" });
    service.create({ channel: "whatsapp" });
    const emails = service.list({ channel: "email" });
    expect(emails).toHaveLength(1);
    expect(emails[0].channel).toBe("email");
  });

  it("filters by status", () => {
    service.create({});
    const c2 = service.create({});
    db.prepare("UPDATE communications SET status = 'sent' WHERE id = ?").run(c2.id);
    const drafts = service.list({ status: "draft" });
    expect(drafts).toHaveLength(1);
  });

  it("filters by contact_id", () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, relationship, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "Alice", "", "", "", "", "professional", now, now);

    service.create({ contact_id: "c1" });
    service.create({});
    const filtered = service.list({ contact_id: "c1" });
    expect(filtered).toHaveLength(1);
  });

  // ── Thread ──────────────────────────────────────────

  it("gets thread messages in order", () => {
    const first = service.create({ subject: "Thread start" });
    service.create({ in_reply_to: first.id, subject: "Reply 1" });
    service.create({ in_reply_to: first.id, subject: "Reply 2" });

    const thread = service.getThread(first.id);
    expect(thread).toHaveLength(3);
    expect(thread[0].subject).toBe("Thread start");
  });

  // ── Attachments ─────────────────────────────────────

  it("attaches a file and removes it", () => {
    const tmpDir = join("/tmp", `comms-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, "test.pdf");
    writeFileSync(tmpFile, "fake pdf content");

    try {
      const comm = service.create({});
      const att = service.attach(comm.id, tmpFile);
      expect(att).not.toBeNull();
      expect(att!.filename).toBe("test.pdf");
      expect(att!.mime_type).toBe("application/pdf");
      expect(att!.size_bytes).toBeGreaterThan(0);

      const attachments = service.getAttachments(comm.id);
      expect(attachments).toHaveLength(1);

      const removed = service.removeAttachment(att!.id);
      expect(removed).toBe(true);

      const after = service.getAttachments(comm.id);
      expect(after).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      // Clean up stored attachment dir
      const storedDir = join("./data/attachments");
      if (existsSync(storedDir)) {
        rmSync(storedDir, { recursive: true, force: true });
      }
    }
  });

  it("returns null when attaching to nonexistent comm", () => {
    const att = service.attach("nope", "/tmp/nonexistent.pdf");
    expect(att).toBeNull();
  });

  it("throws when attaching nonexistent file", () => {
    const comm = service.create({});
    expect(() => service.attach(comm.id, "/tmp/definitely-nonexistent-file.xyz")).toThrow("File not found");
  });

  it("blocks attaching to sent communication", () => {
    const comm = service.create({});
    db.prepare("UPDATE communications SET status = 'sent' WHERE id = ?").run(comm.id);
    const att = service.attach(comm.id, "/tmp/test.pdf");
    expect(att).toBeNull();
  });

  // ── Send ────────────────────────────────────────────

  it("rejects send without provider", async () => {
    const comm = service.create({ recipients_to: "test@example.com", subject: "Test" });
    await expect(service.sendEmail(comm.id)).rejects.toThrow("No email provider configured");
  });

  it("rejects send for non-email channel", async () => {
    const comm = service.create({ channel: "whatsapp", recipients_to: "test" });
    await expect(service.sendEmail(comm.id)).rejects.toThrow("Only email channel");
  });

  it("rejects send without recipients", async () => {
    const comm = service.create({});
    await expect(service.sendEmail(comm.id)).rejects.toThrow("No recipients");
  });
});

// ── MIME Builder ──────────────────────────────────────

describe("buildMimeMessage", () => {
  it("builds a plain text message", () => {
    const raw = buildMimeMessage({
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    // base64url encoded
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    expect(raw).not.toContain("=");

    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: test@example.com");
    expect(decoded).toContain("Subject: Hello");
    expect(decoded).toContain("Content-Type: text/plain");
    expect(decoded).toContain("MIME-Version: 1.0");
  });

  it("builds a multipart/alternative with HTML", () => {
    const raw = buildMimeMessage({
      to: "a@b.com",
      subject: "HTML test",
      body: "Plain text",
      bodyHtml: "<p>HTML</p>",
    });

    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).toContain("text/plain");
    expect(decoded).toContain("text/html");
  });

  it("includes CC and BCC headers", () => {
    const raw = buildMimeMessage({
      to: "a@b.com",
      cc: "c@d.com",
      bcc: "e@f.com",
      subject: "Test",
      body: "Body",
    });

    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Cc: c@d.com");
    expect(decoded).toContain("Bcc: e@f.com");
  });

  it("encodes non-ASCII subjects with RFC 2047", () => {
    const raw = buildMimeMessage({
      to: "a@b.com",
      subject: "Hola señor",
      body: "Body",
    });

    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("=?UTF-8?B?");
  });

  it("passes through ASCII subjects without encoding", () => {
    const raw = buildMimeMessage({
      to: "a@b.com",
      subject: "Hello World",
      body: "Body",
    });

    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Subject: Hello World");
    expect(decoded).not.toContain("=?UTF-8?B?");
  });

  it("includes In-Reply-To and References headers", () => {
    const raw = buildMimeMessage({
      to: "a@b.com",
      subject: "Re: Test",
      body: "Reply body",
      inReplyTo: "<msg-123@gmail.com>",
    });

    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("In-Reply-To: <msg-123@gmail.com>");
    expect(decoded).toContain("References: <msg-123@gmail.com>");
  });
});

// ── Gmail Helpers ────────────────────────────────────

describe("Gmail Helpers", () => {
  it("parseEmailAddress extracts email from header", () => {
    expect(parseEmailAddress("John Doe <john@example.com>")).toBe("john@example.com");
    expect(parseEmailAddress("jane@example.com")).toBe("jane@example.com");
    expect(parseEmailAddress('"Alice B" <alice@test.org>')).toBe("alice@test.org");
  });

  it("parseEmailName extracts display name", () => {
    expect(parseEmailName("John Doe <john@example.com>")).toBe("John Doe");
    expect(parseEmailName("jane@example.com")).toBe("");
    expect(parseEmailName('"Alice B" <alice@test.org>')).toBe("Alice B");
  });

  it("extractHeader finds header by name (case-insensitive)", () => {
    const headers = [
      { name: "From", value: "john@example.com" },
      { name: "Subject", value: "Test" },
      { name: "message-id", value: "<abc@mail.gmail.com>" },
    ];
    expect(extractHeader(headers, "from")).toBe("john@example.com");
    expect(extractHeader(headers, "Subject")).toBe("Test");
    expect(extractHeader(headers, "Message-ID")).toBe("<abc@mail.gmail.com>");
    expect(extractHeader(headers, "Missing")).toBe("");
  });

  it("extractGmailBody handles text/plain", () => {
    const part = {
      mimeType: "text/plain",
      body: { size: 5, data: Buffer.from("Hello").toString("base64url") },
    };
    expect(extractGmailBody(part)).toEqual({ text: "Hello", html: "" });
  });

  it("extractGmailBody handles text/html", () => {
    const html = "<p>Hello</p>";
    const part = {
      mimeType: "text/html",
      body: { size: html.length, data: Buffer.from(html).toString("base64url") },
    };
    expect(extractGmailBody(part)).toEqual({ text: "", html });
  });

  it("extractGmailBody handles multipart/alternative", () => {
    const part = {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: { size: 5, data: Buffer.from("Plain").toString("base64url") },
        },
        {
          mimeType: "text/html",
          body: { size: 11, data: Buffer.from("<b>HTML</b>").toString("base64url") },
        },
      ],
    };
    const result = extractGmailBody(part);
    expect(result.text).toBe("Plain");
    expect(result.html).toBe("<b>HTML</b>");
  });

  it("extractGmailBody handles nested multipart/mixed", () => {
    const part = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: { size: 4, data: Buffer.from("Body").toString("base64url") },
            },
          ],
        },
        {
          mimeType: "application/pdf",
          body: { size: 100 },
        },
      ],
    };
    expect(extractGmailBody(part).text).toBe("Body");
  });

  it("stripHtml removes tags and decodes entities", () => {
    expect(stripHtml("<p>Hello &amp; <b>world</b></p>")).toBe("Hello & world");
    expect(stripHtml("Line1<br>Line2<br/>Line3")).toBe("Line1\nLine2\nLine3");
    expect(stripHtml("<div>A</div><div>B</div>")).toBe("A\nB");
  });

  it("quoteBody formats quoted reply text", () => {
    const result = quoteBody("Hello\nWorld", "John", "2026-02-24");
    expect(result).toContain("On 2026-02-24, John wrote:");
    expect(result).toContain("> Hello");
    expect(result).toContain("> World");
  });

  it("parseMetadata parses valid JSON", () => {
    const meta = parseMetadata('{"from":"a@b.com","from_name":"Alice"}');
    expect(meta.from).toBe("a@b.com");
    expect(meta.from_name).toBe("Alice");
  });

  it("parseMetadata returns empty object for invalid JSON", () => {
    expect(parseMetadata("")).toEqual({});
    expect(parseMetadata("not json")).toEqual({});
  });
});

// ── Create Reply ────────────────────────────────────

describe("CommsService.createReply", () => {
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

  it("creates a reply draft from outbound comm", () => {
    const original = service.create({
      subject: "Original topic",
      recipients_to: "alice@example.com",
    });

    const reply = service.createReply(original.id, { include_quote: false });
    expect(reply.status).toBe("draft");
    expect(reply.direction).toBe("outbound");
    expect(reply.subject).toBe("Re: Original topic");
    expect(reply.recipients_to).toBe("alice@example.com");
    expect(reply.thread_id).toBe(original.id);
    expect(reply.in_reply_to).toBe(original.id);
  });

  it("creates a reply draft from inbound comm with metadata.from", () => {
    const now = new Date().toISOString();
    const id = "inbound-1";
    db.prepare(
      `INSERT INTO communications
       (id, channel, direction, status, subject, body, body_html,
        thread_id, in_reply_to, recipients_to, recipients_cc, recipients_bcc,
        gmail_message_id, gmail_thread_id, error_message, metadata,
        created_at, updated_at)
       VALUES (?, 'email', 'inbound', 'archived', ?, ?, '',
        ?, '', 'me@example.com', '', '',
        'gmail-123', 'thread-456', '', ?,
        ?, ?)`,
    ).run(
      id, "Invoice attached", "Please review the invoice.",
      id, JSON.stringify({ from: "bob@corp.com", from_name: "Bob", message_id_header: "<abc@mail.gmail.com>" }),
      now, now,
    );

    const reply = service.createReply(id, { include_quote: false });
    expect(reply.recipients_to).toBe("bob@corp.com");
    expect(reply.subject).toBe("Re: Invoice attached");
    expect(reply.gmail_thread_id).toBe("thread-456");

    const meta = JSON.parse(reply.metadata);
    expect(meta.reply_to_message_id).toBe("<abc@mail.gmail.com>");
  });

  it("includes quoted text by default", () => {
    const original = service.create({
      subject: "Question",
      body: "What do you think about the proposal?",
      recipients_to: "alice@example.com",
    });

    const reply = service.createReply(original.id);
    expect(reply.body).toContain("> What do you think about the proposal?");
    expect(reply.body).toContain("wrote:");
  });

  it("does not double-prefix Re:", () => {
    const original = service.create({
      subject: "Re: Already a reply",
      recipients_to: "alice@example.com",
    });

    const reply = service.createReply(original.id, { include_quote: false });
    expect(reply.subject).toBe("Re: Already a reply");
    expect(reply.subject).not.toBe("Re: Re: Already a reply");
  });

  it("prepends body before quoted text", () => {
    const original = service.create({
      subject: "Meeting",
      body: "Let's meet tomorrow.",
      recipients_to: "alice@example.com",
    });

    const reply = service.createReply(original.id, { body: "Sounds good!" });
    expect(reply.body.startsWith("Sounds good!")).toBe(true);
    expect(reply.body).toContain("> Let's meet tomorrow.");
  });

  it("reply_all includes original CC", () => {
    const original = service.create({
      subject: "Group discussion",
      recipients_to: "alice@example.com",
      recipients_cc: "bob@example.com, carol@example.com",
    });

    const reply = service.createReply(original.id, { reply_all: true, include_quote: false });
    expect(reply.recipients_cc).toContain("bob@example.com");
    expect(reply.recipients_cc).toContain("carol@example.com");
  });

  it("falls back to contact email for inbound reply recipients", () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, relationship, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "Alice", "alice@example.com", "", "", "", "professional", now, now);

    const id = "inbound-2";
    db.prepare(
      `INSERT INTO communications
       (id, channel, direction, status, subject, body, body_html,
        contact_id, thread_id, in_reply_to, recipients_to, recipients_cc, recipients_bcc,
        gmail_message_id, gmail_thread_id, error_message, metadata,
        created_at, updated_at)
       VALUES (?, 'email', 'inbound', 'archived', 'Hello', 'Hi there', '',
        'c1', ?, '', 'me@example.com', '', '',
        '', '', '', '{}',
        ?, ?)`,
    ).run(id, id, now, now);

    const reply = service.createReply(id, { include_quote: false });
    expect(reply.recipients_to).toBe("alice@example.com");
  });

  it("throws for nonexistent comm", () => {
    expect(() => service.createReply("nonexistent")).toThrow("Communication not found");
  });

  it("searchInbox rejects without provider", async () => {
    await expect(service.searchInbox("test")).rejects.toThrow("No email provider configured");
  });

  it("fetchEmail rejects without provider", async () => {
    await expect(service.fetchEmail("msg-123")).rejects.toThrow("No email provider configured");
  });
});

// ── Dashboard Queries ────────────────────────────────

describe("queryComms (dashboard)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(tasksMigration);
    runMigrations(db, "crm", crmMigrations);
    runMigrations(db, "comms", commsMigrations);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null when communications table does not exist", () => {
    const emptyDb = new Database(":memory:");
    const result = queryComms(emptyDb);
    expect(result).toBeNull();
    emptyDb.close();
  });

  it("returns KPIs for communications", () => {
    const events = new EventBus();
    const service = new CommsService(db, events);

    service.create({ subject: "Draft 1" });
    service.create({ subject: "Draft 2" });
    const sent = service.create({ subject: "Sent one", recipients_to: "a@b.com" });
    db.prepare("UPDATE communications SET status = 'sent', sent_at = ? WHERE id = ?")
      .run(new Date().toISOString(), sent.id);

    const result = queryComms(db);
    expect(result).not.toBeNull();
    expect(result!.kpis.total).toBe(3);
    expect(result!.kpis.drafts).toBe(2);
    expect(result!.kpis.sent).toBe(1);
    expect(result!.pendingDrafts).toHaveLength(2);
    expect(result!.recentSent).toHaveLength(1);
  });

  it("returns by-channel and by-status breakdowns", () => {
    const events = new EventBus();
    const service = new CommsService(db, events);

    service.create({ channel: "email" });
    service.create({ channel: "email" });
    service.create({ channel: "whatsapp" });

    const result = queryComms(db)!;
    expect(result.byChannel.email).toBe(2);
    expect(result.byChannel.whatsapp).toBe(1);
    expect(result.byStatus.draft).toBe(3);
  });

  it("includes email accounts with per-account send stats", () => {
    const events = new EventBus();
    const service = new CommsService(db, events);

    const acct = service.addAccount({ label: "Work", email: "work@co.com", provider: "gmail" });
    service.create({ subject: "S1", account_id: acct.id });
    const c2 = service.create({ subject: "S2", recipients_to: "x@y.com", account_id: acct.id });
    db.prepare("UPDATE communications SET status = 'sent', sent_at = ? WHERE id = ?")
      .run(new Date().toISOString(), c2.id);

    const result = queryComms(db)!;
    expect(result.accounts).toBeDefined();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts![0].label).toBe("Work");
    expect(result.accounts![0].sent_count).toBe(1);
  });

  it("includes template stats by category", () => {
    const events = new EventBus();
    const service = new CommsService(db, events);

    service.createTemplate({ name: "T1", category: "marketing" });
    service.createTemplate({ name: "T2", category: "marketing" });
    service.createTemplate({ name: "T3", category: "transactional" });

    const result = queryComms(db)!;
    expect(result.templates).toBeDefined();
    expect(result.templates!.total).toBe(3);
    expect(result.templates!.byCategory.marketing).toBe(2);
    expect(result.templates!.byCategory.transactional).toBe(1);
  });

  it("includes campaign stats and recent list", () => {
    const events = new EventBus();
    const service = new CommsService(db, events);

    service.createCampaign({ name: "Camp A" });
    const camp2 = service.createCampaign({ name: "Camp B" });
    db.prepare("UPDATE email_campaigns SET status = 'sent', sent_count = 5 WHERE id = ?")
      .run(camp2.id);

    const result = queryComms(db)!;
    expect(result.campaigns).toBeDefined();
    expect(result.campaigns!.total).toBe(2);
    expect(result.campaigns!.byStatus.draft).toBe(1);
    expect(result.campaigns!.byStatus.sent).toBe(1);
    expect(result.campaigns!.recent).toHaveLength(2);
  });

  it("returns accounts/templates/campaigns as undefined when tables missing", () => {
    // Create a DB with only the base communications table (no v2/v3 migration)
    const baseDb = new Database(":memory:");
    baseDb.exec(`CREATE TABLE communications (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'email',
      direction TEXT NOT NULL DEFAULT 'outbound', status TEXT NOT NULL DEFAULT 'draft',
      subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '', contact_id TEXT, task_id TEXT,
      thread_id TEXT NOT NULL DEFAULT '', in_reply_to TEXT NOT NULL DEFAULT '',
      recipients_to TEXT NOT NULL DEFAULT '', recipients_cc TEXT NOT NULL DEFAULT '',
      recipients_bcc TEXT NOT NULL DEFAULT '', gmail_message_id TEXT NOT NULL DEFAULT '',
      gmail_thread_id TEXT NOT NULL DEFAULT '', scheduled_at TEXT, sent_at TEXT,
      error_message TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const result = queryComms(baseDb)!;
    expect(result).not.toBeNull();
    expect(result.kpis.total).toBe(0);
    expect(result.accounts).toBeUndefined();
    expect(result.templates).toBeUndefined();
    expect(result.campaigns).toBeUndefined();
    baseDb.close();
  });
});

// ── Email Accounts ──────────────────────────────

describe("Email Accounts", () => {
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

  it("adds an email account", () => {
    const account = service.addAccount({
      label: "Personal Gmail",
      email: "me@gmail.com",
      provider: "gmail",
    });
    expect(account.id).toBeTruthy();
    expect(account.label).toBe("Personal Gmail");
    expect(account.email).toBe("me@gmail.com");
    expect(account.provider).toBe("gmail");
    expect(account.type).toBe("personal");
    expect(account.is_default).toBe(1); // first account is auto-default
  });

  it("first account becomes default automatically", () => {
    const first = service.addAccount({ label: "First", email: "a@b.com" });
    const second = service.addAccount({ label: "Second", email: "c@d.com" });
    expect(first.is_default).toBe(1);
    expect(second.is_default).toBe(0);
  });

  it("sets explicit default and clears previous", () => {
    const first = service.addAccount({ label: "First", email: "a@b.com" });
    service.addAccount({ label: "Second", email: "c@d.com", is_default: true });

    const accounts = service.listAccounts();
    const firstUpdated = accounts.find((a) => a.id === first.id);
    const secondAccount = accounts.find((a) => a.id !== first.id);
    expect(firstUpdated?.is_default).toBe(0);
    expect(secondAccount?.is_default).toBe(1);
  });

  it("lists accounts ordered by default then label", () => {
    service.addAccount({ label: "Zebra", email: "z@z.com" });
    service.addAccount({ label: "Alpha", email: "a@a.com" });
    const accounts = service.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0].is_default).toBe(1); // default first
  });

  it("gets account by id and by email", () => {
    const account = service.addAccount({ label: "Test", email: "test@test.com" });
    expect(service.getAccount(account.id)?.email).toBe("test@test.com");
    expect(service.getAccountByEmail("test@test.com")?.id).toBe(account.id);
    expect(service.getAccount("nonexistent")).toBeNull();
    expect(service.getAccountByEmail("nope@nope.com")).toBeNull();
  });

  it("updates account fields", () => {
    const account = service.addAccount({ label: "Old", email: "old@test.com" });
    const updated = service.updateAccount(account.id, { label: "New", company: "NewCo" });
    expect(updated?.label).toBe("New");
    expect(updated?.company).toBe("NewCo");
  });

  it("returns null when updating nonexistent account", () => {
    expect(service.updateAccount("nope", { label: "X" })).toBeNull();
  });

  it("deletes account and unlinks communications", () => {
    const account = service.addAccount({ label: "Del", email: "del@test.com" });
    const comm = service.create({ account_id: account.id });
    expect(comm.account_id).toBe(account.id);

    const deleted = service.deleteAccount(account.id);
    expect(deleted).toBe(true);
    expect(service.getAccount(account.id)).toBeNull();

    // Communication should be unlinked
    const updated = service.getById(comm.id);
    expect(updated?.account_id).toBeNull();
  });

  it("deleting default account promotes another", () => {
    const first = service.addAccount({ label: "First", email: "a@b.com" });
    service.addAccount({ label: "Second", email: "c@d.com" });

    service.deleteAccount(first.id);
    const remaining = service.listAccounts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].is_default).toBe(1);
  });

  it("returns false when deleting nonexistent account", () => {
    expect(service.deleteAccount("nope")).toBe(false);
  });

  it("enforces unique email", () => {
    service.addAccount({ label: "A", email: "same@test.com" });
    expect(() => service.addAccount({ label: "B", email: "same@test.com" })).toThrow();
  });

  it("communication inherits default account_id", () => {
    const account = service.addAccount({ label: "Default", email: "def@test.com" });
    const comm = service.create({ subject: "Test" });
    expect(comm.account_id).toBe(account.id);
  });

  it("communication uses explicit account_id", () => {
    service.addAccount({ label: "Default", email: "def@test.com" });
    const other = service.addAccount({ label: "Other", email: "other@test.com" });
    const comm = service.create({ account_id: other.id, subject: "Test" });
    expect(comm.account_id).toBe(other.id);
  });

  it("communication has null account_id when no accounts exist", () => {
    const comm = service.create({ subject: "Test" });
    expect(comm.account_id).toBeNull();
  });

  it("createReply inherits parent account_id", () => {
    const account = service.addAccount({ label: "Acc", email: "acc@test.com" });
    const original = service.create({ account_id: account.id, subject: "Original", recipients_to: "x@y.com" });
    const reply = service.createReply(original.id, { include_quote: false });
    expect(reply.account_id).toBe(account.id);
  });

  it("adds resend account with provider config", () => {
    const account = service.addAccount({
      label: "Transactional",
      email: "noreply@myapp.com",
      provider: "resend",
      type: "transactional",
      provider_config: { api_key: "re_test_123" },
    });
    expect(account.provider).toBe("resend");
    expect(account.type).toBe("transactional");
    const config = JSON.parse(account.provider_config);
    expect(config.api_key).toBe("re_test_123");
  });
});

// ── Provider Registry ──────────────────────────────

describe("Provider Registry", () => {
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

  it("getProvider returns null when no providers", () => {
    expect(service.getProvider()).toBeNull();
  });

  it("getProvider returns legacy provider when set", () => {
    const mockClient = { get: vi.fn(), post: vi.fn(), getPaginated: vi.fn() } as any;
    service.setGoogleClient(mockClient);
    const provider = service.getProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gmail");
  });

  it("getProvider returns registered provider by account id", () => {
    const account = service.addAccount({ label: "Test", email: "t@t.com", provider: "resend" });
    const mockProvider = {
      name: "resend",
      capabilities: { send: true, searchInbox: false, fetchEmail: false },
      send: vi.fn(),
      searchInbox: vi.fn(),
      fetchEmail: vi.fn(),
    };
    service.registerProvider(account.id, mockProvider);

    const provider = service.getProvider(account.id);
    expect(provider).toBe(mockProvider);
  });

  it("getProvider falls back to default account provider", () => {
    const account = service.addAccount({ label: "Default", email: "d@d.com", provider: "resend" });
    const mockProvider = {
      name: "resend",
      capabilities: { send: true, searchInbox: false, fetchEmail: false },
      send: vi.fn(),
      searchInbox: vi.fn(),
      fetchEmail: vi.fn(),
    };
    service.registerProvider(account.id, mockProvider);

    // No accountId passed — should resolve to default
    const provider = service.getProvider();
    expect(provider).toBe(mockProvider);
  });

  it("searchInbox rejects when provider lacks capability", async () => {
    const account = service.addAccount({ label: "Resend", email: "r@r.com", provider: "resend" });
    const mockProvider = {
      name: "resend",
      capabilities: { send: true, searchInbox: false, fetchEmail: false },
      send: vi.fn(),
      searchInbox: vi.fn(),
      fetchEmail: vi.fn(),
    };
    service.registerProvider(account.id, mockProvider);

    await expect(service.searchInbox("test", 10, account.id)).rejects.toThrow("does not support inbox search");
  });
});

// ── Template Engine ──────────────────────────────

describe("Template Engine", () => {
  it("renders built-in variables", () => {
    const result = renderTemplate(
      "Hello {{name}}, welcome to {{company}}!",
      { name: "Alice Smith", company: "Acme" },
    );
    expect(result).toBe("Hello Alice Smith, welcome to Acme!");
  });

  it("derives first_name from name", () => {
    const result = renderTemplate("Hi {{first_name}}!", { name: "Bob Jones" });
    expect(result).toBe("Hi Bob!");
  });

  it("leaves unresolved variables as-is", () => {
    const result = renderTemplate("Hello {{name}}, your {{coupon}} awaits", { name: "Alice" });
    expect(result).toBe("Hello Alice, your {{coupon}} awaits");
  });

  it("custom variables override built-ins", () => {
    const result = renderTemplate("{{name}}", { name: "Built-in", first_name: "Custom" });
    expect(result).toContain("Built-in");
  });

  it("handles empty context", () => {
    const result = renderTemplate("Hello {{name}}!", {});
    expect(result).toBe("Hello {{name}}!");
  });

  it("extractVariables finds all variables", () => {
    const vars = extractVariables("Hi {{name}}, {{company}} sent you {{amount}}");
    expect(vars).toEqual(["name", "company", "amount"]);
  });

  it("extractVariables deduplicates", () => {
    const vars = extractVariables("{{name}} and {{name}} again");
    expect(vars).toEqual(["name"]);
  });

  it("detectTemplateVariables merges subject + body", () => {
    const vars = detectTemplateVariables("Hello {{name}}", "Your {{company}} account", "<p>{{email}}</p>");
    expect(vars).toContain("name");
    expect(vars).toContain("company");
    expect(vars).toContain("email");
    expect(vars).toHaveLength(3);
  });
});

// ── Templates CRUD ──────────────────────────────

describe("Templates", () => {
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

  it("creates a template with auto-detected variables", () => {
    const template = service.createTemplate({
      name: "Welcome",
      subject: "Welcome {{name}}!",
      body: "Hi {{first_name}}, your account at {{company}} is ready.",
    });
    expect(template.id).toBeTruthy();
    expect(template.name).toBe("Welcome");
    const vars = JSON.parse(template.variables) as string[];
    expect(vars).toContain("name");
    expect(vars).toContain("first_name");
    expect(vars).toContain("company");
  });

  it("lists templates", () => {
    service.createTemplate({ name: "A", category: "marketing" });
    service.createTemplate({ name: "B", category: "transactional" });
    service.createTemplate({ name: "C", category: "marketing" });

    expect(service.listTemplates()).toHaveLength(3);
    expect(service.listTemplates("marketing")).toHaveLength(2);
    expect(service.listTemplates("transactional")).toHaveLength(1);
  });

  it("gets template by id", () => {
    const template = service.createTemplate({ name: "Test" });
    expect(service.getTemplate(template.id)?.name).toBe("Test");
    expect(service.getTemplate("nope")).toBeNull();
  });

  it("updates template and re-detects variables", () => {
    const template = service.createTemplate({ name: "Old", subject: "Hi {{name}}" });
    const updated = service.updateTemplate(template.id, {
      subject: "Hi {{name}}, order {{order_id}}",
    });
    expect(updated?.subject).toContain("{{order_id}}");
    const vars = JSON.parse(updated!.variables) as string[];
    expect(vars).toContain("order_id");
  });

  it("deletes template", () => {
    const template = service.createTemplate({ name: "Del" });
    expect(service.deleteTemplate(template.id)).toBe(true);
    expect(service.getTemplate(template.id)).toBeNull();
    expect(service.deleteTemplate("nope")).toBe(false);
  });

  it("previews template with context", () => {
    const template = service.createTemplate({
      name: "Preview",
      subject: "Hello {{name}}",
      body: "Welcome to {{company}}, {{first_name}}!",
    });
    const preview = service.previewTemplate(template.id, { name: "Alice Smith", company: "Acme" });
    expect(preview?.subject).toBe("Hello Alice Smith");
    expect(preview?.body).toBe("Welcome to Acme, Alice!");
  });
});

// ── Campaigns ──────────────────────────────────

describe("Campaigns", () => {
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

  it("creates a campaign", () => {
    const campaign = service.createCampaign({ name: "Welcome Campaign" });
    expect(campaign.id).toBeTruthy();
    expect(campaign.status).toBe("draft");
    expect(campaign.total_recipients).toBe(0);
  });

  it("lists campaigns", () => {
    service.createCampaign({ name: "A" });
    service.createCampaign({ name: "B" });
    expect(service.listCampaigns()).toHaveLength(2);
  });

  it("gets campaign by id", () => {
    const campaign = service.createCampaign({ name: "Test" });
    expect(service.getCampaign(campaign.id)?.name).toBe("Test");
    expect(service.getCampaign("nope")).toBeNull();
  });

  it("adds recipients manually", () => {
    const campaign = service.createCampaign({ name: "Test" });
    const result = service.addRecipients(campaign.id, [
      { email: "alice@test.com", name: "Alice" },
      { email: "bob@test.com", name: "Bob" },
    ]);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);

    const updated = service.getCampaign(campaign.id);
    expect(updated?.total_recipients).toBe(2);
  });

  it("skips duplicate recipients", () => {
    const campaign = service.createCampaign({ name: "Test" });
    service.addRecipients(campaign.id, [{ email: "alice@test.com" }]);
    const result = service.addRecipients(campaign.id, [
      { email: "alice@test.com" },
      { email: "bob@test.com" },
    ]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("adds recipients from CRM contacts", () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, relationship, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "Alice", "alice@test.com", "", "Acme", "", "professional", now, now);
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, relationship, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c2", "Bob", "", "", "", "", "personal", now, now); // no email

    const campaign = service.createCampaign({ name: "From CRM" });
    const result = service.addRecipientsFromContacts(campaign.id);
    expect(result.added).toBe(1); // only Alice has email
  });

  it("rejects adding recipients to non-draft campaign", () => {
    const campaign = service.createCampaign({ name: "Test" });
    db.prepare("UPDATE email_campaigns SET status = 'sent' WHERE id = ?").run(campaign.id);
    expect(() => service.addRecipients(campaign.id, [{ email: "a@b.com" }])).toThrow("draft");
  });

  it("sends campaign with mock provider", async () => {
    const account = service.addAccount({ label: "Test", email: "sender@test.com", provider: "resend" });
    const mockProvider = {
      name: "resend",
      capabilities: { send: true, searchInbox: false, fetchEmail: false },
      send: vi.fn().mockResolvedValue({ messageId: "msg-1", threadId: "" }),
      searchInbox: vi.fn(),
      fetchEmail: vi.fn(),
    };
    service.registerProvider(account.id, mockProvider);

    const template = service.createTemplate({
      name: "Welcome",
      subject: "Hello {{name}}",
      body: "Welcome {{first_name}}!",
    });

    const campaign = service.createCampaign({
      name: "Test Send",
      template_id: template.id,
      account_id: account.id,
    });

    service.addRecipients(campaign.id, [
      { email: "alice@test.com", name: "Alice Smith" },
      { email: "bob@test.com", name: "Bob Jones" },
    ]);

    const result = await service.sendCampaign(campaign.id);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(mockProvider.send).toHaveBeenCalledTimes(2);

    // Verify personalization
    const firstCall = mockProvider.send.mock.calls[0][0];
    expect(firstCall.to).toBe("alice@test.com");
    expect(firstCall.subject).toBe("Hello Alice Smith");
    expect(firstCall.body).toBe("Welcome Alice!");

    // Campaign should be marked as sent
    const updated = service.getCampaign(campaign.id);
    expect(updated?.status).toBe("sent");
    expect(updated?.sent_count).toBe(2);

    // Recipients should be marked as sent with linked comms
    const recipients = service.getCampaignRecipients(campaign.id);
    expect(recipients.every((r) => r.status === "sent")).toBe(true);
    expect(recipients.every((r) => r.comm_id !== null)).toBe(true);
  });

  it("handles partial failures gracefully", async () => {
    const account = service.addAccount({ label: "Test", email: "sender@test.com", provider: "resend" });
    let callCount = 0;
    const mockProvider = {
      name: "resend",
      capabilities: { send: true, searchInbox: false, fetchEmail: false },
      send: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error("Rate limited");
        return { messageId: `msg-${callCount}`, threadId: "" };
      }),
      searchInbox: vi.fn(),
      fetchEmail: vi.fn(),
    };
    service.registerProvider(account.id, mockProvider);

    const template = service.createTemplate({ name: "Test", subject: "Hi {{name}}", body: "Body" });
    const campaign = service.createCampaign({ name: "Partial", template_id: template.id, account_id: account.id });
    service.addRecipients(campaign.id, [
      { email: "a@test.com", name: "A" },
      { email: "b@test.com", name: "B" },
      { email: "c@test.com", name: "C" },
    ]);

    const result = await service.sendCampaign(campaign.id);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);

    const updated = service.getCampaign(campaign.id);
    expect(updated?.status).toBe("sent"); // all processed
    expect(updated?.failed_count).toBe(1);

    const recipients = service.getCampaignRecipients(campaign.id);
    const failed = recipients.find((r) => r.status === "failed");
    expect(failed?.email).toBe("b@test.com");
    expect(failed?.error_message).toBe("Rate limited");
  });

  it("rejects sending non-draft campaign", async () => {
    const campaign = service.createCampaign({ name: "Test" });
    db.prepare("UPDATE email_campaigns SET status = 'sent' WHERE id = ?").run(campaign.id);
    await expect(service.sendCampaign(campaign.id)).rejects.toThrow("Cannot send campaign");
  });

  it("rejects sending without provider", async () => {
    const campaign = service.createCampaign({ name: "Test" });
    await expect(service.sendCampaign(campaign.id)).rejects.toThrow("No email provider");
  });

  it("rejects sending without subject", async () => {
    const account = service.addAccount({ label: "Test", email: "s@t.com", provider: "resend" });
    const mockProvider = {
      name: "resend",
      capabilities: { send: true, searchInbox: false, fetchEmail: false },
      send: vi.fn(),
      searchInbox: vi.fn(),
      fetchEmail: vi.fn(),
    };
    service.registerProvider(account.id, mockProvider);

    const campaign = service.createCampaign({ name: "No Subject", account_id: account.id });
    service.addRecipients(campaign.id, [{ email: "a@b.com" }]);
    await expect(service.sendCampaign(campaign.id)).rejects.toThrow("No subject");
  });

  // ── WhatsApp Send ──────────────────────────────────

  it("sendWhatsApp throws without notifier", async () => {
    const comm = service.create({ channel: "whatsapp", body: "Hola", recipients_to: "34612345678" });
    await expect(service.sendWhatsApp(comm.id)).rejects.toThrow("notifier not configured");
  });

  it("sendWhatsApp throws for email channel", async () => {
    const comm = service.create({ channel: "email", body: "Hola", recipients_to: "test@test.com" });
    const mockNotifier = { getRegistry: () => ({ getProvider: () => null }) } as any;
    service.setNotifier(mockNotifier);
    await expect(service.sendWhatsApp(comm.id)).rejects.toThrow("not a WhatsApp message");
  });

  it("sendWhatsApp throws without recipients", async () => {
    const comm = service.create({ channel: "whatsapp", body: "Hola" });
    const mockNotifier = { getRegistry: () => ({ getProvider: () => null }) } as any;
    service.setNotifier(mockNotifier);
    await expect(service.sendWhatsApp(comm.id)).rejects.toThrow("No recipient phone number");
  });

  it("sendWhatsApp throws when provider not ready", async () => {
    const comm = service.create({ channel: "whatsapp", body: "Hola", recipients_to: "34612345678" });
    const mockNotifier = {
      getRegistry: () => ({
        getProvider: () => ({ isReady: () => false }),
      }),
    } as any;
    service.setNotifier(mockNotifier);
    await expect(service.sendWhatsApp(comm.id)).rejects.toThrow("not connected");
  });

  it("sendWhatsApp succeeds and updates status", async () => {
    const comm = service.create({ channel: "whatsapp", body: "Hola María", recipients_to: "34612345678" });
    const sendToMock = vi.fn().mockResolvedValue(true);
    const mockNotifier = {
      getRegistry: () => ({
        getProvider: () => ({
          isReady: () => true,
          sendTo: sendToMock,
        }),
      }),
    } as any;
    service.setNotifier(mockNotifier);

    const sent = await service.sendWhatsApp(comm.id);
    expect(sent.status).toBe("sent");
    expect(sent.sent_at).toBeTruthy();
    expect(sendToMock).toHaveBeenCalledWith("34612345678@s.whatsapp.net", {
      title: "",
      body: "Hola María",
    });
  });

  it("sendWhatsApp marks failed on provider error", async () => {
    const comm = service.create({ channel: "whatsapp", body: "Test", recipients_to: "34612345678" });
    const mockNotifier = {
      getRegistry: () => ({
        getProvider: () => ({
          isReady: () => true,
          sendTo: vi.fn().mockRejectedValue(new Error("Connection lost")),
        }),
      }),
    } as any;
    service.setNotifier(mockNotifier);

    await expect(service.sendWhatsApp(comm.id)).rejects.toThrow("Connection lost");
    const updated = service.getById(comm.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error_message).toBe("Connection lost");
  });

  it("sendWhatsApp emits contact.interaction when contact_id set", async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, relationship, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "María", "maria@test.com", "34612345678", "", "", "professional", now, now);

    const comm = service.create({
      channel: "whatsapp",
      body: "Hola María",
      recipients_to: "34612345678",
      contact_id: "c1",
    });
    const sendToMock = vi.fn().mockResolvedValue(true);
    const mockNotifier = {
      getRegistry: () => ({
        getProvider: () => ({ isReady: () => true, sendTo: sendToMock }),
      }),
    } as any;
    service.setNotifier(mockNotifier);

    const emitted: any[] = [];
    events.on("contact.interaction", (data) => { emitted.push(data); });

    await service.sendWhatsApp(comm.id);
    expect(emitted.length).toBe(1);
    expect(emitted[0].contactId).toBe("c1");
    expect(emitted[0].type).toBe("whatsapp");
  });

  it("sendWhatsApp strips formatting from phone number", async () => {
    const comm = service.create({ channel: "whatsapp", body: "Test", recipients_to: "+34 612-345-678" });
    const sendToMock = vi.fn().mockResolvedValue(true);
    const mockNotifier = {
      getRegistry: () => ({
        getProvider: () => ({ isReady: () => true, sendTo: sendToMock }),
      }),
    } as any;
    service.setNotifier(mockNotifier);

    await service.sendWhatsApp(comm.id);
    expect(sendToMock).toHaveBeenCalledWith("34612345678@s.whatsapp.net", expect.any(Object));
  });
});
