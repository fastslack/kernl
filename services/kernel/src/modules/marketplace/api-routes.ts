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
import { HttpError, type KernelHttpServer, type RouteMethod } from "../../core/http-server.js";
import type { MarketplaceService } from "./service.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import type { CatalogFilter } from "./catalog/types.js";
import type { ExtensionType } from "../extensions/types.js";
import { marketplaceOperations } from "./operations.js";
import { buildDownloadWatermark } from "../extensions/receipt.js";
import { packBundle, bundleFileName } from "../extensions/bundle.js";

export function registerMarketplaceRoutes(
  server: KernelHttpServer,
  service: MarketplaceService,
  db: SqliteDb,
): void {
  const requireRepos = () => {
    const repos = service.getReposService();
    if (!repos) throw new HttpError(503, "Repos service not initialized");
    return repos;
  };

  // ── Unified catalog ───────────────────────────────────
  //
  // /api/marketplace/catalog            → browse (skills + plugins + offices + …)
  // /api/marketplace/catalog/item/:id   → detail
  // /api/marketplace/catalog/install    → POST { id }
  // /api/marketplace/catalog/uninstall  → POST { id, force? }
  // /api/marketplace/catalog/providers  → list registered providers

  server.route("GET", "/api/marketplace/catalog", async ({ query }) => {
    const type = query.get("type") ?? undefined;
    const limit = query.get("limit");
    const filter: CatalogFilter = {
      type: type ? (type as ExtensionType) : undefined,
      category: query.get("category") ?? undefined,
      query: query.get("q") ?? undefined,
      limit: limit ? Number(limit) : undefined,
    };
    // `?refresh=1` drops provider caches first. The dashboard passes it on
    // page load so a reload always shows a current shelf (prices included),
    // while keystroke-level searches keep hitting the cache.
    if (query.get("refresh") === "1") {
      await service.refreshCatalog();
    }
    const items = await service.browseCatalog(filter);
    return { items, total: items.length };
  });

  server.route("GET", "/api/marketplace/catalog/providers", () => ({
    providers: service.listCatalogProviders(),
  }));

  server.route("GET", "/api/marketplace/catalog/item/:id", async ({ params: { id } }) => {
    const item = await service.getCatalogItem(id);
    if (!item) throw new HttpError(404, "Catalog item not found");
    return { item };
  });

  server.route<{ id?: string }>("POST", "/api/marketplace/catalog/install", async ({ body }) => {
    if (!body.id) throw new HttpError(400, "id required");
    const row = await service.installFromCatalog(body.id);
    return { success: true, item: row };
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
  //
  // Stays a raw handler: it answers with a binary tarball and custom headers.
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

  server.route("GET", "/api/marketplace/repos", () => ({ repos: requireRepos().list() }));

  server.route<{ url?: string; ref?: string; name?: string; description?: string }>(
    "POST", "/api/marketplace/repos", async ({ body }) => {
      const repos = requireRepos();
      if (!body.url) throw new HttpError(400, "url required");
      const row = await repos.add({
        url: body.url,
        ref: body.ref,
        name: body.name,
        description: body.description,
      });
      return { success: true, repo: row };
    },
  );

  server.route("POST", "/api/marketplace/repos/:id/sync", async ({ params: { id } }) => {
    const result = await requireRepos().sync(id);
    return { success: !result.error, result };
  });

  server.route("POST", "/api/marketplace/repos/:id/install-all", async ({ params: { id }, query }) => {
    const repos = service.getReposService();
    const registry = service.getCatalogRegistry();
    if (!repos || !registry) throw new HttpError(503, "Catalog not initialized");
    const repo = repos.get(id);
    if (!repo) throw new HttpError(404, "Repo not found");

    const dryRun = query.get("dry_run") === "true";

    // Discover items via the registered provider for this repo.
    const providerName = `git:${repo.url
      .replace(/^https?:\/\//, "")
      .replace(/^git@/, "")
      .replace(/[:/]/g, "__")
      .replace(/\.git$/, "")
      .toLowerCase()
      .slice(0, 96)}`;
    const provider = registry.getProvider(providerName);
    if (!provider) throw new HttpError(500, `Provider not registered: ${providerName}`);
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

    return {
      success: true,
      dry_run: dryRun,
      total: items.length,
      installed: results.filter((r) => r.status === "installed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errored: results.filter((r) => r.status === "error").length,
      results,
    };
  });

  server.route("DELETE", "/api/marketplace/repos/:id", async ({ params: { id } }) => {
    if (!(await requireRepos().remove(id))) throw new HttpError(404, "Repo not found");
    return { success: true };
  });

  // ── /api/marketplace/catalog/uninstall (existing, path A/B) ──────────

  server.route<{ id?: string; force?: boolean }>("POST", "/api/marketplace/catalog/uninstall", async ({ body }) => {
    if (!body.id) throw new HttpError(400, "id required");
    await service.uninstallFromCatalog(body.id, { force: body.force });
    return { success: true };
  });

  // ── Operations shared with the WS RPC (operations.ts) ─────────
  // The dashboard reaches these through rpcOrCall, WS first and HTTP when
  // the bridge is down, so both roads run the same function. A path param
  // is named after the input key the operation reads.
  const op = marketplaceOperations(service, db);
  const bind = ([method, path, name]: [RouteMethod, string, string]) => server.operation(method, path, op[name]);
  ([
    ["GET", "/api/marketplace", "marketplace.list"],
    ["POST", "/api/marketplace/install", "marketplace.install"],
    ["POST", "/api/marketplace/uninstall", "marketplace.uninstall"],
    ["POST", "/api/marketplace/enable", "marketplace.enable"],
    ["POST", "/api/marketplace/disable", "marketplace.disable"],
    ["POST", "/api/marketplace/review", "marketplace.review"],
    ["POST", "/api/marketplace/theme/activate", "marketplace.theme.activate"],
    ["POST", "/api/marketplace/theme/deactivate", "marketplace.theme.deactivate"],
    ["GET", "/api/marketplace/theme/active", "marketplace.theme.active"],
    ["POST", "/api/marketplace/import", "marketplace.import"],
    ["GET", "/api/marketplace/export/:id", "marketplace.export"],
  ] as Array<[RouteMethod, string, string]>).forEach(bind);

  // GET /api/marketplace/featured
  server.route("GET", "/api/marketplace/featured", () => ({ items: service.getFeatured() }));

  // GET /api/marketplace/popular
  server.route("GET", "/api/marketplace/popular", () => ({ items: service.getPopular() }));

  // GET /api/marketplace/stats
  server.route("GET", "/api/marketplace/stats", () => service.getStats());

  // ── Item CRUD ──────────────────────────────────────

  // GET /api/marketplace/item/:id
  server.route("GET", "/api/marketplace/item/:id", ({ params: { id } }) => {
    const item = service.getItem(id) ?? service.getItemBySlug(id);
    if (!item) throw new HttpError(404, "Item not found");
    const reviews = service.getReviews(item.id);
    const purchased = service.hasPurchased(item.id);
    return { item, reviews, purchased };
  });

  // POST /api/marketplace/item — create
  server.route<Record<string, unknown>>("POST", "/api/marketplace/item", ({ body }) => {
    if (!body.slug || !body.name || !body.type) throw new HttpError(400, "slug, name, type required");
    const item = service.createItem(body as Parameters<typeof service.createItem>[0]);
    return { success: true, item };
  });

  // PUT /api/marketplace/item/:id
  server.route<Record<string, unknown>>("PUT", "/api/marketplace/item/:id", ({ params: { id }, body }) => {
    const item = service.updateItem(id, body as Parameters<typeof service.updateItem>[1]);
    if (!item) throw new HttpError(404, "Item not found");
    return { success: true, item };
  });

  // DELETE /api/marketplace/item/:id
  server.route("DELETE", "/api/marketplace/item/:id", ({ params: { id } }) => {
    if (!service.deleteItem(id)) throw new HttpError(404, "Item not found");
    return { success: true };
  });

  // ── Reviews ──────────────────────────────────────

  server.route("GET", "/api/marketplace/reviews/:item_id", ({ params: { item_id } }) => ({
    reviews: service.getReviews(item_id),
  }));

  server.route("DELETE", "/api/marketplace/review/:id", ({ params: { id } }) => {
    if (!service.deleteReview(id)) throw new HttpError(404, "Review not found");
    return { success: true };
  });

  // ── Purchases ──────────────────────────────────────

  server.route<{ item_id?: string }>("POST", "/api/marketplace/purchase", ({ body: { item_id } }) => {
    if (!item_id) throw new HttpError(400, "item_id required");
    const purchase = service.purchaseItem(item_id);
    return { success: true, purchase };
  });

  server.route("GET", "/api/marketplace/purchases", () => ({ purchases: service.getPurchases() }));

  // ── Themes ──────────────────────────────────────

  // ── GET /api/marketplace/theme/list — themes joined with item metadata
  // Returns one row per installed theme with item name/icon/slug + the
  // preview_colors JSON string. Used by the global theme switcher UI.
  server.route("GET", "/api/marketplace/theme/list", () => ({ themes: service.listThemes() }));

  server.route("GET", "/api/marketplace/theme/preview/:id", ({ params: { id } }) => {
    const theme = service.getThemeData(id);
    if (!theme) throw new HttpError(404, "Theme not found");
    return {
      variables: JSON.parse(theme.variables),
      fonts: JSON.parse(theme.fonts),
      customCss: theme.custom_css,
    };
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
