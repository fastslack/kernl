/**
 * The /mail "Attention" queue follows the account picker: Gmail and IMAP mail
 * that needs an answer, filtered to the chosen mailbox, each row saying which
 * account it came in on.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { runMigrations } from "../src/core/db/migrations.js";
import { googleSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/001_google_sync.js";
import { fullSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/002_full_sync.js";
import { emailTriageMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/003_email_triage.js";
import { accountIdMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/004_account_id.js";
import { EmailTriageService } from "../assets/extensions/people/comms/_module/email-triage-service.js";
import { makeCommsDb } from "./mail-test-db.js";

const NOW = "2026-10-02T12:00:00.000Z";
let db: ReturnType<typeof makeCommsDb>["db"];
let triage: EmailTriageService;

function addAccount(id: string, email: string, provider: "gmail" | "imap_smtp") {
  db.run(
    "INSERT INTO email_accounts (id, label, email, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, email, email, provider, NOW, NOW],
  );
}

function addGmail(gmailId: string, accountId: string, date: string, urgency = "normal") {
  db.run(
    `INSERT INTO google_emails (id, gmail_id, thread_id, from_email, subject, date, labels, account_id, urgency, attention_needed, created_at)
     VALUES (?, ?, ?, 'a@gmail.com', ?, ?, '["INBOX"]', ?, ?, 1, ?)`,
    [gmailId, gmailId, `t-${gmailId}`, `gmail ${gmailId}`, date, accountId, urgency, NOW],
  );
}

function addComm(id: string, accountId: string, sentAt: string, attention: number) {
  db.run(
    `INSERT INTO communications (id, account_id, channel, direction, status, subject, body, thread_id, sent_at, metadata, created_at, updated_at)
     VALUES (?, ?, 'email', 'inbound', 'archived', ?, 'hello body', ?, ?, ?, ?, ?)`,
    [id, accountId, `imap ${id}`, `th-${id}`, sentAt,
      JSON.stringify({ from: "x@vps.org", triage: { attention_needed: attention, urgency: "high", summary: "needs an answer" } }), NOW, NOW],
  );
}

beforeEach(() => {
  ({ db } = makeCommsDb());
  runMigrations(db as never, "google-sync", [...googleSyncMigrations, ...fullSyncMigrations, ...emailTriageMigrations, ...accountIdMigrations]);
  triage = new EmailTriageService(db as never, {} as never);
  addAccount("g1", "me@gmail.com", "gmail");
  addAccount("i1", "admin@vps.org", "imap_smtp");
  addAccount("i2", "sales@vps.org", "imap_smtp");
  addGmail("m1", "g1", "2026-10-01T10:00:00.000Z");
  addComm("c1", "i1", "2026-10-01T09:00:00.000Z", 1);
  addComm("c2", "i1", "2026-10-01T08:00:00.000Z", 0);
  addComm("c3", "i2", "2026-10-01T07:00:00.000Z", 1);
});

describe("attention queue per account", () => {
  it("shows only the chosen IMAP account's mail", () => {
    const items = triage.getAttentionQueue(50, "i1");
    expect(items.map((i) => i.gmail_id)).toEqual(["comm:c1"]);
    expect(items[0].account_id).toBe("i1");
  });

  it("shows only the chosen Gmail account's mail", () => {
    expect(triage.getAttentionQueue(50, "g1").map((i) => i.gmail_id)).toEqual(["m1"]);
  });

  it("without an account, mixes every source, urgency first, each row tagged", () => {
    const items = triage.getAttentionQueue(50);
    expect(items.map((i) => i.gmail_id)).toEqual(["comm:c1", "comm:c3", "m1"]);
    expect(items.map((i) => i.account_id)).toEqual(["i1", "i2", "g1"]);
  });

  it("keeps the limit across sources", () => {
    expect(triage.getAttentionQueue(2)).toHaveLength(2);
  });
});
