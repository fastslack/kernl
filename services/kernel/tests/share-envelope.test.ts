import { describe, it, expect } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  ENVELOPE_VERSION,
  canonicalJson,
  nip73Tags,
  readEnvelope,
  signEnvelope,
  validateEnvelopeBody,
  verifyEnvelope,
  type ShareEnvelopeBody,
  type ShareKind,
} from "../src/sdk/social.js";

const NOW = Math.floor(Date.now() / 1000);
const SECRET = new Uint8Array(32).fill(7);

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, kind: "movie", title: "Nosferatu", ids: { archive: "nosferatu" }, created_at: NOW, ...over };
}

function validBody(over: Record<string, unknown> = {}): ShareEnvelopeBody {
  const r = validateEnvelopeBody(body(over));
  if (!r.ok) throw new Error(r.error);
  return r.body;
}

describe("validateEnvelopeBody", () => {
  it("exports version 1", () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });

  const minimal: Record<ShareKind, Record<string, unknown>> = {
    movie: { ids: { imdb: "tt0013442" } },
    show: { ids: { wikidata: "Q23572" } },
    music: { ids: { musicbrainz: "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d" } },
    book: { ids: { isbn: "9780141439518" } },
    link: { ids: { url: "https://example.org/post" } },
    note: { ids: { url: "https://example.org/n/1" } },
  };
  for (const [kind, over] of Object.entries(minimal)) {
    it(`accepts a minimal ${kind}`, () => {
      const r = validateEnvelopeBody(body({ kind, ...over }));
      expect(r.ok).toBe(true);
    });
  }

  it("accepts every optional field within range", () => {
    const r = validateEnvelopeBody(body({
      year: 1922, creator: "F. W. Murnau", cover: "https://example.org/c.jpg",
      note: "Mirala de noche", rating: 5,
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects an extra top-level key", () => {
    expect(validateEnvelopeBody(body({ extra: "x" })).ok).toBe(false);
  });

  it("rejects an extra key inside ids", () => {
    expect(validateEnvelopeBody(body({ ids: { archive: "a", tmdb: "1" } })).ok).toBe(false);
  });

  it("rejects empty ids", () => {
    const r = validateEnvelopeBody(body({ ids: {} }));
    expect(r.ok).toBe(false);
  });

  it("rejects an http cover and an http ids.url", () => {
    expect(validateEnvelopeBody(body({ cover: "http://example.org/c.jpg" })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ ids: { url: "http://example.org" } })).ok).toBe(false);
  });

  it("rejects out-of-range fields", () => {
    expect(validateEnvelopeBody(body({ title: "" })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ title: "x".repeat(301) })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ year: 1700 })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ rating: 6 })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ rating: 3.5 })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ note: "x".repeat(2001) })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ v: 2 })).ok).toBe(false);
  });

  it("rejects created_at that is not plausible unix seconds", () => {
    expect(validateEnvelopeBody(body({ created_at: 1_500_000_000 })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ created_at: NOW + 2 * 86_400 })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ created_at: NOW * 1000 })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ created_at: NOW + 0.5 })).ok).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("is stable regardless of key order and has no whitespace", () => {
    const a = validBody({ ids: { imdb: "tt1", archive: "a" }, note: "hola" });
    const b = validateEnvelopeBody({
      note: "hola", created_at: NOW, ids: { archive: "a", imdb: "tt1" }, title: "Nosferatu", kind: "movie", v: 1,
    });
    if (!b.ok) throw new Error(b.error);
    expect(canonicalJson(a)).toBe(canonicalJson(b.body));
    expect(canonicalJson(a)).toBe(
      `{"created_at":${NOW},"ids":{"archive":"a","imdb":"tt1"},"kind":"movie","note":"hola","title":"Nosferatu","v":1}`,
    );
  });
});

describe("signEnvelope / verifyEnvelope", () => {
  it("signs and verifies, pubkey is the x-only key of the signer", () => {
    const env = signEnvelope(validBody({ note: "buenísima" }), SECRET);
    expect(env.pubkey).toBe(Buffer.from(schnorr.getPublicKey(SECRET)).toString("hex"));
    expect(env.sig).toMatch(/^[0-9a-f]{128}$/);
    const r = verifyEnvelope(env);
    expect(r.ok).toBe(true);
  });

  it("survives a JSON round trip with reordered keys", () => {
    const env = signEnvelope(validBody(), SECRET);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(env).reverse())));
    expect(verifyEnvelope(reordered).ok).toBe(true);
  });

  it("fails when note is altered after signing", () => {
    const env = signEnvelope(validBody({ note: "original" }), SECRET);
    const r = verifyEnvelope({ ...env, note: "alterada" });
    expect(r.ok).toBe(false);
  });

  it("fails when a key is added after signing", () => {
    const env = signEnvelope(validBody(), SECRET);
    expect(verifyEnvelope({ ...env, extra: 1 }).ok).toBe(false);
  });

  it("fails on garbage", () => {
    expect(verifyEnvelope(null).ok).toBe(false);
    expect(verifyEnvelope({ ...body(), pubkey: "zz", sig: "zz" }).ok).toBe(false);
  });
});

describe("readEnvelope", () => {
  it("reads a signed v1 envelope as typed", () => {
    const env = signEnvelope(validBody(), SECRET);
    const r = readEnvelope(env);
    expect(r.kind).toBe("typed");
  });

  it("degrades v:2 to generic with sanitized ids and cover", () => {
    const r = readEnvelope({
      v: 2, kind: "movie", title: "Futuro", ids: { imdb: "tt9", tmdb: "5", url: "http://bad" },
      cover: "http://insecure/c.jpg", newField: true,
    });
    expect(r).toEqual({ kind: "generic", title: "Futuro", ids: { imdb: "tt9" } });
  });

  it("degrades an unknown kind to generic and keeps an https cover", () => {
    const r = readEnvelope({ v: 1, kind: "podcast", title: "Ep 1", ids: { url: "https://pod.example/1" }, cover: "https://pod.example/c.jpg" });
    expect(r).toEqual({ kind: "generic", title: "Ep 1", ids: { url: "https://pod.example/1" }, cover: "https://pod.example/c.jpg" });
  });

  it("is invalid when the signature does not verify", () => {
    const env = signEnvelope(validBody({ note: "a" }), SECRET);
    expect(readEnvelope({ ...env, note: "b" }).kind).toBe("invalid");
  });

  it("is invalid on garbage", () => {
    expect(readEnvelope("hola").kind).toBe("invalid");
    expect(readEnvelope(null).kind).toBe("invalid");
    expect(readEnvelope({ v: 3, kind: "x" }).kind).toBe("invalid");
    expect(readEnvelope([1, 2]).kind).toBe("invalid");
  });
});

describe("nip73Tags", () => {
  it("emits isbn for a book", () => {
    const tags = nip73Tags(validBody({ kind: "book", ids: { isbn: "9780141439518" } }));
    expect(tags).toEqual([["i", "isbn:9780141439518"]]);
  });

  it("emits the raw https url for a link", () => {
    const tags = nip73Tags(validBody({ kind: "link", ids: { url: "https://example.org/post" } }));
    expect(tags).toEqual([["i", "https://example.org/post"]]);
  });

  it("emits scheme-prefixed ids with one k tag per scheme", () => {
    const tags = nip73Tags(validBody({ ids: { imdb: "tt0013442", wikidata: "Q151895", archive: "nosferatu" } }));
    expect(tags).toEqual([
      ["i", "imdb:tt0013442"], ["k", "imdb"],
      ["i", "wikidata:Q151895"], ["k", "wikidata"],
      ["i", "archive:nosferatu"], ["k", "archive"],
    ]);
  });
});

describe("hardening (F6)", () => {
  const BAD = ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u009f", "‪", "‮", "⁦", "⁩"];

  it("signs the domain-separated digest sha256('kernl-share-v1|' + canonicalJson)", async () => {
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const b = validBody({ note: "hola" });
    const env = signEnvelope(b, SECRET);
    const enc = new TextEncoder();
    const sig = Buffer.from(env.sig, "hex");
    const pub = Buffer.from(env.pubkey, "hex");
    expect(schnorr.verify(sig, sha256(enc.encode("kernl-share-v1|" + canonicalJson(b))), pub)).toBe(true);
    // The undomained digest (the pre-hardening format) no longer verifies.
    expect(schnorr.verify(sig, sha256(enc.encode(canonicalJson(b))), pub)).toBe(false);
  });

  it("rejects an envelope signed over the undomained digest", async () => {
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const b = validBody();
    const sig = Buffer.from(schnorr.sign(sha256(new TextEncoder().encode(canonicalJson(b))), SECRET)).toString("hex");
    const pubkey = Buffer.from(schnorr.getPublicKey(SECRET)).toString("hex");
    expect(verifyEnvelope({ ...b, pubkey, sig }).ok).toBe(false);
  });

  for (const ch of BAD) {
    const code = `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    it(`rejects ${code} in title, creator, note and every id`, () => {
      expect(validateEnvelopeBody(body({ title: `Nos${ch}feratu` })).ok).toBe(false);
      expect(validateEnvelopeBody(body({ creator: `Mur${ch}nau` })).ok).toBe(false);
      expect(validateEnvelopeBody(body({ note: `ho${ch}la` })).ok).toBe(false);
      for (const key of ["archive", "wikidata", "imdb", "isbn", "musicbrainz"]) {
        expect(validateEnvelopeBody(body({ ids: { [key]: `a${ch}b` } })).ok).toBe(false);
      }
      expect(validateEnvelopeBody(body({ ids: { url: `https://example.org/${ch}x` } })).ok).toBe(false);
      expect(validateEnvelopeBody(body({ cover: `https://example.org/${ch}c.jpg` })).ok).toBe(false);
    });
  }

  it("allows newline and tab in note only", () => {
    expect(validateEnvelopeBody(body({ note: "línea 1\nlínea 2\tfin" })).ok).toBe(true);
    expect(validateEnvelopeBody(body({ title: "a\nb" })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ creator: "a\tb" })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ ids: { imdb: "tt\n1" } })).ok).toBe(false);
    expect(validateEnvelopeBody(body({ note: "a\rb" })).ok).toBe(false);
  });

  it("generic reads drop ids and titles carrying bidi overrides", () => {
    expect(readEnvelope({ v: 2, kind: "movie", title: "a‮b", ids: { imdb: "tt1" } }).kind).toBe("invalid");
    const r = readEnvelope({ v: 2, kind: "movie", title: "ok", ids: { imdb: "tt⁦1", wikidata: "Q1" } });
    expect(r).toEqual({ kind: "generic", title: "ok", ids: { wikidata: "Q1" } });
  });
});
