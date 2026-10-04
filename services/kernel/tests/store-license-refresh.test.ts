/**
 * All-Access renewals reaching the kernel.
 *
 * The issuer re-mints on every Stripe renewal but never pushes; if the kernel
 * doesn't ask, a yearly subscriber's Pro features stop when the license runs
 * out even though the renewal was paid. These pin down when the kernel asks,
 * and that nothing short of a renewed license replaces the one it holds.
 */

import { describe, test, expect } from "bun:test";
import { refreshLicenseIfDue, REFRESH_WINDOW_SECONDS } from "../src/modules/store/license-refresh.js";

const STORE = "https://store.example";
const NOW = 1_800_000_000;

function licenseStub(exp: number | null, opts?: { rejectSet?: boolean }) {
  const applied: string[] = [];
  return {
    applied,
    jwt: () => (exp === null ? null : "OLD-JWT"),
    status: () => (exp === null ? { status: "none" as const } : { status: "valid" as const, claim: { exp } as never }),
    set: async (jwt: string) => {
      if (opts?.rejectSet) throw new Error("signature mismatch");
      applied.push(jwt);
      return { status: "valid" as const };
    },
  };
}

function store(answer: { status?: number; body: unknown } | "down") {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (answer === "down") throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("refreshLicenseIfDue", () => {
  test("no license → never contacts the store", async () => {
    const s = store({ body: {} });
    expect(await refreshLicenseIfDue({ storeUrl: STORE, license: licenseStub(null), fetchImpl: s.impl, now: NOW })).toBe("no-license");
    expect(s.calls).toHaveLength(0);
  });

  test("a license far from expiry (an extension bought outright) is left alone", async () => {
    const s = store({ body: {} });
    const license = licenseStub(NOW + REFRESH_WINDOW_SECONDS + 1);
    expect(await refreshLicenseIfDue({ storeUrl: STORE, license, fetchImpl: s.impl, now: NOW })).toBe("not-due");
    expect(s.calls).toHaveLength(0);
  });

  test("near expiry, a renewed license from the store replaces the old one", async () => {
    const s = store({ body: { state: "renewed", jwt: "NEW-JWT", expires_at: NOW + 400 * 86_400 } });
    const license = licenseStub(NOW + 5 * 86_400);
    expect(await refreshLicenseIfDue({ storeUrl: STORE, license, fetchImpl: s.impl, now: NOW })).toBe("renewed");
    expect(license.applied).toEqual(["NEW-JWT"]);
    expect(s.calls[0]!.url).toBe(`${STORE}/api/license/refresh`);
    expect(s.calls[0]!.body).toEqual({ license: "OLD-JWT" });
  });

  test("an already-expired license still asks — the kernel may have been off on renewal day", async () => {
    const s = store({ body: { state: "renewed", jwt: "NEW-JWT", expires_at: NOW + 30 * 86_400 } });
    const license = licenseStub(NOW - 3 * 86_400);
    expect(await refreshLicenseIfDue({ storeUrl: STORE, license, fetchImpl: s.impl, now: NOW })).toBe("renewed");
  });

  test("nothing newer at the store → the current license stays", async () => {
    const s = store({ body: { state: "current" } });
    const license = licenseStub(NOW + 86_400);
    expect(await refreshLicenseIfDue({ storeUrl: STORE, license, fetchImpl: s.impl, now: NOW })).toBe("current");
    expect(license.applied).toEqual([]);
  });

  test("a store outage or refusal keeps the license and reports failed", async () => {
    const license = licenseStub(NOW + 86_400);
    expect(await refreshLicenseIfDue({ storeUrl: STORE, license, fetchImpl: store("down").impl, now: NOW })).toBe("failed");
    const refused = store({ status: 401, body: { error: "license not issued here" } });
    expect(await refreshLicenseIfDue({ storeUrl: STORE, license, fetchImpl: refused.impl, now: NOW })).toBe("failed");
    expect(license.applied).toEqual([]);
  });

  test("a renewed license this kernel can't verify is not installed", async () => {
    const s = store({ body: { state: "renewed", jwt: "BAD-JWT", expires_at: NOW + 86_400 } });
    const license = licenseStub(NOW + 86_400, { rejectSet: true });
    expect(await refreshLicenseIfDue({ storeUrl: STORE, license, fetchImpl: s.impl, now: NOW })).toBe("failed");
  });
});
