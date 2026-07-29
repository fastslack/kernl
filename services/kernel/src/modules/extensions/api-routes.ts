/**
 * HTTP API for the unified extensions registry.
 *
 * Mounted under `/api/extensions`. Used by the dashboard to list, install,
 * enable/disable, and remove extensions. Mirrors the MCP tools surface
 * but over HTTP so browsers can upload .kernlext bundles directly.
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import type { KernelHttpServer } from "../../core/http-server.js";
import type { ExtensionService } from "./service.js";
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

  server.get("/api/extensions", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const type = url.searchParams.get("type") as ExtensionType | null;
      const status = url.searchParams.get("status") as ExtensionStatus | null;
      const query = (url.searchParams.get("q") ?? "").toLowerCase();

      let rows = service.list({
        type: type ?? undefined,
        status: status ?? undefined,
      });

      if (query) {
        rows = rows.filter(
          (r) =>
            r.name.toLowerCase().includes(query) ||
            r.slug.toLowerCase().includes(query) ||
            r.id.toLowerCase().includes(query),
        );
      }

      // Return parsed manifests inline so the UI doesn't have to call each item.
      const items = rows.map((r) => ({
        ...r,
        manifest: safeParse(r.manifest_json),
        source: safeParse(r.source_json),
        granted_permissions: safeParse(r.granted_permissions_json),
        settings: safeParse(r.settings_json),
        install_receipt: safeParse(r.install_receipt_json),
      }));

      server.json(res, 200, {
        items,
        total: items.length,
        stats: computeStats(rows),
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Detail ───────────────────────────────────────────────────────────

  server.get("/api/extensions/item/:id", (req, res) => {
    try {
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) {
        server.json(res, 400, { error: "id required" });
        return;
      }
      const row = service.get(id) ?? service.getBySlug(id);
      if (!row) {
        server.json(res, 404, { error: "Extension not found" });
        return;
      }
      server.json(res, 200, {
        item: {
          ...row,
          manifest: safeParse(row.manifest_json),
          source: safeParse(row.source_json),
          granted_permissions: safeParse(row.granted_permissions_json),
          settings: safeParse(row.settings_json),
          install_receipt: safeParse(row.install_receipt_json),
        },
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
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
      const brandDir = resolve(process.cwd(), "assets/brand-logos");
      const fullPath = resolve(brandDir, raw);
      if (!fullPath.startsWith(brandDir + "/")) {
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

      const manifest = safeParse(row.manifest_json) as { logo?: string } | null;
      const logo = manifest?.logo;
      if (!logo || !row.install_path) {
        server.json(res, 404, { error: "No logo" });
        return;
      }
      // Block path traversal: logo must stay inside install_path.
      const installDir = resolve(row.install_path);
      const fullPath = resolve(installDir, logo);
      if (!fullPath.startsWith(installDir + "/") && fullPath !== installDir) {
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
      if (!fullPath.startsWith(frontendDir + "/")) {
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

  server.post("/api/extensions/install", async (req, res) => {
    try {
      const body = await server.parseBody<{ bundle_path?: string }>(req);
      if (!body.bundle_path) {
        server.json(res, 400, { error: "bundle_path required" });
        return;
      }
      const row = await service.installFromBundle(body.bundle_path, {
        type: "file",
        filename: body.bundle_path,
      });
      server.json(res, 200, { success: true, item: row });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

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
      const name = body.filename ?? "upload.kernlext";
      const stagingDir = join(tmpdir(), `kernlext-upload-${randomBytes(4).toString("hex")}`);
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

  server.post("/api/extensions/item/:id/enable", async (req, res) => {
    try {
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      await service.enable(id);
      server.json(res, 200, { success: true, item: service.get(id) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/extensions/item/:id/disable", async (req, res) => {
    try {
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      await service.disable(id);
      server.json(res, 200, { success: true, item: service.get(id) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.delete?.("/api/extensions/item/:id", async (req, res) => {
    try {
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      await service.uninstall(id);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
  // Fallback for transports without DELETE (POST equivalent).
  server.post("/api/extensions/item/:id/uninstall", async (req, res) => {
    try {
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      await service.uninstall(id);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return null; }
}

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
