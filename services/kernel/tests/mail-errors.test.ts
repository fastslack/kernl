import { describe, it, expect } from "bun:test";
import { classifyMailError, errorDetail } from "../assets/extensions/people/comms/_module/mail-errors.js";

const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

describe("classifyMailError", () => {
  it("imapflow auth failure → auth_failed, or app_password_required for app-password providers", () => {
    const e = err("Command failed", { authenticationFailed: true, responseText: "[AUTHENTICATIONFAILED] Invalid credentials (Failure)" });
    expect(classifyMailError(e, "password")).toBe("auth_failed");
    expect(classifyMailError(e, "app_password")).toBe("app_password_required");
  });

  it("Gmail's 'Application-specific password required' is app_password_required even from an unknown domain", () => {
    const e = err("Command failed", {
      authenticationFailed: true,
      responseText: "[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)",
    });
    expect(classifyMailError(e, "password")).toBe("app_password_required");
  });

  it("nodemailer EAUTH → auth_failed", () => {
    const e = err("Invalid login: 535-5.7.8 Username and Password not accepted", { code: "EAUTH", responseCode: 535 });
    expect(classifyMailError(e, "password")).toBe("auth_failed");
  });

  it("DNS and refused connections → unreachable", () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EDNS", "ECONNECTION"]) {
      expect(classifyMailError(err(`x ${code}`, { code }), "password"), code).toBe("unreachable");
    }
  });

  it("certificate and TLS problems → tls", () => {
    for (const code of ["ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_SSL_WRONG_VERSION_NUMBER"]) {
      expect(classifyMailError(err("handshake failed", { code }), "password"), code).toBe("tls");
    }
  });

  it("timeouts from both libraries → timeout", () => {
    expect(classifyMailError(err("Connection timeout", { code: "ETIMEOUT" }), "password")).toBe("timeout");
    expect(classifyMailError(err("Greeting never received", { code: "ETIMEDOUT" }), "password")).toBe("timeout");
  });

  it("imapflow's own timeout codes → timeout", () => {
    expect(classifyMailError(err("Failed to establish connection in required time", { code: "CONNECT_TIMEOUT" }), "password")).toBe("timeout");
    expect(classifyMailError(err("Failed to receive greeting from server in required time. Maybe should use TLS?", { code: "GREETING_TIMEOUT" }), "password")).toBe("timeout");
  });

  it("no greeting from a plain-text connection to a TLS port (993/465) → tls", () => {
    const e = err("Failed to receive greeting from server in required time. Maybe should use TLS?", { code: "GREETING_TIMEOUT" });
    expect(classifyMailError(e, "password", { host: "imap.x.com", port: 993, secure: false })).toBe("tls");
    expect(classifyMailError(e, "password", { host: "smtp.x.com", port: 465, secure: false })).toBe("tls");
    expect(classifyMailError(e, "password", { host: "imap.x.com", port: 993, secure: true })).toBe("timeout");
    expect(classifyMailError(e, "password", { host: "imap.x.com", port: 143, secure: false })).toBe("timeout");
  });

  it("anything else → unknown", () => {
    expect(classifyMailError(err("something odd"), "password")).toBe("unknown");
    expect(classifyMailError("not an error", "password")).toBe("unknown");
    expect(classifyMailError(undefined, "password")).toBe("unknown");
  });
});

describe("errorDetail", () => {
  it("prefers the server's response text, caps the length and hides the password", () => {
    const e = err("Command failed", { responseText: "NO login failed for maria with s3cr3t" + "x".repeat(400) });
    const d = errorDetail(e, "s3cr3t");
    expect(d.startsWith("NO login failed for maria with ***")).toBe(true);
    expect(d.includes("s3cr3t")).toBe(false);
    expect(d.length).toBeLessThanOrEqual(300);
  });

  it("falls back to the message, and to String() for non-errors", () => {
    expect(errorDetail(err("getaddrinfo ENOTFOUND imap.x.com"))).toBe("getaddrinfo ENOTFOUND imap.x.com");
    expect(errorDetail("boom")).toBe("boom");
  });
});
