/**
 * Nostr provider for community-curated movie directories.
 *
 * Mirrors the design of nostr-provider.ts (subs marketplace) but for a
 * different kind:
 *   - kind 30079 (NIP-78 parameterized replaceable, app-specific data)
 *   - d-tag:  "mtwcinema:dir:<directory_id>"
 *   - t-tags: "mtwcinema-directories"             (firehose)
 *             "mtwcinema-dir:<category>"          (per-category index)
 *             "mtwcinema-dir-owner:<pubkey>"      (per-owner index)
 *   - content: full directory JSON (title, description, items[],
 *              collaborators[], version, ...)
 *
 * Why a separate file instead of extending NostrSubsProvider: the
 * payload + validation rules are different (subs are immutable
 * announcements, directories are versioned mutable lists with co-sign
 * rules). Sharing a base would obscure both.
 */

import type { Event as NostrEvent } from "nostr-tools/core";
import { NostrIdentity } from "../../../../../../src/core/nostr/nostr-identity.js";
import { NostrRelayPool } from "../../../../../../src/core/nostr/nostr-relay-pool.js";
import { log } from "../../../../../../src/core/logger.js";
import type {
  CinemaDirectory,
  DirectoryItem,
  DirectoryVisibility,
} from "../directories-service.js";

const KIND = 30079;
const TOPIC_GLOBAL = "mtwcinema-directories";
const TOPIC_CATEGORY_PREFIX = "mtwcinema-dir:";
const TOPIC_OWNER_PREFIX = "mtwcinema-dir-owner:";
const D_TAG_PREFIX = "mtwcinema:dir:";

/** The event payload — what lives in event.content. Schema-versioned so
 *  we can evolve the on-the-wire shape without breaking older peers. */
export interface DirectoryPayload {
  schema: 1;
  id: string;
  owner_pubkey: string;
  title: string;
  description: string;
  category: string;
  cover_identifier: string;
  visibility: DirectoryVisibility;
  items: DirectoryItem[];
  collaborators: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ParsedDirectoryEvent {
  eventId: string;
  signerPubkey: string;
  createdAtSec: number;
  directoryId: string;
  payload: DirectoryPayload;
}

function tagValue(ev: NostrEvent, name: string): string {
  for (const t of ev.tags) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === "string") return t[1];
  }
  return "";
}

/** Defensive parse: Nostr events are untrusted input. Returns null on
 *  any malformedness so the caller can skip + log without throwing. */
export function parseDirectoryEvent(ev: NostrEvent): ParsedDirectoryEvent | null {
  if (ev.kind !== KIND) return null;
  const dTag = tagValue(ev, "d");
  if (!dTag.startsWith(D_TAG_PREFIX)) return null;
  const directoryId = dTag.slice(D_TAG_PREFIX.length);
  if (!directoryId) return null;

  let payload: DirectoryPayload;
  try {
    const parsed = JSON.parse(ev.content) as Partial<DirectoryPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schema !== 1) return null;
    if (typeof parsed.id !== "string" || parsed.id !== directoryId) return null;
    if (typeof parsed.owner_pubkey !== "string") return null;
    if (typeof parsed.title !== "string") return null;
    if (!Array.isArray(parsed.items)) return null;
    if (!Array.isArray(parsed.collaborators)) return null;
    payload = {
      schema: 1,
      id: parsed.id,
      owner_pubkey: parsed.owner_pubkey,
      title: parsed.title,
      description: typeof parsed.description === "string" ? parsed.description : "",
      category: typeof parsed.category === "string" ? parsed.category : "",
      cover_identifier: typeof parsed.cover_identifier === "string" ? parsed.cover_identifier : "",
      visibility: (parsed.visibility === "unlisted" || parsed.visibility === "private")
        ? parsed.visibility : "public",
      items: parsed.items.filter((it): it is DirectoryItem =>
        !!it && typeof (it as DirectoryItem).identifier === "string",
      ).map((it) => ({
        identifier: it.identifier,
        note: typeof it.note === "string" ? it.note : undefined,
        added_at: typeof it.added_at === "string" ? it.added_at : "",
      })),
      collaborators: parsed.collaborators.filter((p): p is string => typeof p === "string"),
      version: typeof parsed.version === "number" ? parsed.version : 1,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    };
  } catch {
    return null;
  }
  return {
    eventId: ev.id,
    signerPubkey: ev.pubkey,
    createdAtSec: ev.created_at,
    directoryId,
    payload,
  };
}

export interface NostrDirectoriesConfig {
  relays?: string[];
  /** Pre-built pool to share with other modules. When set, this
   *  provider does NOT close it on shutdown. */
  sharedPool?: NostrRelayPool;
  queryTimeoutMs?: number;
}

export interface DiscoverFilter {
  /** Restrict to a single owner (subscriptions). */
  ownerPubkey?: string;
  /** Restrict to a single directory id. */
  directoryId?: string;
  /** Filter by category — uses the per-category t-tag. */
  category?: string;
  /** Only events newer than this iso timestamp. */
  since?: string;
  limit?: number;
}

export class NostrDirectoriesProvider {
  readonly id = "nostr" as const;
  private pool: NostrRelayPool;
  private ownsPool: boolean;
  private identity: NostrIdentity | null;
  private queryTimeoutMs: number;

  constructor(identity: NostrIdentity | null, config: NostrDirectoriesConfig = {}) {
    this.identity = identity;
    if (config.sharedPool) {
      this.pool = config.sharedPool;
      this.ownsPool = false;
    } else {
      this.pool = new NostrRelayPool(config.relays ?? [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.snort.social",
      ]);
      this.ownsPool = true;
    }
    this.queryTimeoutMs = config.queryTimeoutMs ?? 5000;
  }

  get canPublish(): boolean { return this.identity !== null; }

  /** Optional public-base URL to embed in social-post announcements
   *  ("📁 https://my-host/cinema/directories/<id>"). Read from
   *  DASHBOARD_PUBLIC_URL when the kernel is reachable from the open
   *  internet; left empty otherwise — the kind-1 still goes out, just
   *  without a clickable link. */
  private get publicBase(): string {
    const raw: string = (typeof process !== "undefined" && typeof process.env?.DASHBOARD_PUBLIC_URL === "string")
      ? process.env.DASHBOARD_PUBLIC_URL
      : "";
    return raw.replace(/\/+$/, "");
  }

  /**
   * After publishing a kind-30079 directory event, emit a regular kind-1
   * Nostr post that announces it. This makes directories discoverable
   * via standard social clients (Damus, Snort, the kernel's own /social)
   * without those clients needing to understand kind 30079 specifically.
   *
   * Tags are chosen so the post can be filtered out from a "show only
   * cinema" view (`#t=mtwcinema-directory`) AND linked back to the
   * underlying record (`#d=mtwcinema:dir:<id>`, `#e=<event_id>`).
   */
  private async announceToSocial(directory: CinemaDirectory, dirEventId: string): Promise<void> {
    if (!this.identity) return;
    const link = this.publicBase
      ? `${this.publicBase}/cinema/directories#${directory.id}`
      : "";
    const lines = [
      `📁 ${directory.title}`,
      directory.description ? directory.description.slice(0, 280) : "",
      `${directory.items.length} pelis${directory.category ? ` · #${directory.category}` : ""}`,
    ].filter(Boolean);
    if (link) lines.push(link);
    const note = this.identity.signEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "mtwcinema"],
        ["t", "mtwcinema-directory"],
        ["d", `${D_TAG_PREFIX}${directory.id}`],
        ["e", dirEventId],
        ["client", "Kernl/cinema-directories"],
      ],
      content: lines.join("\n"),
    });
    try {
      await this.pool.publish(note);
    } catch (err) {
      log.warn(`cinema/dir-nostr: announce kind-1 failed — ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Publish (create or update) a directory. Bumps version is the
   *  caller's responsibility — the on-the-wire payload carries whatever
   *  version the local row has. Returns the signed event. */
  async publish(directory: CinemaDirectory): Promise<{ eventId: string; relays: string[] }> {
    // A relay is a public place. `friends` and `private` directories travel
    // the peering lane instead. Checked before anything else — including
    // whether an identity exists — so the guarantee cannot depend on how the
    // kernel happens to be configured.
    if (directory.visibility === "friends" || directory.visibility === "private") {
      throw new Error(
        `directory ${directory.id} is ${directory.visibility} — it is never published to relays`,
      );
    }
    if (!this.identity) throw new Error("Nostr identity not configured — cannot publish");
    const payload: DirectoryPayload = {
      schema: 1,
      id: directory.id,
      owner_pubkey: directory.owner_pubkey,
      title: directory.title,
      description: directory.description,
      category: directory.category,
      cover_identifier: directory.cover_identifier,
      visibility: directory.visibility,
      items: directory.items,
      collaborators: directory.collaborators,
      version: directory.version,
      created_at: directory.created_at,
      updated_at: directory.updated_at,
    };
    const tags: string[][] = [
      ["d", `${D_TAG_PREFIX}${directory.id}`],
      ["t", TOPIC_GLOBAL],
    ];
    if (directory.category) tags.push(["t", `${TOPIC_CATEGORY_PREFIX}${directory.category}`]);
    tags.push(["t", `${TOPIC_OWNER_PREFIX}${directory.owner_pubkey}`]);
    if (directory.title) tags.push(["title", directory.title]);

    const event = this.identity.signEvent({
      kind: KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify(payload),
    });
    const outcomes = await this.pool.publish(event);
    const okRelays = outcomes.filter((o) => o.ok).map((o) => o.relay);
    if (okRelays.length === 0) {
      const errs = outcomes.map((o) => `${o.relay}: ${o.error ?? "?"}`).join(" | ");
      throw new Error(`no relay accepted directory event — ${errs.slice(0, 240)}`);
    }
    log.debug?.(`cinema/dir-nostr: published ${event.id.slice(0, 12)} v${directory.version} to ${okRelays.length}/${outcomes.length} relays`);
    // Public/unlisted directories also get a kind-1 announcement so the
    // social timeline (and any external Nostr client) surfaces them as a
    // normal post. Nothing else can reach here: private and friends-only
    // directories are refused at the top of this method.
    // Fire-and-forget — the caller already got the success path.
    this.announceToSocial(directory, event.id).catch(() => undefined);
    return { eventId: event.id, relays: okRelays };
  }

  /** Discover directories on the network. Builds the appropriate Nostr
   *  filter from the discover criteria. */
  async discover(filter: DiscoverFilter): Promise<ParsedDirectoryEvent[]> {
    const tags: string[] = [];
    if (filter.directoryId) {
      // Note: NIP-01 requires #d filtering — relays index it for replaceable kinds.
      tags.push(`${D_TAG_PREFIX}${filter.directoryId}`);
    } else if (filter.ownerPubkey) {
      tags.push(`${TOPIC_OWNER_PREFIX}${filter.ownerPubkey}`);
    } else if (filter.category) {
      tags.push(`${TOPIC_CATEGORY_PREFIX}${filter.category}`);
    } else {
      tags.push(TOPIC_GLOBAL);
    }
    const since = filter.since
      ? Math.floor(new Date(filter.since).getTime() / 1000)
      : undefined;
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    const queryFilter: Record<string, unknown> = {
      kinds: [KIND],
      limit,
    };
    if (filter.directoryId) {
      queryFilter["#d"] = tags;
    } else {
      queryFilter["#t"] = tags;
    }
    if (filter.ownerPubkey && !filter.directoryId) {
      queryFilter.authors = [filter.ownerPubkey];
    }
    if (since !== undefined) queryFilter.since = since;

    const events = await this.pool.querySync([queryFilter as never], this.queryTimeoutMs);
    const parsed: ParsedDirectoryEvent[] = [];
    for (const ev of events) {
      const p = parseDirectoryEvent(ev);
      if (p) parsed.push(p);
    }
    // Dedupe by directory id keeping the newest event.
    const byId = new Map<string, ParsedDirectoryEvent>();
    for (const p of parsed) {
      const existing = byId.get(p.directoryId);
      if (!existing || p.createdAtSec > existing.createdAtSec) byId.set(p.directoryId, p);
    }
    return [...byId.values()];
  }

  async close(): Promise<void> {
    if (this.ownsPool) this.pool.close();
  }
}
