/**
 * Nostr-backed subtitle discovery (kind 30078).
 *
 * Why kind 30078: NIP-78 — application-specific replaceable events. The
 * `d` tag is the dedupe key, so re-publishing the same sub (e.g. when
 * the cinema module restarts) replaces the previous event in relay
 * indexes without spawning duplicates.
 *
 * Why not custom tags like `#video`: damus + nostr.wine reject filters
 * on tags they don't index ("bad req: unindexed tag filter"). The probe
 * in scripts/demo-cinema-nostr.ts caught this — see commit history for
 * the gory details. Using `t` (the universal hashtag tag) sidesteps it.
 *
 * Identity: passed in from outside (typically derived from the social
 * module's ed25519 seed). Reusing the kernel's existing Nostr pubkey
 * means subs and social posts share trust — when someone marks @alice
 * as trusted in the cinema module, their social posts inherit the
 * relationship without extra plumbing.
 */

import type { Event as NostrEvent } from "nostr-tools/core";
import { NostrIdentity } from "../../../../../../src/core/nostr/nostr-identity.js";
import { NostrRelayPool } from "../../../../../../src/core/nostr/nostr-relay-pool.js";
import { log } from "../../../../../../src/core/logger.js";
import {
  ProviderNotPublishableError,
  type PublishInput,
  type PublishOutcome,
  type SubAnnouncement,
  type SubFilter,
  type SubsDiscoveryProvider,
} from "./provider.js";

/** NIP-78 parameterized replaceable event kind for app-specific data. */
const KIND = 30078;
/** Relay-universal topic tag prefix. We emit one global ("mtwcinema")
 *  and one per video ("mtwcinema:<identifier>") so any relay-side
 *  hashtag index lights up. */
const TOPIC_GLOBAL = "mtwcinema";
const TOPIC_VIDEO_PREFIX = "mtwcinema:";

/** Default per-query timeout. Some relays linger past EOSE; this caps it. */
const DEFAULT_QUERY_TIMEOUT_MS = 5000;

function videoTopic(identifier: string): string {
  return `${TOPIC_VIDEO_PREFIX}${identifier}`;
}

/** Pull a tag value out of a Nostr event (first match). */
function tagValue(ev: NostrEvent, name: string): string {
  for (const t of ev.tags) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === "string") return t[1];
  }
  return "";
}

/** Map a verified Nostr event into our announcement shape. Returns null
 *  for malformed events (missing identifier, wrong shape) — we skip
 *  rather than throw because remote events aren't trusted input. */
function eventToAnnouncement(ev: NostrEvent): SubAnnouncement | null {
  const identifier = tagValue(ev, "video");
  // Some events tag the video via `t` ("mtwcinema:<id>") instead of an
  // explicit `video` tag — derive it from the topic if needed.
  let id = identifier;
  if (!id) {
    for (const t of ev.tags) {
      if (Array.isArray(t) && t[0] === "t" && typeof t[1] === "string"
          && t[1].startsWith(TOPIC_VIDEO_PREFIX)) {
        id = t[1].slice(TOPIC_VIDEO_PREFIX.length);
        break;
      }
    }
  }
  if (!id) return null;
  const sizeRaw = tagValue(ev, "size");
  const size = parseInt(sizeRaw, 10);
  return {
    providerEventId: ev.id,
    providerId: "nostr",
    identifier: id,
    srcLang: tagValue(ev, "src_lang"),
    tgtLang: tagValue(ev, "tgt_lang"),
    engine: tagValue(ev, "engine"),
    engineVersion: tagValue(ev, "engine_version"),
    signerPubkey: ev.pubkey,
    magnet: tagValue(ev, "magnet"),
    webseedUrl: tagValue(ev, "webseed"),
    sha256: tagValue(ev, "sha256"),
    sizeBytes: Number.isFinite(size) ? size : 0,
    content: ev.content ?? "",
    observedAt: new Date(ev.created_at * 1000).toISOString(),
  };
}

export interface NostrSubsProviderConfig {
  /** Optional override of the relay set. Defaults to the social module's
   *  defaults minus paid relays (wine), since cinema content is
   *  long-tail / low-traffic and not worth nag-screens. Ignored when
   *  `sharedPool` is provided. */
  relays?: string[];
  /** Pre-built pool to share with other modules (e.g. social bridge).
   *  When set, the provider does NOT close it on shutdown — the owner
   *  is responsible. Reuses the same WebSocket sockets, cutting kernel-
   *  wide relay connections by ~3x. */
  sharedPool?: NostrRelayPool;
  /** Cap query timeouts for slow relays. */
  queryTimeoutMs?: number;
}

export class NostrSubsProvider implements SubsDiscoveryProvider {
  readonly id = "nostr" as const;
  readonly label = "Nostr";
  readonly canPublish: boolean;
  private pool: NostrRelayPool;
  private ownsPool: boolean;
  private identity: NostrIdentity | null;
  private queryTimeoutMs: number;

  constructor(
    identity: NostrIdentity | null,
    config: NostrSubsProviderConfig = {},
  ) {
    this.identity = identity;
    this.canPublish = identity !== null;
    if (config.sharedPool) {
      this.pool = config.sharedPool;
      this.ownsPool = false;
    } else {
      // Wine requires sign-up to publish — the Stage-0 probe rejected our
      // events. Keep it for queries (it's a good index) but avoid sending.
      const relays = config.relays ?? [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.snort.social",
      ];
      this.pool = new NostrRelayPool(relays);
      this.ownsPool = true;
    }
    this.queryTimeoutMs = config.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  }

  async available(): Promise<boolean> {
    // The pool opens connections lazily on first publish/query. Treat
    // the provider as always available; transport errors surface from
    // those calls. Returning false here would falsely disable a perfectly
    // working provider during a network blip.
    return true;
  }

  async query(filter: SubFilter): Promise<SubAnnouncement[]> {
    // Build the most specific filter we can. Per-video query is the
    // common case (player opens a movie → fetch its subs). When called
    // without identifier, fall back to the global topic — useful for
    // background indexing.
    const tags = filter.identifier
      ? [videoTopic(filter.identifier)]
      : [TOPIC_GLOBAL];

    const since = filter.since
      ? Math.floor(new Date(filter.since).getTime() / 1000)
      : undefined;
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 500));

    const events = await this.pool.querySync(
      [{ kinds: [KIND], "#t": tags, limit, since }],
      this.queryTimeoutMs,
    );

    const items: SubAnnouncement[] = [];
    for (const ev of events) {
      const ann = eventToAnnouncement(ev);
      if (!ann) continue;
      if (filter.identifier && ann.identifier !== filter.identifier) continue;
      if (filter.tgtLang && filter.tgtLang.length > 0 && !filter.tgtLang.includes(ann.tgtLang)) continue;
      items.push(ann);
    }
    return items;
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    if (!this.identity) throw new ProviderNotPublishableError(this.id);

    // d-tag: NIP-33 dedupe key. Same input → same `d` → relays replace
    // the prior version. Slash-separated for readability in logs.
    const dTag = `subs/archive-org/${input.identifier}/${input.srcLang || "auto"}/${input.tgtLang}/${input.engine || "auto"}/${input.engineVersion || "v0"}`;

    const event = this.identity.signEvent({
      kind: KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", dTag],
        ["t", TOPIC_GLOBAL],
        ["t", videoTopic(input.identifier)],
        ["video", input.identifier],
        ["src_lang", input.srcLang],
        ["tgt_lang", input.tgtLang],
        ["engine", input.engine],
        ["engine_version", input.engineVersion],
        ["magnet", input.magnet],
        ["webseed", input.webseedUrl],
        ["sha256", input.sha256],
        ["size", String(input.sizeBytes)],
        ["client", "Kernl/cinema-subs"],
      ],
      content: input.content,
    });

    const outcomes = await this.pool.publish(event);
    const oks = outcomes.filter((o) => o.ok);
    if (oks.length === 0) {
      const errs = outcomes.map((o) => `${o.relay}: ${o.error ?? "?"}`).join(" | ");
      throw new Error(`no relay accepted the announcement — ${errs.slice(0, 240)}`);
    }
    log.debug?.(
      `cinema/nostr: published ${event.id.slice(0, 12)} to ${oks.length}/${outcomes.length} relays`,
    );
    return {
      providerEventId: event.id,
      providerId: this.id,
      detail: `${oks.length}/${outcomes.length} relays accepted`,
    };
  }

  /** Cleanup. When the pool is shared (came from another module) we
   *  leave it alone — the owner closes it. Only providers that own
   *  their pool tear down sockets here. */
  async close(): Promise<void> {
    if (this.ownsPool) this.pool.close();
  }
}
