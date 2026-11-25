// The spam filter acts on triage's verdict per account: off by default, a dry
// run that only records, or a move to the server's spam folder that can be
// undone. The email:triage driver gives filtered spam no draft and no letter.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { installedHost, setHost } from "../src/sdk/host.js";
import { installTestHost } from "../src/sdk/testing.js";
import { SpamFilter, normalizeSpamSettings, spamActionFor } from "../assets/extensions/people/comms/_module/spam-filter.js";
import { pickJunkFolder } from "../assets/extensions/people/comms/_module/providers/imap-smtp-provider.js";
import { EmailTriageService, parseSpam, type ClassificationResult } from "../assets/extensions/people/comms/_module/email-triage-service.js";
import { commsAgentDrivers } from "../assets/extensions/people/comms/_module/agent-drivers.js";
import type { EmailProvider, MoveRef } from "../assets/extensions/people/comms/_module/providers/types.js";

const kernelHost = installedHost();
let db: Database;

function makeTables(d: Database) {
  d.run(`CREATE TABLE communications (
    id TEXT PRIMARY KEY, account_id TEXT, channel TEXT, direction TEXT, status TEXT,
    subject TEXT, body TEXT, body_html TEXT DEFAULT '', recipients_to TEXT DEFAULT '',
    gmail_message_id TEXT DEFAULT '', gmail_thread_id TEXT DEFAULT '', thread_id TEXT DEFAULT '', in_reply_to TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}', sent_at TEXT, created_at TEXT, updated_at TEXT
  )`);
  // The real shape: updated_at is NOT NULL with no default.
  d.run("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)");
  d.run(`CREATE TABLE google_emails (
    gmail_id TEXT PRIMARY KEY, thread_id TEXT, from_email TEXT, from_name TEXT, to_emails TEXT,
    subject TEXT, snippet TEXT, body_text TEXT, date TEXT, labels TEXT,
    urgency TEXT, attention_needed INTEGER DEFAULT -1, ai_summary TEXT, draft_comm_id TEXT DEFAULT ''
  )`);
}

function insertMail(id: string, uid: string, account = "acc-1") {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO communications (id, account_id, channel, direction, status, subject, body, gmail_message_id, metadata, sent_at, created_at, updated_at)
              VALUES (?, ?, 'email', 'inbound', 'archived', ?, 'body', ?, ?, ?, ?, ?)`)
    .run(id, account, `Subject ${id}`, uid,
      JSON.stringify({ auto_label: "personal", from: "x@scam.example", message_id_header: `<${id}@example>` }), now, now, now);
}

function fakeProvider(opts: { fail?: boolean } = {}) {
  const moves: Array<{ ref: MoveRef; to: string; from?: string }> = [];
  const provider = {
    name: "fake", capabilities: { send: false, searchInbox: false, fetchEmail: false, move: true },
    async moveMessage(ref: MoveRef, to: string, from?: string) {
      moves.push({ ref, to, from });
      if (opts.fail) throw new Error("server said no");
      return to === "inbox" ? { folder: "INBOX", uid: "900" } : { folder: "[Gmail]/Spam", uid: "77" };
    },
  } as unknown as EmailProvider;
  return { provider, moves };
}

const spamMeta = (id: string) => JSON.parse((db.prepare("SELECT metadata FROM communications WHERE id = ?").get(id) as { metadata: string }).metadata).spam;
const uidOf = (id: string) => (db.prepare("SELECT gmail_message_id FROM communications WHERE id = ?").get(id) as { gmail_message_id: string }).gmail_message_id;

beforeEach(() => {
  setHost(installTestHost({}));
  db = new Database(":memory:");
  makeTables(db);
});
afterEach(() => {
  db.close();
  setHost(kernelHost);
});

describe("pickJunkFolder", () => {
  it("takes the folder flagged \\Junk (Gmail's [Gmail]/Spam)", () => {
    expect(pickJunkFolder([
      { path: "INBOX", name: "INBOX" },
      { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
      { path: "[Gmail]/Spam", name: "Spam", specialUse: "\\Junk" },
    ])).toBe("[Gmail]/Spam");
  });
  it("falls back to the usual names", () => {
    expect(pickJunkFolder([{ path: "INBOX", name: "INBOX" }, { path: "INBOX.Junk", name: "Junk" }])).toBe("INBOX.Junk");
  });
  it("is empty when there is none", () => {
    expect(pickJunkFolder([{ path: "INBOX", name: "INBOX" }, { path: "Sent", name: "Sent" }])).toBe("");
  });
});

describe("spam verdict and settings", () => {
  it("reads the model's answer defensively", () => {
    expect(parseSpam({ spam: true, spam_confidence: 1.4, spam_reason: "phishing" })).toEqual({ spam: true, spam_confidence: 1, spam_reason: "phishing" });
    expect(parseSpam({})).toEqual({ spam: false, spam_confidence: 0, spam_reason: "" });
    expect(parseSpam({ spam: false, spam_confidence: 0.99 })).toEqual({ spam: false, spam_confidence: 0, spam_reason: "" });
  });
  it("is off unless the account turns it on, and never below the threshold", () => {
    expect(normalizeSpamSettings(undefined)).toEqual({ mode: "off", min_confidence: 0.85, folder: "" });
    expect(normalizeSpamSettings({ mode: "move", min_confidence: 0.1 }).min_confidence).toBe(0.5);
    const move = normalizeSpamSettings({ mode: "move", min_confidence: 0.9 });
    expect(spamActionFor({ spam: true, confidence: 0.95 }, move)).toBe("move");
    expect(spamActionFor({ spam: true, confidence: 0.8 }, move)).toBeNull();
    expect(spamActionFor({ spam: false, confidence: 1 }, move)).toBeNull();
    expect(spamActionFor({ spam: true, confidence: 0.95 }, normalizeSpamSettings({ mode: "dry_run" }))).toBe("would_move");
    expect(spamActionFor({ spam: true, confidence: 0.95 }, normalizeSpamSettings({}))).toBeNull();
  });
});

describe("SpamFilter", () => {
  const verdict = (id: string, confidence = 0.95) => ({ id, spam: true, confidence, reason: "fake prize" });

  it("does nothing while the account has it off", async () => {
    insertMail("c1", "10");
    const { provider, moves } = fakeProvider();
    const out = await new SpamFilter(db as any, () => provider).apply([verdict("c1")]);
    expect(out.spamIds.size).toBe(0);
    expect(moves.length).toBe(0);
    expect(spamMeta("c1")).toBeUndefined();
  });

  it("only records in dry run", async () => {
    insertMail("c1", "10");
    const { provider, moves } = fakeProvider();
    const f = new SpamFilter(db as any, () => provider);
    f.setSettings("acc-1", { mode: "dry_run" });
    const out = await f.apply([verdict("c1")]);
    expect(out.flagged).toBe(1);
    expect(out.spamIds.has("c1")).toBe(true);
    expect(moves.length).toBe(0);
    expect(spamMeta("c1").action).toBe("would_move");
  });

  it("moves to the spam folder and back on \"not spam\", keeping the row on the new UID", async () => {
    insertMail("c1", "10");
    insertMail("c2", "11");
    const { provider, moves } = fakeProvider();
    const f = new SpamFilter(db as any, () => provider);
    f.setSettings("acc-1", { mode: "move", min_confidence: 0.9 });
    const out = await f.apply([verdict("c1"), verdict("c2", 0.6)]);
    expect(out.moved).toBe(1);
    expect(moves[0]).toEqual({ ref: { uid: "10", messageId: "<c1@example>" }, to: "junk", from: "INBOX" });
    expect(spamMeta("c1")).toMatchObject({ action: "moved", folder: "[Gmail]/Spam", uid: "77", original_uid: "10" });
    expect(spamMeta("c2")).toBeUndefined();

    const rec = await f.restore("c1");
    expect(rec.action).toBe("restored");
    expect(moves[1]).toEqual({ ref: { uid: "77", messageId: "<c1@example>" }, to: "inbox", from: "[Gmail]/Spam" });
    expect(uidOf("c1")).toBe("900");
    expect(f.list({ accountId: "acc-1" }).map((e) => [e.id, e.spam.action])).toEqual([["c1", "restored"]]);
  });

  it("records a failed move, which can be retried", async () => {
    insertMail("c1", "10");
    const failing = fakeProvider({ fail: true });
    const f = new SpamFilter(db as any, () => failing.provider);
    f.setSettings("acc-1", { mode: "move" });
    const out = await f.apply([verdict("c1")]);
    expect(out.failed).toBe(1);
    expect(spamMeta("c1")).toMatchObject({ action: "move_failed", error: "server said no" });

    const ok = fakeProvider();
    const rec = await new SpamFilter(db as any, () => ok.provider).moveNow("c1");
    expect(rec.action).toBe("moved");
    expect(spamMeta("c1").error).toBeUndefined();
  });
});

describe("email:triage driver with the spam filter", () => {
  it("gives filtered spam no draft and no letter", async () => {
    insertMail("c1", "10");
    insertMail("c2", "11");
    const triage = new EmailTriageService(db as any, {} as any);
    triage.classifyBatch = async (rows): Promise<ClassificationResult[]> => rows.map((r) => ({
      gmail_id: r.gmail_id, urgency: "high", attention_needed: true, summary: "s", agenda_items: [],
      spam: r.gmail_id === "c1", spam_confidence: r.gmail_id === "c1" ? 0.97 : 0, spam_reason: "",
    }));
    const drafted: string[] = [];
    triage.generateDraftForComm = async (row) => { drafted.push(row.gmail_id); return "d"; };
    const letters: string[] = [];
    const { provider } = fakeProvider();
    const spam = new SpamFilter(db as any, () => provider);
    spam.setSettings("acc-1", { mode: "move" });

    const driver = commsAgentDrivers({
      db: () => db as any, service: () => null, triage: () => triage, events: () => null, notifier: () => null,
      agenda: () => null,
      office: () => ({ routerName: () => "R", drainQueued: () => 0, letterFor: (m: any) => { letters.push(m.source_id); return "sent"; } }) as any,
      spam: () => spam,
    }).find((d) => d.handler === "email:triage")!;
    const out = await driver.run();

    expect(drafted).toEqual(["c2"]);
    expect(letters).toEqual(["c2"]);
    expect(spamMeta("c1").action).toBe("moved");
    expect(String(out)).toContain("1 movido(s) a spam");
  });
});
