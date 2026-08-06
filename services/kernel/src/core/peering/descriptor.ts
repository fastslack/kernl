/**
 * The instance descriptor — how one Kernl tells another where it can be
 * reached right now.
 *
 * The identity is the instance's Nostr key; the URL is only where it happens
 * to answer today. That split is what lets a friend survive a move to a new
 * house, IP or network without any re-pairing.
 *
 * The descriptor travels as a *signed Nostr event* rather than a bespoke
 * document with a signature field: the same artifact can be published to
 * relays and served over HTTP, and verification is the library's verifyEvent
 * instead of hand-rolled crypto.
 */
import { npubEncode } from "nostr-tools/nip19";
import { getEventHash } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools/core";
import { NostrIdentity } from "../nostr/nostr-identity.js";
import { isoNow } from "../helpers.js";

/** NIP-78 application-specific replaceable event. */
export const PRESENCE_KIND = 30078;
export const PRESENCE_D_TAG = "kernl:presence";

/** How a peer can be reached, cheapest and most private first. */
export type ReachKind = "lan" | "direct" | "onion";

export interface ReachEntry {
  kind: ReachKind;
  /** Absolute origin, e.g. https://host or http://abcd.onion */
  url: string;
  /** Ascending: lower is tried first. */
  prio: number;
}

export interface InstanceDescriptor {
  /** Envelope version. Bumped only on a breaking shape change. */
  kernl: 1;
  npub: string;
  /** Self-declared, cosmetic. Never used for identity or routing. */
  name: string;
  software: { name: string; version: string };
  reach: ReachEntry[];
  /** Paths a peer may call, so endpoints can move without breaking friends. */
  endpoints: Record<string, string>;
  updated_at: string;
}

export const DEFAULT_PRIORITY: Record<ReachKind, number> = {
  lan: 10,
  direct: 20,
  onion: 30,
};

export interface BuildOptions {
  name: string;
  version: string;
  reach: ReachEntry[];
  endpoints?: Record<string, string>;
}

/** Build the descriptor for this instance. */
export function buildDescriptor(identity: NostrIdentity, opts: BuildOptions): InstanceDescriptor {
  return {
    kernl: 1,
    npub: identity.npub(),
    name: opts.name,
    software: { name: "kernl", version: opts.version },
    // Advertise only what actually exists, sorted the way it should be tried.
    reach: [...opts.reach].sort((a, b) => a.prio - b.prio),
    endpoints: opts.endpoints ?? {},
    updated_at: isoNow(),
  };
}

/** Wrap a descriptor into the signed, replaceable event that carries it. */
export function signDescriptor(
  identity: NostrIdentity,
  descriptor: InstanceDescriptor,
): NostrEvent {
  return identity.signEvent({
    kind: PRESENCE_KIND,
    created_at: Math.floor(Date.parse(descriptor.updated_at) / 1000),
    tags: [
      ["d", PRESENCE_D_TAG],
      ["kernl", "1"],
    ],
    content: JSON.stringify(descriptor),
  });
}

export interface VerifyOptions {
  /** When known, the npub we believe we are talking to. */
  expectNpub?: string;
}

/**
 * Verify a presence event and return the descriptor it carries, or null when
 * anything at all is off. There is no partial trust: a descriptor is either
 * fully verified or discarded.
 */
export function verifyDescriptor(
  event: NostrEvent,
  opts: VerifyOptions = {},
): InstanceDescriptor | null {
  if (!event || event.kind !== PRESENCE_KIND) return null;

  // Recompute the id from the fields rather than trusting the one supplied.
  // nostr-tools memoises verification on the event object, so a mutated copy
  // that carries the cached marker would otherwise sail through.
  try {
    const rehashed = getEventHash({
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
      pubkey: event.pubkey,
    });
    if (rehashed !== event.id) return null;
  } catch {
    return null;
  }
  if (!NostrIdentity.verify(event)) return null;

  const dTag = event.tags?.find((t) => t[0] === "d")?.[1];
  if (dTag !== PRESENCE_D_TAG) return null;

  let descriptor: InstanceDescriptor;
  try {
    descriptor = JSON.parse(event.content) as InstanceDescriptor;
  } catch {
    return null;
  }
  if (!descriptor || descriptor.kernl !== 1) return null;

  // The claimed npub must be the key that actually signed the event, or the
  // document could advertise someone else's identity with our reach.
  let signerNpub: string;
  try {
    signerNpub = npubEncode(event.pubkey);
  } catch {
    return null;
  }
  if (descriptor.npub !== signerNpub) return null;
  if (opts.expectNpub && opts.expectNpub !== signerNpub) return null;

  if (!Array.isArray(descriptor.reach)) return null;
  descriptor.reach = descriptor.reach
    .filter((r) => isSafeReach(r))
    .sort((a, b) => a.prio - b.prio);

  return descriptor;
}

/**
 * A reach entry is only usable if it is an absolute http(s) origin. Anything
 * else — file:, javascript:, a bare host — is dropped rather than trusted,
 * since these URLs end up in a fetch.
 */
export function isSafeReach(entry: ReachEntry): boolean {
  if (!entry || typeof entry.url !== "string") return false;
  if (!["lan", "direct", "onion"].includes(entry.kind)) return false;
  try {
    const u = new URL(entry.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname) return false;
    // An onion entry must actually be an onion address; otherwise a peer could
    // have us send onion-destined traffic out over the clearnet.
    if (entry.kind === "onion" && !u.hostname.endsWith(".onion")) return false;
    if (entry.kind !== "onion" && u.hostname.endsWith(".onion")) return false;
    return true;
  } catch {
    return false;
  }
}

/** npub for an x-only pubkey hex, or "" when it is not a valid key. */
export function npubOf(pubkeyHex: string): string {
  try {
    return npubEncode(pubkeyHex);
  } catch {
    return "";
  }
}

/** x-only pubkey hex for an npub, or "" when it does not decode. */
export function hexOf(npub: string): string {
  const decoded = NostrIdentity.decodeBech32(npub);
  return decoded && decoded.kind === "npub" ? decoded.hex : "";
}
