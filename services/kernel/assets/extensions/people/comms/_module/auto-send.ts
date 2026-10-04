/**
 * The one mail the office may send without the operator: asking a client for
 * the details a proposal needs. Every rule lives here, in code, so a model
 * that asks for more than that gets a refusal instead of a sent mail.
 */

export const MISSING_VOCAB = ["presupuesto", "plazo", "alcance", "stack", "modalidad", "contacto"] as const;
export type MissingField = typeof MISSING_VOCAB[number];

export interface AutoSendCheckInput {
  enabled: boolean;
  direction: string;
  from: string;
  autoLabel: string;
  threadHasAutoSend: boolean;
  missing: string[];
  /** Raw mail headers, lower-cased keys. Empty object when none were stored. */
  headers: Record<string, string>;
}

// "no-reply", "no_reply", "no.reply", "noreply" — and the "do not reply" family
// with the same separators. donotreply is covered by the second alternative
// already (do+not+reply with no separators) but kept explicit for clarity.
const SYSTEM_SENDER = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?@|mailer-daemon|postmaster@|bounce)/i;
const MACHINE_LABELS = new Set(["newsletter", "transactional", "billing", "security"]);
const AUTO_SUBMITTED_OK = new Set(["no"]);
const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);

/**
 * True when the headers mark the mail as bulk/mailing-list/auto-generated.
 * Values are coerced with String() before matching — headers arrives as
 * `Record<string, string>` by type, but it is built from stored JSON
 * metadata that ultimately traces back to an untrusted webhook/IMAP payload,
 * so a non-string value must not throw here.
 */
function looksMachineGenerated(headers: Record<string, string>): boolean {
  const autoSubmitted = String(headers["auto-submitted"] ?? "").toLowerCase().trim();
  if (autoSubmitted && !AUTO_SUBMITTED_OK.has(autoSubmitted)) return true;
  const precedence = String(headers["precedence"] ?? "").toLowerCase().trim();
  if (BULK_PRECEDENCE.has(precedence)) return true;
  if (headers["list-id"] || headers["list-unsubscribe"]) return true;
  return false;
}

export function checkAutoSend(i: AutoSendCheckInput): { ok: true } | { ok: false; reason: string } {
  if (!i.enabled) return { ok: false, reason: "Automatic sending is switched off (comms.auto_send.enabled)." };
  if (i.direction !== "inbound") return { ok: false, reason: "Only a reply to an inbound mail can be sent automatically." };
  if (SYSTEM_SENDER.test(i.from)) return { ok: false, reason: "The sender is an automated address." };
  if (looksMachineGenerated(i.headers ?? {})) {
    return { ok: false, reason: "The mail carries bulk/mailing-list headers (Auto-Submitted, Precedence or List-Id)." };
  }
  if (i.autoLabel === "") return { ok: false, reason: "The mail has not been labelled yet; try again later." };
  if (MACHINE_LABELS.has(i.autoLabel)) return { ok: false, reason: `The mail is labelled ${i.autoLabel}.` };
  if (i.threadHasAutoSend) return { ok: false, reason: "This thread already got its one automatic mail." };
  if (i.missing.length === 0) return { ok: false, reason: "Nothing to ask for." };
  const bad = i.missing.filter((m) => !(MISSING_VOCAB as readonly string[]).includes(m));
  if (bad.length) return { ok: false, reason: `Not askable automatically: ${bad.join(", ")}. Allowed: ${MISSING_VOCAB.join(", ")}.` };
  return { ok: true };
}

const Q: Record<"es" | "en", Record<MissingField, string>> = {
  es: {
    presupuesto: "¿Qué presupuesto tienen previsto?",
    plazo: "¿Qué plazo tienen en mente para el proyecto?",
    alcance: "¿Qué debería incluir el trabajo y qué queda afuera?",
    stack: "¿Con qué tecnologías o sistemas existentes tendría que trabajar?",
    modalidad: "¿Es un trabajo por proyecto cerrado o por horas, remoto o presencial?",
    contacto: "¿Con quién coordinaría el día a día?",
  },
  en: {
    presupuesto: "What budget do you have in mind?",
    plazo: "When do you need it by?",
    alcance: "What should the work include, and what is out of scope?",
    stack: "Which technologies or existing systems would it involve?",
    modalidad: "Is it a fixed-scope project or hourly, remote or on-site?",
    contacto: "Who would I coordinate with day to day?",
  },
};

export function missingInfoBody(lang: "es" | "en", missing: MissingField[], senderFirstName: string): string {
  const name = (senderFirstName ?? "").trim();
  const hi = name
    ? (lang === "es" ? `Hola ${name}, gracias por escribir.` : `Hi ${name}, thanks for reaching out.`)
    : (lang === "es" ? "Hola, gracias por escribir." : "Hi, thanks for reaching out.");
  const lead = lang === "es" ? "Para prepararte una propuesta necesito un par de datos:" : "To put a proposal together I need a couple of details:";
  const bye = lang === "es" ? "Con eso te respondo con la propuesta." : "With that I'll get back to you with a proposal.";
  return [hi, "", lead, ...missing.map((m) => `- ${Q[lang][m]}`), "", bye].join("\n");
}

const ES_HINTS = /[ñ¿¡]|\b(hola|gracias|presupuesto|proyecto|necesit|podr[ií]as|saludos|buen[oa]s)\b/i;
export function detectLang(text: string): "es" | "en" {
  return ES_HINTS.test(text) ? "es" : "en";
}

/**
 * Best-effort sanitizing of a name pulled out of a From header before it goes
 * into the greeting: strip anything that isn't a letter, apostrophe or
 * hyphen (no stray punctuation, emoji or header-injection leftovers in the
 * mail we send), and cap it well short of a full display name.
 */
export function sanitizeFirstName(raw: string): string {
  const cleaned = (raw ?? "").replace(/[^\p{L}'-]/gu, "").trim();
  return cleaned.slice(0, 40);
}
