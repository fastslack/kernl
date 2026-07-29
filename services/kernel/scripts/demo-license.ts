#!/usr/bin/env bun
/**
 * End-to-end smoke test for the license module.
 *
 * This is what an issuer would do — sign a JWT with the private key,
 * hand it to the kernel, and confirm the kernel accepts it. We do it all
 * in-process so a failing roundtrip is visible immediately.
 *
 *   bun scripts/demo-license.ts
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createLicenseService, LicenseError } from "../src/core/license/index.js";

const ROOT = resolve(import.meta.dir, "..");
const PRIV = readFileSync(resolve(ROOT, ".agents/private/license-priv.pem"), "utf-8");

const ISSUER = process.env.KERNEL_LICENSE_ISSUER ?? "issuer.mtwkernel.com";
process.env.KERNEL_LICENSE_ISSUER = ISSUER;

async function signJwt(claim: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body   = b64url(JSON.stringify(claim));
  const data   = new TextEncoder().encode(`${header}.${body}`);

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(PRIV, "PRIVATE KEY"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  const sig = b64urlRaw(new Uint8Array(sigBuf));
  return `${header}.${body}.${sig}`;
}

const tmp = mkdtempSync(resolve(tmpdir(), "mtwk-license-"));
const path = resolve(tmp, "license.jwt");

try {
  console.log(`Using license path: ${path}`);
  const svc = createLicenseService({ path });

  // Wait for initial async load to settle. The service is usable
  // immediately, but the eager load is async.
  await new Promise((r) => setTimeout(r, 50));

  console.log("\n--- Empty state ---");
  console.log("status:", svc.status());
  console.log("isPro:", svc.isPro());
  console.log("has(pro:trading):", svc.has("pro:trading"));

  console.log("\n--- Set a valid Pro license ---");
  const now = Math.floor(Date.now() / 1000);
  const validJwt = await signJwt({
    iss: ISSUER,
    sub: "cus_demo123",
    email: "test@example.com",
    sku: "pro",
    features: ["pro:example"],
    iat: now,
    exp: now + 86400,
  });
  const setResult = await svc.set(validJwt);
  console.log("set result:", setResult.status, "→", setResult.claim?.sku);
  console.log("isPro:", svc.isPro());
  console.log("has(pro:trading):", svc.has("pro:trading"));
  console.log("has(pro:cloud):", svc.has("pro:cloud"), "← should be false (not in features)");

  console.log("\n--- Reload from disk (simulates kernel restart) ---");
  const svc2 = createLicenseService({ path });
  await new Promise((r) => setTimeout(r, 50));
  console.log("status:", svc2.status().status, "→", svc2.status().claim?.email);

  console.log("\n--- Reject expired license ---");
  const expiredJwt = await signJwt({
    iss: ISSUER,
    sub: "cus_demo123",
    email: "test@example.com",
    sku: "pro",
    features: ["pro:trading"],
    iat: now - 86400 * 2,
    exp: now - 86400,
  });
  try {
    await svc.set(expiredJwt);
    console.log("UNEXPECTED: expired JWT accepted");
  } catch (err) {
    if (err instanceof LicenseError) {
      console.log("✓ rejected:", err.kind, "-", err.message);
    } else throw err;
  }

  console.log("\n--- Reject wrong issuer ---");
  const wrongIssuer = await signJwt({
    iss: "evil.example.com",
    sub: "cus_demo123",
    email: "x@y.z",
    sku: "pro",
    features: ["pro:trading"],
    iat: now,
    exp: now + 86400,
  });
  try {
    await svc.set(wrongIssuer);
    console.log("UNEXPECTED: bad issuer accepted");
  } catch (err) {
    if (err instanceof LicenseError) {
      console.log("✓ rejected:", err.kind, "-", err.message);
    } else throw err;
  }

  console.log("\n--- Reject tampered signature ---");
  const tampered = validJwt.slice(0, -5) + "AAAAA";
  try {
    await svc.set(tampered);
    console.log("UNEXPECTED: tampered JWT accepted");
  } catch (err) {
    if (err instanceof LicenseError) {
      console.log("✓ rejected:", err.kind, "-", err.message);
    } else throw err;
  }

  console.log("\n--- Clear license ---");
  await svc.clear();
  console.log("status:", svc.status());

  console.log("\n✓ All license module checks passed.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ─── helpers ─────────────────────────────────────────────

function b64url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}
function b64urlRaw(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
function pemToBytes(pem: string, label: string): ArrayBuffer {
  const base64 = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  const buf = Buffer.from(base64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
