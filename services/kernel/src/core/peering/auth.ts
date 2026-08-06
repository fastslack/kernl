/**
 * Instance-to-instance authentication over NIP-98.
 *
 * Every request a Kernl makes to a friend carries an `Authorization: Nostr
 * <base64 event>` header: a signed event naming the exact URL and method, plus
 * a hash of the body when there is one. The receiver checks the signature and
 * then asks one question — is this signer a *trusted* friend?
 *
 * No shared secrets, no tokens to leak, and the credential cannot be replayed
 * against a different URL or method.
 */
import { getToken, unpackEventFromToken, validateEvent } from "nostr-tools/nip98";
import type { Event as NostrEvent, EventTemplate } from "nostr-tools/core";
import type { IncomingMessage } from "node:http";
import { log } from "../logger.js";
import { NostrIdentity } from "../nostr/nostr-identity.js";
import type { FriendsStore } from "./friends-store.js";
import { npubOf } from "./descriptor.js";

/** How far apart two clocks may be before a request is refused. */
export const MAX_CLOCK_SKEW_SEC = 60;

export interface AuthResult {
  ok: boolean;
  /** The verified signer, present only when ok. */
  npub?: string;
  pubkeyHex?: string;
  /** Why it failed. Logged locally; never sent to the caller. */
  reason?: string;
}

/** Build the Authorization header value for an outbound request. */
export async function buildAuthHeader(
  identity: NostrIdentity,
  url: string,
  method: string,
  body?: unknown,
): Promise<string> {
  return getToken(
    url,
    method,
    (template: EventTemplate) => identity.signEvent(template),
    true, // include the "Nostr " scheme
    body as Record<string, unknown> | undefined,
  );
}

/**
 * Verify an inbound request. The caller supplies the absolute URL it believes
 * was requested — deriving it from headers alone would let a proxy rewrite it.
 */
export async function verifyRequest(opts: {
  req: IncomingMessage;
  url: string;
  friends: FriendsStore;
  body?: unknown;
}): Promise<AuthResult> {
  const header = opts.req.headers["authorization"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) return { ok: false, reason: "missing Authorization" };

  let event: NostrEvent;
  try {
    event = await unpackEventFromToken(token);
  } catch (err) {
    return { ok: false, reason: `malformed token: ${String(err)}` };
  }

  // Clock skew is checked explicitly so the log says how far off it was — it
  // is the single most common cause of a peer that "just stopped working".
  const skew = Math.abs(Math.floor(Date.now() / 1000) - (event.created_at ?? 0));
  if (skew > MAX_CLOCK_SKEW_SEC) {
    log.warn(`peering: rejected request, clock skew ${skew}s`);
    return { ok: false, reason: `clock skew ${skew}s` };
  }

  const method = (opts.req.method ?? "GET").toUpperCase();
  let valid = false;
  try {
    valid = await validateEvent(event, opts.url, method, opts.body as Record<string, unknown>);
  } catch (err) {
    return { ok: false, reason: `validation error: ${String(err)}` };
  }
  if (!valid) return { ok: false, reason: "signature, url, method or payload mismatch" };

  const pubkeyHex = (event.pubkey ?? "").toLowerCase();
  if (!opts.friends.isTrusted(pubkeyHex)) {
    return { ok: false, reason: "signer is not a trusted friend" };
  }

  return { ok: true, pubkeyHex, npub: npubOf(pubkeyHex) };
}
