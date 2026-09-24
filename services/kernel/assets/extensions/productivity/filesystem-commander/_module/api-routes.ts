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
import {
  HttpError,
  isHttpError,
  type KernelHttpServer,
  checkProtected,
  formatViolation,
  log,
} from "@kernl/extension-sdk";
import type { FsCommanderService } from "./service.js";
import { buildPreview, guessMime } from "./preview.js";

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

/**
 * Nearly every failure on this surface is the caller's (bad path, unknown
 * provider, sandbox violation, missing file), so these routes answer 400 with
 * the error's message rather than the helper's default 500. An HttpError
 * thrown inside keeps its own status.
 */
async function as400<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isHttpError(err)) throw err;
    throw new HttpError(400, errMessage(err));
  }
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

  server.route("GET", "/api/fs/providers", () => ({ items: service.listProviders() }));

  // ── List / stat ──────────────────────────────────────────────────────

  server.route("GET", "/api/fs/list", ({ query }) => as400(() => {
    const providerId = requireStr(query.get("provider"), "provider");
    const path = requireStr(query.get("path"), "path");
    return service.get(providerId).list(path);
  }));

  server.route("GET", "/api/fs/stat", ({ query }) => as400(() => {
    const providerId = requireStr(query.get("provider"), "provider");
    const path = requireStr(query.get("path"), "path");
    return service.get(providerId).stat(path);
  }));

  // ── Bookmarks ────────────────────────────────────────────────────────

  server.route("GET", "/api/fs/bookmarks", () => ({ items: service.bookmarksList() }));

  server.route<{
    label?: string;
    provider_id?: string;
    path?: string;
    sort_order?: number;
  }>("POST", "/api/fs/bookmarks", ({ body }) => as400(() => {
    if (!body.label || !body.provider_id || !body.path) {
      throw new HttpError(400, "label, provider_id, path required");
    }
    const row = service.bookmarkAdd({
      label: body.label,
      providerId: body.provider_id,
      path: body.path,
      sortOrder: body.sort_order,
    });
    return { item: row };
  }));

  server.route("DELETE", "/api/fs/bookmarks/:id", ({ params: { id } }) => {
    service.bookmarkRemove(id);
    return { success: true };
  });

  // ── Tabs ─────────────────────────────────────────────────────────────

  server.route("GET", "/api/fs/tabs", ({ query }) => as400(() => {
    const pane = paneParam(query.get("pane"));
    return { items: service.tabsGet(pane) };
  }));

  // Left raw: route() reads an empty body as {}, which would wipe the pane's
  // tabs (tabs ?? []) where an empty body used to be rejected as invalid JSON.
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

  server.route("GET", "/api/fs/history", ({ query }) => as400(() => {
    const pane = paneParam(query.get("pane"));
    const limit = Math.min(parseInt(query.get("limit") ?? "100", 10) || 100, 500);
    return { items: service.historyList(pane, limit) };
  }));

  server.route<{
    pane?: string;
    provider_id?: string;
    path?: string;
  }>("POST", "/api/fs/history", ({ body }) => as400(() => {
    const pane = paneParam(body.pane ?? null);
    if (!body.provider_id || !body.path) {
      throw new HttpError(400, "provider_id, path required");
    }
    service.historyPush(pane, body.provider_id, body.path);
    return { success: true };
  }));

  // ── Mutations ────────────────────────────────────────────────────────

  server.route<{
    provider?: string;
    path?: string;
    recursive?: boolean;
  }>("POST", "/api/fs/mkdir", ({ body }) => as400(async () => {
    if (!body.provider || !body.path) {
      throw new HttpError(400, "provider, path required");
    }
    await service.get(body.provider).mkdir(body.path, {
      recursive: body.recursive ?? false,
    });
    return { success: true };
  }));

  server.route<{
    provider?: string;
    from?: string;
    to?: string;
  }>("POST", "/api/fs/rename", ({ body }) => as400(async () => {
    if (!body.provider || !body.from || !body.to) {
      throw new HttpError(400, "provider, from, to required");
    }
    await service.get(body.provider).rename(body.from, body.to);
    return { success: true };
  }));

  server.route<{
    provider?: string;
    paths?: string[];
    recursive?: boolean;
  }>("POST", "/api/fs/delete", ({ req, res, body }) => as400(async () => {
    if (!body.provider || !Array.isArray(body.paths) || body.paths.length === 0) {
      throw new HttpError(400, "provider, paths[] required");
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
    const result = {
      success: errors.length === 0,
      deleted: body.paths.length - errors.length,
      errors,
    };
    // Partial failure: 207 with the per-path errors.
    if (errors.length) { server.json(res, 207, result, req); return; }
    return result;
  }));

  server.route<OpBody>("POST", "/api/fs/ops/copy", ({ body }) =>
    as400(() => startOp(service, body, "copy")));

  server.route<OpBody>("POST", "/api/fs/ops/move", ({ body }) =>
    as400(() => startOp(service, body, "move")));

  server.route("GET", "/api/fs/ops", () => ({ items: service.ops.list() }));

  server.route("GET", "/api/fs/ops/:id", ({ params: { id } }) => {
    const p = service.ops.get(id);
    if (!p) throw new HttpError(404, "op not found");
    return p;
  });

  server.route("DELETE", "/api/fs/ops/:id", ({ params: { id } }) => {
    if (!service.ops.cancel(id)) throw new HttpError(409, "op not cancellable", { success: false });
    return { success: true };
  });

  // ── Remotes ──────────────────────────────────────────────────────

  server.route("GET", "/api/fs/remotes", () => ({ items: service.remotesList() }));

  server.route<{
    kind?: "sftp" | "s3" | "webdav";
    label?: string;
    config?: Record<string, unknown>;
  }>("POST", "/api/fs/remotes", ({ body }) => as400(async () => {
    if (!body.kind || !body.label || !body.config) {
      throw new HttpError(400, "kind, label, config required");
    }
    const info = await service.addRemote({
      kind: body.kind,
      label: body.label,
      config: body.config as unknown as Parameters<typeof service.addRemote>[0]["config"],
    });
    return { item: info };
  }));

  server.route("POST", "/api/fs/remotes/:id/test", ({ req, res, params: { id } }) => as400(async () => {
    const r = await service.testRemote(id);
    if (!r.ok) { server.json(res, 502, r, req); return; }
    return r;
  }));

  server.route("DELETE", "/api/fs/remotes/:id", ({ params: { id } }) => as400(async () => {
    await service.removeRemote(id);
    return { success: true };
  }));

  // ── Archives ─────────────────────────────────────────────────────

  server.route<{
    source_provider?: string;
    path?: string;
  }>("POST", "/api/fs/archive/open", ({ body }) => as400(async () => {
    if (!body.source_provider || !body.path) {
      throw new HttpError(400, "source_provider, path required");
    }
    return service.openArchive(body.source_provider, body.path);
  }));

  server.route<{ provider?: string }>("POST", "/api/fs/archive/close", ({ body }) => as400(async () => {
    if (!body.provider) throw new HttpError(400, "provider required");
    await service.closeArchive(body.provider);
    return { success: true };
  }));

  // ── Preview (F3) ─────────────────────────────────────────────────

  // Left raw: with raw=1 it streams the file itself with its own MIME type.
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

  server.route("GET", "/api/fs/read", ({ query }) => as400(async () => {
    const providerId = requireStr(query.get("provider"), "provider");
    const path = requireStr(query.get("path"), "path");
    const asText = query.get("text") === "1" || query.get("text") === "true";
    const provider = service.get(providerId);
    const stat = await provider.stat(path);
    if (stat.size > opts.maxEditorBytes) {
      throw new HttpError(413, `File too large (${stat.size} > ${opts.maxEditorBytes})`);
    }
    const stream = await provider.readStream(path);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (asText) {
      return {
        content: buf.toString("utf-8"),
        encoding: "utf-8",
        mime: guessMime(path),
        size: stat.size,
        mtime: stat.mtime,
      };
    }
    return {
      content: buf.toString("base64"),
      encoding: "base64",
      mime: guessMime(path),
      size: stat.size,
      mtime: stat.mtime,
    };
  }));

  // Left raw: needs a 16 MB body cap (route() allows 10 MB).
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

  // Server-sent events: live progress stream for a single op. Left raw (SSE).
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

type OpBody = {
  src_provider?: string;
  dst_provider?: string;
  items?: Array<{ from: string; to: string }>;
  overwrite?: boolean;
};

function startOp(
  service: FsCommanderService,
  body: OpBody,
  kind: "copy" | "move",
): { op_id: string } {
  if (!body.src_provider || !body.dst_provider || !Array.isArray(body.items) || body.items.length === 0) {
    throw new HttpError(400, "src_provider, dst_provider, items[] required");
  }
  const opId = service.ops.start({
    kind,
    src: service.get(body.src_provider),
    dst: service.get(body.dst_provider),
    items: body.items,
    overwrite: body.overwrite ?? false,
  });
  return { op_id: opId };
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
