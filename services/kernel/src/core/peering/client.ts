/**
 * Talking to a friend's Kernl.
 *
 * Resolve the npub, sign the request with our instance key (NIP-98), send it.
 * The signature covers the exact URL and method, so the credential is useless
 * anywhere else — including to whoever relayed it.
 */
import { log } from "../logger.js";
import type { NostrIdentity } from "../nostr/nostr-identity.js";
import type { FriendsStore } from "./friends-store.js";
import { buildAuthHeader } from "./auth.js";
import type { PeerResolver, FetchLike } from "./resolver.js";
import { npubOf } from "./descriptor.js";
import { openLinkProof, verifyLinkProof } from "../social-net/link-proof.js";

export interface PeerResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  /** Which transport carried it — the first thing anyone asks when it is slow. */
  via?: string;
}

export interface PeerClientDeps {
  identity: NostrIdentity;
  friends: FriendsStore;
  resolver: PeerResolver;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  /**
   * Called after any request to a friend succeeds. The peering service uses
   * it to learn the friend's persona while they are known to be answering.
   * Must not throw (errors are swallowed anyway).
   */
  onFriendAnswered?: (npub: string) => void;
}

/** How a persona fetch ended. `definitive`: the friend gave an answer worth caching for hours. */
export interface PersonaFetchOutcome {
  persona: string | null;
  definitive: boolean;
}

export const REQUEST_TIMEOUT_MS = 15_000;
/**
 * A file part over Tor: the onion transport gives an 8 MiB body ~10 minutes
 * (see MIN_ONION_UPLOAD_BYTES_PER_SEC), so the caller must not abort sooner.
 */
export const ONION_PUT_TIMEOUT_MS = 11 * 60_000;
/** Where a friend hands over the link-proof of its Social persona. */
export const PERSONA_PATH = "/api/peering/persona";

export class PeerClient {
  constructor(private deps: PeerClientDeps) {}

  /**
   * GET a path from a friend. Returns a result object rather than throwing:
   * a friend being offline is normal and must never break a caller's loop.
   */
  async get<T = unknown>(npub: string, path: string): Promise<PeerResponse<T>> {
    return this.request<T>(npub, path, "GET");
  }

  async post<T = unknown>(npub: string, path: string, body: unknown): Promise<PeerResponse<T>> {
    return this.request<T>(npub, path, "POST", body);
  }

  /**
   * PUT raw bytes to a friend. The signature covers URL and method only — a
   * file part is not JSON — so callers put the part's hash in the query,
   * where the signed URL protects it.
   */
  async putBinary(npub: string, path: string, data: Uint8Array, timeoutMs = 120_000): Promise<PeerResponse<unknown>> {
    const friend = this.deps.friends.get(npub);
    if (!friend || friend.trust !== "trusted") return { ok: false, status: 0, error: "not a trusted friend" };
    const peer = await this.deps.resolver.resolve(npub);
    if (!peer) return { ok: false, status: 0, error: "unreachable" };
    const url = peer.origin.replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), isOnionUrl(url) ? Math.max(timeoutMs, ONION_PUT_TIMEOUT_MS) : timeoutMs);
    try {
      const auth = await buildAuthHeader(this.deps.identity, url, "PUT");
      const res = await this.deps.fetchImpl(url, {
        method: "PUT",
        headers: { authorization: auth, "content-type": "application/octet-stream" },
        body: data as unknown as BodyInit,
        signal: controller.signal,
      });
      const body = await res.json().catch(() => undefined);
      if (res.ok) {
        this.deps.friends.markSeen(npub, peer.origin);
        this.answered(npub);
      }
      return { ok: res.ok, status: res.status, data: body, via: peer.kind, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), via: peer.kind };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Forward someone else's already-signed request to a third instance.
   *
   * The inner Authorization header is passed through untouched: the far end
   * authenticates the *original* sender, not us. That is what keeps a relay
   * from being able to speak in its friends' names — it moves bytes, it does
   * not vouch for them.
   */
  async forward(opts: {
    npub: string;
    path: string;
    method: "GET" | "POST";
    body?: string;
    authHeader: string;
  }): Promise<PeerResponse<unknown>> {
    const friend = this.deps.friends.get(opts.npub);
    if (!friend || friend.trust !== "trusted") {
      return { ok: false, status: 0, error: "target is not a trusted friend" };
    }
    const peer = await this.deps.resolver.resolve(opts.npub);
    if (!peer) return { ok: false, status: 0, error: "target unreachable" };

    const url = peer.origin.replace(/\/+$/, "") + (opts.path.startsWith("/") ? opts.path : "/" + opts.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { authorization: opts.authHeader };
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const res = await this.deps.fetchImpl(url, {
        method: opts.method,
        headers,
        body: opts.body,
        signal: controller.signal,
      });
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        data: text,
        via: peer.kind,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, error: message, via: peer.kind };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask a trusted friend which Social persona runs on their instance and
   * remember it once its link-proof checks out against their instance key.
   * A 404 means they have none (any old one is forgotten); any other failure
   * keeps what we knew. Returns the persona hex, or null. Never throws.
   */
  async fetchPersona(npub: string): Promise<string | null> {
    return (await this.fetchPersonaOutcome(npub)).persona;
  }

  /**
   * fetchPersona, plus whether the answer was definitive: a proof (good or
   * bad), a 404 (no persona) or a 403 (they do not trust us) is an answer; a
   * network error, a timeout or a 5xx is not, and is worth retrying soon.
   * The proof arrives NIP-44 sealed to our instance key (openLinkProof).
   */
  async fetchPersonaOutcome(npub: string): Promise<PersonaFetchOutcome> {
    try {
      const friend = this.deps.friends.get(npub);
      if (!friend || friend.trust !== "trusted") return { persona: null, definitive: true };
      const res = await this.request<unknown>(npub, PERSONA_PATH, "GET");
      if (!res.ok) {
        // A persona is an extra: a friend without one (or on an older core)
        // must not show up as broken, so whatever error was there stays.
        this.deps.friends.markError(npub, friend.last_error);
        if (res.status === 404) this.deps.friends.setPersona(npub, "");
        return { persona: null, definitive: res.status === 404 || res.status === 403 };
      }
      const opened = openLinkProof(res.data, this.deps.identity.secretKey, friend.pubkey_hex);
      const checked = verifyLinkProof(opened, friend.pubkey_hex);
      if (!checked.ok) {
        log.debug(`peering: persona proof from ${npub} rejected: ${opened === null ? "not sealed for us" : checked.error}`);
        return { persona: null, definitive: true };
      }
      this.deps.friends.setPersona(npub, npubOf(checked.proof.persona));
      return { persona: checked.proof.persona, definitive: true };
    } catch (err) {
      log.debug(`peering: persona fetch from ${npub} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { persona: null, definitive: false };
    }
  }

  private answered(npub: string): void {
    try {
      this.deps.onFriendAnswered?.(npub);
    } catch {
      // best-effort by contract
    }
  }

  private async request<T>(
    npub: string,
    path: string,
    method: "GET" | "POST" | "PUT",
    body?: unknown,
  ): Promise<PeerResponse<T>> {
    const friend = this.deps.friends.get(npub);
    if (!friend) return { ok: false, status: 0, error: "not a friend" };
    if (friend.trust !== "trusted") {
      // Symmetric with the inbound rule: we do not talk to peers we have not
      // vouched for either.
      return { ok: false, status: 0, error: `friend is ${friend.trust}` };
    }

    const peer = await this.deps.resolver.resolve(npub);
    if (!peer) return { ok: false, status: 0, error: "unreachable" };

    const url = peer.origin.replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const auth = await buildAuthHeader(this.deps.identity, url, method, body);
      const headers: Record<string, string> = { authorization: auth };
      if (body !== undefined) headers["content-type"] = "application/json";

      const res = await this.deps.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.deps.friends.markError(npub, `HTTP ${res.status} from ${peer.kind}`);
        const errBody = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
        const detail = errBody && typeof errBody === "object" && typeof errBody.error === "string" ? errBody.error : undefined;
        return { ok: false, status: res.status, data: errBody, error: detail ?? `HTTP ${res.status}`, via: peer.kind };
      }
      const data = (await res.json()) as T;
      this.deps.friends.markSeen(npub, peer.origin);
      this.answered(npub);
      return { ok: true, status: res.status, data, via: peer.kind };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.friends.markError(npub, message);
      log.debug(`peering: request to ${npub} failed: ${message}`);
      return { ok: false, status: 0, error: message, via: peer.kind };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isOnionUrl(url: string): boolean {
  try { return new URL(url).hostname.endsWith(".onion"); } catch { return false; }
}
