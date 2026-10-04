// tests/mail-office-dispatch.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { MailOfficeDispatch } from "../assets/extensions/people/comms/_module/mail-office-dispatch.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";

let db: Database;
let posts: Array<{ to: string; subject: string; body: string }>;
const agents = {
  listAgents: () => [
    { id: "triage", name: "Email Triage", builtin_handler: "email:triage" },
    { id: "tob", name: "Tobias", builtin_handler: null },
  ],
  postToColleague: (i: any) => { posts.push({ to: i.to_agent_id, subject: i.subject, body: i.body }); return { message: { id: `m${posts.length}` } }; },
};
const mail = { source_table: "communications" as const, source_id: "c1", thread_key: "conv-1", comm_thread_id: "conv-1", subject: "Propuesta", from: "ana@x.com", urgency: "high", summary: "Pide presupuesto", agenda: { created: 1, updated: 0, skipped: 0, lines: ["evento «Call» 2030-10-02 10:00"] } };

beforeEach(() => {
  db = new Database(":memory:");
  db.run("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)");
  // The real v3 migration, so the test tracks the schema the kernel creates.
  const v3 = commsMigrations.find((m) => m.version === 3)!;
  db.exec(v3.sql);
  posts = [];
});
afterEach(() => db.close());

describe("MailOfficeDispatch", () => {
  it("posts one letter from Email Triage to the router", () => {
    const d = new MailOfficeDispatch(db as any, () => agents);
    expect(d.letterFor(mail)).toBe("sent");
    expect(posts[0].to).toBe("tob");
    expect(posts[0].body).toContain("source: communications:c1");
    expect(posts[0].body).toContain("evento «Call»");
  });

  it("is idempotent per mail", () => {
    const d = new MailOfficeDispatch(db as any, () => agents);
    d.letterFor(mail);
    expect(d.letterFor(mail)).toBe("duplicate");
    expect(posts.length).toBe(1);
  });

  it("respects the daily cap", () => {
    db.run("INSERT INTO app_settings VALUES ('comms.agent_runs.daily_cap','1')");
    const d = new MailOfficeDispatch(db as any, () => agents);
    d.letterFor(mail);
    expect(d.letterFor({ ...mail, source_id: "c2" })).toBe("capped");
  });

  it("honours a renamed router (no match: the letter is queued for retry)", () => {
    db.run("INSERT INTO app_settings VALUES ('mail_office.router_agent','Nobody')");
    expect(new MailOfficeDispatch(db as any, () => agents).letterFor(mail)).toBe("queued-retry");
    expect(posts.length).toBe(0);
    expect((db.prepare("SELECT status FROM mail_office_letters WHERE source_id = 'c1'").get() as any).status).toBe("queued");
  });

  it("queues a capped mail instead of dropping it", () => {
    db.run("INSERT INTO app_settings VALUES ('comms.agent_runs.daily_cap','1')");
    const d = new MailOfficeDispatch(db as any, () => agents);
    d.letterFor(mail);
    expect(d.letterFor({ ...mail, source_id: "c2" })).toBe("capped");
    const row = db.prepare("SELECT status, message_id, payload FROM mail_office_letters WHERE source_id = 'c2'").get() as any;
    expect(row.status).toBe("queued");
    expect(row.message_id).toBe("");
    expect(JSON.parse(row.payload).subject).toBe("Propuesta");
    expect(posts.length).toBe(1);
  });

  it("treats a queued mail as a duplicate", () => {
    db.run("INSERT INTO app_settings VALUES ('comms.agent_runs.daily_cap','1')");
    const d = new MailOfficeDispatch(db as any, () => agents);
    d.letterFor(mail);
    d.letterFor({ ...mail, source_id: "c2" });
    expect(d.letterFor({ ...mail, source_id: "c2" })).toBe("duplicate");
    expect(db.prepare("SELECT COUNT(*) n FROM mail_office_letters").get()).toEqual({ n: 2 });
  });

  it("drains queued letters the next day, oldest first, and marks them sent", () => {
    db.run("INSERT INTO app_settings VALUES ('comms.agent_runs.daily_cap','1')");
    const d = new MailOfficeDispatch(db as any, () => agents);
    d.letterFor(mail);
    d.letterFor({ ...mail, source_id: "c2", subject: "Segunda" });
    expect(d.drainQueued()).toBe(0); // still today, cap reached

    const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();
    db.prepare("UPDATE mail_office_letters SET created_at = ? WHERE status = 'sent'").run(yesterday);

    expect(d.drainQueued()).toBe(1);
    expect(posts.length).toBe(2);
    expect(posts[1].subject).toBe("Segunda");
    expect(posts[1].body).toContain("source: communications:c2");
    const row = db.prepare("SELECT status, message_id FROM mail_office_letters WHERE source_id = 'c2'").get() as any;
    expect(row).toEqual({ status: "sent", message_id: "m2" });
  });

  it("drain respects today's cap", () => {
    db.run("INSERT INTO app_settings VALUES ('comms.agent_runs.daily_cap','2')");
    const d = new MailOfficeDispatch(db as any, () => agents);
    for (const id of ["c1", "c2", "c3", "c4", "c5"]) d.letterFor({ ...mail, source_id: id });
    expect(posts.length).toBe(2);
    const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();
    db.prepare("UPDATE mail_office_letters SET created_at = ? WHERE status = 'sent'").run(yesterday);

    expect(d.drainQueued()).toBe(2);
    expect(posts.map((p) => p.body.split("\n")[0])).toEqual([
      "source: communications:c1", "source: communications:c2",
      "source: communications:c3", "source: communications:c4",
    ]);
    expect(d.drainQueued()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM mail_office_letters WHERE status = 'queued'").get() as any).n).toBe(1);
  });

  it("leaves queued letters in place when no router is reachable", () => {
    db.run("INSERT INTO app_settings VALUES ('comms.agent_runs.daily_cap','1')");
    let available = true;
    const d = new MailOfficeDispatch(db as any, () => (available ? agents : null));
    d.letterFor(mail);
    d.letterFor({ ...mail, source_id: "c2" });
    db.prepare("UPDATE mail_office_letters SET created_at = ? WHERE status = 'sent'").run(new Date(Date.now() - 36 * 3600_000).toISOString());
    available = false;
    expect(d.drainQueued()).toBe(0);
    expect((db.prepare("SELECT status FROM mail_office_letters WHERE source_id = 'c2'").get() as any).status).toBe("queued");
  });

  it("names the right tool params and the thread in the letter", () => {
    const d = new MailOfficeDispatch(db as any, () => agents);
    d.letterFor(mail);
    d.letterFor({ ...mail, source_table: "google_emails", source_id: "g1", thread_key: "gt-9", comm_thread_id: undefined });
    expect(posts[0].body).toContain("thread: conv-1");
    expect(posts[0].body).toContain('kernel_comms_get(id="c1")');
    expect(posts[0].body).toContain('kernel_comms_thread(thread_id="conv-1")');
    expect(posts[1].body).toContain("thread: gt-9");
    expect(posts[1].body).not.toContain("gmail_id=");
  });

  it("a Gmail letter carries the stored text and never points at kernel_email_fetch", () => {
    const d = new MailOfficeDispatch(db as any, () => agents);
    const long = "Hola, ¿nos pasás un presupuesto? " + "x".repeat(3000);
    d.letterFor({
      ...mail, source_table: "google_emails", source_id: "g1", thread_key: "gt-9", comm_thread_id: undefined,
      date: "2026-09-23T10:00:00.000Z", body_excerpt: long,
    });
    const body = posts[0].body;
    expect(body).not.toContain("kernel_email_fetch");
    expect(body).not.toContain("kernel_email_thread");
    expect(body).toContain("subject: Propuesta");
    expect(body).toContain("from: ana@x.com");
    expect(body).toContain("date: 2026-09-23T10:00:00.000Z");
    expect(body).toContain("Hola, ¿nos pasás un presupuesto?");
    expect(body).toContain("x".repeat(1500 - "Hola, ¿nos pasás un presupuesto? ".length));
    expect(body).not.toContain("x".repeat(1501));
    expect(body).toContain("Gmail mail: the text is above; draft replies with kernel_comms_create (never send)");
  });

  it("a Gmail letter with a queued payload keeps its text through drainQueued", () => {
    let up = false;
    const flaky = { ...agents, listAgents: () => (up ? agents.listAgents() : []) };
    const d = new MailOfficeDispatch(db as any, () => flaky);
    expect(d.letterFor({ ...mail, source_table: "google_emails", source_id: "g2", body_excerpt: "TEXTO-GUARDADO" })).toBe("queued-retry");
    up = true;
    expect(d.drainQueued()).toBe(1);
    expect(posts[0].body).toContain("TEXTO-GUARDADO");
  });

  it("queues a letter whose post fails and sends it on a later drain", () => {
    let working = false;
    const flaky = {
      listAgents: agents.listAgents,
      postToColleague: (i: any) => working ? agents.postToColleague(i) : { message: null, error: "boom" },
    };
    const d = new MailOfficeDispatch(db as any, () => flaky);
    expect(d.letterFor(mail)).toBe("queued-retry");
    expect(posts.length).toBe(0);
    expect(d.drainQueued()).toBe(0); // still failing: stays queued
    expect((db.prepare("SELECT status FROM mail_office_letters WHERE source_id = 'c1'").get() as any).status).toBe("queued");

    working = true;
    expect(d.drainQueued()).toBe(1);
    expect(posts[0].body).toContain("source: communications:c1");
    expect(db.prepare("SELECT status, message_id FROM mail_office_letters WHERE source_id = 'c1'").get()).toEqual({ status: "sent", message_id: "m1" });
    expect(d.letterFor(mail)).toBe("duplicate");
  });

  it("marks an unreadable queued payload failed; it leaves the queue and the cap", () => {
    db.run("INSERT INTO app_settings VALUES ('comms.agent_runs.daily_cap','1')");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO mail_office_letters (source_table, source_id, message_id, status, payload, created_at) VALUES ('communications','bad','','queued','{not json',?)").run(now);
    const d = new MailOfficeDispatch(db as any, () => agents);
    expect(d.drainQueued()).toBe(0);
    expect((db.prepare("SELECT status FROM mail_office_letters WHERE source_id = 'bad'").get() as any).status).toBe("failed");
    // Not counted against the cap: a fresh mail still goes out today.
    expect(d.letterFor(mail)).toBe("sent");
    // And never drained again.
    db.prepare("UPDATE mail_office_letters SET created_at = ? WHERE status = 'sent'").run(new Date(Date.now() - 36 * 3600_000).toISOString());
    expect(d.drainQueued()).toBe(0);
    expect(posts.length).toBe(1);
  });
});
