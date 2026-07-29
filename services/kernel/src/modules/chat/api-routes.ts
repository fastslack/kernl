/**
 * HTTP routes owned by the chat module. Started/messaged via the /chat
 * page on the dashboard. Image serving is sandboxed to the data dir.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import type { KernelHttpServer } from "../../core/http-server.js";
import type { ChatService } from "./service.js";
import type { MemoryDistiller } from "./memory-distiller.js";
import type { EventBus } from "../../core/event-bus.js";
import { PermissionBus } from "./permission-bus.js";
import type {
  ChatStreamEvent,
  ChatStreamSink,
  PermissionRequester,
} from "./types.js";

export function registerChatRoutes(
  server: KernelHttpServer,
  chatService: ChatService,
  events: EventBus,
  distiller: MemoryDistiller | null = null,
): void {
  const permissionBus = new PermissionBus();
  server.post("/api/chat/start", async (req, res) => {
    try {
      const body = await server.parseBody<{
        title?: string;
        provider?: string;
        model?: string;
        instructions?: string;
      }>(req);
      const episode = chatService.createEpisode({
        title: body.title,
        provider: body.provider,
        model: body.model,
        instructions: body.instructions,
      });
      events.emit("data.changed", { module: "chat", action: "start" });
      server.json(res, 200, episode);
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    }
  });

  server.post("/api/chat/message", async (req, res) => {
    try {
      const body = await server.parseBody<{
        episode_id: string;
        message: string;
        images?: Array<{ data: string; media_type: string }>;
        documents?: Array<{ data: string; media_type: string; filename?: string }>;
      }>(req);
      if (!body.episode_id || (!body.message && !body.images?.length && !body.documents?.length)) {
        server.json(res, 400, { error: "episode_id and message (or attachment) required" });
        return;
      }
      const response = await chatService.chat(body.episode_id, body.message ?? "", {
        images: body.images,
        documents: body.documents,
      });
      events.emit("data.changed", { module: "chat", action: "message" });
      server.json(res, 200, response);
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : "Chat error" });
    }
  });

  // ── Streaming chat via Claude Code SDK ──────────────────
  // POST a message; the server keeps the response open and streams SSE
  // events as the SDK loop fires (text deltas, tool_use, tool_result,
  // permission_request, session, done). The dashboard reads the body with
  // fetch+ReadableStream because EventSource can't POST a payload.
  server.post("/api/chat/message/stream", async (req, res) => {
    let episodeId = "";
    try {
      const body = await server.parseBody<{
        episode_id: string;
        message: string;
        /** Optional tool whitelist (`allowed_tools`) — when set the SDK
         *  loop runs ONLY these tools. Prefer `disallowed_tools` for
         *  surgical blocking. */
        allowed_tools?: string[];
        /** Optional tool blacklist — strips the listed tools out of the
         *  SDK loop while leaving everything else (including kernel MCP)
         *  available. */
        disallowed_tools?: string[];
        /** When true, the SDK session ignores host user settings (plugins,
         *  user-scope MCP servers) — built-ins + kernel MCP only. */
        isolate_settings?: boolean;
      }>(req);
      episodeId = body.episode_id ?? "";
      if (!body.episode_id || !body.message) {
        server.json(res, 400, { error: "episode_id and message required" });
        return;
      }

      const sres = res as ServerResponse;
      sres.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      let closed = false;
      const flush = (ev: ChatStreamEvent) => {
        if (closed) return;
        try {
          sres.write(`event: ${ev.type}\n`);
          sres.write(`data: ${JSON.stringify(ev)}\n\n`);
        } catch {
          closed = true;
        }
      };
      const sink: ChatStreamSink = (ev) => flush(ev);

      // Heartbeat every 15s to keep proxies from killing idle connections
      // mid-tool-run. SSE comments are ignored by the browser.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { sres.write(": ping\n\n"); } catch { closed = true; }
      }, 15_000);

      const abortController = new AbortController();
      req.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        abortController.abort();
        // Resolve any parked permission prompts so the SDK subprocess unwinds.
        permissionBus.cancelAllForEpisode(episodeId, "client disconnected");
      });

      const permission: PermissionRequester = {
        ask: (input) => permissionBus.ask({
          request_id: input.request_id,
          episode_id: episodeId,
          tool_name: input.tool_name,
        }),
      };

      try {
        await chatService.chatStream(body.episode_id, body.message, sink, {
          permission,
          signal: abortController.signal,
          allowedTools: Array.isArray(body.allowed_tools) ? body.allowed_tools : undefined,
          disallowedTools: Array.isArray(body.disallowed_tools) ? body.disallowed_tools : undefined,
          isolateSettings: body.isolate_settings === true,
        });
      } catch (err) {
        flush({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          try { sres.end(); } catch { /* ignore */ }
        }
      }
      events.emit("data.changed", { module: "chat", action: "message" });
    } catch (err) {
      // If we haven't started streaming yet, fall back to JSON; otherwise
      // try to emit an error event so the client surfaces it.
      try {
        if (!(res as ServerResponse).headersSent) {
          server.json(res, 500, {
            error: err instanceof Error ? err.message : "Stream error",
          });
        } else {
          (res as ServerResponse).write(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            })}\n\n`,
          );
          (res as ServerResponse).end();
        }
      } catch { /* ignore */ }
    }
  });

  server.post("/api/chat/permission/respond", async (req, res) => {
    try {
      const body = await server.parseBody<{
        request_id: string;
        behavior: "allow" | "deny";
        reason?: string;
      }>(req);
      if (!body.request_id || (body.behavior !== "allow" && body.behavior !== "deny")) {
        server.json(res, 400, { error: "request_id and behavior (allow|deny) required" });
        return;
      }
      const ok = permissionBus.respond(body.request_id, {
        behavior: body.behavior,
        reason: body.reason,
      });
      if (!ok) {
        server.json(res, 404, { error: "Unknown or expired request_id" });
        return;
      }
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    }
  });

  // Serve chat attachments — sandboxed under data/chat-images.
  server.get("/api/chat/images", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.searchParams.get("path") ?? "";
    if (!path || path.includes("..")) {
      server.json(res, 400, { error: "Invalid path" });
      return;
    }
    const fullPath = resolve("./data/chat-images", path);
    const dataDir = resolve("./data/chat-images");
    if (!fullPath.startsWith(dataDir)) {
      server.json(res, 403, { error: "Access denied" });
      return;
    }
    try {
      const buf = readFileSync(fullPath);
      const ext = (path.split(".").pop() ?? "").toLowerCase();
      const mimeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
      };
      res.writeHead(200, {
        "Content-Type": mimeMap[ext] ?? "application/octet-stream",
        "Content-Length": buf.length,
        "Cache-Control": "private, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(buf);
    } catch {
      server.json(res, 404, { error: "Attachment not found" });
    }
  });

  // Hard-delete an episode + its messages (UI sidebar trash button in /chat).
  server.post("/api/chat/episode/delete", async (req, res) => {
    try {
      const body = await server.parseBody<{ episode_id: string }>(req);
      if (!body.episode_id) {
        server.json(res, 400, { error: "episode_id required" });
        return;
      }
      const ok = chatService.deleteEpisode(body.episode_id);
      if (!ok) { server.json(res, 404, { error: "Episode not found" }); return; }
      events.emit("data.changed", { module: "chat", action: "episode_deleted" });
      server.json(res, 200, { success: true, id: body.episode_id });
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    }
  });

  server.post("/api/chat/episode/provider", async (req, res) => {
    try {
      const body = await server.parseBody<{ episode_id: string; provider: string; model?: string }>(req);
      if (!body.episode_id || !body.provider) {
        server.json(res, 400, { error: "episode_id and provider required" });
        return;
      }
      const updated = chatService.updateEpisodeProvider(body.episode_id, body.provider, body.model);
      if (!updated) { server.json(res, 404, { error: "Episode not found" }); return; }
      events.emit("data.changed", { module: "chat", action: "episode_provider" });
      server.json(res, 200, updated);
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    }
  });

  server.get("/api/chat/episodes", (_req, res) => {
    const episodes = chatService.listEpisodes({ limit: 50 });
    server.json(res, 200, episodes);
  });

  server.get("/api/chat/messages", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const episodeId = url.searchParams.get("episode_id");
    if (!episodeId) { server.json(res, 400, { error: "episode_id required" }); return; }
    const messages = chatService.getMessages(episodeId);
    server.json(res, 200, messages);
  });

  // ── Distilled facts ────────────────────────────────────────
  // Surface the durable facts the memory-distiller writes on session_stop.
  // Three endpoints: global search (with category filter), per-episode list,
  // and a category breakdown (counts) for the dashboard "memory" page.
  // All return empty results when the distiller isn't wired (test bootstraps,
  // missing global LLM client) instead of 503-ing — the UI degrades gracefully.

  server.get("/api/chat/distilled-facts", (req, res) => {
    if (!distiller) { server.json(res, 200, { facts: [] }); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const category = url.searchParams.get("category");
    const limitParam = url.searchParams.get("limit");
    let limit = limitParam ? parseInt(limitParam, 10) : 50;
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 500) limit = 500;
    server.json(res, 200, { facts: distiller.search(category, limit) });
  });

  server.get("/api/chat/distilled-facts/episode", (req, res) => {
    if (!distiller) { server.json(res, 200, { facts: [] }); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const episodeId = url.searchParams.get("episode_id");
    if (!episodeId) { server.json(res, 400, { error: "episode_id required" }); return; }
    server.json(res, 200, { facts: distiller.listForEpisode(episodeId) });
  });

  server.get("/api/chat/distilled-facts/summary", (_req, res) => {
    if (!distiller) {
      server.json(res, 200, { categories: [], total: 0 });
      return;
    }
    // The summary is small and recomputes cheap — no need for a stored view.
    // Walk all facts once, bucket by category.
    const all = distiller.search(null, 500);
    const byCategory = new Map<string, { count: number; latest: string }>();
    for (const f of all) {
      const prev = byCategory.get(f.category);
      if (!prev) {
        byCategory.set(f.category, { count: 1, latest: f.created_at });
      } else {
        prev.count++;
        if (f.created_at > prev.latest) prev.latest = f.created_at;
      }
    }
    const categories = [...byCategory.entries()]
      .map(([category, v]) => ({ category, count: v.count, latest: v.latest }))
      .sort((a, b) => b.count - a.count);
    server.json(res, 200, { categories, total: all.length });
  });
}
