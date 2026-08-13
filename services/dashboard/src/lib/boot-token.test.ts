/**
 * First-run handoff: the desktop launchers open the dashboard with the
 * kernel's generated API token in the URL *fragment*.
 *
 * Fragment, not query string: the fragment is never sent to the server, so it
 * stays out of access logs, out of proxy logs and out of the Referer header.
 * It does land in browser history, which is why the login page strips it as
 * soon as it has been consumed.
 */

import { describe, it, expect } from "bun:test";
import { tokenFromHash } from "./boot-token.js";

describe("tokenFromHash", () => {
  it("reads the token the launcher handed over", () => {
    expect(tokenFromHash("#token=abc123")).toBe("abc123");
  });

  it("reads it alongside other fragment params", () => {
    expect(tokenFromHash("#token=abc123&next=/settings")).toBe("abc123");
    expect(tokenFromHash("#next=/settings&token=abc123")).toBe("abc123");
  });

  it("tolerates a fragment with no leading #", () => {
    expect(tokenFromHash("token=abc123")).toBe("abc123");
  });

  it("percent-decodes the value", () => {
    expect(tokenFromHash("#token=a%2Bb%3Dc")).toBe("a+b=c");
  });

  it("trims surrounding whitespace", () => {
    expect(tokenFromHash("#token=%20abc123%20")).toBe("abc123");
  });

  it("returns null when there is no token", () => {
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#")).toBeNull();
    expect(tokenFromHash("#next=/settings")).toBeNull();
  });

  it("returns null for an empty or whitespace-only token", () => {
    expect(tokenFromHash("#token=")).toBeNull();
    expect(tokenFromHash("#token=%20")).toBeNull();
  });

  it("does not mistake a lookalike param for the token", () => {
    expect(tokenFromHash("#mytoken=abc123")).toBeNull();
    expect(tokenFromHash("#token_hint=abc123")).toBeNull();
  });

  // A malformed escape decodes to replacement characters rather than throwing.
  // We don't try to judge the token's shape here — `/api/auth/verify` is the
  // only authority on whether a token is good. All this must guarantee is that
  // a junk fragment can't take the login page down before it gets to ask.
  it("does not throw on a malformed percent-escape", () => {
    expect(() => tokenFromHash("#token=%E0%A4%A")).not.toThrow();
  });
});
