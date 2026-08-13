/**
 * The default expected license issuer.
 *
 * `verifyLicenseJwt` rejects any claim whose `iss` doesn't match. The issuer
 * Worker mints `iss: "issuer.lifekernl.com"`, and only docker-compose.yml sets
 * KERNEL_LICENSE_ISSUER — packaging/, .env.example and the docs never mention
 * it. So every rpm/deb/dmg/msi install fell back to a default that no license
 * ever carries, and a paying customer pasting a valid key got
 * `Wrong issuer "issuer.lifekernl.com"; expected "issuer.mtwkernel.com"`.
 *
 * The default has to be the issuer we actually mint from. It's also read per
 * call rather than captured at import: the license service is constructed
 * during bootstrap, after the environment is loaded.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { expectedIssuer } from "../src/core/license/verify.js";

const saved = process.env.KERNEL_LICENSE_ISSUER;

afterEach(() => {
  if (saved === undefined) delete process.env.KERNEL_LICENSE_ISSUER;
  else process.env.KERNEL_LICENSE_ISSUER = saved;
});

describe("expectedIssuer", () => {
  it("defaults to the issuer that actually mints licenses", () => {
    delete process.env.KERNEL_LICENSE_ISSUER;
    expect(expectedIssuer()).toBe("issuer.lifekernl.com");
  });

  it("honors an explicit KERNEL_LICENSE_ISSUER override", () => {
    process.env.KERNEL_LICENSE_ISSUER = "issuer.staging.example";
    expect(expectedIssuer()).toBe("issuer.staging.example");
  });

  it("reads the environment per call, not once at import", () => {
    process.env.KERNEL_LICENSE_ISSUER = "issuer.first.example";
    expect(expectedIssuer()).toBe("issuer.first.example");
    process.env.KERNEL_LICENSE_ISSUER = "issuer.second.example";
    expect(expectedIssuer()).toBe("issuer.second.example");
  });
});
