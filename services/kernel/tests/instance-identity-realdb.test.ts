/**
 * Acceptance check against a COPY of a real kernel.db (never the live file,
 * never versioned). Skipped unless KERNL_REALDB_COPY points at the copy;
 * KERNL_REALDB_KEY carries the KERNEL_ENCRYPTION_KEY that sealed its seeds.
 *
 *   KERNL_REALDB_COPY=/tmp/x/kernel-copy.db KERNL_REALDB_KEY=... \
 *     bun test tests/instance-identity-realdb.test.ts
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { decrypt } from "../src/core/crypto.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import {
  instanceKeyIsShared,
  loadOrCreateCoreNostrIdentity,
} from "../src/core/nostr/identity-store.js";

const COPY = process.env.KERNL_REALDB_COPY ?? "";
const KEY = process.env.KERNL_REALDB_KEY ?? "";
const PLAINTEXT_SEED_RE = /^[0-9a-f]{64}$/i;

function seedOf(stored: string): string {
  return PLAINTEXT_SEED_RE.test(stored) ? stored : decrypt(stored, KEY);
}

describe("instance identity on a real DB copy", () => {
  it.skipIf(!COPY || !existsSync(COPY))(
    "loads the kernel_nostr_seed identity, not the Social persona",
    () => {
      const db = new Database(COPY, { readonly: true });
      try {
        const kernelRow = db
          .prepare("SELECT seed_hex FROM kernel_nostr_seed WHERE id = 'default'")
          .get() as { seed_hex: string } | undefined;
        expect(kernelRow?.seed_hex).toBeTruthy();
        const expected = NostrIdentity.fromEd25519Seed(
          Buffer.from(seedOf(kernelRow!.seed_hex), "hex"),
        );

        const id = loadOrCreateCoreNostrIdentity(db, KEY);
        expect(id).not.toBeNull();
        expect(id!.npub()).toBe(expected.npub());

        const social = db
          .prepare("SELECT pubkey FROM social_identity WHERE id = 'default'")
          .get() as { pubkey: string } | undefined;
        if (social?.pubkey) {
          // social_identity.pubkey may be stored as hex or npub; compare both forms.
          expect(id!.npub()).not.toBe(social.pubkey);
          expect(id!.pubkeyHex).not.toBe(social.pubkey);
        }
        expect(instanceKeyIsShared(db, KEY)).toBe(false);
      } finally {
        db.close();
      }
    },
  );
});
