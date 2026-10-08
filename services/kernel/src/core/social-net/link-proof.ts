/**
 * Persona↔instance link-proof.
 *
 * The instance key and the Social persona key are kept apart on purpose:
 * publicly, nobody can tell which persona runs on which Kernl. Friends are the
 * exception — a trusted friend may learn it, so a persona post from a friend
 * reads as coming from that friend. This proof is how they learn it: both keys
 * sign the same statement, so neither side can claim the other on its own.
 *
 * It is handed over the authenticated peering lane only, never published, and
 * travels sealed: NIP-44 v2 from our instance key to the asking friend's
 * instance key (sealLinkProof / openLinkProof). Whoever sits on the path — a
 * relaying friend, a proxy, a TLS-less LAN hop — sees only ciphertext.
 *
 * Proofs carry created_at but do not expire: the binding holds until the
 * owner withdraws the persona (the route then answers 404 and friends forget
 * it) or the friendship is revoked.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import type { NostrIdentity } from "../nostr/nostr-identity.js";

export interface LinkProof {
  v: 1;
  /** Instance pubkey, x-only hex. */
  instance: string;
  /** Persona pubkey, x-only hex. */
  persona: string;
  /** Unix seconds. */
  created_at: number;
  instance_sig: string;
  persona_sig: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function digest(instance: string, persona: string, createdAt: number): Uint8Array {
  return sha256(new TextEncoder().encode(`kernl-link-v1|${instance}|${persona}|${createdAt}`));
}

export function buildLinkProof(
  instance: NostrIdentity,
  persona: NostrIdentity,
  now: number = Math.floor(Date.now() / 1000),
): LinkProof {
  const created_at = Math.floor(now);
  const msg = digest(instance.pubkeyHex, persona.pubkeyHex, created_at);
  return {
    v: 1,
    instance: instance.pubkeyHex,
    persona: persona.pubkeyHex,
    created_at,
    instance_sig: bytesToHex(schnorr.sign(msg, instance.secretKey)),
    persona_sig: bytesToHex(schnorr.sign(msg, persona.secretKey)),
  };
}

export function verifyLinkProof(
  p: unknown,
  expectedInstanceHex?: string,
): { ok: true; proof: LinkProof } | { ok: false; error: string } {
  if (!p || typeof p !== "object") return { ok: false, error: "not an object" };
  const c = p as Record<string, unknown>;
  if (c.v !== 1) return { ok: false, error: "unsupported version" };
  const { instance, persona, created_at, instance_sig, persona_sig } = c;
  if (typeof instance !== "string" || !HEX64.test(instance)) return { ok: false, error: "bad instance key" };
  if (typeof persona !== "string" || !HEX64.test(persona)) return { ok: false, error: "bad persona key" };
  if (instance === persona) return { ok: false, error: "instance and persona are the same key" };
  if (typeof created_at !== "number" || !Number.isSafeInteger(created_at) || created_at < 0) {
    return { ok: false, error: "bad created_at" };
  }
  if (typeof instance_sig !== "string" || !HEX128.test(instance_sig)) return { ok: false, error: "bad instance signature" };
  if (typeof persona_sig !== "string" || !HEX128.test(persona_sig)) return { ok: false, error: "bad persona signature" };
  if (expectedInstanceHex !== undefined && instance !== expectedInstanceHex.toLowerCase()) {
    return { ok: false, error: "instance is not the expected one" };
  }

  const msg = digest(instance, persona, created_at);
  try {
    if (!schnorr.verify(hexToBytes(instance_sig), msg, hexToBytes(instance))) {
      return { ok: false, error: "instance signature does not verify" };
    }
    if (!schnorr.verify(hexToBytes(persona_sig), msg, hexToBytes(persona))) {
      return { ok: false, error: "persona signature does not verify" };
    }
  } catch {
    return { ok: false, error: "signature check failed" };
  }
  return { ok: true, proof: { v: 1, instance, persona, created_at, instance_sig, persona_sig } };
}

/** What GET /api/peering/persona answers: the proof, NIP-44 v2 sealed for the caller. */
export interface SealedLinkProof {
  v: 1;
  nip44: string;
}

/** Seal `proof` from our instance secret key to the friend's instance pubkey (hex). */
export function sealLinkProof(proof: LinkProof, ourSecretKey: Uint8Array, friendPubkeyHex: string): SealedLinkProof {
  const key = getConversationKey(ourSecretKey, friendPubkeyHex.toLowerCase());
  return { v: 1, nip44: nip44Encrypt(JSON.stringify(proof), key) };
}

/**
 * Open a sealed proof sent by `friendPubkeyHex` to us. Returns the decoded
 * (still unverified) proof object, or null when it is not a sealed v1 payload
 * or does not decrypt — run verifyLinkProof on the result. Never throws.
 */
export function openLinkProof(sealed: unknown, ourSecretKey: Uint8Array, friendPubkeyHex: string): unknown {
  if (!sealed || typeof sealed !== "object") return null;
  const c = sealed as Record<string, unknown>;
  if (c.v !== 1 || typeof c.nip44 !== "string") return null;
  try {
    const key = getConversationKey(ourSecretKey, friendPubkeyHex.toLowerCase());
    return JSON.parse(nip44Decrypt(c.nip44, key)) as unknown;
  } catch {
    return null;
  }
}
