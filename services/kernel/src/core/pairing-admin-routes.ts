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

import { HttpError, type KernelHttpServer } from "./http-server.js";
import type { PairingManager } from "../security/index.js";

export function registerPairingAdminRoutes(
  server: KernelHttpServer,
  pairingManager: PairingManager,
): void {
  // GET /api/security/pairing/pending — codes waiting for approval.
  server.route("GET", "/api/security/pairing/pending", () => ({
    items: pairingManager.getPendingPairings(),
  }));

  // GET /api/security/pairing/approved — users already approved.
  server.route("GET", "/api/security/pairing/approved", () => {
    const map = pairingManager.getApprovedUsers();
    const items: Array<{ platform: string; userId: string }> = [];
    for (const [platform, users] of map) {
      for (const userId of users) items.push({ platform, userId });
    }
    return { items };
  });

  // POST /api/security/pairing/approve { code } — approve a pending code.
  server.route<{ code: string }>("POST", "/api/security/pairing/approve", ({ body }) => {
    if (!body.code) throw new HttpError(400, "code required");
    const pairing = pairingManager.approve(body.code);
    if (!pairing) throw new HttpError(404, "code not found or expired");
    return { success: true, pairing };
  });

  // POST /api/security/pairing/revoke { platform, userId } — drop approval.
  server.route<{ platform: string; userId: string }>("POST", "/api/security/pairing/revoke", ({ body }) => {
    if (!body.platform || !body.userId) throw new HttpError(400, "platform and userId required");
    const revoked = pairingManager.revoke(body.platform, body.userId);
    if (!revoked) throw new HttpError(404, "revoke failed", { success: false });
    return { success: true };
  });
}
