/**
 * Bundle authenticity — RS256 signatures for signed `.kernl` packages.
 *
 * The `.kernlext`/`.kernl` container already carries an INTEGRITY digest
 * (`manifest.integrity.sha256`, the SHA-256 over its content — tamper
 * detection). Paid bundles add AUTHENTICITY: an RS256 signature over that
 * digest, produced by the vendor's license private key and verifiable with the
 * public key embedded in the kernel (`LICENSE_PUBLIC_KEY`). A tampered file
 * fails the integrity check; a re-signed/pirated bundle fails signature
 * verification because the private key never leaves the issuer.
 *
 * Reuses the platform Web Crypto API (Bun + Node 20+) exactly like
 * `core/license/verify.ts` — zero crypto dependencies.
 */

import { LICENSE_PUBLIC_KEY } from "../../core/license/public-key.js";

const ALGO = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

// ArrayBuffer-backed on purpose — see the note in core/license/verify.ts.
function pemToDer(pem: string, label: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/**
 * Sign a bundle's integrity digest (hex sha256) with the vendor's RSA private
 * key (PKCS#8 PEM). Returns a base64 signature to store in `manifest.signature`.
 * Vendor-side only — the private key lives at the issuer, never in a kernel.
 */
export async function signBundleDigest(digestHex: string, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem, "PRIVATE KEY"),
    ALGO,
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(ALGO, key, new TextEncoder().encode(digestHex));
  return Buffer.from(sig).toString("base64");
}

/**
 * Verify a base64 RS256 signature over a bundle's integrity digest against the
 * embedded license public key (override `publicKeyPem` for tests). Never throws
 * — returns false on any malformed input or verification failure.
 */
export async function verifyBundleSignature(
  digestHex: string,
  signatureB64: string,
  publicKeyPem: string = LICENSE_PUBLIC_KEY,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pemToDer(publicKeyPem, "PUBLIC KEY"),
      ALGO,
      false,
      ["verify"],
    );
    const sig = Uint8Array.from(Buffer.from(signatureB64, "base64"));
    return await crypto.subtle.verify(ALGO, key, sig, new TextEncoder().encode(digestHex));
  } catch {
    return false;
  }
}
