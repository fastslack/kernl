import { describe, it, expect } from "bun:test";
import { resolveSecureBind } from "../src/core/config.js";

// H7 fail-closed: an empty auth token disables authentication (dev mode), so
// the kernel must NEVER expose its tool surface on a non-loopback interface.
// resolveSecureBind downgrades the bind host to loopback whenever no token is
// configured. A configured token re-enables non-loopback binding (auth is then
// enforced on every /api/* and /mcp request).
describe("resolveSecureBind (H7 fail-closed)", () => {
  it("forces loopback when no auth token and bind is 0.0.0.0", () => {
    expect(resolveSecureBind("0.0.0.0", "")).toBe("127.0.0.1");
  });

  it("treats a whitespace-only token as no token and forces loopback", () => {
    expect(resolveSecureBind("0.0.0.0", "   ")).toBe("127.0.0.1");
  });

  it("forces loopback for any non-loopback host with no token (LAN IP or IPv6 any)", () => {
    expect(resolveSecureBind("192.168.1.50", "")).toBe("127.0.0.1");
    expect(resolveSecureBind("::", "")).toBe("127.0.0.1");
  });

  it("leaves 0.0.0.0 untouched when an auth token is set", () => {
    expect(resolveSecureBind("0.0.0.0", "secret-token")).toBe("0.0.0.0");
  });

  it("leaves an explicit loopback bind untouched when no token", () => {
    expect(resolveSecureBind("127.0.0.1", "")).toBe("127.0.0.1");
    expect(resolveSecureBind("localhost", "")).toBe("localhost");
    expect(resolveSecureBind("::1", "")).toBe("::1");
  });

  // Container escape hatch: the zero-config eval stack proxies through nginx
  // in a sibling container, so the kernel must be allowed to bind 0.0.0.0 —
  // but ONLY when the operator explicitly set BOTH switches.
  it("honors an explicit non-loopback bind when allowUnauth is explicitly set", () => {
    expect(resolveSecureBind("0.0.0.0", "", { allowUnauth: true, bindIsExplicit: true })).toBe("0.0.0.0");
  });

  it("still forces loopback with allowUnauth but a DEFAULT (non-explicit) bind", () => {
    expect(resolveSecureBind("0.0.0.0", "", { allowUnauth: true, bindIsExplicit: false })).toBe("127.0.0.1");
  });

  it("still forces loopback with an explicit bind but no allowUnauth", () => {
    expect(resolveSecureBind("0.0.0.0", "", { allowUnauth: false, bindIsExplicit: true })).toBe("127.0.0.1");
  });
});
