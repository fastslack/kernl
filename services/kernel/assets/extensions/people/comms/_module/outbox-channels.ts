/**
 * Outbox channels owned by Comms (kernel projects module): `email`,
 * `email_campaign` and `whatsapp`. Offices never send by themselves — they
 * propose a draft, the operator approves it, and the outbox calls `send` here.
 *
 * account_ref: `comms:<email_account_id>` for mail, `whatsapp:default` for
 * WhatsApp. Mail also takes the bare id, `email:<id>` and the account's
 * address — agents reach for all of them, and a project link stores the bare
 * id or the address. A channel never falls back to another account, and every check
 * (including "do not contact") runs again at send time: the draft may have
 * been approved days after it was proposed.
 */
import { registerOutboxChannel, log, type OutboxChannelHandler, type SqliteDb } from "@kernl/extension-sdk";
import type { CommsService } from "./service.js";
import { isDoNotContact, samePhone, whatsappNumber } from "./dnc.js";
import { unsubscribeToken } from "./unsubscribe.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAIL_REF_HINT = "comms:<email_account_id> (the id from kernel_comms_list_accounts; the bare id or the account's address also work)";

/** The email account a ref names, or "" — never the default account. */
function resolveAccountId(svc: CommsService, ref: string): string {
  const raw = String(ref ?? "").trim().replace(/^(comms|email_account|email):/i, "");
  if (!raw) return "";
  if (svc.getAccount(raw)) return raw;
  return EMAIL_RE.test(raw) ? (svc.getAccountByEmail(raw)?.id ?? "") : "";
}

const accountMissing = (ref: string) => `Cuenta de correo ${ref} no encontrada. account_ref: ${MAIL_REF_HINT}`;

/** Mail channels share how a ref is resolved and canonicalized. */
function mailRefs(deps: CommsChannelDeps): Pick<OutboxChannelHandler, "canonicalRef" | "refHint"> {
  return {
    refHint: MAIL_REF_HINT,
    canonicalRef: (ref) => {
      const svc = deps.service();
      const id = svc ? resolveAccountId(svc, ref) : "";
      return id ? `comms:${id}` : null;
    },
  };
}

interface EmailPayload {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  body_html?: string;
  reply_to_comm_id?: string;
  contact_id?: string;
}

interface CommsChannelDeps {
  db: SqliteDb;
  service: () => CommsService | null;
}

export function emailChannel(deps: CommsChannelDeps): OutboxChannelHandler {
  const problem = (p: EmailPayload, ref: string): string | null => {
    const svc = deps.service();
    if (!svc) return "Comms no está disponible";
    if (!Array.isArray(p?.to) || p.to.length === 0) return "Falta el destinatario";
    const bad = [...p.to, ...(p.cc ?? [])].find((a) => !EMAIL_RE.test(String(a).trim()));
    if (bad !== undefined) return `Dirección inválida: ${bad}`;
    if (!p.subject?.trim()) return "Falta el asunto";
    if (!p.body?.trim()) return "Falta el cuerpo del mail";
    if (!resolveAccountId(svc, ref)) return accountMissing(ref);
    const blocked = [...p.to, ...(p.cc ?? [])].find((a) => isDoNotContact(deps.db, { email: a }));
    if (blocked) return `${blocked} pidió no ser contactado`;
    if (p.contact_id && isDoNotContact(deps.db, { contactId: p.contact_id })) return "El contacto pidió no ser contactado";
    return null;
  };

  return {
    ...mailRefs(deps),
    validate: (payload, ref) => {
      const err = problem(payload as EmailPayload, ref);
      return err ? { ok: false, error: err } : { ok: true };
    },
    preview: (payload) => {
      const p = payload as EmailPayload;
      return {
        title: p.subject,
        body: p.body,
        meta: { Para: (p.to ?? []).join(", "), ...(p.cc?.length ? { CC: p.cc.join(", ") } : {}) },
      };
    },
    send: async (payload, ref) => {
      const p = payload as EmailPayload;
      const err = problem(p, ref);
      if (err) throw new Error(err);
      const svc = deps.service()!;
      const comm = svc.create({
        channel: "email",
        direction: "outbound",
        account_id: resolveAccountId(svc, ref),
        subject: p.subject,
        body: p.body,
        body_html: p.body_html,
        contact_id: p.contact_id,
        in_reply_to: p.reply_to_comm_id,
        recipients_to: p.to.map((a) => a.trim()).join(", "),
        recipients_cc: (p.cc ?? []).map((a) => a.trim()).join(", "),
      });
      await svc.sendEmail(comm.id);
      return { ref: `comms:${comm.id}` };
    },
  };
}

interface Segment { project_id: string; lead_status?: string[]; lead_source?: string[] }

interface CampaignPayload {
  subject: string;
  body: string;
  body_html?: string;
  segment: Segment;
}

/** Contacts of a project segment that have an email and did not unsubscribe. */
export function resolveSegment(db: SqliteDb, seg: Segment): Array<{ id: string; name: string; email: string }> {
  if (!seg?.project_id) return [];
  // An unsubscribe on ANY row with the same address counts (duplicates, other projects).
  let sql = `SELECT id, name, email FROM contacts c WHERE project_id = ? AND email <> '' AND do_not_contact = 0
               AND NOT EXISTS (SELECT 1 FROM contacts d WHERE d.do_not_contact = 1 AND LOWER(d.email) = LOWER(c.email))`;
  const params: unknown[] = [seg.project_id];
  if (seg.lead_status?.length) {
    sql += ` AND lead_status IN (${seg.lead_status.map(() => "?").join(",")})`;
    params.push(...seg.lead_status);
  }
  if (seg.lead_source?.length) {
    sql += ` AND lead_source IN (${seg.lead_source.map(() => "?").join(",")})`;
    params.push(...seg.lead_source);
  }
  try {
    return db.prepare(sql + " ORDER BY email").all(...params) as Array<{ id: string; name: string; email: string }>;
  } catch {
    return [];
  }
}

const describeSegment = (seg: Segment) => {
  const parts: string[] = [];
  if (seg.lead_source?.length) parts.push(`origen: ${seg.lead_source.join(", ")}`);
  if (seg.lead_status?.length) parts.push(`estado: ${seg.lead_status.join(", ")}`);
  return parts.length ? parts.join(" · ") : "todos los contactos del proyecto";
};

const UNSUB_FOOTER = "\n\n—\nSi no querés recibir más mails nuestros: {{unsubscribe_url}}";
const UNSUB_FOOTER_HTML = '<hr><p style="font-size:12px;color:#666">Si no querés recibir más mails nuestros, <a href="{{unsubscribe_url}}">date de baja acá</a>.</p>';
const publicBase = () => (process.env.KERNEL_PUBLIC_URL ?? "").replace(/\/$/, "");

export function emailCampaignChannel(deps: CommsChannelDeps & { secret: () => string }): OutboxChannelHandler {
  const problem = (p: CampaignPayload, ref: string): string | null => {
    const svc = deps.service();
    if (!svc) return "Comms no está disponible";
    if (!p?.subject?.trim()) return "Falta el asunto";
    if (!p.body?.trim()) return "Falta el cuerpo";
    if (!resolveAccountId(svc, ref)) return accountMissing(ref);
    if (resolveSegment(deps.db, p.segment).length === 0) return "El segmento no tiene ningún contacto con mail (o todos se dieron de baja)";
    if (!/^https?:\/\//.test(publicBase())) {
      return "Configurá la URL pública del kernel (KERNEL_PUBLIC_URL) para que el link de baja funcione en los mails";
    }
    return null;
  };

  return {
    ...mailRefs(deps),
    validate: (payload, ref) => {
      const err = problem(payload as CampaignPayload, ref);
      return err ? { ok: false, error: err } : { ok: true };
    },
    preview: (payload) => {
      const p = payload as CampaignPayload;
      const n = resolveSegment(deps.db, p.segment).length;
      return { title: p.subject, body: p.body, meta: { Destinatarios: `${n} contacto${n === 1 ? "" : "s"} (${describeSegment(p.segment)})` } };
    },
    send: async (payload, ref) => {
      const p = payload as CampaignPayload;
      const err = problem(p, ref);
      if (err) throw new Error(err);
      const svc = deps.service()!;
      const accountId = resolveAccountId(svc, ref);
      const body = p.body.includes("{{unsubscribe_url}}") ? p.body : p.body + UNSUB_FOOTER;
      const bodyHtml = p.body_html && !p.body_html.includes("{{unsubscribe_url}}") ? p.body_html + UNSUB_FOOTER_HTML : p.body_html;
      const template = svc.createTemplate({ name: `Outbox · ${p.subject}`, subject: p.subject, body, body_html: bodyHtml, account_id: accountId });
      const campaign = svc.createCampaign({ name: `Outbox · ${p.subject}`, template_id: template.id, account_id: accountId, subject_override: p.subject });
      // Recipients are resolved now, not when the draft was proposed.
      const recipients = resolveSegment(deps.db, p.segment).map((c) => ({
        email: c.email,
        name: c.name,
        contact_id: c.id,
        variables: { unsubscribe_url: `${publicBase()}/api/comms/unsubscribe/${unsubscribeToken(c.id, deps.secret())}` },
      }));
      svc.addRecipients(campaign.id, recipients);
      const result = await svc.sendCampaign(campaign.id);
      // sendCampaign never throws per recipient; a campaign where nothing left is a failure.
      if (result.total > 0 && result.sent === 0) {
        throw new Error(`No salió ningún mail de la campaña (${result.failed} fallaron). Revisá la cuenta de correo.`);
      }
      return { ref: `campaign:${campaign.id}${result.failed ? `?failed=${result.failed}/${result.total}` : ""}` };
    },
  };
}

interface WhatsappPayload { to_phone: string; text: string; contact_id?: string }

/**
 * Anti-spam: WhatsApp only to people who gave you their number (waitlist or
 * signup) or who already wrote to you. Comms keeps no WhatsApp inbound, so
 * "already wrote" means any inbound communication from the contact. Returns
 * the contact id, or null when the number is a stranger.
 */
export function knownWhatsappContact(db: SqliteDb, phone: string): string | null {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.phone, c.lead_source,
             EXISTS(SELECT 1 FROM communications m WHERE m.contact_id = c.id AND m.direction = 'inbound') AS wrote
        FROM contacts c
       WHERE c.phone <> '' AND c.do_not_contact = 0`).all() as Array<{ id: string; phone: string; lead_source: string; wrote: number }>;
    const hit = rows.find((r) => samePhone(r.phone, phone) && (r.wrote === 1 || r.lead_source === "waitlist" || r.lead_source === "signup"));
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

export function whatsappChannel(deps: CommsChannelDeps & { whatsappReady: () => boolean }): OutboxChannelHandler {
  const problem = (p: WhatsappPayload): string | null => {
    if (!deps.service()) return "Comms no está disponible";
    if (!deps.whatsappReady()) return "WhatsApp no está conectado";
    if (!p?.text?.trim()) return "Falta el mensaje";
    if (p.text.length > 4096) return "El mensaje supera los 4096 caracteres";
    if (!p.to_phone || p.to_phone.replace(/\D/g, "").length < 8) return "Falta un teléfono válido";
    if (isDoNotContact(deps.db, { phone: p.to_phone }) || (p.contact_id && isDoNotContact(deps.db, { contactId: p.contact_id }))) {
      return "El contacto pidió no ser contactado";
    }
    if (!knownWhatsappContact(deps.db, p.to_phone)) {
      return "WhatsApp solo para contactos que ya te escribieron o te dejaron su número. Usá mail.";
    }
    return null;
  };
  const nameOf = (id: string | null) => {
    if (!id) return "";
    try {
      return (deps.db.prepare("SELECT name FROM contacts WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "";
    } catch {
      return "";
    }
  };

  return {
    validate: (payload) => {
      const err = problem(payload as WhatsappPayload);
      return err ? { ok: false, error: err } : { ok: true };
    },
    preview: (payload) => {
      const p = payload as WhatsappPayload;
      const name = nameOf(knownWhatsappContact(deps.db, p.to_phone) ?? p.contact_id ?? null);
      return { title: "WhatsApp", body: p.text, meta: { Para: name ? `${name} · ${p.to_phone}` : p.to_phone } };
    },
    send: async (payload) => {
      const p = payload as WhatsappPayload;
      const err = problem(p);
      if (err) throw new Error(err);
      const svc = deps.service()!;
      const contactId = knownWhatsappContact(deps.db, p.to_phone) ?? p.contact_id ?? undefined;
      const comm = svc.create({
        channel: "whatsapp",
        direction: "outbound",
        body: p.text,
        contact_id: contactId,
        // WhatsApp's own form (549 + national for AR mobiles), not the digits as typed.
        recipients_to: whatsappNumber(p.to_phone),
      });
      await svc.sendWhatsApp(comm.id);
      return { ref: `comms:${comm.id}` };
    },
  };
}

/** Is the paired WhatsApp provider connected right now? */
function whatsappReady(notifier: unknown): boolean {
  try {
    const n = notifier as { getRegistry?: () => { getProvider(id: string): { isReady?: () => boolean } | undefined } };
    return n.getRegistry?.().getProvider("whatsapp")?.isReady?.() ?? false;
  } catch {
    return false;
  }
}

/** Called once from the Comms module init. A kernel without projects only logs. */
export function registerCommsChannels(deps: CommsChannelDeps & { notifier: unknown; secret: () => string }): void {
  const channels: Array<[string, () => OutboxChannelHandler]> = [
    ["email", () => emailChannel(deps)],
    ["email_campaign", () => emailCampaignChannel(deps)],
    ["whatsapp", () => whatsappChannel({ ...deps, whatsappReady: () => whatsappReady(deps.notifier) })],
  ];
  for (const [name, make] of channels) {
    try {
      registerOutboxChannel(name, make());
    } catch (err) {
      log.warn(`comms: outbox channel "${name}" not registered (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
