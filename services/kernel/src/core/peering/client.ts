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
}

export const REQUEST_TIMEOUT_MS = 15_000;

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

  private async request<T>(
    npub: string,
    path: string,
    method: "GET" | "POST",
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
        return { ok: false, status: res.status, error: `HTTP ${res.status}`, via: peer.kind };
      }
      const data = (await res.json()) as T;
      this.deps.friends.markSeen(npub, peer.origin);
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
