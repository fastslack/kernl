/**
 * Where the browser goes after Google's consent screen: back to the screen
 * that asked (Growth → Conexiones, a settings page), carried in the OAuth
 * `state`. Only a loopback dashboard or the configured public dashboard URL
 * is accepted, so the callback can never be turned into an open redirect.
 */

function allowed(raw: string, publicBase: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return u;
  if (publicBase) {
    try { if (new URL(publicBase).origin === u.origin) return u; } catch { /* bad public URL: loopback only */ }
  }
  return null;
}

/** The OAuth `state` for a return URL, or "" when that URL is not one we go back to. */
export function encodeReturnState(returnTo: string, publicBase = ""): string {
  const u = allowed(returnTo, publicBase);
  return u ? Buffer.from(JSON.stringify({ r: u.toString() })).toString("base64url") : "";
}

/** The URL to send the browser to, with `google_auth=<result>`; null falls back to the default. */
export function returnTarget(state: string | null, publicBase: string, result: string): string | null {
  if (!state) return null;
  let r: unknown;
  try { r = (JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { r?: unknown }).r; } catch { return null; }
  const u = typeof r === "string" ? allowed(r, publicBase) : null;
  if (!u) return null;
  u.searchParams.set("google_auth", result);
  return u.toString();
}
