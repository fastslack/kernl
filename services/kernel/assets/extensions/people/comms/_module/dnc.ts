import type { SqliteDb } from "@kernl/extension-sdk";

/**
 * Argentine national number (10 digits: area + subscriber) from whatever was
 * typed: drops +54, the mobile 9, the trunk 0 and the "15" mobile prefix that
 * follows the area code (11 15 5555-0000 → 1155550000). Null when it does
 * not look Argentine.
 */
function arNational(raw: string): string | null {
  let d = (raw ?? "").replace(/\D/g, "");
  const intl = /^\s*\+/.test(raw ?? "") || d.startsWith("54");
  if (d.startsWith("54")) d = d.slice(2);
  else if (intl) return null;
  if (d.startsWith("9") && d.length === 11) d = d.slice(1);
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length === 12) {
    const area = d.startsWith("11") ? 2 : d.slice(3, 5) === "15" ? 3 : d.slice(4, 6) === "15" ? 4 : 0;
    if (area && d.slice(area, area + 2) === "15") d = d.slice(0, area) + d.slice(area + 2);
  }
  return d.length === 10 ? d : null;
}

/** Comparable key: the AR national number when it is one, else all digits. */
export function phoneKey(raw: string): string {
  return arNational(raw) ?? (raw ?? "").replace(/\D/g, "");
}

/** The number WhatsApp expects (digits, with country code): AR mobiles as 549 + national. */
export function whatsappNumber(raw: string): string {
  const ar = arNational(raw);
  return ar ? `549${ar}` : (raw ?? "").replace(/\D/g, "");
}

/** Same person when the last 10 digits match (enough to skip country/area prefixes). */
export function samePhone(a: string, b: string): boolean {
  const ka = phoneKey(a);
  const kb = phoneKey(b);
  if (ka.length < 8 || kb.length < 8) return false;
  return ka.slice(-10) === kb.slice(-10);
}

/**
 * True when the contact (by id, email or phone) asked not to be contacted.
 * Every outbox channel calls it in validate() and again in send().
 */
export function isDoNotContact(db: SqliteDb, who: { contactId?: string; email?: string; phone?: string }): boolean {
  try {
    if (who.contactId) {
      const r = db.prepare("SELECT do_not_contact FROM contacts WHERE id = ?").get(who.contactId) as { do_not_contact: number } | undefined;
      if (r?.do_not_contact === 1) return true;
    }
    if (who.email?.trim()) {
      const r = db.prepare("SELECT 1 AS x FROM contacts WHERE LOWER(email) = LOWER(?) AND do_not_contact = 1").get(who.email.trim());
      if (r) return true;
    }
    if (who.phone?.trim()) {
      const rows = db.prepare("SELECT phone FROM contacts WHERE do_not_contact = 1 AND phone <> ''").all() as Array<{ phone: string }>;
      if (rows.some((r) => samePhone(r.phone, who.phone!))) return true;
    }
  } catch {
    /* no contacts table (CRM off) or no do_not_contact column yet: nobody is marked */
  }
  return false;
}
