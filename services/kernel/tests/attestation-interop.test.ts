import { describe, expect, test } from "bun:test";
import {
  Identity,
  hashJson,
  signReceipt,
  verifyReceipt,
  type Receipt,
} from "../src/core/attestation.js";

/**
 * Cross-language interop tests.
 *
 * The fixture below was produced by the Rust `mtw-attest` crate via:
 *   `cargo run -p mtw-attest --example emit_fixture`
 *
 * If either side's canonical JSON or hashing changes, this test breaks
 * — that's the whole point. Re-generate ONLY when both sides have been
 * intentionally updated and you've verified the new bytes match.
 *
 * The seed is deterministic (`[42u8; 32]`), so re-running the Rust
 * fixture should produce byte-identical output.
 */
const RUST_FIXTURE: Receipt = {
  v: 1,
  tool: "kernel_interop",
  input_hash:
    "sha256:b6c619be8871ccf336e1bdffd76745a93c76ea00931ad8831c2aefc54e9a4f82",
  output_hash:
    "sha256:b113f91c50124134b6e81e75587588a5acb115d9eaff50cd5fb9f8b5fb1c1b6a",
  side_effects: ["log.appended:1", "metric.recorded:1"],
  ts_ms: 1_715_025_600_000,
  server_id:
    "ed25519:197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61",
  sig: "liLm3L8PKGQycBUG+hL0Af1uR0XiLixUL6WJk4xu9Z210QSa0b3nue990MKA73tm6hK8SSD4Bapdq68I3AZBCw==",
};

const DETERMINISTIC_SEED = new Uint8Array(32).fill(42);

describe("interop with mtw-attest (Rust)", () => {
  test("the Rust fixture's identity matches when re-derived in TS", () => {
    const id = Identity.fromSecretBytes(DETERMINISTIC_SEED);
    expect(id.serverId()).toBe(RUST_FIXTURE.server_id);
  });

  test("a Rust-signed receipt verifies in TS", () => {
    const result = verifyReceipt(RUST_FIXTURE);
    expect(result.valid).toBe(true);
  });

  test("hashJson on the Rust fixture inputs matches the embedded hashes", () => {
    // Same JSON shapes the Rust example feeds to hash_json — proves both
    // sides produce identical canonical bytes for the same logical value.
    expect(hashJson({ q: "hi", n: 7 })).toBe(RUST_FIXTURE.input_hash);
    expect(hashJson({ answer: 42, items: [1, 2, 3] })).toBe(RUST_FIXTURE.output_hash);
  });

  test("a TS-signed receipt with the same seed has the same server_id", () => {
    const id = Identity.fromSecretBytes(DETERMINISTIC_SEED);
    const r = signReceipt({
      identity: id,
      tool: "kernel_interop",
      inputHash: hashJson({ q: "hi", n: 7 }),
      outputHash: hashJson({ answer: 42, items: [1, 2, 3] }),
      sideEffects: ["log.appended:1", "metric.recorded:1"],
      tsMs: 1_715_025_600_000,
    });
    expect(r.server_id).toBe(RUST_FIXTURE.server_id);
    expect(r.input_hash).toBe(RUST_FIXTURE.input_hash);
    expect(r.output_hash).toBe(RUST_FIXTURE.output_hash);
    // Note: signatures are not deterministic in Ed25519 by default
    // (RFC 8032 leaves the nonce derivation flexible). What matters is
    // that BOTH signatures verify against the same public key — checked
    // in the next test.
    expect(verifyReceipt(r).valid).toBe(true);
  });

  test("tampering a Rust-signed receipt invalidates it in TS", () => {
    const tampered: Receipt = { ...RUST_FIXTURE, side_effects: ["evil:1"] };
    expect(verifyReceipt(tampered).valid).toBe(false);
  });
});
