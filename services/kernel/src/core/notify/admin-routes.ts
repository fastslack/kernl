/**
 * Admin HTTP routes for the NotificationRegistry.
 *
 * Today only WhatsApp has provider-specific actions (QR pairing), but the
 * routes are generic: `GET /api/notifications/:slug/qr` looks up the
 * running provider by slug and, if it exposes `getQr()`, returns the
 * current pairing code alongside the connection state.
 */

import type { KernelHttpServer } from "../http-server.js";
import type { NotificationRegistry } from "./registry.js";

export function registerNotificationAdminRoutes(
  server: KernelHttpServer,
  registry: NotificationRegistry,
): void {
  // GET /api/notifications/:slug/status — public status of one provider.
  server.get("/api/notifications/:slug/status", (req, res) => {
    const slug = (req as unknown as { params?: Record<string, string> }).params?.slug;
    if (!slug) { server.json(res, 400, { error: "slug required" }); return; }
    const provider = registry.getProvider(slug);
    if (!provider) { server.json(res, 404, { error: "provider not running" }); return; }
    server.json(res, 200, { status: provider.getStatus() });
  });

  // GET /api/notifications/:slug/qr — QR pairing string for a provider that
  // supports QR-based login (currently only WhatsApp).
  server.get("/api/notifications/:slug/qr", (req, res) => {
    const slug = (req as unknown as { params?: Record<string, string> }).params?.slug;
    if (!slug) { server.json(res, 400, { error: "slug required" }); return; }
    const provider = registry.getProvider(slug) as unknown as {
      getQr?: () => string | null;
      getStatus: () => { connected: boolean; error?: string };
    } | null;
    if (!provider) { server.json(res, 404, { error: "provider not running" }); return; }
    if (typeof provider.getQr !== "function") {
      server.json(res, 400, { error: `provider ${slug} does not support QR pairing` });
      return;
    }
    const status = provider.getStatus();
    server.json(res, 200, {
      qr: provider.getQr(),
      connected: status.connected,
      error: status.error ?? null,
    });
  });

  // POST /api/notifications/:slug/request_qr — force the provider to request
  // a fresh QR code (useful when the current one expired).
  server.post("/api/notifications/:slug/request_qr", async (req, res) => {
    const slug = (req as unknown as { params?: Record<string, string> }).params?.slug;
    if (!slug) { server.json(res, 400, { error: "slug required" }); return; }
    const provider = registry.getProvider(slug) as unknown as {
      requestQr?: () => Promise<boolean>;
    } | null;
    if (!provider || typeof provider.requestQr !== "function") {
      server.json(res, 400, { error: `provider ${slug} does not support QR pairing` });
      return;
    }
    try {
      const ok = await provider.requestQr();
      server.json(res, ok ? 200 : 500, { ok });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/notifications/:slug/logout — drop the session so the next
  // connection requires a fresh pairing.
  server.post("/api/notifications/:slug/logout", async (req, res) => {
    const slug = (req as unknown as { params?: Record<string, string> }).params?.slug;
    if (!slug) { server.json(res, 400, { error: "slug required" }); return; }
    const provider = registry.getProvider(slug) as unknown as {
      logout?: () => Promise<boolean>;
    } | null;
    if (!provider || typeof provider.logout !== "function") {
      server.json(res, 400, { error: `provider ${slug} does not support logout` });
      return;
    }
    try {
      const ok = await provider.logout();
      server.json(res, ok ? 200 : 500, { ok });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
