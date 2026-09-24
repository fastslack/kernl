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

import { HttpError, type KernelHttpServer } from "../../core/http-server.js";
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

  server.route("GET", "/api/store/status", async () => {
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

    return {
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
    };
  });

  // ── POST /api/store/checkout ─────────────────────────────────────────
  // Body: { slug }. Opens (or resumes) a Stripe Checkout for that item.

  server.route<{ slug?: string }>("POST", "/api/store/checkout", async ({ body }) => {
    const slug = body.slug?.trim();
    if (!slug) throw new HttpError(400, "slug required");

    const catalog = await fetchStoreCatalogFull(deps.storeUrl, fetchImpl).catch((err) => {
      throw new HttpError(500, `Could not reach the store: ${err instanceof Error ? err.message : String(err)}`);
    });
    const item = catalog.items.find((i) => i.slug === slug);
    if (!item) throw new HttpError(404, `Unknown store item "${slug}"`);

    // Already entitled → buying again would be a double charge. Tell the
    // client to install instead.
    if (deps.license.has(item.feature)) {
      const error = `Your license already includes ${item.name}. Install it instead of buying it again.`;
      throw new HttpError(409, error, { error, already_owned: true });
    }

    if (!item.price_id) {
      throw new HttpError(503, `${item.name} has no price configured yet. See https://lifekernl.com/pricing.`);
    }

    // Resume an in-flight purchase rather than opening a second checkout for
    // the same thing — double-clicking Buy must not double-charge.
    const existing = deps.checkouts.pendingForSlug(slug);
    if (existing && existing.checkout_url) {
      return {
        session_id: existing.session_id,
        url: existing.checkout_url,
        state: existing.state,
        resumed: true,
      };
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

    return { session_id: session.id, url: session.url, state: "pending" };
  });

  // ── GET /api/store/checkout/:sessionId ───────────────────────────────
  // The poll. Advances the state machine at most one step per call.

  server.route("GET", "/api/store/checkout/:sessionId", async ({ params: { sessionId } }) => {
    // Only sessions this kernel opened. A caller can't make us claim a
    // license for someone else's checkout.
    const row = deps.checkouts.get(sessionId);
    if (!row) throw new HttpError(404, "Unknown checkout session");

    if (row.state === "done" || row.state === "failed") return checkoutView(row);

    if (CheckoutService.isExpired(row)) {
      deps.checkouts.setState(sessionId, "failed", "Checkout expired without payment.");
      deps.checkouts.pruneExpired();
      return checkoutView(deps.checkouts.get(sessionId)!);
    }

    // Another poll is mid-install. Report the last known state.
    if (advancing.has(sessionId)) return checkoutView(row);

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
      return checkoutView(advanced);
    } finally {
      advancing.delete(sessionId);
    }
  });

  // ── POST /api/store/install ──────────────────────────────────────────
  // For items the license already covers (bought earlier, or All-Access).

  server.route<{ slug?: string }>("POST", "/api/store/install", async ({ body }) => {
    const slug = body.slug?.trim();
    if (!slug) throw new HttpError(400, "slug required");

    const jwt = deps.license.jwt();
    if (!jwt) {
      throw new HttpError(402, "No license on this kernel. Buy the extension, or paste your license under Settings → License.");
    }

    let result: Awaited<ReturnType<typeof installFromStore>>;
    try {
      result = await installFromStore({
        storeUrl: deps.storeUrl,
        slug,
        licenseJwt: jwt,
        getExtensionService: deps.getExtensionService,
        getAgentService: deps.getAgentService,
        sqlite: deps.sqlite,
        fetchImpl,
      });
    } catch (err) {
      // 402 for "you don't own this" so the dashboard can flip to a Buy button;
      // 500 for anything genuinely broken.
      const message = err instanceof Error ? err.message : String(err);
      const notEntitled = /does not include|license/i.test(message);
      throw new HttpError(notEntitled ? 402 : 500, message);
    }

    return {
      success: true,
      kind: result.kind,
      item: result.kind === "extension" ? result.installed : { office: result.officeName, agents: result.agents },
    };
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
