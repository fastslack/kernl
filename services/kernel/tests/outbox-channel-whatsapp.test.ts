import { describe, it, expect } from "bun:test";
import { makeCommsDb } from "./mail-test-db.js";
import { whatsappChannel, knownWhatsappContact } from "../assets/extensions/people/comms/_module/outbox-channels.js";

describe("whatsapp channel", () => {
  it("only writes to people who gave their number or already wrote", async () => {
    const { db, service } = makeCommsDb();
    const ins = db.prepare("INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at, lead_source, do_not_contact) VALUES (?,?,?,?,'','','x','x',?,?)");
    ins.run("W1", "Ana", "", "+54 9 11 5555-0000", "waitlist", 0);
    ins.run("P1", "Prospecto", "pro@x.ar", "+54 11 4444-0000", "outbound", 0);
    ins.run("R1", "Respondió", "res@x.ar", "011 3333-0000", "outbound", 0);
    ins.run("D1", "Baja", "", "+54 9 11 2222-0000", "waitlist", 1);
    service.create({ channel: "email", direction: "inbound", contact_id: "R1", subject: "re", body: "sí" });

    expect(knownWhatsappContact(db, "5491155550000")).toBe("W1");
    expect(knownWhatsappContact(db, "+54 11 4444 0000")).toBeNull();
    expect(knownWhatsappContact(db, "+54 9 11 3333-0000")).toBe("R1");

    const sent: string[] = [];
    (service as any).sendWhatsApp = async (id: string) => { sent.push(id); return service.getById(id); };
    const ch = whatsappChannel({ db, service: () => service, whatsappReady: () => true });
    expect(ch.validate({ to_phone: "+5491155550000", text: "Hola" }, "whatsapp:default")).toEqual({ ok: true });
    expect(ch.validate({ to_phone: "+541144440000", text: "Hola" }, "whatsapp:default")).toMatchObject({ ok: false, error: expect.stringMatching(/solo para contactos que ya te escribieron/) });
    expect(ch.validate({ to_phone: "+5491122220000", text: "Hola" }, "whatsapp:default")).toMatchObject({ ok: false, error: expect.stringMatching(/no ser contactado/) });
    expect(ch.validate({ to_phone: "+5491155550000", text: "" }, "whatsapp:default").ok).toBe(false);
    expect(whatsappChannel({ db, service: () => service, whatsappReady: () => false }).validate({ to_phone: "+5491155550000", text: "x" }, "whatsapp:default"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/no está conectado/) });
    expect(ch.preview({ to_phone: "+5491155550000", text: "Hola" }).meta?.Para).toContain("Ana");

    const r = await ch.send({ to_phone: "+5491155550000", text: "Hola" }, "whatsapp:default");
    expect(sent.length).toBe(1);
    expect(r.ref).toMatch(/^comms:/);
    const comm = service.getById(r.ref.slice(6))!;
    expect(comm.channel).toBe("whatsapp");
    expect(comm.contact_id).toBe("W1");
  });

  it("sends to the contact's number in WhatsApp's E.164 form, whatever format was typed", async () => {
    const { db, service } = makeCommsDb();
    db.prepare("INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at, lead_source, do_not_contact) VALUES ('W1','Ana','','011 15 5555-0000','','','x','x','waitlist',0)").run();
    const sent: string[] = [];
    (service as any).sendWhatsApp = async (id: string) => { sent.push(id); return service.getById(id); };
    const ch = whatsappChannel({ db, service: () => service, whatsappReady: () => true });
    for (const typed of ["011 5555-0000", "+54 11 5555-0000", "5491155550000"]) {
      const r = await ch.send({ to_phone: typed, text: "Hola" }, "whatsapp:default");
      expect(service.getById(r.ref.slice(6))!.recipients_to).toBe("5491155550000");
    }
  });
});
