import { describe, it, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { signBundleDigest, verifyBundleSignature } from "../src/modules/extensions/bundle-signature.js";

// A .kernl bundle is authenticated by an RS256 signature over its
// integrity digest (the hex SHA-256 of its content). The vendor signs with the
// license private key; any kernel verifies with the embedded public key. These
// tests exercise the sign/verify round-trip with an ephemeral keypair.

function keypair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const DIGEST = "a".repeat(64); // stand-in hex sha256

describe("bundle signature (RS256)", () => {
  it("verifies a signature produced by the matching private key", async () => {
    const { publicKey, privateKey } = keypair();
    const sig = await signBundleDigest(DIGEST, privateKey);
    expect(typeof sig).toBe("string");
    expect(await verifyBundleSignature(DIGEST, sig, publicKey)).toBe(true);
  });

  it("rejects when the digest was tampered", async () => {
    const { publicKey, privateKey } = keypair();
    const sig = await signBundleDigest(DIGEST, privateKey);
    expect(await verifyBundleSignature("b".repeat(64), sig, publicKey)).toBe(false);
  });

  it("rejects when the signature was tampered", async () => {
    const { publicKey, privateKey } = keypair();
    const sig = await signBundleDigest(DIGEST, privateKey);
    const bytes = Buffer.from(sig, "base64");
    bytes[0] ^= 0xff;
    expect(await verifyBundleSignature(DIGEST, bytes.toString("base64"), publicKey)).toBe(false);
  });

  it("rejects a signature from a different key (piracy/tamper)", async () => {
    const { privateKey } = keypair();
    const { publicKey: otherPub } = keypair();
    const sig = await signBundleDigest(DIGEST, privateKey);
    expect(await verifyBundleSignature(DIGEST, sig, otherPub)).toBe(false);
  });

  it("returns false (never throws) on a malformed signature", async () => {
    const { publicKey } = keypair();
    expect(await verifyBundleSignature(DIGEST, "not-base64-!!!", publicKey)).toBe(false);
  });
});
