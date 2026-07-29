import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { TwitterService } from "./service.js";
import type { TwitterPublisher } from "./publisher.js";

export function registerTwitterRoutes(
  server: KernelHttpServer,
  service: TwitterService,
  publisher: TwitterPublisher,
): void {
  // ── Accounts ───────────────────────────────────────

  server.get("/api/twitter/accounts", (_req, res) => {
    server.json(res, 200, service.listAccounts());
  });

  server.post("/api/twitter/accounts", async (req, res) => {
    try {
      const body = await server.parseBody<{
        handle: string;
        display_name?: string;
        api_key?: string;
        api_secret?: string;
        access_token?: string;
        access_secret?: string;
      }>(req);
      if (!body.handle) {
        server.json(res, 400, { error: "handle is required" });
        return;
      }
      const account = service.addAccount(body);
      server.json(res, 200, account);
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  server.post("/api/twitter/accounts/update", async (req, res) => {
    try {
      const body = await server.parseBody<{
        id: string;
        handle?: string;
        display_name?: string;
        api_key?: string;
        api_secret?: string;
        access_token?: string;
        access_secret?: string;
        status?: string;
      }>(req);
      if (!body.id) {
        server.json(res, 400, { error: "id is required" });
        return;
      }
      const { id, ...changes } = body;
      const account = service.updateAccount(id, changes);
      if (!account) {
        server.json(res, 404, { error: "Account not found" });
        return;
      }
      server.json(res, 200, account);
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  // ── Posts ──────────────────────────────────────────

  server.get("/api/twitter/posts", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const status = url.searchParams.get("status") ?? undefined;
    const account_id = url.searchParams.get("account_id") ?? undefined;
    const post_type = url.searchParams.get("post_type") ?? undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    server.json(res, 200, service.listPosts({ status, account_id, post_type, limit, offset }));
  });

  server.post("/api/twitter/posts", async (req, res) => {
    try {
      const body = await server.parseBody<{
        account_id: string;
        content: string;
        post_type?: string;
        status?: string;
        scheduled_at?: string;
        reply_to_x_id?: string;
        quote_x_id?: string;
      }>(req);
      if (!body.account_id || !body.content) {
        server.json(res, 400, { error: "account_id and content are required" });
        return;
      }
      const post = service.createPost(body);
      server.json(res, 200, post);
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  server.post("/api/twitter/posts/update", async (req, res) => {
    try {
      const body = await server.parseBody<{
        id: string;
        content?: string;
        post_type?: string;
        status?: string;
        scheduled_at?: string | null;
      }>(req);
      if (!body.id) {
        server.json(res, 400, { error: "id is required" });
        return;
      }
      const { id, ...changes } = body;
      const post = service.updatePost(id, changes);
      if (!post) {
        server.json(res, 404, { error: "Post not found" });
        return;
      }
      server.json(res, 200, post);
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  server.post("/api/twitter/posts/approve", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      const post = service.approvePost(body.id);
      if (!post) {
        server.json(res, 400, { error: "Post not found or not in draft/queued status" });
        return;
      }
      server.json(res, 200, post);
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  server.post("/api/twitter/posts/publish", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      const result = await publisher.publishNow(body.id);
      if (!result.ok) {
        server.json(res, 400, { error: result.error });
        return;
      }
      server.json(res, 200, { ok: true, x_post_id: result.x_post_id });
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  server.post("/api/twitter/posts/delete", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      const post = service.getPost(body.id);
      if (!post) {
        server.json(res, 404, { error: "Post not found" });
        return;
      }
      // Only allow deleting drafts/queued/failed
      if (post.status === "posted") {
        server.json(res, 400, { error: "Cannot delete a posted tweet from here" });
        return;
      }
      service.deletePost(body.id);
      server.json(res, 200, { ok: true });
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  // ── Queue ─────────────────────────────────────────

  server.get("/api/twitter/queue", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const account_id = url.searchParams.get("account_id") ?? undefined;
    server.json(res, 200, service.getQueue(account_id));
  });

  // ── Mentions ──────────────────────────────────────

  server.get("/api/twitter/mentions", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const account_id = url.searchParams.get("account_id") ?? undefined;
    const unread_only = url.searchParams.get("unread_only") === "1";
    server.json(res, 200, service.listMentions({ account_id, unread_only }));
  });

  // ── Metrics & Sync ────────────────────────────────

  server.post("/api/twitter/sync-metrics", async (req, res) => {
    try {
      const body = await server.parseBody<{ account_id: string }>(req);
      const synced = await publisher.syncMetrics(body.account_id);
      server.json(res, 200, { ok: true, synced });
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  server.post("/api/twitter/check-mentions", async (req, res) => {
    try {
      const body = await server.parseBody<{ account_id: string }>(req);
      const added = await publisher.checkMentions(body.account_id);
      server.json(res, 200, { ok: true, new_mentions: added });
    } catch {
      server.json(res, 400, { error: "Invalid request" });
    }
  });

  server.get("/api/twitter/metrics", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const account_id = url.searchParams.get("account_id") ?? "";
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    server.json(res, 200, service.getMetricsTrend(account_id, days));
  });

  server.get("/api/twitter/performance", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const account_id = url.searchParams.get("account_id") ?? "";
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    server.json(res, 200, service.getPerformanceReport(account_id, days));
  });
}
