/**
 * The friends lane for directories.
 *
 * Two endpoints with two different callers:
 *   - `friend-view` is called by *another kernel*, authenticated with NIP-98.
 *     It is the only place a friends-only directory ever leaves this machine.
 *   - `sync-friends` is called by the owner from the dashboard to pull now
 *     instead of waiting for the periodic sweep.
 *
 * Kept out of api-routes.ts, which already takes sixteen positional
 * dependencies; this file needs two and can be read on its own.
 */
import type { IncomingMessage } from "node:http";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import { log } from "../../../../../src/core/logger.js";
import { PeeringService } from "../../../../../src/core/peering/service.js";
import { verifyRequest } from "../../../../../src/core/peering/auth.js";
import type { CinemaDirectoriesService as DirectoriesService } from "./directories-service.js";
import { FriendsDirectorySync, FRIENDS_ENDPOINT } from "./friends-sync.js";

/** Rebuild the absolute URL the peer signed, so a proxy cannot rewrite it. */
function absoluteUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  return `${proto}://${host}${req.url ?? ""}`;
}

export function registerCinemaFriendsRoutes(
  server: KernelHttpServer,
  dirsRef: () => DirectoriesService | null,
): void {
  // ── Called by another kernel ────────────────────────────────
  server.get(FRIENDS_ENDPOINT, async (req, res) => {
    const peering = PeeringService.current;
    const dirs = dirsRef();
    if (!peering || !dirs) {
      server.json(res, 503, { error: "not available" });
      return;
    }
    try {
      const auth = await verifyRequest({
        req,
        url: absoluteUrl(req),
        friends: peering.friends,
      });
      if (!auth.ok) {
        // The caller learns nothing about which check failed, on purpose.
        log.debug(`cinema: friend-view refused — ${auth.reason}`);
        server.json(res, 401, { error: "unauthorized" });
        return;
      }
      const directories = dirs.listForFriend();
      log.info(`cinema: served ${directories.length} directories to ${auth.npub?.slice(0, 16)}…`);
      server.json(res, 200, { directories });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Called by the owner ─────────────────────────────────────
  server.post("/api/cinema/directories/sync-friends", async (_req, res) => {
    const peering = PeeringService.current;
    const dirs = dirsRef();
    if (!peering || !dirs) {
      server.json(res, 503, { error: "peering not available" });
      return;
    }
    try {
      const sync = new FriendsDirectorySync({ peering, directories: dirs });
      const results = await sync.syncAll();
      server.json(res, 200, { results });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
