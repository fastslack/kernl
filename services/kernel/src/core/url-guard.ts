/**
 * SSRF guard for outbound fetches whose target URL is user-controlled
 * (transcode proxy, webseed proxy, federated subtitle download).
 *
 * Two layers:
 *  1. Reject non-http(s) protocols outright (no file://, gopher://, ftp://…).
 *  2. Resolve the hostname via DNS and reject if the resolved address sits
 *     in a private/loopback/link-local range. A literal-IP host is also
 *     checked directly so a request to `http://127.0.0.1:6379` is denied
 *     before any DNS query happens.
 *
 * `redirect: "follow"` is unsafe with this guard alone — a 302 to a private
 * IP would still execute the second hop. Callers that follow redirects on
 * untrusted URLs should set `redirect: "manual"` and re-validate each hop,
 * or accept the residual risk if the upstream is a known CDN (archive.org,
 * etc.). For Kernl's current callers (webseed/transcode/subs-download)
 * the residual risk is tolerable: a malicious sub announcement could redirect
 * to a private host, but the response body is still subject to size limits
 * and only stored as a subtitle string — no command injection surface.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface UrlGuardOk { ok: true; parsed: URL }
export interface UrlGuardErr { ok: false; reason: string }
export type UrlGuardResult = UrlGuardOk | UrlGuardErr;

/** Accept HTTP/HTTPS only — explicit allow-list, since fetch silently
 *  ignores some unknown schemes and Node's http_client honours others
 *  (`data:` etc.) that we never want here. */
function isAllowedProtocol(u: URL): boolean {
  return u.protocol === "http:" || u.protocol === "https:";
}

/** True if the IPv4/IPv6 string lives in a range that should never be
 *  reachable from a user-controlled URL. Compare in canonical form. */
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast (224/4) + reserved (240/4)
    return false;
  }
  if (v === 6) {
    const lc = ip.toLowerCase();
    if (lc === "::1" || lc === "::") return true;
    if (lc.startsWith("fe80:") || lc.startsWith("fc") || lc.startsWith("fd")) return true;
    if (lc.startsWith("ff")) return true;          // multicast
    // ::ffff:<v4> mapped — strip and recurse on the v4 portion.
    const m = lc.match(/^::ffff:([0-9.]+)$/);
    if (m && isIP(m[1]) === 4) return isPrivateIp(m[1]);
    return false;
  }
  return false;
}

/** Hostnames we always reject regardless of DNS. Catches the case where
 *  someone configures /etc/hosts to alias `internal.svc → 192.168…` and
 *  passes the alias as URL host. */
const FORBIDDEN_HOSTS = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/**
 * Validate a user-supplied URL before opening an outbound HTTP(S) request.
 * Resolves DNS once — callers using `redirect: "follow"` should be aware
 * that intermediate hops are NOT re-validated.
 */
export async function guardOutboundUrl(raw: string): Promise<UrlGuardResult> {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { return { ok: false, reason: "invalid url" }; }
  if (!isAllowedProtocol(parsed)) return { ok: false, reason: "only http(s) urls are allowed" };
  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "missing host" };
  if (FORBIDDEN_HOSTS.has(host)) return { ok: false, reason: "host is forbidden" };
  // Literal-IP host: validate without DNS.
  if (isIP(host)) {
    if (isPrivateIp(host)) return { ok: false, reason: "host resolves to a private/loopback range" };
    return { ok: true, parsed };
  }
  // Hostname: resolve and check every returned address.
  try {
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        return { ok: false, reason: `host resolves to a private range (${a.address})` };
      }
    }
  } catch (err) {
    return { ok: false, reason: `dns lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, parsed };
}

/**
 * Like fetch(), but every URL we touch — initial target and each redirect hop
 * — is re-validated through `guardOutboundUrl`. The native fetch only sees the
 * first URL; with `redirect: "follow"` an attacker-controlled 30x can land on
 * a private IP without us noticing. So we drive the redirect loop ourselves
 * with `redirect: "manual"` and a hop cap.
 *
 * Use this for any outbound fetch whose target URL is influenced by user
 * input or remote data (peer URLs, RSS feeds, agent variables, mail webhooks).
 */
export interface GuardedFetchOptions extends RequestInit {
  /** Max redirects to follow. Default 5 (matches fetch's historical behaviour). */
  maxRedirects?: number;
}

export async function guardedFetch(rawUrl: string, init: GuardedFetchOptions = {}): Promise<Response> {
  const { maxRedirects = 5, ...fetchInit } = init;
  let currentUrl = rawUrl;
  // Preserve only safe headers across redirects (drop Authorization on
  // cross-origin like browsers do — prevents accidental token leaks).
  const initialHeaders = new Headers(fetchInit.headers ?? {});

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const guard = await guardOutboundUrl(currentUrl);
    if (!guard.ok) {
      throw new Error(`guardedFetch: blocked URL "${currentUrl}" — ${guard.reason}`);
    }
    const headers = new Headers(initialHeaders);
    if (hop > 0) {
      // Drop Authorization if the redirect changed origin.
      const initial = new URL(rawUrl);
      const now = guard.parsed;
      if (initial.origin !== now.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
    }
    const res = await fetch(currentUrl, { ...fetchInit, headers, redirect: "manual" });
    // Status 3xx with a Location → follow manually, re-validate next URL.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res; // 3xx without Location — nothing to follow, return as-is.
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error(`guardedFetch: exceeded ${maxRedirects} redirects starting at "${rawUrl}"`);
}
