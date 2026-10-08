import { describe, it, expect, beforeEach } from "bun:test";
import { makeCommsDb } from "./mail-test-db.js";
import { emailChannel } from "../assets/extensions/people/comms/_module/outbox-channels.js";

describe("email outbox channel", () => {
  let db: any; let service: any; let acct: string; let sent: string[];
  beforeEach(() => {
    ({ db, service } = makeCommsDb());
    acct = service.addAccount({ label: "Ventas", email: "ventas@x.ar", provider: "resend" }).id;
    sent = [];
    service.sendEmail = async (id: string) => { sent.push(id); return service.getById(id); };
  });
  const ch = () => emailChannel({ db, service: () => service });
  const payload = { to: ["ana@x.ar"], subject: "Hola", body: "Te escribo por…" };

  it("validates recipients, subject, body and the linked account", () => {
    expect(ch().validate(payload, `comms:${acct}`)).toEqual({ ok: true });
    expect(ch().validate({ ...payload, to: ["no-es-mail"] }, `comms:${acct}`).ok).toBe(false);
    expect(ch().validate({ ...payload, to: [] }, `comms:${acct}`).ok).toBe(false);
    expect(ch().validate({ ...payload, subject: "" }, `comms:${acct}`).ok).toBe(false);
    expect(ch().validate(payload, "comms:nope")).toMatchObject({ ok: false, error: expect.stringMatching(/no encontrada/) });
  });

  it("accepts the bare id, email:<id> and the account address, and says which format it wants", () => {
    for (const ref of [acct, `email:${acct}`, `email_account:${acct}`, "ventas@x.ar", "email:VENTAS@x.ar"]) expect(ch().validate(payload, ref)).toEqual({ ok: true });
    expect(ch().canonicalRef!("ventas@x.ar")).toBe(`comms:${acct}`);
    expect(ch().canonicalRef!("email:heural")).toBeNull();
    expect(ch().validate(payload, "email:heural")).toMatchObject({ ok: false, error: expect.stringMatching(/no encontrada\. account_ref: comms:<email_account_id>/) });
  });

  it("sends through an account named by its address", async () => {
    const r = await ch().send(payload, "ventas@x.ar");
    expect(service.getById(r.ref.slice(6)).account_id).toBe(acct);
  });

  it("previews as a mail", () => {
    expect(ch().preview(payload)).toEqual({ title: "Hola", body: "Te escribo por…", meta: { Para: "ana@x.ar" } });
  });

  it("sends through the linked account and records the comm", async () => {
    const r = await ch().send(payload, `comms:${acct}`);
    expect(r.ref).toMatch(/^comms:/);
    const comm = service.getById(r.ref.slice(6));
    expect(comm.account_id).toBe(acct);
    expect(comm.direction).toBe("outbound");
    expect(comm.recipients_to).toBe("ana@x.ar");
    expect(sent).toEqual([comm.id]);
  });

  it("refuses at send time a recipient who unsubscribed after the draft", async () => {
    db.prepare("INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at, do_not_contact) VALUES ('C1','Ana','ana@x.ar','','','','x','x',1)").run();
    expect(ch().validate(payload, `comms:${acct}`).ok).toBe(false);
    await expect(ch().send(payload, `comms:${acct}`)).rejects.toThrow(/pidió no ser contactado/);
    expect(sent).toEqual([]);
  });

  it("never falls back to the default account", async () => {
    await expect(ch().send(payload, "comms:deleted")).rejects.toThrow(/no encontrada/);
    expect(sent).toEqual([]);
  });

  it("checks CC recipients against do-not-contact too", () => {
    db.prepare("INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at, do_not_contact) VALUES ('C9','Cc','cc@x.ar','','','','x','x',1)").run();
    expect(ch().validate({ ...payload, cc: ["cc@x.ar"] }, `comms:${acct}`)).toMatchObject({ ok: false, error: expect.stringMatching(/cc@x.ar pidió no ser contactado/) });
  });
});
