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
import { loadOrCreateCoreNostrIdentity } from "../nostr/identity-store.js";
import { FriendsStore } from "./friends-store.js";
import { PeerResolver, buildReach } from "./resolver.js";
import { PeerClient } from "./client.js";
import { detectTor, makeTorAwareFetch, isTorListening, DEFAULT_HTTP_TUNNEL_PORT } from "./tor.js";
import { PresenceAnnouncer } from "./announce.js";
import type { NostrRelayPool } from "../nostr/nostr-relay-pool.js";
import { buildDescriptor, signDescriptor, DEFAULT_PRIORITY, type InstanceDescriptor } from "./descriptor.js";

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
    });

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
    const identity = loadOrCreateCoreNostrIdentity(opts.sqlite, opts.encryptionKey);
    if (!identity) {
      log.warn("peering: no instance identity — peering disabled");
      return null;
    }
    const service = new PeeringService(identity, opts);
    PeeringService.current = service;
    return service;
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
        lanUrl: host ? `http://${host}.local:${this.opts.port}` : undefined,
        directUrl: this.opts.directUrl || process.env.KERNEL_PUBLIC_URL || undefined,
        onionUrl: onionUrl || undefined,
        priorities: DEFAULT_PRIORITY,
      }),
      endpoints: { directories: "/api/cinema/directories" },
    });
  }
}
