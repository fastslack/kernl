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
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KernelHttpServer } from "../http-server.js";
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

function param(req: IncomingMessage, name: string): string {
  return (req as IncomingMessage & { params?: Record<string, string> }).params?.[name] ?? "";
}

export function registerPeeringRoutes(server: KernelHttpServer, deps: PeeringRoutesDeps): void {
  // ── Public: who am I ────────────────────────────────────────
  server.get("/.well-known/kernl", (_req, res: ServerResponse) => {
    const event = deps.currentDescriptor();
    if (!event) {
      server.json(res, 503, { error: "presence not ready" });
      return;
    }
    server.json(res, 200, event);
  });

  // ── Owner: our own identity ─────────────────────────────────
  server.get("/api/peering/whoami", (_req, res) => {
    const event = deps.currentDescriptor();
    let descriptor: unknown = null;
    try {
      descriptor = event ? JSON.parse(event.content) : null;
    } catch {
      descriptor = null;
    }
    server.json(res, 200, { npub: deps.selfNpub(), descriptor });
  });

  // ── Owner: friends ──────────────────────────────────────────
  server.get("/api/peering/friends", (_req, res) => {
    server.json(res, 200, { friends: deps.friends.list().map(publicView) });
  });

  server.post("/api/peering/friends", async (req, res) => {
    try {
      const body = await server.parseBody<{ npub?: string; petname?: string; note?: string }>(req);
      const npub = (body.npub ?? "").trim();
      if (!npub || !hexOf(npub)) {
        server.json(res, 400, { error: "a valid npub is required" });
        return;
      }
      const friend = deps.friends.add({ npub, petname: body.petname, note: body.note });
      if (!friend) {
        server.json(res, 400, { error: "could not decode that npub" });
        return;
      }
      server.json(res, 201, { friends: deps.friends.list().map(publicView) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.put("/api/peering/friends/:npub", async (req, res) => {
    try {
      const npub = param(req, "npub");
      const body = await server.parseBody<{ petname?: string; note?: string; trust?: Trust }>(req);
      if (body.trust && !["pending", "trusted", "revoked"].includes(body.trust)) {
        server.json(res, 400, { error: "invalid trust value" });
        return;
      }
      const updated = deps.friends.update(npub, body);
      if (!updated) {
        server.json(res, 404, { error: "not found" });
        return;
      }
      server.json(res, 200, { friends: deps.friends.list().map(publicView) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.delete("/api/peering/friends/:npub", (req, res) => {
    deps.friends.remove(param(req, "npub"));
    server.json(res, 200, { friends: deps.friends.list().map(publicView) });
  });

  // ── Called by a friend: carry a request to a mutual friend ──
  // Last resort, for when two instances cannot see each other directly but
  // both can see this one.
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
  server.post("/api/peering/friends/:npub/probe", async (req, res) => {
    try {
      const npub = param(req, "npub");
      const peer = await deps.resolver.resolve(npub);
      if (!peer) {
        server.json(res, 200, {
          reachable: false,
          error: deps.friends.get(npub)?.last_error ?? "unreachable",
        });
        return;
      }
      server.json(res, 200, { reachable: true, via: peer.kind, origin: peer.origin });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
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
