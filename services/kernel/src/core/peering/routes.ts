/**
 * HTTP surface for peering.
 *
 * Two audiences with two different credentials:
 *   - the owner, through the dashboard, using the kernel token: manage friends.
 *   - other Kernl instances, using NIP-98: prove who they are.
 *
 * `/.well-known/kernl` is deliberately public and unauthenticated. It carries
 * no secrets and it is signed, so serving it to anyone is safe — and being
 * public is the point: it is how a friend finds you the first time.
 */
import type { IncomingMessage } from "node:http";
import { HttpError, type KernelHttpServer } from "../http-server.js";
import { log } from "../logger.js";
import { verifyRequest } from "./auth.js";
import type { PeerClient } from "./client.js";
import type { FriendsStore, Trust } from "./friends-store.js";
import type { PeerResolver } from "./resolver.js";
import { hexOf } from "./descriptor.js";
import type { Event as NostrEvent } from "nostr-tools/core";

export interface PeeringRoutesDeps {
  friends: FriendsStore;
  resolver: PeerResolver;
  /** Needed only for the relay endpoint; omit to leave relaying off. */
  client?: PeerClient;
  /** The current signed descriptor. A getter, since reach changes at runtime. */
  currentDescriptor: () => NostrEvent | null;
  selfNpub: () => string;
}

/** The absolute URL the peer signed. Rebuilt, never taken from a proxy header alone. */
function absoluteUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  return `${proto}://${host}${req.url ?? ""}`;
}

export function registerPeeringRoutes(server: KernelHttpServer, deps: PeeringRoutesDeps): void {
  // ── Public: who am I ────────────────────────────────────────
  server.route("GET", "/.well-known/kernl", () => {
    const event = deps.currentDescriptor();
    if (!event) throw new HttpError(503, "presence not ready");
    return event;
  });

  // ── Owner: our own identity ─────────────────────────────────
  server.route("GET", "/api/peering/whoami", () => {
    const event = deps.currentDescriptor();
    let descriptor: unknown = null;
    try {
      descriptor = event ? JSON.parse(event.content) : null;
    } catch {
      descriptor = null;
    }
    return { npub: deps.selfNpub(), descriptor };
  });

  // ── Owner: friends ──────────────────────────────────────────
  server.route("GET", "/api/peering/friends", () => ({ friends: deps.friends.list().map(publicView) }));

  server.route<{ npub?: string; petname?: string; note?: string }>("POST", "/api/peering/friends", ({ res, body }) => {
    const npub = (body.npub ?? "").trim();
    if (!npub || !hexOf(npub)) throw new HttpError(400, "a valid npub is required");
    const friend = deps.friends.add({ npub, petname: body.petname, note: body.note });
    if (!friend) throw new HttpError(400, "could not decode that npub");
    // A 201, so written here. Without `req`: that keeps json() synchronous
    // (no gzip), so the response is out before the helper looks at it.
    server.json(res, 201, { friends: deps.friends.list().map(publicView) });
  });

  server.route<{ petname?: string; note?: string; trust?: Trust }>("PUT", "/api/peering/friends/:npub", ({ params: { npub }, body }) => {
    if (body.trust && !["pending", "trusted", "revoked"].includes(body.trust)) {
      throw new HttpError(400, "invalid trust value");
    }
    const updated = deps.friends.update(npub, body);
    if (!updated) throw new HttpError(404, "not found");
    return { friends: deps.friends.list().map(publicView) };
  });

  server.route("DELETE", "/api/peering/friends/:npub", ({ params: { npub } }) => {
    deps.friends.remove(npub);
    return { friends: deps.friends.list().map(publicView) };
  });

  // ── Called by a friend: carry a request to a mutual friend ──
  // Last resort, for when two instances cannot see each other directly but
  // both can see this one.
  //
  // Left on the raw handler: it verifies a NIP-98 signature over the request,
  // and answers 503 before reading the body at all when relaying is off.
  server.post("/api/peering/relay", async (req, res) => {
    if (!deps.client) {
      server.json(res, 503, { error: "relay not available" });
      return;
    }
    try {
      const body = await server.parseBody<RelayRequest>(req);
      const auth = await verifyRequest({
        req,
        url: absoluteUrl(req),
        friends: deps.friends,
        body,
      });
      if (!auth.ok || !auth.npub) {
        server.json(res, 401, { error: "unauthorized" });
        return;
      }

      const verdict = checkRelay(body, auth.npub, (npub) => deps.friends.get(npub)?.trust === "trusted");
      if (!verdict.ok) {
        // Deliberately uninformative: whose trust was missing is not the
        // caller's business.
        log.debug(`peering: relay refused — ${verdict.reason}`);
        server.json(res, 403, { error: "refused" });
        return;
      }

      const out = await deps.client.forward({
        npub: body.target!,
        path: body.path!,
        method: (body.method ?? "GET").toUpperCase() as "GET" | "POST",
        body: body.body,
        authHeader: body.auth!,
      });
      server.json(res, out.ok ? 200 : 502, {
        ok: out.ok,
        status: out.status,
        data: out.data,
        via: out.via,
        error: out.error,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Owner: is this friend reachable right now? ──────────────
  server.route("POST", "/api/peering/friends/:npub/probe", async ({ params: { npub } }) => {
    const peer = await deps.resolver.resolve(npub);
    if (!peer) {
      return {
        reachable: false,
        error: deps.friends.get(npub)?.last_error ?? "unreachable",
      };
    }
    return { reachable: true, via: peer.kind, origin: peer.origin };
  });
}

/** Bodies a relay will carry. Small on purpose: this is metadata, not media. */
export const MAX_RELAY_BODY_BYTES = 256 * 1024;

export interface RelayRequest {
  target?: string;
  path?: string;
  method?: string;
  body?: string;
  /** The sender's own NIP-98 header for the inner request. */
  auth?: string;
}

/**
 * Decide whether a relay request is allowed, given who asked. Pure, so the
 * rules that keep this from becoming an open proxy can be tested directly.
 */
export function checkRelay(
  req: RelayRequest,
  senderNpub: string,
  isTrusted: (npub: string) => boolean,
): { ok: true } | { ok: false; reason: string } {
  if (!req.target || !req.path || !req.auth) return { ok: false, reason: "incomplete relay request" };
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") return { ok: false, reason: "method not relayable" };

  // Both ends must be ours. Relaying between two strangers is what would turn
  // this kernel into an open proxy for the whole network.
  if (!isTrusted(senderNpub)) return { ok: false, reason: "sender is not trusted" };
  if (!isTrusted(req.target)) return { ok: false, reason: "target is not trusted" };
  if (req.target === senderNpub) return { ok: false, reason: "sender and target are the same" };

  // No chaining: a relay that relays can be strung into a loop, and each hop
  // hides the origin a little more.
  if (req.path.startsWith("/api/peering/relay")) return { ok: false, reason: "relay chaining" };

  if (req.body !== undefined && Buffer.byteLength(req.body) > MAX_RELAY_BODY_BYTES) {
    return { ok: false, reason: "body over the relay cap" };
  }
  return { ok: true };
}

/** Never hand the raw row to the UI — pubkey_hex is redundant and noisy. */
function publicView(f: ReturnType<FriendsStore["list"]>[number]) {
  return {
    npub: f.npub,
    petname: f.petname,
    trust: f.trust,
    note: f.note,
    last_seen_at: f.last_seen_at,
    last_reach: f.last_reach,
    last_error: f.last_error,
    created_at: f.created_at,
  };
}
