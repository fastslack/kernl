/**
 * HTTP API for the licensed store — buying and installing paid extensions from
 * the dashboard, with no copy-pasting of license keys.
 *
 * Mounted under `/api/store`:
 *
 *   GET  /api/store/status              → store reachability, All-Access prices,
 *                                         license summary, open checkouts
 *   POST /api/store/checkout            → { slug } → { session_id, url }
 *   GET  /api/store/checkout/:sessionId → poll a purchase to completion
 *   POST /api/store/install             → { slug } — install something the
 *                                         license already covers
 *
 * The purchase flow, end to end:
 *
 *   1. POST /checkout opens a Stripe Checkout session at the issuer and records
 *      it in `store_checkouts`. The dashboard opens `url` in a new tab.
 *   2. The user pays. Stripe fires `checkout.session.completed`; the issuer
 *      mints the license and parks `session:<id> → customer` in KV.
 *   3. The dashboard polls GET /checkout/:sessionId. As soon as the license is
 *      claimable we apply it locally, then download + install the bundle.
 *
 * The session id is the credential — nothing else authenticates step 3, which
 * is exactly why we never accept one from the client that we didn't create
 * ourselves in step 1.
 */

import type { KernelHttpServer } from "../../core/http-server.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { LicenseService } from "../../core/license/types.js";
import type { ExtensionService } from "../extensions/service.js";
import type { AgentService } from "../agents/service.js";
import { log } from "../../core/logger.js";
import { createStoreCheckout, fetchStoreCatalogFull } from "./client.js";
import { installFromStore } from "./install.js";
import { advanceCheckout } from "./purchase-flow.js";
import { CheckoutService, type CheckoutRow } from "./checkout-service.js";

export interface StoreRoutesDeps {
  storeUrl: string;
  license: LicenseService;
  checkouts: CheckoutService;
  sqlite: SqliteDb;
  getExtensionService: () => ExtensionService | null;
  getAgentService: () => AgentService | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function registerStoreRoutes(server: KernelHttpServer, deps: StoreRoutesDeps): void {
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Guards against two concurrent polls of the same session both claiming the
  // license and both kicking off an install.
  const advancing = new Set<string>();

  // ── GET /api/store/status ────────────────────────────────────────────

  server.get("/api/store/status", async (_req, res) => {
    try {
      const report = deps.license.status();
      let items: Awaited<ReturnType<typeof fetchStoreCatalogFull>>["items"] = [];
      let allAccess: Awaited<ReturnType<typeof fetchStoreCatalogFull>>["allAccess"] = null;
      let storeError: string | null = null;
      try {
        const catalog = await fetchStoreCatalogFull(deps.storeUrl, fetchImpl);
        items = catalog.items;
        allAccess = catalog.allAccess;
      } catch (err) {
        storeError = err instanceof Error ? err.message : String(err);
      }

      server.json(res, 200, {
        store_url: deps.storeUrl,
        reachable: storeError === null,
        error: storeError,
        all_access: allAccess,
        license: {
          status: report.status,
          is_pro: deps.license.isPro(),
          sku: report.claim?.sku ?? null,
          email: report.claim?.email ?? null,
          features: report.claim?.features ?? [],
          expires_at: report.claim?.exp ?? null,
        },
        items: items.map((it) => ({
          ...it,
          owned: deps.license.has(it.feature),
        })),
        open_checkouts: deps.checkouts.listOpen(),
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── POST /api/store/checkout ─────────────────────────────────────────
  // Body: { slug }. Opens (or resumes) a Stripe Checkout for that item.

  server.post("/api/store/checkout", async (req, res) => {
    try {
      const body = await server.parseBody<{ slug?: string }>(req);
      const slug = body.slug?.trim();
      if (!slug) {
        server.json(res, 400, { error: "slug required" });
        return;
      }

      const catalog = await fetchStoreCatalogFull(deps.storeUrl, fetchImpl).catch((err) => {
        throw new Error(`Could not reach the store: ${err instanceof Error ? err.message : String(err)}`);
      });
      const item = catalog.items.find((i) => i.slug === slug);
      if (!item) {
        server.json(res, 404, { error: `Unknown store item "${slug}"` });
        return;
      }

      // Already entitled → buying again would be a double charge. Tell the
      // client to install instead.
      if (deps.license.has(item.feature)) {
        server.json(res, 409, {
          error: `Your license already includes ${item.name}. Install it instead of buying it again.`,
          already_owned: true,
        });
        return;
      }

      if (!item.price_id) {
        server.json(res, 503, {
          error: `${item.name} has no price configured yet. See https://lifekernl.com/pricing.`,
        });
        return;
      }

      // Resume an in-flight purchase rather than opening a second checkout for
      // the same thing — double-clicking Buy must not double-charge.
      const existing = deps.checkouts.pendingForSlug(slug);
      if (existing && existing.checkout_url) {
        server.json(res, 200, {
          session_id: existing.session_id,
          url: existing.checkout_url,
          state: existing.state,
          resumed: true,
        });
        return;
      }

      const email = deps.license.status().claim?.email;
      const session = await createStoreCheckout({
        storeUrl: deps.storeUrl,
        priceId: item.price_id,
        email,
        fetchImpl,
      });

      deps.checkouts.create({
        sessionId: session.id,
        slug,
        priceId: item.price_id,
        checkoutUrl: session.url,
      });
      log.info(`store: checkout ${session.id} opened for ${slug}`);

      server.json(res, 200, { session_id: session.id, url: session.url, state: "pending" });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/store/checkout/:sessionId ───────────────────────────────
  // The poll. Advances the state machine at most one step per call.

  server.get("/api/store/checkout/:sessionId", async (req, res) => {
    try {
      const sessionId = (req as unknown as { params?: Record<string, string> }).params?.sessionId;
      if (!sessionId) {
        server.json(res, 400, { error: "session_id required" });
        return;
      }

      // Only sessions this kernel opened. A caller can't make us claim a
      // license for someone else's checkout.
      const row = deps.checkouts.get(sessionId);
      if (!row) {
        server.json(res, 404, { error: "Unknown checkout session" });
        return;
      }

      if (row.state === "done" || row.state === "failed") {
        server.json(res, 200, checkoutView(row));
        return;
      }

      if (CheckoutService.isExpired(row)) {
        deps.checkouts.setState(sessionId, "failed", "Checkout expired without payment.");
        deps.checkouts.pruneExpired();
        server.json(res, 200, checkoutView(deps.checkouts.get(sessionId)!));
        return;
      }

      if (advancing.has(sessionId)) {
        // Another poll is mid-install. Report the last known state.
        server.json(res, 200, checkoutView(row));
        return;
      }

      advancing.add(sessionId);
      try {
        const advanced = await advanceCheckout(row, {
          storeUrl: deps.storeUrl,
          license: deps.license,
          checkouts: deps.checkouts,
          install: (slug) =>
            installFromStore({
              storeUrl: deps.storeUrl,
              slug,
              licenseJwt: deps.license.jwt() ?? "",
              getExtensionService: deps.getExtensionService,
              getAgentService: deps.getAgentService,
              sqlite: deps.sqlite,
              fetchImpl,
            }),
          fetchImpl,
        });
        server.json(res, 200, checkoutView(advanced));
      } finally {
        advancing.delete(sessionId);
      }
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /api/store/install ──────────────────────────────────────────
  // For items the license already covers (bought earlier, or All-Access).

  server.post("/api/store/install", async (req, res) => {
    try {
      const body = await server.parseBody<{ slug?: string }>(req);
      const slug = body.slug?.trim();
      if (!slug) {
        server.json(res, 400, { error: "slug required" });
        return;
      }

      const jwt = deps.license.jwt();
      if (!jwt) {
        server.json(res, 402, {
          error: "No license on this kernel. Buy the extension, or paste your license under Settings → License.",
        });
        return;
      }

      const result = await installFromStore({
        storeUrl: deps.storeUrl,
        slug,
        licenseJwt: jwt,
        getExtensionService: deps.getExtensionService,
        getAgentService: deps.getAgentService,
        sqlite: deps.sqlite,
        fetchImpl,
      });

      server.json(res, 200, {
        success: true,
        kind: result.kind,
        item: result.kind === "extension" ? result.installed : { office: result.officeName, agents: result.agents },
      });
    } catch (err) {
      // 402 for "you don't own this" so the dashboard can flip to a Buy button;
      // 500 for anything genuinely broken.
      const message = err instanceof Error ? err.message : String(err);
      const notEntitled = /does not include|license/i.test(message);
      server.json(res, notEntitled ? 402 : 500, { error: message });
    }
  });

}

function checkoutView(row: CheckoutRow): Record<string, unknown> {
  return {
    session_id: row.session_id,
    slug: row.slug,
    state: row.state,
    error: row.error || null,
    url: row.checkout_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
