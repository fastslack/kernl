import { describe, it, expect } from "bun:test";
import { makeCommsDb } from "./mail-test-db.js";
import { emailCampaignChannel, resolveSegment } from "../assets/extensions/people/comms/_module/outbox-channels.js";

describe("email_campaign channel", () => {
  it("resolves the segment at send time, skips unsubscribed, adds the unsubscribe link", async () => {
    const { db, service } = makeCommsDb();
    const acct = service.addAccount({ label: "News", email: "news@x.ar", provider: "resend" }).id;
    const ins = db.prepare("INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at, project_id, lead_source, do_not_contact) VALUES (?,?,?,'','','','x','x',?,?,?)");
    ins.run("C1", "Ana", "ana@x.ar", "P1", "waitlist", 0);
    ins.run("C2", "Beto", "beto@x.ar", "P1", "waitlist", 1);
    ins.run("C3", "Caro", "caro@x.ar", "P2", "waitlist", 0);
    ins.run("C5", "Eli", "eli@x.ar", "P1", "signup", 0);
    const seg = { project_id: "P1", lead_source: ["waitlist"] };
    expect(resolveSegment(db, seg).map((c) => c.email)).toEqual(["ana@x.ar"]);

    process.env.KERNEL_PUBLIC_URL = "https://k.example.com";
    let sentCampaign = "";
    service.sendCampaign = async (id: string) => { sentCampaign = id; return { sent: 1, failed: 0, total: 1 }; };
    const ch = emailCampaignChannel({ db, service: () => service, secret: () => "k" });
    const payload = { subject: "Novedades", body: "Hola {{name}}", segment: seg };
    expect(ch.validate(payload, `comms:${acct}`)).toEqual({ ok: true });
    expect(ch.preview(payload).meta?.Destinatarios).toMatch(/^1 contacto /);

    ins.run("C4", "Dani", "dani@x.ar", "P1", "waitlist", 0); // joined after the draft was proposed
    const r = await ch.send(payload, `comms:${acct}`);
    expect(r.ref).toBe(`campaign:${sentCampaign}`);
    const recips = db.prepare("SELECT email, variables FROM campaign_recipients WHERE campaign_id = ? ORDER BY email").all(sentCampaign) as Array<{ email: string; variables: string }>;
    expect(recips.map((x) => x.email)).toEqual(["ana@x.ar", "dani@x.ar"]);
    expect(JSON.parse(recips[0].variables).unsubscribe_url).toMatch(/\/api\/comms\/unsubscribe\/[^/]+$/);
    const camp = db.prepare("SELECT account_id, template_id FROM email_campaigns WHERE id = ?").get(sentCampaign) as { account_id: string; template_id: string };
    expect(camp.account_id).toBe(acct);
    const tpl = db.prepare("SELECT subject, body FROM email_templates WHERE id = ?").get(camp.template_id) as { subject: string; body: string };
    expect(tpl.subject).toBe("Novedades");
    expect(tpl.body).toContain("{{unsubscribe_url}}");

    expect(ch.validate({ ...payload, segment: { project_id: "P9" } }, `comms:${acct}`)).toMatchObject({ ok: false, error: expect.stringMatching(/ningún contacto/) });
    expect(ch.validate(payload, "comms:nope").ok).toBe(false);
  });

  it("fails when no recipient got the mail, and needs a public URL for the unsubscribe link", async () => {
    const { db, service } = makeCommsDb();
    const acct = service.addAccount({ label: "News", email: "news@x.ar", provider: "resend" }).id;
    db.prepare("INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at, project_id, lead_source, do_not_contact) VALUES ('C1','Ana','ana@x.ar','','','','x','x','P1','waitlist',0)").run();
    const ch = emailCampaignChannel({ db, service: () => service, secret: () => "k" });
    const payload = { subject: "Novedades", body: "Hola", body_html: "<p>Hola</p>", segment: { project_id: "P1" } };
    const saved = process.env.KERNEL_PUBLIC_URL;
    delete process.env.KERNEL_PUBLIC_URL;
    expect(ch.validate(payload, `comms:${acct}`)).toMatchObject({ ok: false, error: expect.stringMatching(/URL pública/) });
    process.env.KERNEL_PUBLIC_URL = "https://k.example.com/";
    (service as any).sendCampaign = async () => ({ sent: 0, failed: 1, total: 1 });
    await expect(ch.send(payload, `comms:${acct}`)).rejects.toThrow(/No salió ningún mail/);
    let camp = "";
    (service as any).sendCampaign = async (id: string) => { camp = id; return { sent: 1, failed: 0, total: 1 }; };
    await ch.send(payload, `comms:${acct}`);
    const t = db.prepare("SELECT t.body_html FROM email_campaigns c JOIN email_templates t ON t.id = c.template_id WHERE c.id = ?").get(camp) as { body_html: string };
    expect(t.body_html).toContain('href="{{unsubscribe_url}}"');
    if (saved === undefined) delete process.env.KERNEL_PUBLIC_URL; else process.env.KERNEL_PUBLIC_URL = saved;
  });

  it("an unsubscribe on any row with the same email excludes the person", () => {
    const { db } = makeCommsDb();
    const ins = db.prepare("INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at, project_id, lead_source, do_not_contact) VALUES (?,?,?,'','','','x','x',?,'waitlist',?)");
    ins.run("C1", "Ana", "Ana@x.ar", "P1", 0);
    ins.run("C2", "Ana dup", "ana@x.ar", "P2", 1);
    expect(resolveSegment(db, { project_id: "P1" })).toEqual([]);
  });
});
