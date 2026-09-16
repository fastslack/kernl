/**
 * The brand-logo route is the only prefix served without a token, and it has to
 * stay the only one: the exemption exists because an `<img src>` cannot send an
 * Authorization header, not because anything under /api/extensions is public.
 */
import { describe, it, expect } from "bun:test";
import { isAuthExemptPath, AUTH_EXEMPT_PREFIXES } from "../src/core/auth.js";

describe("auth exempt paths", () => {
  it("serves bundled brand logos without a token", () => {
    expect(isAuthExemptPath("/api/extensions/brand/nvidia.svg")).toBe(true);
    expect(isAuthExemptPath("/api/extensions/brand/claude-code.svg")).toBe(true);
  });

  it("keeps the exact-match exemptions", () => {
    expect(isAuthExemptPath("/api/health")).toBe(true);
    expect(isAuthExemptPath("/api/auth/verify")).toBe(true);
  });

  it("leaves the rest of the extensions API behind the gate", () => {
    expect(isAuthExemptPath("/api/extensions")).toBe(false);
    expect(isAuthExemptPath("/api/extensions/brand")).toBe(false);
    expect(isAuthExemptPath("/api/extensions/install")).toBe(false);
    expect(isAuthExemptPath("/api/llm/catalog")).toBe(false);
    expect(isAuthExemptPath("/api/config/ai")).toBe(false);
  });

  it("exempts by prefix only, never by substring", () => {
    expect(isAuthExemptPath("/api/evil/api/extensions/brand/x.svg")).toBe(false);
    expect(AUTH_EXEMPT_PREFIXES).toEqual(["/api/extensions/brand/"]);
  });
});
