/**
 * Admin HTTP routes for the PairingManager (user-to-bot approval flow).
 *
 * When a new phone/user on WhatsApp/Telegram/Slack/etc. messages the bot,
 * the orchestrator intercepts the message and generates a short pairing
 * code. The user-facing client sends the code back to the owner, who
 * approves it from the dashboard (these routes) — after that the number
 * is trusted and the LLM handles its messages directly.
 *
 * Not to be confused with `/api/federation/pair` which is instance-to-
 * instance pairing between Kernl deployments.
 */

import type { KernelHttpServer } from "./http-server.js";
import type { PairingManager } from "../security/index.js";

export function registerPairingAdminRoutes(
  server: KernelHttpServer,
  pairingManager: PairingManager,
): void {
  // GET /api/security/pairing/pending — codes waiting for approval.
  server.get("/api/security/pairing/pending", (_req, res) => {
    try {
      const pending = pairingManager.getPendingPairings();
      server.json(res, 200, { items: pending });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/security/pairing/approved — users already approved.
  server.get("/api/security/pairing/approved", (_req, res) => {
    try {
      const map = pairingManager.getApprovedUsers();
      const items: Array<{ platform: string; userId: string }> = [];
      for (const [platform, users] of map) {
        for (const userId of users) items.push({ platform, userId });
      }
      server.json(res, 200, { items });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/security/pairing/approve { code } — approve a pending code.
  server.post("/api/security/pairing/approve", async (req, res) => {
    try {
      const body = await server.parseBody<{ code: string }>(req);
      if (!body.code) { server.json(res, 400, { error: "code required" }); return; }
      const pairing = pairingManager.approve(body.code);
      if (!pairing) {
        server.json(res, 404, { error: "code not found or expired" });
        return;
      }
      server.json(res, 200, { success: true, pairing });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/security/pairing/revoke { platform, userId } — drop approval.
  server.post("/api/security/pairing/revoke", async (req, res) => {
    try {
      const body = await server.parseBody<{ platform: string; userId: string }>(req);
      if (!body.platform || !body.userId) {
        server.json(res, 400, { error: "platform and userId required" });
        return;
      }
      const revoked = pairingManager.revoke(body.platform, body.userId);
      server.json(res, revoked ? 200 : 404, { success: revoked });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
