import type { IncomingMessage } from "node:http";

/** Paths that bypass authentication (health check, auth verification, MCP has its own auth). */
export const AUTH_EXEMPT_PATHS = ["/api/health", "/api/metrics", "/api/auth/verify"];

/**
 * Paths that carry their own authentication and must bypass the kernel token
 * check — otherwise the credential they *do* present can never be evaluated.
 *
 * These are the instance-peering endpoints: another Kernl proves who it is
 * with a NIP-98 signature and is then checked against the friends list. It has
 * no reason to hold this kernel's token, and handing one out would defeat the
 * purpose. Exempt from the token, never from authentication.
 */
export const PEER_AUTH_PATHS = ["/api/cinema/directories/friend-view", "/api/peering/relay"];

/** True when the path authenticates itself and should skip the token gate. */
export function isPeerAuthenticatedPath(pathname: string): boolean {
  return PEER_AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * Checks if a request carries a valid Bearer token.
 * If no token is configured (empty string), auth is disabled — all requests pass.
 *
 * Accepts the token in either of:
 *   * `Authorization: Bearer <token>` header (preferred — used by `fetch`).
 *   * `?auth=<token>` query string — honored ONLY for requests that can't set
 *     a custom header in the browser:
 *       - SSE/EventSource (`Accept: text/event-stream`).
 *       - Media-streaming routes loaded by `<video>`/`<img>`/`<track>` elements
 *         and by ffmpeg/ffprobe child processes (transcode, file/stream,
 *         webseed-proxy). None of these can attach an Authorization header.
 *     Restricting the query fallback to this narrow allow-list keeps the static
 *     token off the general JSON API (and so out of most logs/history).
 *
 * For all other requests, only the Bearer header is accepted.
 */

/**
 * Routes served to header-less clients (video elements, ffmpeg). These must
 * accept the `?auth=<token>` query fallback or playback + server-side audio
 * extraction (subtitle generation) break with 401.
 *
 * Cinema's two media routes belong here for exactly the reason the paid
 * torrents ones do, and were missing: a `<video src>` cannot set an
 * Authorization header, so every playback in the free module answered 401 and
 * the player sat at 0:00 with no error anywhere — the request never reached a
 * handler that could report one. The cinema frontend was already appending
 * `&auth=<token>` (Page.svelte:2100); only this list had not been told.
 */
const AUTH_QUERY_PATH_RE =
  /^\/api\/(torrents\/(transcode|webseed-proxy|[^/?#]+\/file\/\d+\/stream)|cinema\/media\/(transcode|webseed-proxy))/;

export function isAuthenticated(req: IncomingMessage, token: string): boolean {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts[0] === "Bearer" && parts[1] === token) return true;
  }
  // Query-string fallback. `req.url` is path+query — parse the bare query
  // string instead of new URL() to avoid needing a real host.
  const url = req.url ?? "";
  const qIdx = url.indexOf("?");
  if (qIdx >= 0) {
    const accept = req.headers.accept ?? "";
    const path = url.slice(0, qIdx);
    if (accept.includes("text/event-stream") || AUTH_QUERY_PATH_RE.test(path)) {
      const params = new URLSearchParams(url.slice(qIdx + 1));
      if (params.get("auth") === token) return true;
    }
  }
  return false;
}
