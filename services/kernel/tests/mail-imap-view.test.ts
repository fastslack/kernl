/**
 * The /mail view over IMAP accounts: their mail lives in `communications`
 * (comms:inbox-fetch), not in google_emails, and the view has to show both —
 * plus a per-account sync status that explains an empty mailbox.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { googleSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/001_google_sync.js";
import { fullSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/002_full_sync.js";
import { emailTriageMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/003_email_triage.js";
import { accountIdMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/004_account_id.js";
import { EmailService } from "../assets/extensions/people/comms/_module/email-service.js";
import { readFetchStatus, writeFetchStatus } from "../assets/extensions/people/comms/_module/fetch-status.js";
import { EventBus } from "../src/core/event-bus.js";
import { storableHtml } from "../assets/extensions/people/comms/_module/gmail-helpers.js";
import { bodyHtmlMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/006_body_html.js";
import { makeCommsDb } from "./mail-test-db.js";

const NOW = "2026-10-02T12:00:00.000Z";
let db: ReturnType<typeof makeCommsDb>["db"];
let mail: EmailService;

function addAccount(id: string, email: string, provider: "gmail" | "imap_smtp") {
  db.run(
    "INSERT INTO email_accounts (id, label, email, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, email, email, provider, NOW, NOW],
  );
}

function addGmail(gmailId: string, accountId: string, date: string) {
  db.run(
    `INSERT INTO google_emails (id, gmail_id, thread_id, from_email, subject, date, labels, account_id, created_at)
     VALUES (?, ?, ?, 'a@gmail.com', ?, ?, '["INBOX"]', ?, ?)`,
    [gmailId, gmailId, `t-${gmailId}`, `gmail ${gmailId}`, date, accountId, NOW],
  );
}

function addComm(id: string, accountId: string, sentAt: string, direction = "inbound", status = "archived") {
  db.run(
    `INSERT INTO communications (id, account_id, channel, direction, status, subject, body, thread_id, sent_at, metadata, created_at, updated_at)
     VALUES (?, ?, 'email', ?, ?, ?, 'hello body', ?, ?, ?, ?, ?)`,
    [id, accountId, direction, status, `imap ${id}`, `th-${id}`, sentAt, JSON.stringify({ from: "x@vps.org", from_name: "X" }), NOW, NOW],
  );
}

beforeEach(() => {
  ({ db } = makeCommsDb());
  runMigrations(db as never, "google-sync", [...googleSyncMigrations, ...fullSyncMigrations, ...emailTriageMigrations, ...accountIdMigrations]);
  runMigrations(db as never, "google-sync-body-html", bodyHtmlMigrations);
  mail = new EmailService(db as never, new EventBus());
  addAccount("g1", "me@gmail.com", "gmail");
  addAccount("i1", "admin@vps.org", "imap_smtp");
});

describe("IMAP mail in the /mail view", () => {
  it("lists an IMAP account's inbound mail under a comm: id", () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    const r = mail.listEmails({ folder: "inbox", accountId: "i1" });
    expect(r.total).toBe(1);
    expect(r.emails[0].gmail_id).toBe("comm:c1");
    expect(r.emails[0].from_email).toBe("x@vps.org");
    expect(r.emails[0].subject).toBe("imap c1");
  });

  it("keeps a Gmail account's view to google_emails only", () => {
    addGmail("m1", "g1", "2026-10-01T09:00:00.000Z");
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    const r = mail.listEmails({ folder: "inbox", accountId: "g1" });
    expect(r.emails.map((e) => e.gmail_id)).toEqual(["m1"]);
  });

  it("merges both sources by date in the all-accounts view", () => {
    addGmail("m1", "g1", "2026-10-01T09:00:00.000Z");
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    addGmail("m2", "g1", "2026-10-01T11:00:00.000Z");
    const r = mail.listEmails({ folder: "inbox" });
    expect(r.total).toBe(3);
    expect(r.emails.map((e) => e.gmail_id)).toEqual(["m2", "comm:c1", "m1"]);
  });

  it("pages the merged list correctly", () => {
    addGmail("m1", "g1", "2026-10-01T09:00:00.000Z");
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    addGmail("m2", "g1", "2026-10-01T11:00:00.000Z");
    const p2 = mail.listEmails({ folder: "inbox", page: 2, pageSize: 2 });
    expect(p2.emails.map((e) => e.gmail_id)).toEqual(["m1"]);
  });

  it("does not show IMAP-fetched copies of a Gmail account's mail", () => {
    addComm("c9", "g1", "2026-10-01T10:00:00.000Z");
    expect(mail.listEmails({ folder: "inbox" }).total).toBe(0);
  });

  it("files sent IMAP mail under Sent, not Inbox", () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z", "outbound", "sent");
    addComm("c2", "i1", "2026-10-01T10:00:00.000Z", "outbound", "draft");
    expect(mail.listEmails({ folder: "inbox", accountId: "i1" }).total).toBe(0);
    expect(mail.listEmails({ folder: "sent", accountId: "i1" }).emails.map((e) => e.gmail_id)).toEqual(["comm:c1"]);
  });

  it("opens detail and thread for a comm: id", () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    expect(mail.getEmail("comm:c1")?.body_text).toBe("hello body");
    expect(mail.getThread("comm:th-c1")?.messages.length).toBe(1);
  });

  it("stars, reads and counts IMAP mail", () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    expect(mail.getCounts("i1").unread).toBe(1);
    mail.markRead("comm:c1");
    expect(mail.getCounts("i1").unread).toBe(0);
    expect(mail.toggleStar("comm:c1")).toBe(true);
    expect(mail.getCounts("i1").starred).toBe(1);
    expect(mail.toggleStar("comm:c1")).toBe(false);
  });

  it("archives IMAP mail through email_actions", () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    mail.archive("comm:c1");
    expect(mail.listEmails({ folder: "inbox", accountId: "i1" }).total).toBe(0);
    expect(mail.listEmails({ folder: "archived", accountId: "i1" }).total).toBe(1);
  });
});

describe("mail sync status", () => {
  it("reports an IMAP account the fetcher never reached as fetch: null", () => {
    const s = mail.getSyncStatus().find((a) => a.account_id === "i1");
    expect(s).toMatchObject({ provider: "imap_smtp", stored: 0, fetch: null });
  });

  it("reports stored mail and the fetcher's progress", () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    writeFetchStatus(db as never, "i1", { state: "fetching", started_at: NOW, on_wire: 20, done: 7 });
    const s = mail.getSyncStatus().find((a) => a.account_id === "i1");
    expect(s?.stored).toBe(1);
    expect(s?.fetch).toMatchObject({ state: "fetching", on_wire: 20, done: 7 });
  });

  it("gives Gmail accounts no fetch status", () => {
    addGmail("m1", "g1", "2026-10-01T09:00:00.000Z");
    expect(mail.getSyncStatus().find((a) => a.account_id === "g1")).toMatchObject({ stored: 1, fetch: null });
  });
});

describe("fetch status store", () => {
  it("merges patches and keeps last_success_at across a later failure", () => {
    writeFetchStatus(db as never, "i1", { state: "ok", started_at: NOW, last_success_at: NOW, added: 3 });
    writeFetchStatus(db as never, "i1", { state: "error", error: "AUTHENTICATIONFAILED" });
    expect(readFetchStatus(db as never, "i1")).toMatchObject({ state: "error", last_success_at: NOW, error: "AUTHENTICATIONFAILED" });
  });

  it("clears a field patched to undefined", () => {
    writeFetchStatus(db as never, "i1", { state: "error", started_at: NOW, error: "boom" });
    writeFetchStatus(db as never, "i1", { state: "fetching", error: undefined });
    expect(readFetchStatus(db as never, "i1")?.error).toBeUndefined();
  });
});

describe("HTML bodies in the mail view", () => {
  it("gives a Gmail row synced before body_html existed a null body_html", () => {
    addGmail("m1", "g1", "2026-10-01T09:00:00.000Z");
    expect(mail.getEmail("m1")?.body_html).toBeNull();
  });

  it("keeps a fetched Gmail HTML body, and '' for a message without one", () => {
    addGmail("m1", "g1", "2026-10-01T09:00:00.000Z");
    addGmail("m2", "g1", "2026-10-01T09:00:00.000Z");
    mail.saveGmailHtml("m1", "<p>hola</p>");
    mail.saveGmailHtml("m2", "");
    expect(mail.getEmail("m1")?.body_html).toBe("<p>hola</p>");
    expect(mail.getEmail("m2")?.body_html).toBe("");
  });

  it("serves an IMAP message's stored HTML, '' when it has none", () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    db.run("UPDATE communications SET body_html = '<b>x</b>' WHERE id = 'c1'");
    addComm("c2", "i1", "2026-10-01T10:00:00.000Z");
    expect(mail.getEmail("comm:c1")?.body_html).toBe("<b>x</b>");
    expect(mail.getEmail("comm:c2")?.body_html).toBe("");
  });

  it("reports the account a message belongs to", () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    expect(mail.getEmail("comm:c1")?.account_id).toBe("i1");
  });
});

describe("Gmail inbox tabs", () => {
  function setLabels(gmailId: string, labels: string[], read = 0) {
    db.run("UPDATE google_emails SET labels = ?, is_read = ? WHERE gmail_id = ?", [JSON.stringify(labels), read, gmailId]);
  }

  beforeEach(() => {
    addGmail("p1", "g1", "2026-10-01T09:00:00.000Z");
    setLabels("p1", ["INBOX", "CATEGORY_PERSONAL"]);
    addGmail("u1", "g1", "2026-10-01T09:01:00.000Z");
    setLabels("u1", ["INBOX", "CATEGORY_UPDATES"], 1);
    addGmail("pr1", "g1", "2026-10-01T09:02:00.000Z");
    setLabels("pr1", ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
    addGmail("s1", "g1", "2026-10-01T09:03:00.000Z");
    setLabels("s1", ["INBOX", "CATEGORY_SOCIAL"]);
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
  });

  it("filters the inbox to one tab", () => {
    const ids = (category: "primary" | "updates" | "promotions" | "social" | "forums") =>
      mail.listEmails({ folder: "inbox", category }).emails.map((e) => e.gmail_id);
    expect(ids("updates")).toEqual(["u1"]);
    expect(ids("promotions")).toEqual(["pr1"]);
    expect(ids("social")).toEqual(["s1"]);
    expect(ids("forums")).toEqual([]);
  });

  it("puts uncategorized mail, IMAP included, in Primary", () => {
    expect(mail.listEmails({ folder: "inbox", category: "primary" }).emails.map((e) => e.gmail_id))
      .toEqual(["comm:c1", "p1"]);
  });

  it("counts each tab's threads and unread ones", () => {
    const c = mail.getCounts("g1").categories;
    expect(c.primary).toEqual({ total: 1, unread: 1 });
    expect(c.updates).toEqual({ total: 1, unread: 0 });
    expect(c.promotions.total).toBe(1);
    expect(c.forums).toEqual({ total: 0, unread: 0 });
  });
});

describe("storableHtml", () => {
  it("sanitizes scripts and handlers away but keeps images and links", () => {
    const out = storableHtml(`<p onclick="x()">hi<script>alert(1)</script></p><img src="https://a.b/c.png"><a href="https://a.b">l</a>`);
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).toContain('src="https://a.b/c.png"');
    expect(out).toContain('href="https://a.b"');
  });

  it("drops an oversized document whole instead of truncating it", () => {
    expect(storableHtml(`<p>${"x".repeat(600 * 1024)}</p>`)).toBe("");
    expect(storableHtml("")).toBe("");
  });
});

// IMAP attachments used to vanish: the decoder skipped them and the view had
// nowhere to show them. They are kept on disk now, listed with the message,
// and a screenshot pasted into the body points at its stored file.
describe("IMAP mail attachments", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  let cwd: string;
  let tmp: string;
  let comms: ReturnType<typeof makeCommsDb>["service"];

  beforeEach(() => {
    cwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "kernl-att-"));
    process.chdir(tmp);
    ({ db, service: comms } = makeCommsDb());
    runMigrations(db as never, "google-sync", [...googleSyncMigrations, ...fullSyncMigrations, ...emailTriageMigrations, ...accountIdMigrations]);
    runMigrations(db as never, "google-sync-body-html", bodyHtmlMigrations);
    mail = new EmailService(db as never, new EventBus());
    addAccount("i1", "admin@vps.org", "imap_smtp");
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  function fakeImap(calls: string[], attachments = [
    { filename: "image.png", mimeType: "image/png", content: png, contentId: "ii_1", inline: true },
    { filename: "../../etc/informe.pdf", mimeType: "application/pdf", content: new Uint8Array([37, 80]), contentId: "", inline: false },
  ]) {
    (comms as unknown as { providers: Map<string, unknown> }).providers.set("i1", {
      name: "imap_smtp",
      capabilities: { fetchEmail: true },
      async fetchEmail(uid: string) { calls.push(uid); return { attachments }; },
    });
  }

  it("downloads a stored message's attachments once and shows them in the detail", async () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    db.run(`UPDATE communications SET gmail_message_id = '42', body_html = '<p>captura</p><img src="cid:ii_1">' WHERE id = 'c1'`);
    const calls: string[] = [];
    fakeImap(calls);

    expect(mail.listEmails({ folder: "inbox" }).emails[0].has_attachments).toBe(0);
    await comms.ensureReceivedAttachments("c1");
    await comms.ensureReceivedAttachments("c1");
    expect(calls).toEqual(["42"]);

    const email = mail.getEmail("comm:c1")!;
    expect(email.has_attachments).toBe(1);
    expect(email.attachments.map((a) => [a.filename, a.mime_type, a.in_body])).toEqual([
      ["image.png", "image/png", true],
      ["informe.pdf", "application/pdf", false],
    ]);
    expect(email.body_html).toContain(`src="/api/attachments?id=${email.attachments[0].id}"`);
    expect(email.body_html).not.toContain("cid:");
    expect(mail.listEmails({ folder: "inbox" }).emails[0].has_attachments).toBe(1);

    const stored = comms.getAttachment(email.attachments[1].id)!;
    expect(stored.stored_path.startsWith(join("data", "attachments", "c1"))).toBe(true);
    expect(existsSync(stored.stored_path)).toBe(true);
    expect(new Uint8Array(readFileSync(comms.getAttachment(email.attachments[0].id)!.stored_path))).toEqual(png);
  });

  it("tries again on the next open when the server failed, and stops once the message is gone", async () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    db.run(`UPDATE communications SET gmail_message_id = '42' WHERE id = 'c1'`);
    let error = "connect ETIMEDOUT";
    let calls = 0;
    (comms as unknown as { providers: Map<string, unknown> }).providers.set("i1", {
      name: "imap_smtp",
      capabilities: { fetchEmail: true },
      async fetchEmail() { calls++; throw new Error(error); },
    });
    await comms.ensureReceivedAttachments("c1");
    error = "IMAP message not found: 42";
    await comms.ensureReceivedAttachments("c1");
    await comms.ensureReceivedAttachments("c1");
    expect(calls).toBe(2);
  });

  it("does not take the files of another message that now holds the same UID", async () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z");
    db.run(`UPDATE communications SET gmail_message_id = '42', metadata = json_set(metadata, '$.message_id_header', '<a@x>') WHERE id = 'c1'`);
    const calls: string[] = [];
    (comms as unknown as { providers: Map<string, unknown> }).providers.set("i1", {
      name: "imap_smtp",
      capabilities: { fetchEmail: true },
      async fetchEmail(uid: string) {
        calls.push(uid);
        return { messageIdHeader: "<other@x>", attachments: [{ filename: "x.png", mimeType: "image/png", content: png, contentId: "", inline: false }] };
      },
    });
    expect(await comms.ensureReceivedAttachments("c1")).toEqual([]);
    await comms.ensureReceivedAttachments("c1");
    expect(calls).toEqual(["42"]);
  });

  it("leaves outbound mail alone", async () => {
    addComm("c1", "i1", "2026-10-01T10:00:00.000Z", "outbound", "sent");
    db.run(`UPDATE communications SET gmail_message_id = '42' WHERE id = 'c1'`);
    const calls: string[] = [];
    fakeImap(calls);
    expect(await comms.ensureReceivedAttachments("c1")).toEqual([]);
    expect(calls).toEqual([]);
  });
});
