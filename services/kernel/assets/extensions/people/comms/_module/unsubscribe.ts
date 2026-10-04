import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Unsubscribe links: /api/comms/unsubscribe/<token>, where the token is the
 * contact id plus an HMAC of it. Public route — the signature is the auth.
 */
export function unsubscribeToken(contactId: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(contactId).digest("base64url").slice(0, 32);
  return `${Buffer.from(contactId).toString("base64url")}.${sig}`;
}

/** The contact id the token was signed for, or null when it was tampered with. */
export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  const [idPart, sig] = (token ?? "").split(".");
  if (!idPart || !sig) return null;
  const contactId = Buffer.from(idPart, "base64url").toString();
  const expected = unsubscribeToken(contactId, secret).split(".")[1];
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? contactId : null;
}

/** Mark the token's contact as do-not-contact. False for an invalid token. */
export function applyUnsubscribe(db: import("@kernl/extension-sdk").SqliteDb, token: string, secret: string): boolean {
  const id = verifyUnsubscribeToken(token, secret);
  if (!id) return false;
  try {
    db.prepare("UPDATE contacts SET do_not_contact = 1 WHERE id = ?").run(id);
  } catch {
    return false;
  }
  return true;
}
