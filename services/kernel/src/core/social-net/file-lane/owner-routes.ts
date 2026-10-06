// services/kernel/src/core/social-net/file-lane/owner-routes.ts
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import { log } from "../../logger.js";
import type { KernelHttpServer } from "../../http-server.js";
import { isHttpError } from "../../http-server.js";
import type { TransferOwner } from "./owner.js";
import { readBody } from "./body.js";
import { CHUNK_SIZE } from "./limits.js";

export function registerTransferOwnerRoutes(server: KernelHttpServer, owner: TransferOwner): void {
  server.route("GET", "/api/transfers", () => ({ transfers: owner.list() }));
  server.route("POST", "/api/transfers", ({ body }) => owner.createOutgoing(body), { requireBody: true });
  server.route("POST", "/api/transfers/:id/accept", async ({ params, body }) => { await owner.accept(params.id, body?.always === true); return { ok: true }; });
  server.route("POST", "/api/transfers/:id/reject", ({ params }) => { owner.reject(params.id); return { ok: true }; });
  server.route("POST", "/api/transfers/:id/cancel", async ({ params }) => { await owner.cancel(params.id); return { ok: true }; });
  server.route("POST", "/api/transfers/:id/retry", ({ params }) => { owner.retry(params.id); return { ok: true }; });

  server.put("/api/transfers/:id/upload/:n/:k", async (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params;
      const sha = new URL(req.url ?? "/", "http://x").searchParams.get("sha");
      const data = await readBody(req, CHUNK_SIZE);
      await owner.uploadChunk(p.id, Number(p.n), Number(p.k), sha, new Uint8Array(data));
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, isHttpError(err) ? err.status : 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Download to the browser, with Range so big files resume and media can seek.
  server.get("/api/transfers/:id/files/:n", async (req, res) => {
    const p = (req as unknown as { params: Record<string, string> }).params;
    const f = owner.filePath(p.id, Number(p.n));
    if (!f) return server.json(res, 404, { error: "not found" });
    const headers: Record<string, string> = {
      "Content-Type": f.mime || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "Accept-Ranges": "bytes",
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (m && f.size > 0) {
      const start = m[1] ? Number(m[1]) : Math.max(0, f.size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), f.size - 1) : f.size - 1;
      if (start > end || start >= f.size) { res.writeHead(416, { "Content-Range": `bytes */${f.size}` }); res.end(); return; }
      await sendFile(res, f.path, 206, { ...headers, "Content-Range": `bytes ${start}-${end}/${f.size}`, "Content-Length": String(end - start + 1) }, { start, end });
      return;
    }
    await sendFile(res, f.path, 200, { ...headers, "Content-Length": String(f.size) });
  });
}

/**
 * Stream a file to the browser. An unhandled stream error takes the whole
 * Bun process down, so everything goes through pipeline: a vanished file or
 * EISDIR before the first byte answers 404/500, a failure mid-way cuts the
 * response, and a client that hangs up closes the file descriptor.
 */
async function sendFile(res: ServerResponse, path: string, status: number, headers: Record<string, string>, range?: { start: number; end: number }): Promise<void> {
  const refuse = (code: number, error: string) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  };
  // Checked before any header goes out, so a moved file or a directory in its
  // place still gets a clean status code (a directory opens fine and only
  // fails on the first read, with EISDIR).
  try {
    if (!(await stat(path)).isFile()) return refuse(404, "file not found");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? refuse(404, "file not found") : refuse(500, "could not read the file");
  }
  const stream = createReadStream(path, range);
  try {
    await new Promise<void>((resolve, reject) => { stream.once("open", () => resolve()); stream.once("error", reject); });
  } catch {
    stream.destroy();
    return refuse(500, "could not read the file");
  }
  res.writeHead(status, headers);
  try {
    await pipeline(stream, res);
  } catch (err) {
    // Client gone (ERR_STREAM_PREMATURE_CLOSE) or a read error mid-way: pipeline
    // already destroyed both ends; nothing else to answer.
    log.debug(`file-lane: download of ${path} stopped: ${String(err)}`);
    if (!res.destroyed) res.destroy();
  }
}
