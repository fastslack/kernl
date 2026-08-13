import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KernelHttpServer } from "../../core/http-server.js";
import type { MarketplaceService } from "./service.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import type { ItemType, ItemStatus } from "./types.js";
import type { CatalogFilter } from "./catalog/types.js";
import type { ExtensionType } from "../extensions/types.js";
import { queryMarketplace } from "./dashboard-query.js";
import { buildDownloadWatermark } from "../extensions/receipt.js";
import { packBundle, bundleFileName } from "../extensions/bundle.js";

export function registerMarketplaceRoutes(
  server: KernelHttpServer,
  service: MarketplaceService,
  db: SqliteDb,
): void {
  // ── Unified catalog ───────────────────────────────────
  //
  // /api/marketplace/catalog            → browse (skills + plugins + offices + …)
  // /api/marketplace/catalog/item/:id   → detail
  // /api/marketplace/catalog/install    → POST { id }
  // /api/marketplace/catalog/uninstall  → POST { id, force? }
  // /api/marketplace/catalog/providers  → list registered providers

  server.get("/api/marketplace/catalog", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const type = url.searchParams.get("type") ?? undefined;
      const category = url.searchParams.get("category") ?? undefined;
      const query = url.searchParams.get("q") ?? undefined;
      const limit = url.searchParams.get("limit");
      const filter: CatalogFilter = {
        type: type ? (type as ExtensionType) : undefined,
        category,
        query,
        limit: limit ? Number(limit) : undefined,
      };
      // `?refresh=1` drops provider caches first. The dashboard passes it on
      // page load so a reload always shows a current shelf (prices included),
      // while keystroke-level searches keep hitting the cache.
      if (url.searchParams.get("refresh") === "1") {
        await service.refreshCatalog();
      }
      const items = await service.browseCatalog(filter);
      server.json(res, 200, { items, total: items.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/marketplace/catalog/providers", (_req, res) => {
    try {
      server.json(res, 200, { providers: service.listCatalogProviders() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/marketplace/catalog/item/:id", async (req, res) => {
    try {
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const item = await service.getCatalogItem(id);
      if (!item) { server.json(res, 404, { error: "Catalog item not found" }); return; }
      server.json(res, 200, { item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/marketplace/catalog/install", async (req, res) => {
    try {
      const body = await server.parseBody<{ id?: string }>(req);
      if (!body.id) { server.json(res, 400, { error: "id required" }); return; }
      const row = await service.installFromCatalog(body.id);
      server.json(res, 200, { success: true, item: row });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Watermarked download (server-side, path B) ───────────────────────
  //
  // GET /api/marketplace/catalog/download/:slug?downloader_fp=<fingerprint>
  //
  // Build a per-download .kernl bundle for `slug`:
  //   1. Locate the bundle directory via the catalog (must be a bundled provider
  //      item with origin.directory set — we don't proxy remote-of-remote).
  //   2. Stage a copy to a temp dir.
  //   3. Sign a download watermark with the kernel's Ed25519 identity.
  //   4. Embed the watermark into a fresh copy of extension.json under
  //      `.tracking.download` so the downloader can extract it offline.
  //   5. packBundle() into a tarball, return bytes + the watermark via header.
  //
  // The downloader is responsible for storing the watermark in its install
  // receipt (RemoteProvider does this automatically).
  server.get("/api/marketplace/catalog/download/:slug", async (req, res) => {
    let stagingDir: string | null = null;
    let outDir: string | null = null;
    try {
      const slug = (req as unknown as { params?: Record<string, string> }).params?.slug;
      if (!slug) { server.json(res, 400, { error: "slug required" }); return; }

      const url = new URL(req.url ?? "/", "http://localhost");
      const downloaderFp = url.searchParams.get("downloader_fp") ?? "anonymous";

      const identity = service.getIdentity();
      if (!identity) {
        server.json(res, 503, { error: "Marketplace identity not initialized" });
        return;
      }

      const item = await service.getCatalogItem(slug);
      if (!item) { server.json(res, 404, { error: "Catalog item not found" }); return; }
      if (!item.origin.directory) {
        server.json(res, 400, {
          error: "Item has no on-disk source — only bundled-provider items can be served",
        });
        return;
      }

      const watermark = buildDownloadWatermark({ downloaderFp, source: identity });

      // Stage a copy of the source dir, embed watermark into extension.json,
      // pack into a tarball. Original assets/ dir is never mutated.
      // The .kernl output MUST live OUTSIDE the staging dir — otherwise tar
      // complains "file changed as we read it" when it reaches its own output.
      stagingDir = mkdtempSync(join(tmpdir(), `mtw-dl-${item.slug}-`));
      outDir = mkdtempSync(join(tmpdir(), `mtw-dl-out-${item.slug}-`));
      copyDirSync(item.origin.directory, stagingDir);

      const manifestPath = join(stagingDir, "extension.json");
      let manifestObj: Record<string, unknown> = {};
      try {
        manifestObj = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      } catch {
        // Synthetic manifest from a normalized provider (skill/plugin) — write
        // the catalog item's manifest so the bundle is self-describing.
        manifestObj = item.manifest as unknown as Record<string, unknown>;
      }
      manifestObj.tracking = { download: watermark };
      writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2), "utf-8");

      const bundlePath = join(outDir, bundleFileName(item.slug));
      const packed = await packBundle(stagingDir, bundlePath);
      const buf = readFileSync(bundlePath);
      const size = statSync(bundlePath).size;

      res.writeHead(200, {
        "Content-Type": "application/x-kernl+gzip",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="${bundleFileName(item.slug)}"`,
        "X-MTW-Watermark": Buffer.from(JSON.stringify(watermark)).toString("base64"),
        "X-MTW-Bundle-Sha256": packed.sha256,
      });
      res.end(buf);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    } finally {
      if (stagingDir) {
        try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      if (outDir) {
        try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  });

  // ── Subscribed catalog repos (path C — git-discovered skills) ────────
  //
  // GET  /api/marketplace/repos                   → list subscribed repos
  // POST /api/marketplace/repos                   → add { url, ref?, name?, description? }
  // POST /api/marketplace/repos/:id/sync          → re-clone + rescan
  // POST /api/marketplace/repos/:id/install-all   → install every item in the repo
  // DELETE /api/marketplace/repos/:id             → unsubscribe + drop cache

  server.get("/api/marketplace/repos", (_req, res) => {
    try {
      const repos = service.getReposService();
      if (!repos) { server.json(res, 503, { error: "Repos service not initialized" }); return; }
      server.json(res, 200, { repos: repos.list() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/marketplace/repos", async (req, res) => {
    try {
      const repos = service.getReposService();
      if (!repos) { server.json(res, 503, { error: "Repos service not initialized" }); return; }
      const body = await server.parseBody<{ url?: string; ref?: string; name?: string; description?: string }>(req);
      if (!body.url) { server.json(res, 400, { error: "url required" }); return; }
      const row = await repos.add({
        url: body.url,
        ref: body.ref,
        name: body.name,
        description: body.description,
      });
      server.json(res, 200, { success: true, repo: row });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/marketplace/repos/:id/sync", async (req, res) => {
    try {
      const repos = service.getReposService();
      if (!repos) { server.json(res, 503, { error: "Repos service not initialized" }); return; }
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const result = await repos.sync(id);
      server.json(res, 200, { success: !result.error, result });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/marketplace/repos/:id/install-all", async (req, res) => {
    try {
      const repos = service.getReposService();
      const registry = service.getCatalogRegistry();
      if (!repos || !registry) { server.json(res, 503, { error: "Catalog not initialized" }); return; }
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const repo = repos.get(id);
      if (!repo) { server.json(res, 404, { error: "Repo not found" }); return; }

      const url = new URL(req.url ?? "/", "http://localhost");
      const dryRun = url.searchParams.get("dry_run") === "true";

      // Discover items via the registered provider for this repo.
      const providerName = `git:${repo.url
        .replace(/^https?:\/\//, "")
        .replace(/^git@/, "")
        .replace(/[:/]/g, "__")
        .replace(/\.git$/, "")
        .toLowerCase()
        .slice(0, 96)}`;
      const provider = registry.getProvider(providerName);
      if (!provider) { server.json(res, 500, { error: `Provider not registered: ${providerName}` }); return; }
      const items = await provider.list();

      const results: Array<{ slug: string; status: "installed" | "skipped" | "error"; error?: string }> = [];
      for (const item of items) {
        if (dryRun) {
          results.push({ slug: item.slug, status: "skipped" });
          continue;
        }
        try {
          await registry.install(item.slug);
          results.push({ slug: item.slug, status: "installed" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // "already installed" is a soft skip, not a failure.
          if (msg.includes("already installed") || msg.includes("Already installed")) {
            results.push({ slug: item.slug, status: "skipped" });
          } else {
            results.push({ slug: item.slug, status: "error", error: msg });
          }
        }
      }

      server.json(res, 200, {
        success: true,
        dry_run: dryRun,
        total: items.length,
        installed: results.filter((r) => r.status === "installed").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        errored: results.filter((r) => r.status === "error").length,
        results,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.delete?.("/api/marketplace/repos/:id", async (req, res) => {
    try {
      const repos = service.getReposService();
      if (!repos) { server.json(res, 503, { error: "Repos service not initialized" }); return; }
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = await repos.remove(id);
      if (!ok) { server.json(res, 404, { error: "Repo not found" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── /api/marketplace/catalog/uninstall (existing, path A/B) ──────────

  server.post("/api/marketplace/catalog/uninstall", async (req, res) => {
    try {
      const body = await server.parseBody<{ id?: string; force?: boolean }>(req);
      if (!body.id) { server.json(res, 400, { error: "id required" }); return; }
      await service.uninstallFromCatalog(body.id, { force: body.force });
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Browse / Search ──────────────────────────────────

  // GET /api/marketplace — full payload (items + stats + themes + activeTheme).
  // Mirrors the WebSocket dashboard channel so the page renders the same shape
  // whether bootstrap data arrives via HTTP first or WS first.
  // Filters (type/category/status/query/sort) still apply to the items array;
  // stats reflect the unfiltered totals (intentional: stats are global).
  server.get("/api/marketplace", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const type = url.searchParams.get("type") as ItemType | null;
      const category = url.searchParams.get("category") ?? undefined;
      const status = url.searchParams.get("status") as ItemStatus | null;
      const query = url.searchParams.get("q") ?? undefined;
      const sort = url.searchParams.get("sort") as "popular" | "rating" | "newest" | "name" | null;

      const hasFilter = type || category || status || query || sort;
      const payload = queryMarketplace(db);

      if (!payload) {
        server.json(res, 200, { items: [], total: 0, stats: { total: 0, installed: 0, active: 0, byType: {} }, themes: [], activeTheme: null });
        return;
      }

      // When the caller passes filters, override the items array with the
      // filtered list — but keep stats/themes/activeTheme unfiltered so the
      // header counters stay accurate.
      const items = hasFilter
        ? service.listItems({
            type: type ?? undefined,
            category,
            status: status ?? undefined,
            query,
            sort: sort ?? undefined,
          })
        : payload.items;

      server.json(res, 200, {
        ...payload,
        items,
        total: items.length,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/marketplace/featured
  server.get("/api/marketplace/featured", (_req, res) => {
    try {
      server.json(res, 200, { items: service.getFeatured() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/marketplace/popular
  server.get("/api/marketplace/popular", (_req, res) => {
    try {
      server.json(res, 200, { items: service.getPopular() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/marketplace/stats
  server.get("/api/marketplace/stats", (_req, res) => {
    try {
      server.json(res, 200, service.getStats());
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Item CRUD ──────────────────────────────────────

  // GET /api/marketplace/item/:id
  server.get("/api/marketplace/item/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const item = service.getItem(id) ?? service.getItemBySlug(id);
      if (!item) { server.json(res, 404, { error: "Item not found" }); return; }
      const reviews = service.getReviews(item.id);
      const purchased = service.hasPurchased(item.id);
      server.json(res, 200, { item, reviews, purchased });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/marketplace/item — create
  server.post("/api/marketplace/item", async (req, res) => {
    try {
      const body = await server.parseBody<Record<string, unknown>>(req);
      if (!body.slug || !body.name || !body.type) {
        server.json(res, 400, { error: "slug, name, type required" });
        return;
      }
      const item = service.createItem(body as Parameters<typeof service.createItem>[0]);
      server.json(res, 200, { success: true, item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // PUT /api/marketplace/item/:id
  server.put("/api/marketplace/item/:id", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<Record<string, unknown>>(req);
      const item = service.updateItem(id, body as Parameters<typeof service.updateItem>[1]);
      if (!item) { server.json(res, 404, { error: "Item not found" }); return; }
      server.json(res, 200, { success: true, item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/marketplace/item/:id
  server.delete("/api/marketplace/item/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = service.deleteItem(id);
      if (!ok) { server.json(res, 404, { error: "Item not found" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Install / Uninstall / Enable / Disable ──────────

  server.post("/api/marketplace/install", async (req, res) => {
    try {
      const { id } = await server.parseBody<{ id: string }>(req);
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const item = service.installItem(id);
      if (!item) { server.json(res, 404, { error: "Item not found" }); return; }
      server.json(res, 200, { success: true, item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/marketplace/uninstall", async (req, res) => {
    try {
      const { id } = await server.parseBody<{ id: string }>(req);
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const item = service.uninstallItem(id);
      if (!item) { server.json(res, 404, { error: "Item not found" }); return; }
      server.json(res, 200, { success: true, item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/marketplace/enable", async (req, res) => {
    try {
      const { id } = await server.parseBody<{ id: string }>(req);
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const item = service.enableItem(id);
      if (!item) { server.json(res, 404, { error: "Item not found" }); return; }
      server.json(res, 200, { success: true, item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/marketplace/disable", async (req, res) => {
    try {
      const { id } = await server.parseBody<{ id: string }>(req);
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const item = service.disableItem(id);
      if (!item) { server.json(res, 404, { error: "Item not found" }); return; }
      server.json(res, 200, { success: true, item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Reviews ──────────────────────────────────────

  server.post("/api/marketplace/review", async (req, res) => {
    try {
      const body = await server.parseBody<{
        item_id: string; rating: number; title?: string; body?: string;
      }>(req);
      if (!body.item_id || !body.rating) {
        server.json(res, 400, { error: "item_id and rating required" });
        return;
      }
      const review = service.addReview(body);
      server.json(res, 200, { success: true, review });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/marketplace/reviews/:item_id", (req, res) => {
    try {
      const itemId = (req as unknown as { params: Record<string, string> }).params?.item_id;
      if (!itemId) { server.json(res, 400, { error: "item_id required" }); return; }
      const reviews = service.getReviews(itemId);
      server.json(res, 200, { reviews });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.delete("/api/marketplace/review/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = service.deleteReview(id);
      if (!ok) { server.json(res, 404, { error: "Review not found" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Purchases ──────────────────────────────────────

  server.post("/api/marketplace/purchase", async (req, res) => {
    try {
      const { item_id } = await server.parseBody<{ item_id: string }>(req);
      if (!item_id) { server.json(res, 400, { error: "item_id required" }); return; }
      const purchase = service.purchaseItem(item_id);
      server.json(res, 200, { success: true, purchase });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/marketplace/purchases", (_req, res) => {
    try {
      server.json(res, 200, { purchases: service.getPurchases() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Themes ──────────────────────────────────────

  server.post("/api/marketplace/theme/activate", async (req, res) => {
    try {
      const { item_id } = await server.parseBody<{ item_id: string }>(req);
      if (!item_id) { server.json(res, 400, { error: "item_id required" }); return; }
      const theme = service.activateTheme(item_id);
      if (!theme) { server.json(res, 404, { error: "Theme not found" }); return; }
      server.json(res, 200, { success: true, theme });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/marketplace/theme/deactivate", async (_req, res) => {
    try {
      service.deactivateTheme();
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── GET /api/marketplace/theme/list — themes joined with item metadata
  // Returns one row per installed theme with item name/icon/slug + the
  // preview_colors JSON string. Used by the global theme switcher UI.
  server.get("/api/marketplace/theme/list", (_req, res) => {
    try {
      server.json(res, 200, { themes: service.listThemes() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/marketplace/theme/active", (_req, res) => {
    try {
      const theme = service.getActiveTheme();
      if (!theme) {
        server.json(res, 200, { theme: null });
        return;
      }
      server.json(res, 200, {
        theme: {
          name: theme.name,
          slug: theme.slug,
          icon: theme.icon,
          variables: JSON.parse(theme.variables),
          fonts: JSON.parse(theme.fonts),
          customCss: theme.custom_css,
          previewColors: JSON.parse(theme.preview_colors),
        },
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/marketplace/theme/preview/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const theme = service.getThemeData(id);
      if (!theme) { server.json(res, 404, { error: "Theme not found" }); return; }
      server.json(res, 200, {
        variables: JSON.parse(theme.variables),
        fonts: JSON.parse(theme.fonts),
        customCss: theme.custom_css,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Import / Export ──────────────────────────────────

  server.post("/api/marketplace/import", async (req, res) => {
    try {
      const pkg = await server.parseBody<Record<string, unknown>>(req);
      if (!pkg.$schema || !pkg.slug) {
        server.json(res, 400, { error: "$schema and slug required" });
        return;
      }
      const item = service.importItem(pkg);
      server.json(res, 200, { success: true, item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/marketplace/export/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const pkg = service.exportItem(id);
      if (!pkg) { server.json(res, 404, { error: "Item not found" }); return; }
      server.json(res, 200, pkg);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  log.info("Marketplace routes registered (/api/marketplace/*)");
}

/** Synchronous recursive copy. fs.cpSync would do it but its recursive option
 *  has had bugs across Node versions; this is small and predictable. */
function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) copyFileSync(s, d);
  }
}
