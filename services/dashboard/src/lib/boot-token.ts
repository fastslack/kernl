/**
 * First-run token handoff from the desktop launchers.
 *
 * A fresh install generates its own API token, so the very first thing a new
 * user sees would otherwise be a login screen asking for a secret they have
 * never been shown. The .app / .bat launchers read that generated token and
 * open the dashboard at `/login#token=<it>`; this parses it back out.
 *
 * The token travels in the URL fragment because the fragment is never sent to
 * the server — it stays out of access logs, proxy logs and `Referer`. It does
 * land in browser history, so the login page clears it once consumed.
 */

const TOKEN_KEY = "token";

/**
 * Extract the handed-over token from a URL fragment, or null when there
 * isn't one. Never throws — a malformed fragment is simply "no token".
 */
export function tokenFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }

  let value: string | null;
  try {
    // URLSearchParams decodes on read, and throws URIError on a truncated
    // escape like "%E0%A4%A".
    value = params.get(TOKEN_KEY);
  } catch {
    return null;
  }

  const token = value?.trim() ?? "";
  return token.length > 0 ? token : null;
}
