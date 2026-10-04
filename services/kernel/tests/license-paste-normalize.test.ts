/**
 * A license pasted from an email or a chat rarely arrives as the exact JWT:
 * mail clients wrap the long line, insert zero-width spaces or soft hyphens
 * where they break it, and people copy it with quotes or a "Bearer " prefix.
 * Any of those used to reach atob() and come back as "The string contains
 * invalid characters". The paste is normalized before it is verified.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeLicenseInput } from "../src/core/license/verify.js";
import { createLicenseService } from "../src/core/license/service.js";

const JWT = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJpc3N1ZXIubGlmZWtlcm5sLmNvbSJ9.AbC_d-Ef0123456789xyz";

describe("normalizeLicenseInput", () => {
  it("returns a clean JWT unchanged", () => {
    expect(normalizeLicenseInput(JWT)).toBe(JWT);
  });

  it("removes line breaks and spaces a mail client put inside the token", () => {
    const wrapped = `${JWT.slice(0, 30)}\r\n ${JWT.slice(30, 70)}\n\t${JWT.slice(70)}  `;
    expect(normalizeLicenseInput(wrapped)).toBe(JWT);
  });

  it("removes zero-width spaces, soft hyphens and BOMs", () => {
    const dirty = `﻿${JWT.slice(0, 20)}​${JWT.slice(20, 50)}­${JWT.slice(50, 60)}⁠${JWT.slice(60)}`;
    expect(normalizeLicenseInput(dirty)).toBe(JWT);
  });

  it("drops quotes, a Bearer prefix and text around the token", () => {
    expect(normalizeLicenseInput(`"${JWT}"`)).toBe(JWT);
    expect(normalizeLicenseInput(`Bearer ${JWT}`)).toBe(JWT);
    expect(normalizeLicenseInput(`Your license:\n\n${JWT}\n\nThanks!`)).toBe(JWT);
  });

  it("returns what it got when there is no token-shaped text at all", () => {
    expect(normalizeLicenseInput("hola")).toBe("hola");
  });
});

describe("normalizeLicenseInput with an RS256 license (342-char signature)", () => {
  const SIG = "A".repeat(170) + "_-" + "b".repeat(170);
  const LIC = `${JWT.split(".").slice(0, 2).join(".")}.${SIG}`;
  const wrapWith = (sep: string) => LIC.match(/.{1,76}/g)!.join(sep);

  it("rejoins a token whose line breaks a mail client turned into spaces", () => {
    expect(normalizeLicenseInput(wrapWith(" "))).toBe(LIC);
  });

  it("stops at the end of the signature even when the email's next line was copied too", () => {
    expect(normalizeLicenseInput(`${wrapWith(" ")} Unlocks All extensions (All-Access) Valid until Tue`)).toBe(LIC);
    expect(normalizeLicenseInput(`LICENSE KEY\n${wrapWith("\n")}\nUnlocks\nAll extensions`)).toBe(LIC);
  });
});

describe("license.set with a messy paste", () => {
  it("never surfaces the raw atob error; it says what to do", async () => {
    const svc = createLicenseService({ path: join(mkdtempSync(join(tmpdir(), "lic-")), "license.jwt") });
    const err = await svc.set("eyJhbGciOiJSUzI1NiJ9.e$$$yJ.x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("invalid characters");
    expect((err as Error).message.toLowerCase()).toContain("copy it again");
  });

  it("verifies the normalized token (a wrapped paste is not rejected as malformed)", async () => {
    const svc = createLicenseService({ path: join(mkdtempSync(join(tmpdir(), "lic-")), "license.jwt") });
    const err = await svc.set(`${JWT.slice(0, 40)}\n${JWT.slice(40)}`).catch((e: Error) => e);
    // The fake token has no valid signature, so it is still rejected — but for
    // the signature, not because of the line break.
    expect((err as Error).message).not.toContain("malformed");
    expect((err as Error).message).not.toContain("invalid characters");
  });
});
