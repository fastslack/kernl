/**
 * Pulling directories from friends.
 *
 * The public lane (Nostr relays) and this one never mix: a directory arrives
 * either signed off a relay or handed over an authenticated peering request,
 * and it is recorded with the provenance that matches.
 *
 * Everything here is best-effort by design. A friend whose kernel is asleep,
 * behind a dead onion, or simply switched off is an ordinary state of the
 * world — it is logged and the sweep moves on to the next one.
 */
import { log } from "../../../../../src/core/logger.js";
import type { PeeringService } from "../../../../../src/core/peering/service.js";
import type { CinemaDirectory, CinemaDirectoriesService as DirectoriesService } from "./directories-service.js";

export const FRIENDS_ENDPOINT = "/api/cinema/directories/friend-view";
/** A friend's whole list is a few KB; this cap is about a peer gone wrong. */
export const MAX_DIRECTORIES_PER_FRIEND = 200;

export interface SyncOutcome {
  npub: string;
  ok: boolean;
  created: number;
  updated: number;
  error?: string;
  via?: string;
}

export class FriendsDirectorySync {
  constructor(
    private deps: {
      peering: PeeringService;
      directories: DirectoriesService;
    },
  ) {}

  /** Sweep every trusted friend once. Never throws. */
  async syncAll(): Promise<SyncOutcome[]> {
    const friends = this.deps.peering.friends.trusted();
    const out: SyncOutcome[] = [];
    for (const friend of friends) {
      out.push(await this.syncOne(friend.npub));
    }
    const ok = out.filter((o) => o.ok).length;
    if (friends.length > 0) {
      log.info(`cinema: directory sync reached ${ok}/${friends.length} friend(s)`);
    }
    return out;
  }

  async syncOne(npub: string): Promise<SyncOutcome> {
    const res = await this.deps.peering.client.get<{ directories?: CinemaDirectory[] }>(
      npub,
      FRIENDS_ENDPOINT,
    );
    if (!res.ok) {
      return { npub, ok: false, created: 0, updated: 0, error: res.error, via: res.via };
    }

    const list = Array.isArray(res.data?.directories) ? res.data!.directories! : [];
    let created = 0;
    let updated = 0;
    for (const dir of list.slice(0, MAX_DIRECTORIES_PER_FRIEND)) {
      if (!isPlausible(dir)) continue;
      const result = this.deps.directories.upsertFromFriend(dir, npub);
      if (result === "created") created++;
      else if (result === "updated") updated++;
    }
    return { npub, ok: true, created, updated, via: res.via };
  }
}

/**
 * A friend is trusted to share, not to send us anything at all. Shape is
 * checked before it reaches the database.
 */
function isPlausible(dir: unknown): dir is CinemaDirectory {
  if (!dir || typeof dir !== "object") return false;
  const d = dir as Partial<CinemaDirectory>;
  if (typeof d.id !== "string" || d.id.length === 0 || d.id.length > 128) return false;
  if (typeof d.title !== "string" || d.title.length > 500) return false;
  if (typeof d.owner_pubkey !== "string") return false;
  if (!Array.isArray(d.items)) return false;
  if (d.items.length > 5000) return false;
  return true;
}
