/**
 * PeeringService — assembles the peering layer and keeps the instance's own
 * descriptor current. Bootstrap constructs one of these and everything else
 * (routes, the cinema sync, future consumers) hangs off it.
 */
import { hostname } from "node:os";
import type { Event as NostrEvent } from "nostr-tools/core";
import type { SqliteDb } from "../db/sqlite.js";
import { log } from "../logger.js";
import { NostrIdentity } from "../nostr/nostr-identity.js";
import { loadOrCreateCoreNostrIdentity, instanceKeyIsShared } from "../nostr/identity-store.js";
import { FriendsStore } from "./friends-store.js";
import { PeerResolver, buildReach } from "./resolver.js";
import { PeerClient } from "./client.js";
import { detectTor, makeTorAwareFetch, isTorListening, DEFAULT_HTTP_TUNNEL_PORT } from "./tor.js";
import { PresenceAnnouncer } from "./announce.js";
import type { NostrRelayPool } from "../nostr/nostr-relay-pool.js";
import { buildDescriptor, signDescriptor, DEFAULT_PRIORITY, type InstanceDescriptor } from "./descriptor.js";
import { currentLanEnv, lanReachUrls } from "./lan.js";
import { buildLinkProof, sealLinkProof, type LinkProof, type SealedLinkProof } from "../social-net/link-proof.js";

/** A friend that answered which persona runs there is asked again after this. */
export const PERSONA_REFRESH_MS = 6 * 60 * 60 * 1000;
/** A persona fetch that never got an answer (offline, timeout, 5xx) is retried after this. */
export const PERSONA_RETRY_MS = 10 * 60 * 1000;

export const SHARED_KEY_WARNING =
  "peering: instance key equals the public persona key: presence links them publicly; rotate the persona";

export interface PeeringOptions {
  sqlite: SqliteDb;
  encryptionKey: string;
  /** Relays for presence. Omit to run HTTP-only (no "friend moved" recovery). */
  pool?: NostrRelayPool;
  /** Cosmetic instance name. Falls back to the machine hostname. */
  name?: string;
  version: string;
  /** Port the kernel HTTP server listens on, for the LAN URL. */
  port: number;
  /** Public URL when the operator has one (KERNEL_PUBLIC_URL). */
  directUrl?: string;
  dataDir?: string;
}

export class PeeringService {
  readonly identity: NostrIdentity;
  readonly friends: FriendsStore;
  readonly resolver: PeerResolver;
  readonly client: PeerClient;
  readonly announcer: PresenceAnnouncer | null;

  private descriptor: InstanceDescriptor;
  private signed: NostrEvent;
  /** Link-proof for the Social persona running here; memory only, friends only. */
  private personaProof: LinkProof | null = null;
  /** npub → earliest time its persona may be asked for again. Memory only. */
  private personaNextAt = new Map<string, number>();
  /** npubs whose persona fetch is running right now. */
  private personaInFlight = new Set<string>();
  /** Clock, swappable in tests. */
  now: () => number = () => Date.now();

  private constructor(identity: NostrIdentity, private opts: PeeringOptions) {
    this.identity = identity;
    this.friends = new FriendsStore(opts.sqlite);

    const tor = detectTor({ dataDir: opts.dataDir });
    const fetchImpl = makeTorAwareFetch(fetch, tor.httpProxy);

    // Announcing is optional: without relays the instance still serves its
    // descriptor over HTTP, it just cannot be found again after it moves.
    this.announcer = opts.pool
      ? new PresenceAnnouncer({ pool: opts.pool, currentDescriptor: () => this.signed })
      : null;

    this.resolver = new PeerResolver({
      friends: this.friends,
      fetchImpl,
      lookupPresence: this.announcer ? (npub) => this.announcer!.lookup(npub) : undefined,
    });
    this.client = new PeerClient({
      identity,
      friends: this.friends,
      resolver: this.resolver,
      fetchImpl,
      // Any successful request to a friend is a good moment to learn its
      // persona: it is answering right now. Throttled in refreshPersona.
      onFriendAnswered: (npub) => void this.refreshPersona(npub),
    });
    // A friend just became trusted: ask now, regardless of the throttle.
    this.friends.onTrusted((npub) => void this.refreshPersona(npub, { force: true }));

    this.descriptor = this.buildOwn(tor.onionUrl);
    this.signed = signDescriptor(identity, this.descriptor);

    log.info(
      `peering: instance is ${identity.npub().slice(0, 16)}… with ${this.descriptor.reach.length} reach entr${
        this.descriptor.reach.length === 1 ? "y" : "ies"
      }${tor.available ? " (onion up)" : ""}`,
    );
  }

  /**
   * The live instance, for consumers that cannot be threaded a reference —
   * extensions load after bootstrap and would otherwise need the service
   * passed through every layer between.
   *
   * Held on globalThis rather than in a module-level field because each
   * extension is bundled separately: an extension importing this file gets its
   * own copy of the module, so a plain static would always read back null
   * there. globalThis is the one slot they genuinely share.
   */
  static get current(): PeeringService | null {
    return (globalThis as { __kernlPeering?: PeeringService }).__kernlPeering ?? null;
  }

  static set current(service: PeeringService | null) {
    (globalThis as { __kernlPeering?: PeeringService | null }).__kernlPeering = service;
  }

  /** Returns null when no instance key is available; peering then stays off. */
  static create(opts: PeeringOptions): PeeringService | null {
    let identity: NostrIdentity | null;
    try {
      identity = loadOrCreateCoreNostrIdentity(opts.sqlite, opts.encryptionKey);
    } catch (err) {
      // An instance key that exists but cannot be read must not be replaced:
      // run without peering rather than as a different instance.
      log.warn(`peering: instance key unreadable — peering disabled: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (!identity) {
      log.warn("peering: no instance identity — peering disabled");
      return null;
    }
    const service = new PeeringService(identity, opts);
    // Every boot, until it is fixed: a shared key ties the public persona to
    // this instance for anyone watching the relays.
    if (service.instanceKeyIsShared()) log.warn(SHARED_KEY_WARNING);
    PeeringService.current = service;
    return service;
  }

  /** The instance key — what extensions sign machine-level events with. */
  instanceNostrIdentity(): NostrIdentity {
    return this.identity;
  }

  /**
   * True when the instance key is the Social persona key (legacy continuity,
   * see identity-store.ts). Anything signed "as the instance" would then be
   * signed by the persona, so instance-level public announcements must not go
   * out. Read live: cheap, and it flips once the key is rotated.
   */
  instanceKeyIsShared(): boolean {
    return instanceKeyIsShared(this.opts.sqlite, this.opts.encryptionKey);
  }

  /**
   * The Social persona running on this instance, or null to withdraw it.
   *
   * The proof is built right here and only the proof is kept: the persona's
   * secret key passes through this call and is never stored. Only trusted
   * friends can fetch the proof (GET /api/peering/persona).
   *
   * First registration wins: while a persona is registered, a different one
   * is ignored (with a warning) — one instance runs one persona, and a second
   * caller must not be able to swap it. Registering the same persona again is
   * a no-op. A persona equal to the instance key (legacy shared key) proves
   * nothing and is ignored. Returns true when `persona` is now the registered one.
   *
   * Proofs carry created_at but do not expire: a friend keeps the binding
   * until the persona is withdrawn (404) or the friendship is revoked.
   */
  registerPersona(persona: NostrIdentity | null): boolean {
    if (!persona) {
      this.personaProof = null;
      return false;
    }
    if (persona.pubkeyHex === this.identity.pubkeyHex) return false;
    if (this.personaProof) {
      if (this.personaProof.persona === persona.pubkeyHex) return true;
      log.warn("peering: a different persona is already registered for this instance — ignored");
      return false;
    }
    this.personaProof = buildLinkProof(this.identity, persona);
    return true;
  }

  personaLinkProof(): LinkProof | null {
    return this.personaProof;
  }

  /** Our persona proof sealed (NIP-44 v2) for one friend's instance key. */
  sealPersonaProofFor(proof: LinkProof, friendPubkeyHex: string): SealedLinkProof {
    return sealLinkProof(proof, this.identity.secretKey, friendPubkeyHex);
  }

  /**
   * Learn which persona a friend runs, best-effort and throttled per friend:
   * after an answer (proof, 404, 403) the friend is not asked again for
   * PERSONA_REFRESH_MS; after no answer (offline, timeout, 5xx) for
   * PERSONA_RETRY_MS. The throttle is only set once a fetch completes, so a
   * fetch that dies half-way never blocks the next attempt for hours. `force`
   * skips the throttle (a friend that just became trusted), never the
   * one-at-a-time guard. Never throws.
   */
  async refreshPersona(npub: string, opts: { force?: boolean } = {}): Promise<void> {
    if (this.personaInFlight.has(npub)) return;
    if (!opts.force && this.now() < (this.personaNextAt.get(npub) ?? 0)) return;
    this.personaInFlight.add(npub);
    try {
      const out = await this.client.fetchPersonaOutcome(npub);
      this.personaNextAt.set(npub, this.now() + (out.definitive ? PERSONA_REFRESH_MS : PERSONA_RETRY_MS));
    } catch {
      this.personaNextAt.set(npub, this.now() + PERSONA_RETRY_MS);
    } finally {
      this.personaInFlight.delete(npub);
    }
  }

  /** Persona pubkeys (hex) of trusted friends, from their verified link-proofs. */
  friendPersonas(): string[] {
    return this.friends.trustedPersonas();
  }

  selfNpub(): string {
    return this.identity.npub();
  }

  currentDescriptor(): NostrEvent {
    return this.signed;
  }

  /**
   * Begin announcing presence. Before the first announcement, confirm tor is
   * actually up: the onion hostname persists in the data volume, so a kernel
   * started with tor off would otherwise advertise an address that answers
   * nobody and cost every friend a full circuit timeout.
   */
  async start(): Promise<void> {
    await this.reconcileOnion();
    this.announcer?.start();
  }

  /** Drop or restore the onion entry according to whether tor is listening. */
  private async reconcileOnion(): Promise<void> {
    const advertising = this.descriptor.reach.some((r) => r.kind === "onion");
    const tor = detectTor({ dataDir: this.opts.dataDir });
    const port = Number(process.env.KERNEL_TOR_HTTP_PORT ?? DEFAULT_HTTP_TUNNEL_PORT);
    const live = tor.available ? await isTorListening(port) : false;

    if (advertising && !live) {
      log.warn("peering: tor is not listening — dropping the onion address from our reach");
      this.descriptor = this.buildOwn("");
      this.signed = signDescriptor(this.identity, this.descriptor);
    } else if (!advertising && live && tor.onionUrl) {
      log.info("peering: tor came up — advertising the onion address");
      this.descriptor = this.buildOwn(tor.onionUrl);
      this.signed = signDescriptor(this.identity, this.descriptor);
    }
  }

  stop(): void {
    this.announcer?.stop();
  }

  /**
   * Rebuild after something about our reachability changed (e.g. tor came up)
   * and tell the relays, so friends do not keep probing a dead address.
   */
  refresh(): void {
    const tor = detectTor({ dataDir: this.opts.dataDir });
    this.descriptor = this.buildOwn(tor.onionUrl);
    this.signed = signDescriptor(this.identity, this.descriptor);
    void this.announcer?.publishOnce();
  }

  private buildOwn(onionUrl: string): InstanceDescriptor {
    const host = hostname().replace(/\.local$/, "");
    // A container hostname is a hex blob; let the operator name the instance,
    // since this string is what a friend sees in their list.
    const name = this.opts.name || process.env.KERNEL_INSTANCE_NAME || host || "kernl";
    return buildDescriptor(this.identity, {
      name,
      version: this.opts.version,
      reach: buildReach({
        lanUrls: lanReachUrls(currentLanEnv(this.opts.port)),
        directUrl: this.opts.directUrl || process.env.KERNEL_PUBLIC_URL || undefined,
        onionUrl: onionUrl || undefined,
        priorities: DEFAULT_PRIORITY,
      }),
      endpoints: { directories: "/api/cinema/directories" },
    });
  }
}
