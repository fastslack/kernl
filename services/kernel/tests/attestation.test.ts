import { describe, expect, test } from "bun:test";
import {
  Identity,
  hashJson,
  signReceipt,
  verifyReceipt,
} from "../src/core/attestation.js";
import { canonicalize, canonicalString } from "../src/core/canonical-json.js";

describe("canonical JSON", () => {
  test("primitives", () => {
    expect(canonicalString(null)).toBe("null");
    expect(canonicalString(true)).toBe("true");
    expect(canonicalString(false)).toBe("false");
    expect(canonicalString(42)).toBe("42");
    expect(canonicalString("hello")).toBe('"hello"');
  });

  test("object keys are sorted lexicographically", () => {
    expect(canonicalString({ z: 1, b: 2, a: 3 })).toBe('{"a":3,"b":2,"z":1}');
  });

  test("nested objects sort recursively", () => {
    expect(canonicalString({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  test("arrays preserve order", () => {
    expect(canonicalString([3, 1, 2])).toBe("[3,1,2]");
  });

  test("strings are escaped", () => {
    expect(canonicalString('a"b')).toBe('"a\\"b"');
    expect(canonicalString("line\nbreak")).toBe('"line\\nbreak"');
    expect(canonicalString("tab\there")).toBe('"tab\\there"');
  });

  test("empty containers", () => {
    expect(canonicalString({})).toBe("{}");
    expect(canonicalString([])).toBe("[]");
  });

  test("unicode passthrough as UTF-8", () => {
    const bytes = canonicalize("héllo 🌎");
    const expected = new TextEncoder().encode('"héllo 🌎"');
    expect(bytes).toEqual(expected);
  });
});

describe("hashJson", () => {
  test("is order-independent over keys", () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });

  test("matches the documented sha256 prefix format", () => {
    const h = hashJson({ x: 1 });
    expect(h.startsWith("sha256:")).toBe(true);
    expect(h.length).toBe("sha256:".length + 64); // hex(32) = 64 chars
  });
});

describe("Identity", () => {
  test("server_id round-trips through deterministic secret", () => {
    const id1 = Identity.fromSecretBytes(new Uint8Array(32).fill(7));
    const id2 = Identity.fromSecretBytes(new Uint8Array(32).fill(7));
    expect(id1.serverId()).toBe(id2.serverId());
    expect(id1.serverId().startsWith("ed25519:")).toBe(true);
  });

  test("generated identities have distinct fingerprints", () => {
    const a = Identity.generate();
    const b = Identity.generate();
    expect(a.serverId()).not.toBe(b.serverId());
  });
});

describe("signReceipt / verifyReceipt", () => {
  test("round-trip: sign then verify is valid", () => {
    const id = Identity.generate();
    const r = signReceipt({
      identity: id,
      tool: "kernel_demo",
      inputHash: hashJson({ q: "hi" }),
      outputHash: hashJson({ answer: 42 }),
      sideEffects: ["log.appended:1"],
      tsMs: 1715025600000,
    });
    expect(verifyReceipt(r).valid).toBe(true);
  });

  test("tampered output_hash fails", () => {
    const id = Identity.generate();
    const r = signReceipt({
      identity: id,
      tool: "kernel_demo",
      inputHash: hashJson({}),
      outputHash: hashJson({ a: 1 }),
    });
    const tampered = { ...r, output_hash: hashJson({ a: 2 }) };
    const result = verifyReceipt(tampered);
    expect(result.valid).toBe(false);
  });

  test("tampered side_effects fails", () => {
    const id = Identity.generate();
    const r = signReceipt({
      identity: id,
      tool: "kernel_demo",
      inputHash: hashJson({}),
      outputHash: hashJson({}),
      sideEffects: ["safe.action:1"],
    });
    const tampered = { ...r, side_effects: ["scary.action:9000"] };
    expect(verifyReceipt(tampered).valid).toBe(false);
  });

  test("unknown receipt version is rejected", () => {
    const id = Identity.generate();
    const r = signReceipt({
      identity: id,
      tool: "x",
      inputHash: "sha256:00",
      outputHash: "sha256:00",
    });
    const wrong = { ...r, v: 99 };
    const result = verifyReceipt(wrong);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("unsupported");
  });

  test("swapping server_id to another identity invalidates", () => {
    const alice = Identity.generate();
    const mallory = Identity.generate();
    const r = signReceipt({
      identity: alice,
      tool: "x",
      inputHash: "sha256:00",
      outputHash: "sha256:00",
    });
    const tampered = { ...r, server_id: mallory.serverId() };
    expect(verifyReceipt(tampered).valid).toBe(false);
  });
});
