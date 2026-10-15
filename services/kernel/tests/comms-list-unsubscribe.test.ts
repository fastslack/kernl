import { describe, it, expect, vi } from "bun:test";
import { buildMimeMessage } from "../assets/extensions/people/comms/_module/mime-builder.js";
import { buildSmtpMail } from "../assets/extensions/people/comms/_module/providers/imap-smtp-provider.js";
import { buildResendPayload } from "../assets/extensions/people/comms/_module/providers/resend-provider.js";
import { emailChannel } from "../assets/extensions/people/comms/_module/outbox-channels.js";
import { makeCommsDb } from "./mail-test-db.js";

const LU = "<mailto:contacto@heural-tech.com?subject=baja>";
const base = { to: "a@x.com", subject: "Hola", body: "texto", bodyHtml: "<p>html</p>" };

function withProvider() {
  const { db, service } = makeCommsDb();
  const acct = service.addAccount({ label: "Ventas", email: "contacto@heural-tech.com", provider: "resend" }).id;
  const send = vi.fn().mockResolvedValue({ messageId: "m", threadId: "" });
  service.registerProvider(acct, { name: "mock", capabilities: { send: true, searchInbox: false, fetchEmail: false }, send, searchInbox: vi.fn(), fetchEmail: vi.fn() } as never);
  return { db, service, acct, send, ch: emailChannel({ db, service: () => service }) };
}

describe("List-Unsubscribe", () => {
  it("goes into the Gmail MIME message", () => {
    const raw = buildMimeMessage({ ...base, headers: { "List-Unsubscribe": LU } });
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(text).toContain(`List-Unsubscribe: ${LU}`);
  });

  it("goes into the SMTP mail and the Resend payload, next to the threading headers", () => {
    expect(buildSmtpMail({ ...base, headers: { "List-Unsubscribe": LU } }, "Equipo Heural <c@h.com>").headers).toEqual({ "List-Unsubscribe": LU });
    const r = buildResendPayload({ ...base, inReplyTo: "<m1>", headers: { "List-Unsubscribe": LU } }, "c@h.com");
    expect(r.headers).toEqual({ "In-Reply-To": "<m1>", References: "<m1>", "List-Unsubscribe": LU });
    expect(r.html).toBe("<p>html</p>");
    expect(r.text).toBe("texto");
  });

  it("is absent when nobody asked for it", () => {
    expect(buildSmtpMail(base, "c@h.com").headers).toBeUndefined();
    expect(buildResendPayload(base, "c@h.com").headers).toBeUndefined();
  });

  it("travels from the outbox email payload to the provider", async () => {
    const { send, ch, acct } = withProvider();
    await ch.send({ to: ["ana@x.ar"], subject: "Hola", body: "b", list_unsubscribe: LU }, `comms:${acct}`);
    expect(send.mock.calls[0][0].headers).toEqual({ "List-Unsubscribe": LU });
  });

  it("refuses a List-Unsubscribe that is not a <mailto:…> or <https://…> value", () => {
    const { ch, acct } = withProvider();
    expect(ch.validate({ to: ["a@x.ar"], subject: "s", body: "b", list_unsubscribe: "baja\r\nBcc: x@y.z" }, `comms:${acct}`).ok).toBe(false);
  });
});

describe("verbatim HTML", () => {
  const DESIGNED = '<!doctype html><html><head><style>@media screen and (max-width:620px){.wrap{width:100%!important}}</style></head><body><table class="wrap" style="background-image:radial-gradient(#203753,#0D1826)"><tr><td>Hola</td></tr></table><script>x()</script></body></html>';

  it("sends a designed template exactly as written, while the stored copy for the dashboard stays sanitized", async () => {
    const { service, send, ch, acct } = withProvider();
    const r = await ch.send({ to: ["ana@x.ar"], subject: "Hola", body: "Hola", body_html: DESIGNED, html_verbatim: true }, `comms:${acct}`);
    expect(send.mock.calls[0][0].bodyHtml).toBe(DESIGNED);
    const comm = service.getById(r.ref.slice(6))!;
    expect(comm.body_html).not.toContain("<style");
    expect(comm.body_html).not.toContain("<script");
  });

  it("without the flag the provider gets the sanitized HTML, as before", async () => {
    const { send, ch, acct } = withProvider();
    await ch.send({ to: ["ana@x.ar"], subject: "Hola", body: "Hola", body_html: DESIGNED }, `comms:${acct}`);
    expect(send.mock.calls[0][0].bodyHtml).not.toContain("<style");
  });
});
