/**
 * Nostr identity (secp256k1 / BIP-340 Schnorr).
 *
 * Derived deterministically from the existing ed25519 social seed so the
 * user has a single 32-byte secret to back up. The derivation:
 *
 *   secret_k1 = HMAC-SHA256("mtw/nostr-derive/v1", ed25519_seed)
 *
 * If by astronomical chance the output is >= the curve order, we re-hash
 * with a counter byte appended ("/v1/2", "/v1/3", …). In practice the
 * first try always succeeds.
 *
 * This deliberately uses a TAGGED hash (the "v1" version label) so we can
 * change the derivation later without colliding with old keys.
 */

import { createHmac } from "node:crypto";
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { npubEncode, nsecEncode, decode as nip19Decode } from "nostr-tools/nip19";
import type { Event as NostrEvent, EventTemplate, UnsignedEvent } from "nostr-tools/core";

// secp256k1 curve order (n). A valid private key is in the range [1, n-1].
const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

const DERIVE_TAG = "mtw/nostr-derive/v1";

export class NostrIdentity {
  private constructor(
    public readonly secretKey: Uint8Array, // 32 bytes
    public readonly pubkeyHex: string,     // 32-byte x-only pubkey, hex
  ) {}

  /**
   * Derive a Nostr identity from a 32-byte ed25519 seed. The same input
   * always produces the same output — backing up the social seed is enough
   * to recover both identities.
   */
  static fromEd25519Seed(seed: Uint8Array): NostrIdentity {
    if (seed.length !== 32) {
      throw new Error(`seed must be 32 bytes, got ${seed.length}`);
    }
    let counter = 1;
    while (true) {
      const tag = counter === 1 ? DERIVE_TAG : `${DERIVE_TAG}/${counter}`;
      const candidate = createHmac("sha256", tag).update(seed).digest();
      const n = BigInt("0x" + candidate.toString("hex"));
      if (n > 0n && n < SECP256K1_N) {
        const secret = new Uint8Array(candidate);
        const pubHex = getPublicKey(secret); // 32-byte x-only hex
        return new NostrIdentity(secret, pubHex);
      }
      counter++;
      if (counter > 16) {
        // Cosmically improbable: 2^-128 per try.
        throw new Error("nostr key derivation diverged");
      }
    }
  }

  /** Bech32 npub encoding of the public key. */
  npub(): string {
    return npubEncode(this.pubkeyHex);
  }

  /** Bech32 nsec encoding — treat as a credential. */
  nsec(): string {
    return nsecEncode(this.secretKey);
  }

  /**
   * Sign an event template (kind, tags, content, created_at). Fills id, pubkey
   * and sig and returns a fully signed Nostr event ready to broadcast.
   */
  signEvent(template: EventTemplate): NostrEvent {
    return finalizeEvent(template, this.secretKey);
  }

  /** Hash-only helper, useful for tests. */
  eventHash(unsigned: UnsignedEvent): string {
    return getEventHash(unsigned);
  }

  /** Verify a Nostr event signature. */
  static verify(event: NostrEvent): boolean {
    try {
      return verifyEvent(event);
    } catch {
      return false;
    }
  }

  /** Decode npub1… / nsec1… to hex; rejects other bech32 prefixes. */
  static decodeBech32(s: string): { kind: "npub" | "nsec"; hex: string } | null {
    try {
      const d = nip19Decode(s);
      if (d.type === "npub" && typeof d.data === "string") {
        return { kind: "npub", hex: d.data };
      }
      if (d.type === "nsec" && d.data instanceof Uint8Array) {
        return { kind: "nsec", hex: Buffer.from(d.data).toString("hex") };
      }
    } catch {
      return null;
    }
    return null;
  }
}
