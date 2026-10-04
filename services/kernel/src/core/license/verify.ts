/**
 * JWT RS256 verification. Uses the platform Web Crypto API (Bun + Node 20+
 * both expose it via `globalThis.crypto.subtle`) so we ship zero crypto deps.
 *
 * Flow:
 *   1. Split <header>.<payload>.<signature> (3 parts, base64url).
 *   2. Verify header.alg === "RS256" and typ === "JWT".
 *   3. Import the embedded public key via SubtleCrypto.
 *   4. Verify signature over the canonical "<header>.<payload>" bytes.
 *   5. Parse payload, validate exp/iat/iss claims.
 *
 * Anything that goes wrong throws `LicenseError(kind, message)`. The kind
 * matches a `LicenseStatus`, so the service can map error → status without a
 * second branch.
 */

import { LicenseError, type LicenseClaim } from "./types.js";
import { LICENSE_PUBLIC_KEY } from "./public-key.js";

/**
 * The issuer a license must be signed by, as its `iss` claim.
 *
 * Default: the issuer Worker we actually mint from. Overriding it is for
 * staging only — a wrong default silently rejects every real customer key,
 * and the override is set in exactly one place (docker-compose.yml), so the
 * native installers depend entirely on this default being right.
 *
 * Read per call rather than captured at import: the license service is built
 * during bootstrap, after `.env` has been loaded.
 */
export function expectedIssuer(): string {
  return process.env.KERNEL_LICENSE_ISSUER ?? "issuer.lifekernl.com";
}

/**
 * Turn whatever the user pasted into the JWT it contains.
 *
 * A license copied out of an email or a chat is rarely the bare token: mail
 * clients wrap the long line and put zero-width spaces or soft hyphens where
 * they break it, and people copy it with quotes, a "Bearer " prefix or the
 * sentence around it. None of that is ever part of a JWT (base64url + dots),
 * so it is all dropped before verification instead of reaching atob() and
 * failing with "The string contains invalid characters".
 */
export function normalizeLicenseInput(raw: string): string {
  const compact = raw
    .replace(/[\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g, "")
    .replace(/^\s*bearer\s+/i, "");
  // Every license header is base64url JSON, so the token starts with "eyJ".
  const at = compact.indexOf("eyJ");
  if (at < 0) return raw.trim();
  // From there, token characters with any whitespace between them: mail
  // clients turn the box's line wraps into newlines OR spaces. A blank line or
  // any other character ends it.
  const run = /^[A-Za-z0-9_\-.]+(?:[ \t]*\r?\n?[ \t]*[A-Za-z0-9_\-.]+)*/.exec(compact.slice(at))?.[0] ?? "";
  const parts = run.replace(/\s+/g, "").split(".");
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return raw.trim();
  // The signature is the last segment and nothing marks where it ends, so text
  // copied after it ("Unlocks …") would be glued on. An RS256 signature under
  // our 2048-bit key is always exactly RS256_SIG_CHARS long: cut it there.
  let sig = parts[2];
  if (sig.length > RS256_SIG_CHARS) sig = sig.slice(0, RS256_SIG_CHARS);
  return `${parts[0]}.${parts[1]}.${sig}`;
}

/** base64url length of a 256-byte (2048-bit RSA) signature, unpadded. */
const RS256_SIG_CHARS = 342;

/**
 * Parse and cryptographically verify a license JWT.
 *
 * @throws LicenseError on any failure (signature, expiry, claim shape).
 */
export async function verifyLicenseJwt(jwt: string): Promise<LicenseClaim> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new LicenseError("invalid", "License JWT malformed: expected 3 segments");
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // ── 1. Header ───────────────────────────────────────────────
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlToUtf8(headerB64));
  } catch {
    throw new LicenseError("invalid", "License JWT header is not valid JSON");
  }
  if (header.alg !== "RS256") {
    throw new LicenseError("invalid", `Unsupported alg ${header.alg}; expected RS256`);
  }
  // typ is informational; some issuers omit it. We accept either "JWT" or unset.
  if (header.typ != null && header.typ !== "JWT") {
    throw new LicenseError("invalid", `Unsupported typ ${header.typ}; expected JWT`);
  }

  // ── 2. Signature ────────────────────────────────────────────
  const publicKey = await importPublicKey(LICENSE_PUBLIC_KEY);
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBytes(signatureB64);

  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    publicKey,
    signature,
    signed,
  );
  if (!ok) {
    throw new LicenseError("invalid", "License signature did not verify");
  }

  // ── 3. Payload ──────────────────────────────────────────────
  let claim: Partial<LicenseClaim>;
  try {
    claim = JSON.parse(b64urlToUtf8(payloadB64));
  } catch {
    throw new LicenseError("invalid", "License payload is not valid JSON");
  }

  // Shape check — be defensive; users can paste anything.
  if (typeof claim.iss !== "string"
      || typeof claim.sub !== "string"
      || typeof claim.email !== "string"
      || typeof claim.sku !== "string"
      || !Array.isArray(claim.features)
      || typeof claim.iat !== "number"
      || typeof claim.exp !== "number") {
    throw new LicenseError("invalid", "License payload is missing required fields");
  }
  if (!["pro", "cloud", "both"].includes(claim.sku)) {
    throw new LicenseError("invalid", `Unknown SKU "${claim.sku}"`);
  }
  const issuer = expectedIssuer();
  if (claim.iss !== issuer) {
    throw new LicenseError(
      "invalid",
      `Wrong issuer "${claim.iss}"; expected "${issuer}"`,
    );
  }
  if (!claim.features.every((f) => typeof f === "string")) {
    throw new LicenseError("invalid", "License features must all be strings");
  }

  // ── 4. Expiry ───────────────────────────────────────────────
  // We separate "expired" from "invalid" because the UI surfaces them
  // differently (expired → "renew", invalid → "wrong key").
  const now = Math.floor(Date.now() / 1000);
  if (claim.exp < now) {
    throw new LicenseError(
      "expired",
      `License expired on ${new Date(claim.exp * 1000).toISOString()}`,
    );
  }
  // Reject licenses issued in the future too (clock skew up to 5min ok).
  if (claim.iat > now + 300) {
    throw new LicenseError(
      "invalid",
      `License iat ${new Date(claim.iat * 1000).toISOString()} is in the future`,
    );
  }

  return claim as LicenseClaim;
}

// ─── Helpers ─────────────────────────────────────────────────

async function importPublicKey(pem: string): Promise<CryptoKey> {
  const der = pemToArrayBuffer(pem, "PUBLIC KEY");
  return crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function pemToArrayBuffer(pem: string, label: string): ArrayBuffer {
  const base64 = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  return base64ToBytes(base64).buffer as ArrayBuffer;
}

function b64urlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  return base64ToBytes(b64urlToB64(b64url));
}

function b64urlToUtf8(b64url: string): string {
  return new TextDecoder().decode(b64urlToBytes(b64url));
}

function b64urlToB64(b64url: string): string {
  // JWT uses base64url; convert to standard base64 with padding.
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return b64 + padding;
}

// Pinned to an ArrayBuffer-backed view: TS 5.7+ made Uint8Array generic, and
// WebCrypto's BufferSource rejects the SharedArrayBuffer-compatible default.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new LicenseError(
      "invalid",
      "This doesn't look like a complete license: some characters got changed or cut when it was copied. Copy it again from the purchase email or from lifekernl.com/account and paste it here.",
    );
  }
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
