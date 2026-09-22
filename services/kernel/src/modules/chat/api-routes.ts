/**
 * HTTP routes owned by the chat module. Started/messaged via the /chat
 * page on the dashboard. Image serving is sandboxed to the data dir.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { HttpError, isHttpError, type KernelHttpServer, type RouteMethod } from "../../core/http-server.js";
import type { ChatService } from "./service.js";
import { chatOperations } from "./operations.js";
import { EpisodeLockedError } from "./service.js";
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

  /** These routes answer a failure of the service call with a 400 carrying its message. */
  const asBadRequest = (err: unknown): HttpError =>
    isHttpError(err) ? err : new HttpError(400, err instanceof Error ? err.message : "Bad request");

  // ── Operations shared with the WS RPC (operations.ts) ─────────
  // The dashboard reaches these through rpcOrCall, WS first and HTTP when
  // the bridge is down, so both roads run the same function.
  const op = chatOperations({ chatService, events });
  const bind = ([method, path, name]: [RouteMethod, string, string]) => server.operation(method, path, op[name]);
  ([
    ["POST", "/api/chat/start", "chat.episode.start"],
    ["POST", "/api/chat/message", "chat.message.send"],
    ["GET", "/api/chat/episodes", "chat.episodes.list"],
    ["GET", "/api/chat/messages", "chat.messages.list"],
  ] as Array<[RouteMethod, string, string]>).forEach(bind);

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
        ...server.corsHeaders(req),
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

  server.route<{
    request_id: string;
    behavior: "allow" | "deny";
    reason?: string;
  }>("POST", "/api/chat/permission/respond", ({ body }) => {
    if (!body.request_id || (body.behavior !== "allow" && body.behavior !== "deny")) {
      throw new HttpError(400, "request_id and behavior (allow|deny) required");
    }
    let ok: boolean;
    try {
      ok = permissionBus.respond(body.request_id, {
        behavior: body.behavior,
        reason: body.reason,
      });
    } catch (err) {
      throw asBadRequest(err);
    }
    if (!ok) throw new HttpError(404, "Unknown or expired request_id");
    return { ok: true };
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
        ...server.corsHeaders(req),
      });
      res.end(buf);
    } catch {
      server.json(res, 404, { error: "Attachment not found" });
    }
  });

  // Hard-delete an episode + its messages (UI sidebar trash button in /chat).
  server.route<{ episode_id: string }>("POST", "/api/chat/episode/delete", ({ body }) => {
    if (!body.episode_id) throw new HttpError(400, "episode_id required");
    let ok: boolean;
    try {
      ok = chatService.deleteEpisode(body.episode_id);
    } catch (err) {
      throw asBadRequest(err);
    }
    if (!ok) throw new HttpError(404, "Episode not found");
    events.emit("data.changed", { module: "chat", action: "episode_deleted" });
    return { success: true, id: body.episode_id };
  });

  server.route<{ episode_id: string; provider: string; model?: string }>(
    "POST", "/api/chat/episode/provider", ({ body }) => {
      if (!body.episode_id || !body.provider) {
        throw new HttpError(400, "episode_id and provider required");
      }
      let updated: ReturnType<ChatService["updateEpisodeProvider"]>;
      try {
        updated = chatService.updateEpisodeProvider(body.episode_id, body.provider, body.model);
      } catch (err) {
        // A started conversation's model is fixed — that's a conflict with the
        // episode's state, not a malformed request, so it gets its own status.
        if (err instanceof EpisodeLockedError) {
          throw new HttpError(409, err.message, { error: err.message, locked: true, message_count: err.messageCount });
        }
        throw asBadRequest(err);
      }
      if (!updated) throw new HttpError(404, "Episode not found");
      events.emit("data.changed", { module: "chat", action: "episode_provider" });
      return updated;
    },
  );

  // ── Distilled facts ────────────────────────────────────────
  // Surface the durable facts the memory-distiller writes on session_stop.
  // Three endpoints: global search (with category filter), per-episode list,
  // and a category breakdown (counts) for the dashboard "memory" page.
  // All return empty results when the distiller isn't wired (test bootstraps,
  // missing global LLM client) instead of 503-ing — the UI degrades gracefully.

  server.route("GET", "/api/chat/distilled-facts", ({ query }) => {
    if (!distiller) return { facts: [] };
    const category = query.get("category");
    const limitParam = query.get("limit");
    let limit = limitParam ? parseInt(limitParam, 10) : 50;
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 500) limit = 500;
    return { facts: distiller.search(category, limit) };
  });

  server.route("GET", "/api/chat/distilled-facts/episode", ({ query }) => {
    if (!distiller) return { facts: [] };
    const episodeId = query.get("episode_id");
    if (!episodeId) throw new HttpError(400, "episode_id required");
    return { facts: distiller.listForEpisode(episodeId) };
  });

  server.route("GET", "/api/chat/distilled-facts/summary", () => {
    if (!distiller) return { categories: [], total: 0 };
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
    return { categories, total: all.length };
  });
}
