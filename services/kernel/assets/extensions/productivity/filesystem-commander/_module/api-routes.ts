/**
 * HTTP API for Filesystem Commander.
 *
 * Mounted via the module's DashboardDescriptor.registerRoutes hook.
 * Phase-1 surface: providers, list, stat, bookmarks, tabs, history.
 * Mutating + transfer endpoints land in later phases.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { FsCommanderService } from "./service.js";
import { buildPreview, guessMime } from "./preview.js";
import { checkProtected, formatViolation } from "../../../../../src/core/protected-files.js";
import { log } from "../../../../../src/core/logger.js";

function q(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://localhost").searchParams;
}

function params(req: IncomingMessage): Record<string, string> {
  return (req as unknown as { params?: Record<string, string> }).params ?? {};
}

function requireStr(value: string | null, name: string): string {
  if (!value) throw new Error(`${name} required`);
  return value;
}

export function registerFilesystemCommanderRoutes(
  server: KernelHttpServer,
  service: FsCommanderService,
  opts: { maxPreviewBytes: number; maxEditorBytes: number } = {
    maxPreviewBytes: 2 * 1024 * 1024,
    maxEditorBytes: 4 * 1024 * 1024,
  },
): void {
  // ── Providers ────────────────────────────────────────────────────────

  server.get("/api/fs/providers", (req, res) => {
    server.json(res, 200, { items: service.listProviders() });
  });

  // ── List / stat ──────────────────────────────────────────────────────

  server.get("/api/fs/list", async (req, res) => {
    try {
      const s = q(req);
      const providerId = requireStr(s.get("provider"), "provider");
      const path = requireStr(s.get("path"), "path");
      const listing = await service.get(providerId).list(path);
      server.json(res, 200, listing, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  server.get("/api/fs/stat", async (req, res) => {
    try {
      const s = q(req);
      const providerId = requireStr(s.get("provider"), "provider");
      const path = requireStr(s.get("path"), "path");
      const stat = await service.get(providerId).stat(path);
      server.json(res, 200, stat, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  // ── Bookmarks ────────────────────────────────────────────────────────

  server.get("/api/fs/bookmarks", (req, res) => {
    server.json(res, 200, { items: service.bookmarksList() }, req);
  });

  server.post("/api/fs/bookmarks", async (req, res) => {
    try {
      const body = await server.parseBody<{
        label?: string;
        provider_id?: string;
        path?: string;
        sort_order?: number;
      }>(req);
      if (!body.label || !body.provider_id || !body.path) {
        server.json(res, 400, { error: "label, provider_id, path required" });
        return;
      }
      const row = service.bookmarkAdd({
        label: body.label,
        providerId: body.provider_id,
        path: body.path,
        sortOrder: body.sort_order,
      });
      server.json(res, 200, { item: row }, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  server.delete("/api/fs/bookmarks/:id", (req, res) => {
    const id = params(req).id;
    if (!id) { server.json(res, 400, { error: "id required" }); return; }
    service.bookmarkRemove(id);
    server.json(res, 200, { success: true });
  });

  // ── Tabs ─────────────────────────────────────────────────────────────

  server.get("/api/fs/tabs", (req, res) => {
    try {
      const pane = paneParam(q(req).get("pane"));
      server.json(res, 200, { items: service.tabsGet(pane) }, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  server.put("/api/fs/tabs", async (req, res) => {
    try {
      const pane = paneParam(q(req).get("pane"));
      const body = await server.parseBody<{
        tabs?: Array<{ provider_id: string; path: string; title?: string }>;
      }>(req);
      const rows = service.tabsSet(pane, body.tabs ?? []);
      server.json(res, 200, { items: rows }, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  // ── History ──────────────────────────────────────────────────────────

  server.get("/api/fs/history", (req, res) => {
    try {
      const s = q(req);
      const pane = paneParam(s.get("pane"));
      const limit = Math.min(parseInt(s.get("limit") ?? "100", 10) || 100, 500);
      server.json(res, 200, { items: service.historyList(pane, limit) }, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  server.post("/api/fs/history", async (req, res) => {
    try {
      const body = await server.parseBody<{
        pane?: string;
        provider_id?: string;
        path?: string;
      }>(req);
      const pane = paneParam(body.pane ?? null);
      if (!body.provider_id || !body.path) {
        server.json(res, 400, { error: "provider_id, path required" });
        return;
      }
      service.historyPush(pane, body.provider_id, body.path);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) });
    }
  });

  // ── Mutations ────────────────────────────────────────────────────────

  server.post("/api/fs/mkdir", async (req, res) => {
    try {
      const body = await server.parseBody<{
        provider?: string;
        path?: string;
        recursive?: boolean;
      }>(req);
      if (!body.provider || !body.path) {
        server.json(res, 400, { error: "provider, path required" });
        return;
      }
      await service.get(body.provider).mkdir(body.path, {
        recursive: body.recursive ?? false,
      });
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) });
    }
  });

  server.post("/api/fs/rename", async (req, res) => {
    try {
      const body = await server.parseBody<{
        provider?: string;
        from?: string;
        to?: string;
      }>(req);
      if (!body.provider || !body.from || !body.to) {
        server.json(res, 400, { error: "provider, from, to required" });
        return;
      }
      await service.get(body.provider).rename(body.from, body.to);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) });
    }
  });

  server.post("/api/fs/delete", async (req, res) => {
    try {
      const body = await server.parseBody<{
        provider?: string;
        paths?: string[];
        recursive?: boolean;
      }>(req);
      if (!body.provider || !Array.isArray(body.paths) || body.paths.length === 0) {
        server.json(res, 400, { error: "provider, paths[] required" });
        return;
      }
      const p = service.get(body.provider);
      const errors: Array<{ path: string; error: string }> = [];
      for (const path of body.paths) {
        try {
          await p.rm(path, { recursive: body.recursive ?? false });
        } catch (err) {
          errors.push({ path, error: errMessage(err) });
        }
      }
      server.json(res, errors.length ? 207 : 200, {
        success: errors.length === 0,
        deleted: body.paths.length - errors.length,
        errors,
      });
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) });
    }
  });

  server.post("/api/fs/ops/copy", async (req, res) => {
    await startOp(server, service, req, res, "copy");
  });

  server.post("/api/fs/ops/move", async (req, res) => {
    await startOp(server, service, req, res, "move");
  });

  server.get("/api/fs/ops", (req, res) => {
    server.json(res, 200, { items: service.ops.list() }, req);
  });

  server.get("/api/fs/ops/:id", (req, res) => {
    const id = params(req).id;
    const p = id ? service.ops.get(id) : null;
    if (!p) { server.json(res, 404, { error: "op not found" }); return; }
    server.json(res, 200, p, req);
  });

  server.delete("/api/fs/ops/:id", (req, res) => {
    const id = params(req).id;
    if (!id) { server.json(res, 400, { error: "id required" }); return; }
    const ok = service.ops.cancel(id);
    server.json(res, ok ? 200 : 409, { success: ok });
  });

  // ── Remotes ──────────────────────────────────────────────────────

  server.get("/api/fs/remotes", (req, res) => {
    server.json(res, 200, { items: service.remotesList() }, req);
  });

  server.post("/api/fs/remotes", async (req, res) => {
    try {
      const body = await server.parseBody<{
        kind?: "sftp" | "s3" | "webdav";
        label?: string;
        config?: Record<string, unknown>;
      }>(req);
      if (!body.kind || !body.label || !body.config) {
        server.json(res, 400, { error: "kind, label, config required" });
        return;
      }
      const info = await service.addRemote({
        kind: body.kind,
        label: body.label,
        config: body.config as unknown as Parameters<typeof service.addRemote>[0]["config"],
      });
      server.json(res, 200, { item: info }, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  server.post("/api/fs/remotes/:id/test", async (req, res) => {
    try {
      const id = params(req).id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const r = await service.testRemote(id);
      server.json(res, r.ok ? 200 : 502, r, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  server.delete("/api/fs/remotes/:id", async (req, res) => {
    try {
      const id = params(req).id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      await service.removeRemote(id);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  // ── Archives ─────────────────────────────────────────────────────

  server.post("/api/fs/archive/open", async (req, res) => {
    try {
      const body = await server.parseBody<{
        source_provider?: string;
        path?: string;
      }>(req);
      if (!body.source_provider || !body.path) {
        server.json(res, 400, { error: "source_provider, path required" });
        return;
      }
      const info = await service.openArchive(body.source_provider, body.path);
      server.json(res, 200, info, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  server.post("/api/fs/archive/close", async (req, res) => {
    try {
      const body = await server.parseBody<{ provider?: string }>(req);
      if (!body.provider) {
        server.json(res, 400, { error: "provider required" });
        return;
      }
      await service.closeArchive(body.provider);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  // ── Preview (F3) ─────────────────────────────────────────────────

  server.get("/api/fs/preview", async (req, res) => {
    try {
      const s = q(req);
      const providerId = requireStr(s.get("provider"), "provider");
      const path = requireStr(s.get("path"), "path");
      const raw = s.get("raw") === "1";
      const provider = service.get(providerId);

      if (raw) {
        // Stream the file as-is with inferred MIME. Range requests not yet
        // implemented — video seek in the UI will work end-to-end once we
        // parse Range headers (fase 5).
        const mime = guessMime(path);
        const stat = await provider.stat(path);
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": String(stat.size),
          "Content-Disposition": `inline; filename="${encodeURIComponent(stat.name)}"`,
          "Cache-Control": "no-store",
        });
        const stream = await provider.readStream(path);
        await pipeline(stream, res);
        return;
      }

      const result = await buildPreview(provider, path, {
        maxTextBytes: opts.maxPreviewBytes,
        maxHexBytes: opts.maxPreviewBytes * 2,
      });
      server.json(res, 200, result, req);
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  // ── Read / Write (editor, F4) ────────────────────────────────────

  server.get("/api/fs/read", async (req, res) => {
    try {
      const s = q(req);
      const providerId = requireStr(s.get("provider"), "provider");
      const path = requireStr(s.get("path"), "path");
      const asText = s.get("text") === "1" || s.get("text") === "true";
      const provider = service.get(providerId);
      const stat = await provider.stat(path);
      if (stat.size > opts.maxEditorBytes) {
        server.json(res, 413, {
          error: `File too large (${stat.size} > ${opts.maxEditorBytes})`,
        });
        return;
      }
      const stream = await provider.readStream(path);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (asText) {
        server.json(res, 200, {
          content: buf.toString("utf-8"),
          encoding: "utf-8",
          mime: guessMime(path),
          size: stat.size,
          mtime: stat.mtime,
        }, req);
      } else {
        server.json(res, 200, {
          content: buf.toString("base64"),
          encoding: "base64",
          mime: guessMime(path),
          size: stat.size,
          mtime: stat.mtime,
        }, req);
      }
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) }, req);
    }
  });

  server.post("/api/fs/write", async (req, res) => {
    try {
      const body = await server.parseBody<{
        provider?: string;
        path?: string;
        content?: string;
        encoding?: "utf-8" | "base64";
        overwrite?: boolean;
        expected_mtime?: string;
      }>(req, 16 * 1024 * 1024);
      if (!body.provider || !body.path || body.content === undefined) {
        server.json(res, 400, { error: "provider, path, content required" });
        return;
      }
      // Block writes to kernel-protected paths (.env, lockfiles, *.test.ts,
      // SSH keys, CI configs). The dashboard editor is human-driven so a
      // 403 with a clear message is the right surface — power users can
      // still edit these files via shell if they really need to.
      const violation = checkProtected(body.path);
      if (violation) {
        log.warn(`/api/fs/write blocked: ${formatViolation(body.path, violation)}`);
        server.json(res, 403, { error: formatViolation(body.path, violation) });
        return;
      }
      const provider = service.get(body.provider);
      // Optimistic concurrency check: fail if file has changed since caller
      // loaded it in the editor.
      if (body.expected_mtime && body.overwrite) {
        try {
          const cur = await provider.stat(body.path);
          if (cur.mtime !== body.expected_mtime) {
            server.json(res, 409, {
              error: "File changed on disk since last read",
              current_mtime: cur.mtime,
            });
            return;
          }
        } catch {
          // Not found → fresh write, fine.
        }
      }
      const buf =
        body.encoding === "base64"
          ? Buffer.from(body.content, "base64")
          : Buffer.from(body.content, "utf-8");
      const sink = await provider.writeStream(body.path, {
        overwrite: body.overwrite ?? true,
        expectedSize: buf.length,
      });
      await pipeline(Readable.from(buf), sink);
      const after = await provider.stat(body.path);
      server.json(res, 200, { success: true, size: after.size, mtime: after.mtime });
    } catch (err) {
      server.json(res, 400, { error: errMessage(err) });
    }
  });

  // Server-sent events: live progress stream for a single op.
  server.get("/api/fs/ops/:id/stream", (req, res) => {
    const id = params(req).id;
    const current = id ? service.ops.get(id) : null;
    if (!current) { server.json(res, 404, { error: "op not found" }); return; }
    writeSseHead(res);
    writeSseEvent(res, current);
    const unsub = service.ops.subscribe(id!, (p) => {
      writeSseEvent(res, p);
      if (p.status === "done" || p.status === "error" || p.status === "cancelled") {
        res.end();
      }
    });
    res.on("close", unsub);
  });
}

async function startOp(
  server: KernelHttpServer,
  service: FsCommanderService,
  req: IncomingMessage,
  res: ServerResponse,
  kind: "copy" | "move",
): Promise<void> {
  try {
    const body = await server.parseBody<{
      src_provider?: string;
      dst_provider?: string;
      items?: Array<{ from: string; to: string }>;
      overwrite?: boolean;
    }>(req);
    if (!body.src_provider || !body.dst_provider || !Array.isArray(body.items) || body.items.length === 0) {
      server.json(res, 400, {
        error: "src_provider, dst_provider, items[] required",
      });
      return;
    }
    const opId = service.ops.start({
      kind,
      src: service.get(body.src_provider),
      dst: service.get(body.dst_provider),
      items: body.items,
      overwrite: body.overwrite ?? false,
    });
    server.json(res, 200, { op_id: opId });
  } catch (err) {
    server.json(res, 400, { error: errMessage(err) });
  }
}

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function writeSseEvent(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function paneParam(raw: string | null): "left" | "right" {
  if (raw !== "left" && raw !== "right") throw new Error("pane must be 'left' or 'right'");
  return raw;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
