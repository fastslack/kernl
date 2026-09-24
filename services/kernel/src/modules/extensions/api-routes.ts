/**
 * HTTP API for the unified extensions registry.
 *
 * Mounted under `/api/extensions`. Used by the dashboard to list, install,
 * enable/disable, and remove extensions. Mirrors the MCP tools surface
 * but over HTTP so browsers can upload .kernl bundles directly.
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { HttpError, type KernelHttpServer } from "../../core/http-server.js";
import { assetsDir } from "../../core/assets-root.js";
import { isPathInside } from "../../core/fs-paths.js";
import { safeJson } from "../../core/helpers.js";
import type { ExtensionService } from "./service.js";
import { BUNDLE_EXT } from "./bundle.js";
import {
  isPaidExtension,
  requiredFeature,
  type EntitlementManifest,
} from "./entitlement.js";
import type {
  ExtensionSource,
  ExtensionStatus,
  ExtensionType,
} from "./types.js";

export function registerExtensionsRoutes(
  server: KernelHttpServer,
  service: ExtensionService,
): void {
  // ── List / filter ────────────────────────────────────────────────────

  server.route("GET", "/api/extensions", ({ query }) => {
    const type = query.get("type") as ExtensionType | null;
    const status = query.get("status") as ExtensionStatus | null;
    const q = (query.get("q") ?? "").toLowerCase();

    let rows = service.list({
      type: type ?? undefined,
      status: status ?? undefined,
    });

    if (q) {
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.slug.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q),
      );
    }

    // Return parsed manifests inline so the UI doesn't have to call each item.
    //
    // `entitlement` says why a paid extension that installed cleanly is not
    // running. The kernel already knew — entitlement.ts derives the feature
    // and downgrades the row to "installed" — but it kept that to itself, so
    // the UI showed a healthy-looking card whose tools simply did not exist.
    // Nothing named the missing feature, and nothing pointed at
    // /settings/license, which is the page that fixes it.
    const items = rows.map((r) => {
      const manifest = safeJson<unknown>(r.manifest_json, null);
      const paid = manifest ? isPaidExtension(manifest as EntitlementManifest) : false;
      const feature = paid ? requiredFeature(manifest as EntitlementManifest) : null;
      return {
        ...r,
        manifest,
        source: safeJson<unknown>(r.source_json, null),
        granted_permissions: safeJson<unknown>(r.granted_permissions_json, null),
        settings: safeJson<unknown>(r.settings_json, null),
        install_receipt: safeJson<unknown>(r.install_receipt_json, null),
        entitlement: feature
          ? { required_feature: feature, licensed: service.hasLicense(feature) }
          : null,
      };
    });

    return {
      items,
      total: items.length,
      stats: computeStats(rows),
    };
  });

  // ── Detail ───────────────────────────────────────────────────────────

  /** An extension by id, falling back to slug. */
  const requireExtension = (id: string) => {
    const row = service.get(id) ?? service.getBySlug(id);
    if (!row) throw new HttpError(404, "Extension not found");
    return row;
  };

  server.route("GET", "/api/extensions/item/:id", ({ params: { id } }) => {
    const row = requireExtension(id);
    return {
      item: {
        ...row,
        manifest: safeJson<unknown>(row.manifest_json, null),
        source: safeJson<unknown>(row.source_json, null),
        granted_permissions: safeJson<unknown>(row.granted_permissions_json, null),
        settings: safeJson<unknown>(row.settings_json, null),
        install_receipt: safeJson<unknown>(row.install_receipt_json, null),
      },
    };
  });

  // ── Brand logos (kernel-bundled, for extensions without install_path) ──

  server.get("/api/extensions/brand/:name", (req, res) => {
    try {
      const raw = (req as unknown as { params?: Record<string, string> }).params?.name ?? "";
      // Reject anything that could escape the directory.
      if (!/^[a-z0-9][a-z0-9_-]*\.(svg|png|jpe?g|webp|gif|ico)$/i.test(raw)) {
        server.json(res, 400, { error: "Invalid brand name" });
        return;
      }
      // assetsDir, not cwd: native packages start in the user's data dir,
      // which has no brand-logos folder.
      const brandDir = assetsDir("brand-logos");
      const fullPath = resolve(brandDir, raw);
      if (!isPathInside(brandDir, fullPath, { allowRoot: false })) {
        server.json(res, 403, { error: "Access denied" });
        return;
      }
      try {
        const buf = readFileSync(fullPath);
        const ext = (raw.split(".").pop() ?? "").toLowerCase();
        const mime: Record<string, string> = {
          svg: "image/svg+xml",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          gif: "image/gif",
          ico: "image/x-icon",
        };
        res.writeHead(200, {
          "Content-Type": mime[ext] ?? "application/octet-stream",
          "Content-Length": buf.length,
          "Cache-Control": "public, max-age=86400",
        });
        res.end(buf);
      } catch {
        server.json(res, 404, { error: "Brand logo not found" });
      }
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Logo (served from bundle dir) ────────────────────────────────────

  server.get("/api/extensions/item/:id/logo", (req, res) => {
    try {
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const row = service.get(id) ?? service.getBySlug(id);
      if (!row) { server.json(res, 404, { error: "Extension not found" }); return; }

      const manifest = safeJson<unknown>(row.manifest_json, null) as { logo?: string } | null;
      const logo = manifest?.logo;
      if (!logo || !row.install_path) {
        server.json(res, 404, { error: "No logo" });
        return;
      }
      // Block path traversal: logo must stay inside install_path.
      const installDir = resolve(row.install_path);
      const fullPath = resolve(installDir, logo);
      if (!isPathInside(installDir, fullPath)) {
        server.json(res, 403, { error: "Invalid logo path" });
        return;
      }
      try {
        const buf = readFileSync(fullPath);
        statSync(fullPath); // throws if missing
        const ext = (logo.split(".").pop() ?? "").toLowerCase();
        const mime: Record<string, string> = {
          svg: "image/svg+xml",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          gif: "image/gif",
          ico: "image/x-icon",
        };
        res.writeHead(200, {
          "Content-Type": mime[ext] ?? "application/octet-stream",
          "Content-Length": buf.length,
          "Cache-Control": "public, max-age=3600",
        });
        res.end(buf);
      } catch {
        server.json(res, 404, { error: "Logo file missing" });
      }
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Frontend page bundles (served from <install_path>/frontend/) ────
  //
  // NOTE: /ext-assets/ is deliberately OUTSIDE the /api/* auth gate (like the
  // dashboard's own static assets) — bundles are public static JS, same trust
  // level as the SPA chunks. Data access still goes through /api/* with auth.

  const EXT_ASSET_MIME: Record<string, string> = {
    // HTML lets an extension ship a standalone page the dashboard can embed in
    // an iframe — how Scene Studio shows a live preview inside the agent
    // drawer without the free shell needing to know anything about three.js.
    // Not a new trust boundary: these same directories already serve the
    // JavaScript that runs inside the dashboard, which is strictly more
    // powerful than a document served beside it. Same-origin is the point —
    // the page reads the auth token from localStorage instead of taking one
    // through the URL.
    html: "text/html; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    map: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    woff2: "font/woff2",
  };

  server.get("/ext-assets/:slug/*", (req, res) => {
    try {
      const params = (req as unknown as { params?: Record<string, string> }).params;
      const slug = params?.slug ?? "";
      let rest = params?.rest ?? "";
      try {
        rest = decodeURIComponent(rest);
      } catch {
        server.json(res, 400, { error: "Invalid path" });
        return;
      }
      const row = service.getBySlug(slug);
      if (!row || row.status !== "active" || !row.install_path) {
        server.json(res, 404, { error: "Extension not found or not active" });
        return;
      }
      const frontendDir = resolve(row.install_path, "frontend");
      const fullPath = resolve(join(frontendDir, rest));
      // Containment: the resolved path must stay inside frontend/.
      // isPathInside, not startsWith(dir + "/"): resolve() returns backslashes
      // on Windows, so the old check 404'd every extension page there.
      if (!isPathInside(frontendDir, fullPath, { allowRoot: false })) {
        server.json(res, 404, { error: "Not found" });
        return;
      }
      const ext = (fullPath.split(".").pop() ?? "").toLowerCase();
      const mime = EXT_ASSET_MIME[ext];
      if (!mime) {
        server.json(res, 404, { error: "Not found" });
        return;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(fullPath);
      } catch {
        server.json(res, 404, { error: "Not found" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const cache = url.searchParams.has("v")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": buf.length,
        "Cache-Control": cache,
      });
      res.end(buf);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Install (JSON payload w/ bundle_path on the server) ─────────────

  server.route<{ bundle_path?: string }>("POST", "/api/extensions/install", async ({ body }) => {
    if (!body.bundle_path) throw new HttpError(400, "bundle_path required");
    const row = await service.installFromBundle(body.bundle_path, {
      type: "file",
      filename: body.bundle_path,
    });
    return { success: true, item: row };
  });

  /**
   * Upgrade an installed extension from a local bundle.
   *
   * `install` refuses when the slug already exists and tells the caller to
   * "use update()" — advice with no way to follow it, because `update()` had
   * no route. Anyone shipping a v2 had to uninstall first, which throws away
   * the install receipt and briefly leaves the extension gone.
   *
   * `force` skips the newer-version check, for re-applying a rebuilt bundle at
   * the same version during development. Entitlement is re-checked against the
   * INCOMING manifest either way, so this cannot be used to sidestep a licence.
   */
  server.route<{ bundle_path?: string; force?: boolean }>(
    "POST", "/api/extensions/item/:id/update", async ({ body }) => {
      if (!body.bundle_path) throw new HttpError(400, "bundle_path required");
      const result = await service.update(
        body.bundle_path,
        { type: "file", filename: body.bundle_path },
        { force: body.force === true },
      );
      return {
        success: true,
        from: result.from,
        to: result.to,
        item: result.extension,
      };
    },
  );

  // ── Install from browser upload (base64 payload) ────────────────────

  server.post("/api/extensions/upload", async (req, res) => {
    try {
      const body = await server.parseBody<{
        filename?: string;
        base64?: string;
        /**
         * Optional remote download watermark — when an upload originates from
         * a watermarking marketplace download (path B), the client passes the
         * X-MTW-Watermark blob back through here so the install receipt
         * preserves the chain of custody.
         *
         * Accepted shapes: a JSON object, OR a base64-encoded JSON string
         * (the dashboard pastes the X-MTW-Watermark header verbatim).
         */
        watermark?: Record<string, unknown> | string;
        /** Override the source descriptor — defaults to {type:"file", filename}. */
        source?: { type: string; [k: string]: unknown };
      }>(req, 50 * 1024 * 1024);

      if (!body.base64) {
        server.json(res, 400, { error: "base64 payload required" });
        return;
      }
      const name = body.filename ?? `upload${BUNDLE_EXT}`;
      const stagingDir = join(tmpdir(), `kernl-upload-${randomBytes(4).toString("hex")}`);
      await mkdir(stagingDir, { recursive: true });
      const stagingPath = join(stagingDir, name);
      await writeFile(stagingPath, Buffer.from(body.base64, "base64"));

      // Decode an optional watermark — accept either an inline object or a
      // base64-encoded JSON string (so the X-MTW-Watermark header value can
      // be passed through verbatim).
      let watermark: Parameters<typeof service.installFromBundle>[2] extends { remoteWatermark?: infer W } ? W | null : null = null;
      if (body.watermark) {
        try {
          const raw =
            typeof body.watermark === "string"
              ? JSON.parse(Buffer.from(body.watermark, "base64").toString("utf-8"))
              : body.watermark;
          watermark = raw as typeof watermark;
        } catch (err) {
          server.json(res, 400, { error: `Invalid watermark: ${String(err)}` });
          return;
        }
      }

      try {
        const source = (body.source as Parameters<typeof service.installFromBundle>[1]) ?? {
          type: "file",
          filename: name,
        };
        const row = await service.installFromBundle(stagingPath, source, {
          remoteWatermark: watermark,
        });
        server.json(res, 200, { success: true, item: row });
      } finally {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Enable / disable / uninstall ─────────────────────────────────────

  server.route("POST", "/api/extensions/item/:id/enable", async ({ params: { id } }) => {
    await service.enable(id);
    return { success: true, item: service.get(id) };
  });

  server.route("POST", "/api/extensions/item/:id/disable", async ({ params: { id } }) => {
    await service.disable(id);
    return { success: true, item: service.get(id) };
  });

  server.route("DELETE", "/api/extensions/item/:id", async ({ params: { id } }) => {
    await service.uninstall(id);
    return { success: true };
  });
  // Fallback for transports without DELETE (POST equivalent).
  server.route("POST", "/api/extensions/item/:id/uninstall", async ({ params: { id } }) => {
    await service.uninstall(id);
    return { success: true };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

interface StatsBlock {
  total: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
}

function computeStats(rows: Array<{ status: string; type: string }>): StatsBlock {
  const by_status: Record<string, number> = {};
  const by_type: Record<string, number> = {};
  for (const r of rows) {
    by_status[r.status] = (by_status[r.status] ?? 0) + 1;
    by_type[r.type] = (by_type[r.type] ?? 0) + 1;
  }
  return { total: rows.length, by_status, by_type };
}
