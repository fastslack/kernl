/**
 * HTTP routes for chat attachments.
 *
 * The upload is the raw request body — no multipart. The server is node:http
 * and streaming the body to disk needs no parser; it also keeps clear of
 * `parseBody`'s 10 MB JSON cap, which a 100 MB video would never fit.
 *
 * Every lookup is by uuid v4 (anything else is a 400 before the store is
 * touched), files are served with `nosniff`, and only images, video and pdf
 * render inline — the rest download.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, isHttpError, type KernelHttpServer } from "../../core/http-server.js";
import { log } from "../../core/logger.js";
import { isAttachmentId, type AttachmentService } from "./service.js";
import type { AttachmentRecord } from "./types.js";

/**
 * The request body as an async iterable that, unlike the stream's own
 * iterator, does not destroy the request when the consumer stops early. An
 * upload refused at 21 MB still has to get its 413 back to the client, and a
 * destroyed socket would turn that into a connection reset.
 */
function requestChunks(req: IncomingMessage): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]() {
      const queue: Buffer[] = [];
      let ended = false;
      let error: Error | null = null;
      let wake: (() => void) | null = null;
      const notify = () => { const w = wake; wake = null; w?.(); };
      const onData = (c: Buffer) => { queue.push(c); if (queue.length > 16) req.pause(); notify(); };
      const onEnd = () => { ended = true; notify(); };
      const onError = (e: Error) => { error = e; notify(); };
      const onAborted = () => { error = new Error("upload aborted"); notify(); };
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("aborted", onAborted);
      const cleanup = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
      };
      return {
        async next(): Promise<IteratorResult<Buffer>> {
          for (;;) {
            if (queue.length > 0) {
              const value = queue.shift()!;
              if (queue.length <= 4) req.resume();
              return { value, done: false };
            }
            if (error) { cleanup(); throw error; }
            if (ended) { cleanup(); return { value: undefined, done: true }; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
        async return(): Promise<IteratorResult<Buffer>> {
          cleanup();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const INLINE = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime|webm)|application\/pdf)$/;

/** `filename*` per RFC 6266 / 5987, plus an ASCII fallback. */
function disposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function mimeForPath(rel: string, fallback: string): string {
  if (rel.endsWith(".jpg")) return "image/jpeg";
  if (rel.endsWith(".png")) return "image/png";
  return fallback;
}

export function registerAttachmentRoutes(server: KernelHttpServer, service: AttachmentService): void {
  const requireRecord = (id: string | undefined): AttachmentRecord => {
    if (!isAttachmentId(id)) throw new HttpError(400, "Invalid attachment id");
    const rec = service.get(id);
    if (!rec) throw new HttpError(404, "Attachment not found");
    return rec;
  };

  /** Stream a stored file, honouring a single byte Range (video seeking needs it). */
  const sendFile = async (
    req: IncomingMessage,
    res: ServerResponse,
    rel: string,
    mime: string,
    disp: string,
  ): Promise<void> => {
    let abs: string;
    let size: number;
    try {
      abs = service.absPath(rel);
      size = (await stat(abs)).size;
    } catch {
      throw new HttpError(404, "File not found");
    }
    const headers: Record<string, string | number> = {
      "Content-Type": mime,
      "Content-Disposition": disp,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "private, max-age=86400",
      "Accept-Ranges": "bytes",
      ...server.corsHeaders(req),
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start: number;
      let end: number;
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(range[2]));
        end = size - 1;
      }
      if (start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}`, ...server.corsHeaders(req) });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") { res.end(); return; }
      createReadStream(abs, { start, end }).on("error", () => res.destroy()).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(abs).on("error", () => res.destroy()).pipe(res);
  };

  // ── Upload: raw body, ?filename=<name> ──────────────────
  server.post("/api/attachments", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const filename = (url.searchParams.get("filename") ?? "").slice(0, 500);
    const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
    try {
      const rec = await service.createFromStream(requestChunks(req), filename, Number.isFinite(declared) ? declared : undefined);
      server.json(res, 200, service.toMeta(rec), req);
    } catch (err) {
      // Whatever is still coming is read and dropped; `Connection: close`
      // ends the socket once the error is out instead of reusing it.
      req.resume();
      res.setHeader("Connection", "close");
      if (isHttpError(err)) {
        server.json(res, err.status, { error: err.message }, req);
        return;
      }
      log.error("attachments: upload failed", err);
      server.json(res, 500, { error: "Upload failed" }, req);
    }
  });

  server.route("GET", "/api/attachments/:id", ({ params }) => service.toMeta(requireRecord(params.id)));

  // `?variant=normalized` serves the resized, metadata-free image when there
  // is one (thumbnails), the original otherwise.
  server.get("/api/attachments/:id/file", async (req, res) => {
    const params = (req as unknown as { params?: Record<string, string> }).params ?? {};
    const rec = requireRecord(params.id);
    const variant = new URL(req.url ?? "/", "http://localhost").searchParams.get("variant");
    if (variant === "normalized" && rec.kind === "image" && rec.derived.normalized) {
      await sendFile(req, res, rec.derived.normalized, mimeForPath(rec.derived.normalized, rec.mime), disposition("inline", rec.filename));
      return;
    }
    const inline = INLINE.test(rec.mime);
    await sendFile(
      req,
      res,
      rec.path,
      inline ? rec.mime : "application/octet-stream",
      disposition(inline ? "inline" : "attachment", rec.filename),
    );
  });

  // n is 0-based and indexes `derived.frames`.
  server.get("/api/attachments/:id/frames/:n", async (req, res) => {
    const params = (req as unknown as { params?: Record<string, string> }).params ?? {};
    const rec = requireRecord(params.id);
    if (!/^\d{1,2}$/.test(params.n ?? "")) throw new HttpError(400, "Invalid frame index");
    const frame = rec.derived.frames?.[Number(params.n)];
    if (!frame) throw new HttpError(404, "Frame not found");
    await sendFile(req, res, frame, "image/jpeg", disposition("inline", `frame-${params.n}.jpg`));
  });

  server.route("DELETE", "/api/attachments/:id", async ({ params }) => {
    if (!isAttachmentId(params.id)) throw new HttpError(400, "Invalid attachment id");
    const result = await service.deleteIfUnbound(params.id);
    if (result === "not_found") throw new HttpError(404, "Attachment not found");
    if (result === "bound") throw new HttpError(409, "The attachment belongs to a sent message");
    return { ok: true, id: params.id };
  });
}
