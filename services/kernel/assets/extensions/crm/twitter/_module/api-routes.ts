import { HttpError, isHttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { TwitterService } from "./service.js";
import type { TwitterPublisher } from "./publisher.js";

export function registerTwitterRoutes(
  server: KernelHttpServer,
  service: TwitterService,
  publisher: TwitterPublisher,
): void {
  /**
   * A POST route whose failures — anything but a deliberate HttpError — all
   * answer 400 "Invalid request", as these routes always have.
   */
  const post = <B>(path: string, fn: (body: B) => unknown) =>
    server.route<B>("POST", path, async ({ body }) => {
      try {
        return await fn(body);
      } catch (err) {
        if (isHttpError(err)) throw err;
        throw new HttpError(400, "Invalid request");
      }
    });

  // ── Accounts ───────────────────────────────────────

  server.route("GET", "/api/twitter/accounts", () => service.listAccounts());

  post<{
    handle: string;
    display_name?: string;
    api_key?: string;
    api_secret?: string;
    access_token?: string;
    access_secret?: string;
  }>("/api/twitter/accounts", (body) => {
    if (!body.handle) throw new HttpError(400, "handle is required");
    return service.addAccount(body);
  });

  post<{
    id: string;
    handle?: string;
    display_name?: string;
    api_key?: string;
    api_secret?: string;
    access_token?: string;
    access_secret?: string;
    status?: string;
  }>("/api/twitter/accounts/update", (body) => {
    if (!body.id) throw new HttpError(400, "id is required");
    const { id, ...changes } = body;
    const account = service.updateAccount(id, changes);
    if (!account) throw new HttpError(404, "Account not found");
    return account;
  });

  // ── Posts ──────────────────────────────────────────

  server.route("GET", "/api/twitter/posts", ({ query }) => {
    const status = query.get("status") ?? undefined;
    const account_id = query.get("account_id") ?? undefined;
    const post_type = query.get("post_type") ?? undefined;
    const limit = parseInt(query.get("limit") ?? "50", 10);
    const offset = parseInt(query.get("offset") ?? "0", 10);

    return service.listPosts({ status, account_id, post_type, limit, offset });
  });

  post<{
    account_id: string;
    content: string;
    post_type?: string;
    status?: string;
    scheduled_at?: string;
    reply_to_x_id?: string;
    quote_x_id?: string;
  }>("/api/twitter/posts", (body) => {
    if (!body.account_id || !body.content) {
      throw new HttpError(400, "account_id and content are required");
    }
    return service.createPost(body);
  });

  post<{
    id: string;
    content?: string;
    post_type?: string;
    status?: string;
    scheduled_at?: string | null;
  }>("/api/twitter/posts/update", (body) => {
    if (!body.id) throw new HttpError(400, "id is required");
    const { id, ...changes } = body;
    const post = service.updatePost(id, changes);
    if (!post) throw new HttpError(404, "Post not found");
    return post;
  });

  post<{ id: string }>("/api/twitter/posts/approve", (body) => {
    const post = service.approvePost(body.id);
    if (!post) throw new HttpError(400, "Post not found or not in draft/queued status");
    return post;
  });

  post<{ id: string }>("/api/twitter/posts/publish", async (body) => {
    const result = await publisher.publishNow(body.id);
    if (!result.ok) throw new HttpError(400, result.error ?? "", { error: result.error });
    return { ok: true, x_post_id: result.x_post_id };
  });

  post<{ id: string }>("/api/twitter/posts/delete", (body) => {
    const post = service.getPost(body.id);
    if (!post) throw new HttpError(404, "Post not found");
    // Only allow deleting drafts/queued/failed
    if (post.status === "posted") throw new HttpError(400, "Cannot delete a posted tweet from here");
    service.deletePost(body.id);
    return { ok: true };
  });

  // ── Queue ─────────────────────────────────────────

  server.route("GET", "/api/twitter/queue", ({ query }) =>
    service.getQueue(query.get("account_id") ?? undefined));

  // ── Mentions ──────────────────────────────────────

  server.route("GET", "/api/twitter/mentions", ({ query }) => {
    const account_id = query.get("account_id") ?? undefined;
    const unread_only = query.get("unread_only") === "1";
    return service.listMentions({ account_id, unread_only });
  });

  // ── Metrics & Sync ────────────────────────────────

  post<{ account_id: string }>("/api/twitter/sync-metrics", async (body) => {
    const synced = await publisher.syncMetrics(body.account_id);
    return { ok: true, synced };
  });

  post<{ account_id: string }>("/api/twitter/check-mentions", async (body) => {
    const added = await publisher.checkMentions(body.account_id);
    return { ok: true, new_mentions: added };
  });

  server.route("GET", "/api/twitter/metrics", ({ query }) => {
    const account_id = query.get("account_id") ?? "";
    const days = parseInt(query.get("days") ?? "30", 10);
    return service.getMetricsTrend(account_id, days);
  });

  server.route("GET", "/api/twitter/performance", ({ query }) => {
    const account_id = query.get("account_id") ?? "";
    const days = parseInt(query.get("days") ?? "30", 10);
    return service.getPerformanceReport(account_id, days);
  });
}
