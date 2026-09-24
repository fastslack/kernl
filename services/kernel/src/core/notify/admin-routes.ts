/**
 * Admin HTTP routes for the NotificationRegistry.
 *
 * Today only WhatsApp has provider-specific actions (QR pairing), but the
 * routes are generic: `GET /api/notifications/:slug/qr` looks up the
 * running provider by slug and, if it exposes `getQr()`, returns the
 * current pairing code alongside the connection state.
 */

import { HttpError, type KernelHttpServer } from "../http-server.js";
import type { NotificationRegistry } from "./registry.js";

export function registerNotificationAdminRoutes(
  server: KernelHttpServer,
  registry: NotificationRegistry,
): void {
  // GET /api/notifications/:slug/status — public status of one provider.
  server.route("GET", "/api/notifications/:slug/status", ({ params: { slug } }) => {
    const provider = registry.getProvider(slug);
    if (!provider) throw new HttpError(404, "provider not running");
    return { status: provider.getStatus() };
  });

  // GET /api/notifications/:slug/qr — QR pairing string for a provider that
  // supports QR-based login (currently only WhatsApp).
  server.route("GET", "/api/notifications/:slug/qr", ({ params: { slug } }) => {
    const provider = registry.getProvider(slug) as unknown as {
      getQr?: () => string | null;
      getStatus: () => { connected: boolean; error?: string };
    } | null;
    if (!provider) throw new HttpError(404, "provider not running");
    if (typeof provider.getQr !== "function") {
      throw new HttpError(400, `provider ${slug} does not support QR pairing`);
    }
    const status = provider.getStatus();
    return {
      qr: provider.getQr(),
      connected: status.connected,
      error: status.error ?? null,
    };
  });

  // POST /api/notifications/:slug/request_qr — force the provider to request
  // a fresh QR code (useful when the current one expired).
  server.route("POST", "/api/notifications/:slug/request_qr", async ({ params: { slug } }) => {
    const provider = registry.getProvider(slug) as unknown as {
      requestQr?: () => Promise<boolean>;
    } | null;
    if (!provider || typeof provider.requestQr !== "function") {
      throw new HttpError(400, `provider ${slug} does not support QR pairing`);
    }
    const ok = await provider.requestQr();
    if (!ok) throw new HttpError(500, "request_qr failed", { ok });
    return { ok };
  });

  // POST /api/notifications/:slug/logout — drop the session so the next
  // connection requires a fresh pairing.
  server.route("POST", "/api/notifications/:slug/logout", async ({ params: { slug } }) => {
    const provider = registry.getProvider(slug) as unknown as {
      logout?: () => Promise<boolean>;
    } | null;
    if (!provider || typeof provider.logout !== "function") {
      throw new HttpError(400, `provider ${slug} does not support logout`);
    }
    const ok = await provider.logout();
    if (!ok) throw new HttpError(500, "logout failed", { ok });
    return { ok };
  });
}
