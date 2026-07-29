import type { IncomingMessage } from "node:http";

/** Paths that bypass authentication (health check, auth verification, MCP has its own auth). */
export const AUTH_EXEMPT_PATHS = ["/api/health", "/api/metrics", "/api/auth/verify"];

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
 */
const AUTH_QUERY_PATH_RE =
  /^\/api\/torrents\/(transcode|webseed-proxy|[^/?#]+\/file\/\d+\/stream)/;

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
