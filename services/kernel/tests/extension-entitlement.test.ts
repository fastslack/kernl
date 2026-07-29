import { describe, it, expect } from "bun:test";
import {
  isPaidExtension,
  requiredFeature,
  checkBundleAuthenticity,
  activationStatus,
} from "../src/modules/extensions/entitlement.js";

// Install-time enforcement for paid `.kernl` extensions:
//   • authenticity — a signed bundle must verify; a paid bundle MUST be signed.
//   • entitlement  — a paid bundle only activates with a matching `pro:<slug>` license.
// The crypto itself is covered by bundle-signature.test.ts; here we test the
// decision logic with injected verify/licenseHas so it's deterministic + CI-safe.

const free = { slug: "notes", pricing: { model: "free" as const } };
const paid = { slug: "trading", pricing: { model: "one-time" as const } };
const unpriced = { slug: "tasks" };

describe("isPaidExtension", () => {
  it("is false for free / unpriced, true for paid", () => {
    expect(isPaidExtension(free)).toBe(false);
    expect(isPaidExtension(unpriced)).toBe(false);
    expect(isPaidExtension(paid)).toBe(true);
  });
});

describe("requiredFeature", () => {
  it("maps a slug to its pro feature flag", () => {
    expect(requiredFeature(paid)).toBe("pro:trading");
  });
});

describe("checkBundleAuthenticity", () => {
  const yes = async () => true;
  const no = async () => false;

  it("accepts an unsigned FREE bundle", async () => {
    expect((await checkBundleAuthenticity(free, "a".repeat(64), no)).ok).toBe(true);
  });

  it("rejects an unsigned PAID bundle (paid must be signed)", async () => {
    const r = await checkBundleAuthenticity(paid, "a".repeat(64), no);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing/i);
  });

  it("accepts a signed bundle whose signature verifies", async () => {
    const m = { ...paid, integrity: { sha256: "a".repeat(64), signature: "sig" } };
    expect((await checkBundleAuthenticity(m, "a".repeat(64), yes)).ok).toBe(true);
  });

  it("rejects a signed bundle whose signature does NOT verify (tamper/piracy)", async () => {
    const m = { ...paid, integrity: { sha256: "a".repeat(64), signature: "sig" } };
    const r = await checkBundleAuthenticity(m, "a".repeat(64), no);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verification failed/i);
  });
});

describe("activationStatus", () => {
  const licensed = (f: string) => f === "pro:trading";
  const unlicensed = () => false;

  it("activates a free extension", () => {
    expect(activationStatus(free, unlicensed, false)).toBe("active");
  });

  it("leaves a requires_activation extension installed (inactive)", () => {
    expect(activationStatus(free, licensed, true)).toBe("installed");
  });

  it("activates a paid extension WHEN licensed", () => {
    expect(activationStatus(paid, licensed, false)).toBe("active");
  });

  it("leaves a paid extension installed (inactive) when NOT licensed", () => {
    expect(activationStatus(paid, unlicensed, false)).toBe("installed");
  });
});
