import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { checkAutoSend, missingInfoBody, detectLang } from "../assets/extensions/people/comms/_module/auto-send.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { CommsService } from "../assets/extensions/people/comms/_module/service.js";
import { commsTools } from "../assets/extensions/people/comms/_module/tools.js";
import { EventBus } from "../src/core/event-bus.js";
import type { EmailProvider } from "../assets/extensions/people/comms/_module/providers/types.js";

const base = {
  enabled: true,
  direction: "inbound",
  from: "Ana Pérez <ana@cliente.com>",
  autoLabel: "personal",
  threadHasAutoSend: false,
  missing: ["presupuesto", "plazo"],
  headers: {} as Record<string, string>,
};

describe("checkAutoSend", () => {
  it("allows a first request to a human sender", () => expect(checkAutoSend(base)).toEqual({ ok: true }));
  it("rejects when the switch is off", () => expect(checkAutoSend({ ...base, enabled: false }).ok).toBe(false));
  it("rejects outbound mails", () => expect(checkAutoSend({ ...base, direction: "outbound" }).ok).toBe(false));
  it("rejects system senders", () => {
    for (const from of [
      "no-reply@x.com",
      "noreply@x.com",
      "no_reply@x.com",
      "do_not_reply@x.com",
      "notifications@github.com",
      "MAILER-DAEMON@x.com",
      "donotreply@x.com",
    ]) {
      expect(checkAutoSend({ ...base, from }).ok).toBe(false);
    }
  });
  it("rejects machine labels", () => {
    for (const autoLabel of ["newsletter", "transactional", "billing", "security"]) {
      expect(checkAutoSend({ ...base, autoLabel }).ok).toBe(false);
    }
  });
  it("rejects an unlabelled mail", () => {
    const r = checkAutoSend({ ...base, autoLabel: "" });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/has not been labelled yet/);
  });
  it("rejects a second automatic mail in the thread", () => expect(checkAutoSend({ ...base, threadHasAutoSend: true }).ok).toBe(false));
  it("rejects fields outside the vocabulary", () => expect(checkAutoSend({ ...base, missing: ["presupuesto", "tu tarjeta"] }).ok).toBe(false));
  it("rejects an empty request", () => expect(checkAutoSend({ ...base, missing: [] }).ok).toBe(false));

  it("rejects bulk/mailing-list headers", () => {
    expect(checkAutoSend({ ...base, headers: { precedence: "bulk" } }).ok).toBe(false);
    expect(checkAutoSend({ ...base, headers: { precedence: "list" } }).ok).toBe(false);
    expect(checkAutoSend({ ...base, headers: { precedence: "junk" } }).ok).toBe(false);
    expect(checkAutoSend({ ...base, headers: { "list-unsubscribe": "<mailto:x@y.com>" } }).ok).toBe(false);
    expect(checkAutoSend({ ...base, headers: { "list-id": "<newsletter.y.com>" } }).ok).toBe(false);
    expect(checkAutoSend({ ...base, headers: { "auto-submitted": "auto-replied" } }).ok).toBe(false);
    expect(checkAutoSend({ ...base, headers: { "auto-submitted": "auto-generated" } }).ok).toBe(false);
  });
  it("allows Auto-Submitted: no", () => {
    expect(checkAutoSend({ ...base, headers: { "auto-submitted": "no" } })).toEqual({ ok: true });
  });
});

describe("missingInfoBody", () => {
  it("lists only the asked fields, no prices or commitments", () => {
    const b = missingInfoBody("es", ["presupuesto", "plazo"], "Ana");
    expect(b).toContain("Hola Ana");
    expect(b).toMatch(/presupuesto/i);
    expect(b).toMatch(/plazo/i);
    expect(b).not.toMatch(/alcance/i);
    expect(b).not.toMatch(/\$|USD|€/);
  });
  it("english template", () => {
    const b = missingInfoBody("en", ["alcance"], "Bob");
    expect(b).toContain("Hi Bob");
    expect(b).toContain("out of scope");
  });
  it("drops the name from the greeting when the first name is empty", () => {
    const es = missingInfoBody("es", ["presupuesto"], "");
    expect(es).toContain("Hola, gracias por escribir.");
    expect(es).not.toContain("Hola ,");
    expect(es).not.toMatch(/Hola\s{2,}/);
    const en = missingInfoBody("en", ["presupuesto"], "");
    expect(en).toContain("Hi, thanks for reaching out.");
    expect(en).not.toContain("Hi ,");
  });
});

describe("detectLang", () => {
  it("spanish", () => expect(detectLang("Hola, ¿nos podrías pasar el presupuesto para el proyecto?")).toBe("es"));
  it("english", () => expect(detectLang("Hi, could you send us a quote for the project?")).toBe("en"));
  it("defaults to english for an empty string", () => expect(detectLang("")).toBe("en"));
});

// ── Test harness ──────────────────────────────────────

function harness(enabled: boolean) {
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
  db.run("CREATE TABLE contacts (id TEXT PRIMARY KEY, email TEXT)");
  db.run("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)");
  runMigrations(db, "comms", commsMigrations);
  db.run("INSERT INTO app_settings VALUES ('comms.auto_send.enabled', ?)", [enabled ? "true" : "false"]);
  const service = new CommsService(db as any, new EventBus() as any);
  (service as any).sendEmail = async (id: string) => service.getById(id)!;
  const tool = commsTools(service).find((t) => t.name === "kernel_comms_request_missing_info")!;
  return { db, service, tool };
}

/** Simulates the (out-of-scope) triage/classification step that stamps a real, human auto_label. */
function labelAsHuman(db: Database, id: string, label = "personal") {
  db.prepare(`UPDATE communications SET metadata = json_set(COALESCE(metadata,'{}'), '$.auto_label', ?) WHERE id = ?`).run(label, id);
}

describe("tool kernel_comms_request_missing_info", () => {
  function setup(enabled: boolean, accountId?: string) {
    const { db, service, tool } = harness(enabled);
    const { comm: inbound } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      from_name: "Ana",
      subject: "Proyecto web",
      body: "Hola, necesitamos una web.",
      account_id: accountId,
    } as any);
    labelAsHuman(db, inbound.id);
    return { db, service, tool, id: inbound.id };
  }

  it("refuses with the switch off, and nothing is created", async () => {
    const { tool, id, db } = setup(false);
    const r: any = await tool.handler({ comm_id: id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(r)).toContain("switched off");
    expect(db.query("SELECT COUNT(*) n FROM communications").get()).toEqual({ n: 1 });
  });

  it("sends once per thread, refuses the second attempt", async () => {
    const { tool, id } = setup(true);
    const ok: any = await tool.handler({ comm_id: id, missing: ["presupuesto", "plazo"] } as any);
    expect(JSON.stringify(ok)).toContain("Sent to");
    const again: any = await tool.handler({ comm_id: id, missing: ["plazo"] } as any);
    expect(JSON.stringify(again)).toContain("already got its one automatic mail");
  });

  it("marks the reply metadata.auto_sent = 1", async () => {
    const { tool, service, id } = setup(true);
    await tool.handler({ comm_id: id, missing: ["presupuesto"] } as any);
    const inbound = service.getById(id)!;
    const reply = (service as any).db
      .prepare("SELECT * FROM communications WHERE in_reply_to = ?")
      .get(inbound.id) as any;
    expect(reply).toBeTruthy();
    expect(JSON.parse(reply.metadata).auto_sent).toBe(1);
  });

  it("the reply goes out through the same account that received the original", async () => {
    const { tool, service, id } = setup(true, "acct-123");
    await tool.handler({ comm_id: id, missing: ["presupuesto"] } as any);
    const inbound = service.getById(id)!;
    expect(inbound.account_id).toBe("acct-123");
    const reply = (service as any).db
      .prepare("SELECT * FROM communications WHERE in_reply_to = ?")
      .get(inbound.id) as any;
    expect(reply.account_id).toBe("acct-123");
  });

  it("refuses when the comm is not found", async () => {
    const { tool } = setup(true);
    const r: any = await tool.handler({ comm_id: "does-not-exist", missing: ["presupuesto"] } as any);
    expect(JSON.stringify(r)).toContain("No communication");
  });

  it("refuses when the comm is not an email (channel check)", async () => {
    const { tool, service, id } = setup(true);
    (service as any).db.prepare("UPDATE communications SET channel = 'whatsapp' WHERE id = ?").run(id);
    const r: any = await tool.handler({ comm_id: id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(r)).toContain("email");
    const countReplies = (service as any).db
      .prepare("SELECT COUNT(*) n FROM communications WHERE in_reply_to = ?")
      .get(id) as any;
    expect(countReplies.n).toBe(0);
  });

  it("refuses fields outside the vocabulary and creates nothing", async () => {
    const { tool, id } = setup(true);
    const r: any = await tool.handler({ comm_id: id, missing: ["tu tarjeta"] } as any);
    expect(JSON.stringify(r)).toContain("Not askable automatically");
  });

  it("refuses when the mail has not been labelled yet", async () => {
    const { service, tool } = harness(true);
    const { comm } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      from_name: "Ana",
      subject: "Proyecto web",
      body: "Hola, necesitamos una web.",
    } as any);
    // deliberately not labelled — no labelAsHuman() call
    const r: any = await tool.handler({ comm_id: comm.id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(r)).toContain("has not been labelled yet");
  });

  it("refuses at the tool level for a no-reply sender", async () => {
    const { db, service, tool } = harness(true);
    const { comm } = service.ingestInboundRaw({
      from: "no-reply@banco.com",
      from_name: "Banco",
      subject: "Confirmá tus datos",
      body: "Por favor confirmá tus datos.",
    } as any);
    labelAsHuman(db, comm.id);
    const r: any = await tool.handler({ comm_id: comm.id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(r)).toContain("automated address");
    const countReplies = (service as any).db
      .prepare("SELECT COUNT(*) n FROM communications WHERE in_reply_to = ?")
      .get(comm.id) as any;
    expect(countReplies.n).toBe(0);
  });

  it("a client reply threaded via In-Reply-To is refused as a second automatic mail", async () => {
    const { db, service, tool } = harness(true);
    const { comm: first } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      from_name: "Ana",
      subject: "Proyecto web",
      body: "Hola, necesitamos una web.",
      message_id_header: "<msg1@cliente.com>",
    } as any);
    labelAsHuman(db, first.id);
    const ok: any = await tool.handler({ comm_id: first.id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(ok)).toContain("Sent to");

    const { comm: reply } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      from_name: "Ana",
      subject: "Re: Proyecto web",
      body: "Les paso el presupuesto que pidieron.",
      message_id_header: "<msg2@cliente.com>",
      raw_headers: { "In-Reply-To": "<msg1@cliente.com>" },
    } as any);
    labelAsHuman(db, reply.id);
    const again: any = await tool.handler({ comm_id: reply.id, missing: ["plazo"] } as any);
    expect(JSON.stringify(again)).toContain("already got its one automatic mail");
  });

  it("refuses a different thread from the same sender within 30 days (cross-thread cap)", async () => {
    const { db, service, tool } = harness(true);
    const { comm: first } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      from_name: "Ana",
      subject: "Proyecto web",
      body: "Hola, necesitamos una web.",
    } as any);
    labelAsHuman(db, first.id);
    const ok: any = await tool.handler({ comm_id: first.id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(ok)).toContain("Sent to");

    const { comm: unrelated } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      from_name: "Ana",
      subject: "Otro proyecto distinto",
      body: "Hola de nuevo, tenemos otro pedido para ustedes.",
    } as any);
    labelAsHuman(db, unrelated.id);
    const again: any = await tool.handler({ comm_id: unrelated.id, missing: ["plazo"] } as any);
    expect(JSON.stringify(again)).toContain("already went to this sender in the last 30 days");
  });

  it("a sendEmail failure returns an errorResult instead of throwing, and marks the thread as spent", async () => {
    const { service, tool, id } = setup(true);
    (service as any).sendEmail = async () => {
      throw new Error("SMTP down");
    };
    const r: any = await tool.handler({ comm_id: id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(r)).toContain("Not sent");
    expect(JSON.stringify(r)).toContain("SMTP down");
    const again: any = await tool.handler({ comm_id: id, missing: ["plazo"] } as any);
    expect(JSON.stringify(again)).toContain("already got its one automatic mail");
  });
});

describe("ingestInboundRaw threading", () => {
  it("In-Reply-To links the new row to the earlier row's thread", () => {
    const { service } = harness(true);
    const { comm: first } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      subject: "Proyecto web",
      body: "hola",
      message_id_header: "<msg1@cliente.com>",
    } as any);
    const { comm: second } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      subject: "Re: Proyecto web",
      body: "segunda",
      message_id_header: "<msg2@cliente.com>",
      raw_headers: { "In-Reply-To": "<msg1@cliente.com>" },
    } as any);
    expect(second.thread_id).toBe(first.thread_id);
    expect(second.thread_id).toBe(first.id);
  });

  it("References links the new row to the earlier row's thread (newest id checked first)", () => {
    const { service } = harness(true);
    const { comm: first } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      subject: "Proyecto web",
      body: "hola",
      message_id_header: "<msg1@cliente.com>",
    } as any);
    const { comm: second } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      subject: "Re: Proyecto web",
      body: "segunda",
      message_id_header: "<msg2@cliente.com>",
      raw_headers: { References: "<other@x.com> <msg1@cliente.com>" },
    } as any);
    expect(second.thread_id).toBe(first.thread_id);
  });

  it("no matching In-Reply-To/References keeps the row as its own thread root", () => {
    const { service } = harness(true);
    const { comm } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      subject: "Proyecto web",
      body: "hola",
      raw_headers: { "In-Reply-To": "<unknown@x.com>" },
    } as any);
    expect(comm.thread_id).toBe(comm.id);
  });

  it("an all-digit In-Reply-To (an IMAP UID) never threads onto an unrelated row", () => {
    const { db, service } = harness(true);
    const { comm: unrelated } = service.ingestInboundRaw({
      from: "otro@x.com",
      subject: "Otra cosa",
      body: "hola",
    } as any);
    // IMAP-fetched rows are keyed by their numeric UID.
    db.prepare("UPDATE communications SET gmail_message_id = '4711' WHERE id = ?").run(unrelated.id);
    const { comm } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      subject: "Proyecto web",
      body: "hola",
      raw_headers: { "In-Reply-To": "4711", References: "<4711>" },
    } as any);
    expect(comm.thread_id).toBe(comm.id);
  });

  it("createReply keeps the parent's thread_id", () => {
    const { service } = harness(true);
    const { comm: inbound } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      subject: "Proyecto web",
      body: "hola",
    } as any);
    const reply = service.createReply(inbound.id, { body: "hi" });
    expect(reply.thread_id).toBe(inbound.thread_id);
  });

  it("a webhook body with References as an array does not throw", () => {
    const { service } = harness(true);
    expect(() =>
      service.ingestInboundRaw({
        from: "ana@cliente.com",
        subject: "Proyecto web",
        body: "hola",
        // An untrusted webhook payload can hand us anything JSON allows —
        // the type says Record<string,string> but nothing enforces it at
        // the HTTP boundary.
        raw_headers: { References: ["<a@cliente.com>", "<b@cliente.com>"] } as any,
      } as any),
    ).not.toThrow();
  });
});

// ── fetchEmail (the production IMAP/Gmail path) ──────────

function fakeFetchProvider(
  fetchImpl: (id: string) => ReturnType<EmailProvider["fetchEmail"]>,
): EmailProvider {
  return {
    name: "fake",
    capabilities: { send: false, searchInbox: false, fetchEmail: true },
    async send() {
      throw new Error("not implemented");
    },
    async searchInbox() {
      return [];
    },
    fetchEmail: fetchImpl,
  };
}

describe("CommsService.fetchEmail threading (production IMAP path)", () => {
  it("In-Reply-To threads the new row onto the earlier fetched mail", async () => {
    const { service } = harness(true);
    service.registerProvider(
      "acct-1",
      fakeFetchProvider(async () => ({
        from: "ana@cliente.com",
        fromName: "Ana",
        to: "me@kernl.local",
        cc: "",
        subject: "Proyecto web",
        body: "hola",
        bodyHtml: "",
        date: new Date().toISOString(),
        messageIdHeader: "<msg1@cliente.com>",
        threadId: "",
        rawHeaders: { "message-id": "<msg1@cliente.com>" },
      })),
    );
    const first = await service.fetchEmail("uid-1", "acct-1");

    service.registerProvider(
      "acct-1",
      fakeFetchProvider(async () => ({
        from: "ana@cliente.com",
        fromName: "Ana",
        to: "me@kernl.local",
        cc: "",
        subject: "Re: Proyecto web",
        body: "segunda",
        bodyHtml: "",
        date: new Date().toISOString(),
        messageIdHeader: "<msg2@cliente.com>",
        threadId: "",
        rawHeaders: { "message-id": "<msg2@cliente.com>", "in-reply-to": "<msg1@cliente.com>" },
      })),
    );
    const second = await service.fetchEmail("uid-2", "acct-1");

    expect(second.thread_id).toBe(first.thread_id);
  });

  it("References threads the new row onto the earlier fetched mail", async () => {
    const { service } = harness(true);
    service.registerProvider(
      "acct-1",
      fakeFetchProvider(async () => ({
        from: "ana@cliente.com",
        fromName: "Ana",
        to: "me@kernl.local",
        cc: "",
        subject: "Proyecto web",
        body: "hola",
        bodyHtml: "",
        date: new Date().toISOString(),
        messageIdHeader: "<msg1@cliente.com>",
        threadId: "",
        rawHeaders: { "message-id": "<msg1@cliente.com>" },
      })),
    );
    const first = await service.fetchEmail("uid-1", "acct-1");

    service.registerProvider(
      "acct-1",
      fakeFetchProvider(async () => ({
        from: "ana@cliente.com",
        fromName: "Ana",
        to: "me@kernl.local",
        cc: "",
        subject: "Re: Proyecto web",
        body: "segunda",
        bodyHtml: "",
        date: new Date().toISOString(),
        messageIdHeader: "<msg2@cliente.com>",
        threadId: "",
        rawHeaders: { "message-id": "<msg2@cliente.com>", references: "<other@x.com> <msg1@cliente.com>" },
      })),
    );
    const second = await service.fetchEmail("uid-2", "acct-1");

    expect(second.thread_id).toBe(first.thread_id);
  });

  it("stores metadata.raw_headers lower-cased, no matter how the provider cased them", async () => {
    const { service } = harness(true);
    service.registerProvider(
      "acct-1",
      fakeFetchProvider(async () => ({
        from: "ana@cliente.com",
        fromName: "Ana",
        to: "me@kernl.local",
        cc: "",
        subject: "Proyecto web",
        body: "hola",
        bodyHtml: "",
        date: new Date().toISOString(),
        messageIdHeader: "<msg1@cliente.com>",
        threadId: "",
        rawHeaders: { "Message-ID": "<msg1@cliente.com>", "List-Unsubscribe": "<mailto:x@y.com>" },
      })),
    );
    const comm = await service.fetchEmail("uid-1", "acct-1");
    const stored = JSON.parse(comm.metadata).raw_headers;
    expect(stored["message-id"]).toBe("<msg1@cliente.com>");
    expect(stored["list-unsubscribe"]).toBe("<mailto:x@y.com>");
    expect(stored["Message-ID"]).toBeUndefined();
  });

  it("a mail fetched over IMAP with List-Unsubscribe is refused end-to-end through the tool", async () => {
    const { db, service, tool } = harness(true);
    service.registerProvider(
      "acct-1",
      fakeFetchProvider(async () => ({
        from: "newsletter@empresa.com",
        fromName: "Newsletter",
        to: "me@kernl.local",
        cc: "",
        subject: "Últimas noticias",
        body: "hola, esto es un boletín",
        bodyHtml: "",
        date: new Date().toISOString(),
        messageIdHeader: "<news1@empresa.com>",
        threadId: "",
        rawHeaders: { "message-id": "<news1@empresa.com>", "list-unsubscribe": "<mailto:baja@empresa.com>" },
      })),
    );
    const comm = await service.fetchEmail("uid-news-1", "acct-1");
    labelAsHuman(db, comm.id);
    const r: any = await tool.handler({ comm_id: comm.id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(r)).toContain("bulk/mailing-list");
    const countReplies = db.prepare("SELECT COUNT(*) n FROM communications WHERE in_reply_to = ?").get(comm.id) as any;
    expect(countReplies.n).toBe(0);
  });
});

describe("cross-conversation Message-ID threading", () => {
  it("a client reply referencing only our auto-reply's provider Message-ID threads to the same conversation and is refused", async () => {
    const { db, service, tool } = harness(true);
    // Use the real sendEmail (not the harness's blanket stub) so the outbound
    // auto-reply actually gets a provider Message-ID recorded — that's the
    // id we need the client's reply to reference. The provider itself is
    // still fully fake: no network call, no real mail sent.
    delete (service as any).sendEmail;
    service.registerProvider("acct-1", {
      name: "fake-send",
      capabilities: { send: true, searchInbox: false, fetchEmail: false },
      async send() {
        return { messageId: "<autoreply-abc@kernl.local>", threadId: "" };
      },
      async searchInbox() {
        return [];
      },
      async fetchEmail() {
        throw new Error("not implemented");
      },
    } as EmailProvider);

    const { comm: first } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      from_name: "Ana",
      subject: "Proyecto web",
      body: "Hola, necesitamos una web.",
      account_id: "acct-1",
    } as any);
    labelAsHuman(db, first.id);

    const ok: any = await tool.handler({ comm_id: first.id, missing: ["presupuesto"] } as any);
    expect(JSON.stringify(ok)).toContain("Sent to");

    // The client's mail app references our auto-reply's own Message-ID —
    // not anything from the original inbound mail — because that's the
    // message they're actually answering.
    const { comm: reply } = service.ingestInboundRaw({
      from: "ana@cliente.com",
      from_name: "Ana",
      subject: "Re: Proyecto web",
      body: "Ahí va el presupuesto.",
      account_id: "acct-1",
      message_id_header: "<msg-reply@cliente.com>",
      raw_headers: { "In-Reply-To": "<autoreply-abc@kernl.local>" },
    } as any);
    labelAsHuman(db, reply.id);

    const again: any = await tool.handler({ comm_id: reply.id, missing: ["plazo"] } as any);
    expect(JSON.stringify(again)).toContain("already got its one automatic mail");
  });
});
