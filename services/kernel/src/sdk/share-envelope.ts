/**
 * Share envelope v1 — the canonical, signed card ("ficha") that travels when
 * someone shares a movie, show, record, book, link or note.
 *
 * - The body is validated strictly: any key the schema does not know is an
 *   error, so a sender cannot smuggle extra data inside a valid-looking card.
 * - The signature is BIP-340 Schnorr (secp256k1, the Nostr curve) over
 *   sha256("kernl-share-v1|" + canonicalJson(body)); the prefix keeps a card
 *   signature from ever being valid for any other message the same key signs.
 *   `pubkey` is the signer's x-only key in hex.
 * - Text fields and ids reject control characters (C0, DEL, C1) and bidi
 *   overrides/isolates, so a card cannot hide or reorder what the reader sees.
 *   `note` alone may carry newlines and tabs.
 * - Readers degrade gracefully: a card from a newer version (or an unknown
 *   kind) that still carries a title is shown as a generic card with only the
 *   fields this version can vouch for.
 *
 * Pure code only (zod + @noble): no kernel runtime imports.
 */

import { z } from "zod";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const ENVELOPE_VERSION = 1;

export const SHARE_KINDS = ["movie", "show", "music", "book", "link", "note"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export interface ShareIds {
  archive?: string;
  wikidata?: string;
  imdb?: string;
  isbn?: string;
  musicbrainz?: string;
  url?: string;
}

export interface ShareEnvelopeBody {
  v: 1;
  kind: ShareKind;
  title: string;
  year?: number;
  creator?: string;
  cover?: string;
  ids: ShareIds;
  note?: string;
  rating?: number;
  created_at: number;
}

export interface ShareEnvelope extends ShareEnvelopeBody {
  pubkey: string;
  sig: string;
}

// ── Schema ───────────────────────────────────────────────────────────────

const MIN_CREATED_AT = 1_600_000_000;
const MAX_FUTURE_SECONDS = 86_400;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// C0 controls, DEL, C1 controls, bidi embeddings/overrides (U+202A-U+202E)
// and bidi isolates (U+2066-U+2069).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
// Same set minus \n and \t, for free text that may span lines.
const UNSAFE_CHARS_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const safeText = (s: string) => !UNSAFE_CHARS.test(s);
const safeMultiline = (s: string) => !UNSAFE_CHARS_MULTILINE.test(s);
const UNSAFE_MESSAGE = { message: "must not contain control or bidi-override characters" };

const httpsUrl = z
  .string()
  .max(1000)
  .refine(safeText, UNSAFE_MESSAGE)
  .refine(isHttpsUrl, { message: "must be an https: URL" });
const nonBlank = (s: string) => s.trim().length > 0;
// No transforms (e.g. .trim()) anywhere: the verified body must be byte-for-byte
// the body that was signed.
const idString = z
  .string()
  .min(1)
  .max(200)
  .refine(nonBlank, { message: "must not be blank" })
  .refine(safeText, UNSAFE_MESSAGE);

const ID_SHAPE = {
  archive: idString,
  wikidata: idString,
  imdb: idString,
  isbn: idString,
  musicbrainz: idString,
  url: httpsUrl,
} as const;

const idsSchema = z
  .object({
    archive: ID_SHAPE.archive.optional(),
    wikidata: ID_SHAPE.wikidata.optional(),
    imdb: ID_SHAPE.imdb.optional(),
    isbn: ID_SHAPE.isbn.optional(),
    musicbrainz: ID_SHAPE.musicbrainz.optional(),
    url: ID_SHAPE.url.optional(),
  })
  .strict()
  .refine((ids) => Object.values(ids).some((v) => v !== undefined), {
    message: "ids must carry at least one identifier",
  });

const titleSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(nonBlank, { message: "must not be blank" })
  .refine(safeText, UNSAFE_MESSAGE);

const bodyShape = {
  v: z.literal(1),
  kind: z.enum(SHARE_KINDS),
  title: titleSchema,
  year: z.number().int().min(1800).max(2200).optional(),
  creator: z.string().max(200).refine(safeText, UNSAFE_MESSAGE).optional(),
  cover: httpsUrl.optional(),
  ids: idsSchema,
  note: z.string().max(2000).refine(safeMultiline, UNSAFE_MESSAGE).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  created_at: z
    .number()
    .int()
    .gt(MIN_CREATED_AT)
    .refine((t) => t <= Math.floor(Date.now() / 1000) + MAX_FUTURE_SECONDS, {
      message: "created_at is too far in the future",
    }),
};

const bodySchema = z.object(bodyShape).strict();

const envelopeSchema = z
  .object({
    ...bodyShape,
    pubkey: z.string().regex(/^[0-9a-f]{64}$/, "pubkey must be 32-byte lowercase hex"),
    sig: z.string().regex(/^[0-9a-f]{128}$/, "sig must be 64-byte lowercase hex"),
  })
  .strict();

function formatError(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

// ── Public API ───────────────────────────────────────────────────────────

export function validateEnvelopeBody(
  input: unknown,
): { ok: true; body: ShareEnvelopeBody } | { ok: false; error: string } {
  const parsed = bodySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: formatError(parsed.error) };
  return { ok: true, body: parsed.data as ShareEnvelopeBody };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Sorted keys at every level, no whitespace, undefined fields dropped. */
export function canonicalJson(body: ShareEnvelopeBody): string {
  return JSON.stringify(sortKeys(body));
}

/** Domain separator: a card signature is never valid for another kind of message. */
const DIGEST_PREFIX = "kernl-share-v1|";

function digest(body: ShareEnvelopeBody): Uint8Array {
  return sha256(new TextEncoder().encode(DIGEST_PREFIX + canonicalJson(body)));
}

/** Validates `body` (throws if invalid) and signs it with a 32-byte secp256k1 secret key. */
export function signEnvelope(body: ShareEnvelopeBody, secretKey: Uint8Array): ShareEnvelope {
  const checked = validateEnvelopeBody(body);
  if (!checked.ok) throw new Error(`invalid share envelope: ${checked.error}`);
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  const sig = bytesToHex(schnorr.sign(digest(checked.body), secretKey));
  return { ...checked.body, pubkey, sig };
}

export function verifyEnvelope(
  env: unknown,
): { ok: true; envelope: ShareEnvelope } | { ok: false; error: string } {
  const parsed = envelopeSchema.safeParse(env);
  if (!parsed.success) return { ok: false, error: formatError(parsed.error) };
  const { pubkey, sig, ...body } = parsed.data as ShareEnvelope;
  let valid = false;
  try {
    valid = schnorr.verify(hexToBytes(sig), digest(body), hexToBytes(pubkey));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "signature does not verify" };
  return { ok: true, envelope: parsed.data as ShareEnvelope };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keeps only the ids this version knows, each validated on its own. */
function sanitizeIds(raw: unknown): ShareIds {
  const ids: ShareIds = {};
  if (!isRecord(raw)) return ids;
  for (const key of Object.keys(ID_SHAPE) as (keyof ShareIds)[]) {
    const r = ID_SHAPE[key].safeParse(raw[key]);
    if (r.success) ids[key] = r.data;
  }
  return ids;
}

/**
 * - `typed`: a v1 envelope of a known kind whose signature verifies.
 * - `generic`: a newer version or unknown kind that still carries a title;
 *   only the title, the known ids and an https cover survive.
 * - `invalid`: anything else, including a v1 card whose signature fails.
 */
export function readEnvelope(
  env: unknown,
):
  | { kind: "typed"; envelope: ShareEnvelope }
  | { kind: "generic"; title: string; ids: ShareIds; cover?: string }
  | { kind: "invalid"; error: string } {
  if (!isRecord(env)) return { kind: "invalid", error: "envelope must be an object" };

  const newerVersion = typeof env.v === "number" && env.v !== ENVELOPE_VERSION;
  const unknownKind = !(SHARE_KINDS as readonly unknown[]).includes(env.kind);

  if (newerVersion || unknownKind) {
    const title = titleSchema.safeParse(env.title);
    if (!title.success) return { kind: "invalid", error: "unreadable envelope without a title" };
    const out: { kind: "generic"; title: string; ids: ShareIds; cover?: string } = {
      kind: "generic",
      title: title.data,
      ids: sanitizeIds(env.ids),
    };
    const cover = httpsUrl.safeParse(env.cover);
    if (cover.success) out.cover = cover.data;
    return out;
  }

  const verified = verifyEnvelope(env);
  if (!verified.ok) return { kind: "invalid", error: verified.error };
  return { kind: "typed", envelope: verified.envelope };
}

/**
 * NIP-73 external-content tags for a share.
 *
 * NIP-73 defines `isbn:<isbn>` and bare web URLs as `i` identifiers; those are
 * emitted as-is. It has no prefixes for IMDb, Wikidata, MusicBrainz or the
 * Internet Archive, but lets a client use its own identifier scheme when it
 * names it with a `k` tag — so those are emitted as `["i", "<scheme>:<id>"]`
 * plus one `["k", "<scheme>"]` per scheme used. Order is fixed: isbn, url,
 * imdb, wikidata, musicbrainz, archive.
 */
export function nip73Tags(body: ShareEnvelopeBody): string[][] {
  const tags: string[][] = [];
  const { ids } = body;
  if (ids.isbn) tags.push(["i", `isbn:${ids.isbn}`]);
  if (ids.url) tags.push(["i", ids.url]);
  for (const scheme of ["imdb", "wikidata", "musicbrainz", "archive"] as const) {
    const id = ids[scheme];
    if (id) tags.push(["i", `${scheme}:${id}`], ["k", scheme]);
  }
  return tags;
}
