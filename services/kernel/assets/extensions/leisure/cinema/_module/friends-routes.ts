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
import {
  HttpError,
  type KernelHttpServer,
  log,
  peering as currentPeering,
  verifyPeerRequest as verifyRequest,
} from "@kernl/extension-sdk";
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
  server.route("GET", FRIENDS_ENDPOINT, async ({ req }) => {
    const peering = currentPeering();
    const dirs = dirsRef();
    if (!peering || !dirs) throw new HttpError(503, "not available");
    const auth = await verifyRequest({
      req,
      url: absoluteUrl(req),
      friends: peering.friends,
    });
    if (!auth.ok) {
      // The caller learns nothing about which check failed, on purpose.
      log.debug(`cinema: friend-view refused — ${auth.reason}`);
      throw new HttpError(401, "unauthorized");
    }
    const directories = dirs.listForFriend();
    log.info(`cinema: served ${directories.length} directories to ${auth.npub?.slice(0, 16)}…`);
    return { directories };
  });

  // ── Called by the owner ─────────────────────────────────────
  server.route("POST", "/api/cinema/directories/sync-friends", async () => {
    const peering = currentPeering();
    const dirs = dirsRef();
    if (!peering || !dirs) throw new HttpError(503, "peering not available");
    const sync = new FriendsDirectorySync({ peering, directories: dirs });
    return { results: await sync.syncAll() };
  });
}
