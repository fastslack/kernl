/**
 * What went wrong talking to a mail server, as a code the dashboard can turn
 * into "what happened + what to do". The raw server text travels separately
 * (errorDetail) for the "see details" line.
 */
import type { MailAuth, ServerEndpoint } from "./mail-providers.js";

export type MailErrorCode =
  | "app_password_required" | "auth_failed" | "unreachable" | "tls" | "timeout"
  | "oauth_only" | "bridge" | "smtp_failed" | "already_connected" | "unknown";

type Classified = "app_password_required" | "auth_failed" | "unreachable" | "tls" | "timeout" | "unknown";

const UNREACHABLE = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EDNS", "ECONNECTION"]);
const TLS = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_SSL_WRONG_VERSION_NUMBER"]);
const TIMEOUT = new Set(["ETIMEOUT", "ETIMEDOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT"]);
/** Ports that speak TLS from the first byte: a plain-text client there never sees a greeting. */
const IMPLICIT_TLS_PORTS = new Set([993, 465]);

interface MailishError { code?: string; authenticationFailed?: boolean; responseText?: string; message?: string }

const textOf = (e: MailishError) => `${e.responseText ?? ""} ${e.message ?? ""}`;

/**
 * `endpoint` is the server the error came from, when the caller has it: a
 * greeting timeout on a plain-text connection to 993/465 is a TLS mismatch,
 * not a slow server.
 */
export function classifyMailError(err: unknown, auth: MailAuth, endpoint?: ServerEndpoint): Classified {
  if (!err || typeof err !== "object") return "unknown";
  const e = err as MailishError;
  const text = textOf(e);
  const code = e.code ?? "";

  const authFailed = e.authenticationFailed === true || code === "EAUTH"
    || /AUTHENTICATIONFAILED|invalid credentials|authentication failed|username and password not accepted/i.test(text);
  if (authFailed) {
    return auth === "app_password" || /application-specific password|app password/i.test(text)
      ? "app_password_required"
      : "auth_failed";
  }
  if (code.startsWith("ERR_TLS") || TLS.has(code)) return "tls";
  if (code === "GREETING_TIMEOUT" && endpoint && !endpoint.secure && IMPLICIT_TLS_PORTS.has(endpoint.port)) return "tls";
  if (TIMEOUT.has(code)) return "timeout";
  if (UNREACHABLE.has(code)) return "unreachable";
  return "unknown";
}

export function errorDetail(err: unknown, secret?: string): string {
  let text: string;
  if (err && typeof err === "object") {
    const e = err as MailishError;
    text = (e.responseText || e.message || String(err)).trim();
  } else {
    text = String(err);
  }
  if (secret) text = text.split(secret).join("***");
  return text.slice(0, 300);
}
