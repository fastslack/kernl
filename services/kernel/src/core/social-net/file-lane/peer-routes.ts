/**
 * What another Kernl calls to send us something. NIP-98 on every request;
 * verifyRequest already refuses anyone who is not a trusted friend.
 * Token-exempt through PEER_AUTH_PATHS ("/api/peering/transfer").
 */
import type { KernelHttpServer } from "../../http-server.js";
import { isHttpError } from "../../http-server.js";
import type { FriendsStore } from "../../peering/friends-store.js";
import { verifyRequest } from "../../peering/auth.js";
import { absoluteUrl } from "../../peering/routes.js";
import { TransferReceiver, OfferError, type OfferBody, type ChunkResult } from "./receiver.js";
import { readBody } from "./body.js";
import { CHUNK_SIZE } from "./limits.js";

// no-space → 507 and write-failed → 422: both final for the sender's worker
// (it backs off only on 5xx/0 and treats 404/409/410 as "look again").
const CHUNK_STATUS: Record<ChunkResult, number> = {
  ok: 200, "bad-hash": 409, "not-accepted": 409, "not-found": 404, "out-of-range": 400, failed: 410,
  "no-space": 507, "write-failed": 422,
};

export function registerTransferPeerRoutes(server: KernelHttpServer, deps: { receiver: TransferReceiver; friends: FriendsStore }): void {
  const auth = async (req: Parameters<typeof absoluteUrl>[0], body?: unknown) =>
    verifyRequest({ req, url: absoluteUrl(req), friends: deps.friends, body });

  server.post("/api/peering/transfer/offer", async (req, res) => {
    try {
      const body = await server.parseBody<OfferBody>(req);
      const a = await auth(req, body);
      if (!a.ok || !a.npub) return server.json(res, 401, { error: "unauthorized" });
      server.json(res, 200, await deps.receiver.offer(a.npub, body));
    } catch (err) {
      if (err instanceof OfferError) return server.json(res, err.status, { error: err.message });
      server.json(res, isHttpError(err) ? err.status : 500, { error: String(err instanceof Error ? err.message : err) });
    }
  });

  server.get("/api/peering/transfer/:id", async (req, res) => {
    const a = await auth(req);
    if (!a.ok || !a.npub) return server.json(res, 401, { error: "unauthorized" });
    const id = (req as unknown as { params: Record<string, string> }).params.id;
    const s = deps.receiver.status(a.npub, id);
    server.json(res, s ? 200 : 404, s ?? { error: "not found" });
  });

  server.put("/api/peering/transfer/:id/files/:n/chunks/:k", async (req, res) => {
    try {
      const a = await auth(req);
      if (!a.ok || !a.npub) return server.json(res, 401, { error: "unauthorized" });
      const p = (req as unknown as { params: Record<string, string> }).params;
      const sha = new URL(req.url ?? "/", "http://x").searchParams.get("sha") ?? "";
      const data = await readBody(req, CHUNK_SIZE);
      const result = await deps.receiver.putChunk(a.npub, p.id, Number(p.n), Number(p.k), sha, new Uint8Array(data));
      if (result === "no-space" || result === "write-failed") {
        return server.json(res, CHUNK_STATUS[result], { result, error: deps.receiver.failureReason(a.npub, p.id) });
      }
      server.json(res, CHUNK_STATUS[result], { result });
    } catch (err) {
      server.json(res, isHttpError(err) ? err.status : 500, { error: String(err instanceof Error ? err.message : err) });
    }
  });

  server.post("/api/peering/transfer/:id/cancel", async (req, res) => {
    const a = await auth(req);
    if (!a.ok || !a.npub) return server.json(res, 401, { error: "unauthorized" });
    const id = (req as unknown as { params: Record<string, string> }).params.id;
    server.json(res, deps.receiver.cancelFromPeer(a.npub, id) ? 200 : 404, { state: "cancelled" });
  });
}
