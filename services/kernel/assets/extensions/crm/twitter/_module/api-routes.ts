import { HttpError, isHttpError, type KernelHttpServer, type Operation } from "@kernl/extension-sdk";
import type { TwitterService } from "./service.js";
import type { TwitterPublisher } from "./publisher.js";
import { twitterOperations } from "./operations.js";

type Method = Parameters<KernelHttpServer["operation"]>[0];

export function registerTwitterRoutes(
  server: KernelHttpServer,
  service: TwitterService,
  publisher: TwitterPublisher,
): void {
  /**
   * A POST route whose failures — anything but a deliberate HttpError — all
   * answer 400 "Invalid request", as these routes always have. The RPC side
   * of the same operation keeps the underlying message.
   */
  const invalidAs400 = (op: Operation): Operation => async (input) => {
    try {
      return await op(input);
    } catch (err) {
      if (isHttpError(err)) throw err;
      throw new HttpError(400, "Invalid request");
    }
  };

  // ── Operations shared with the WS RPC (operations.ts) ─────────
  // The page reaches these through rpcOrCall, WS first and HTTP when the
  // bridge is down, so both roads run the same function.
  const op = twitterOperations(service, publisher);
  ([
    ["POST", "/api/twitter/accounts", "twitter.accounts.create"],
    ["POST", "/api/twitter/accounts/update", "twitter.accounts.update"],
    ["POST", "/api/twitter/posts", "twitter.posts.create"],
    ["POST", "/api/twitter/posts/update", "twitter.posts.update"],
    ["POST", "/api/twitter/posts/approve", "twitter.posts.approve"],
    ["POST", "/api/twitter/posts/publish", "twitter.posts.publish"],
    ["POST", "/api/twitter/posts/delete", "twitter.posts.delete"],
    ["POST", "/api/twitter/sync-metrics", "twitter.syncMetrics"],
    ["POST", "/api/twitter/check-mentions", "twitter.checkMentions"],
    ["GET", "/api/twitter/performance", "twitter.performance"],
  ] as Array<[Method, string, string]>).forEach(([method, path, name]) =>
    server.operation(method, path, method === "POST" ? invalidAs400(op[name]) : op[name]));

  // ── Accounts ───────────────────────────────────────

  server.route("GET", "/api/twitter/accounts", () => service.listAccounts());

  // ── Posts ──────────────────────────────────────────

  server.route("GET", "/api/twitter/posts", ({ query }) => {
    const status = query.get("status") ?? undefined;
    const account_id = query.get("account_id") ?? undefined;
    const post_type = query.get("post_type") ?? undefined;
    const limit = parseInt(query.get("limit") ?? "50", 10);
    const offset = parseInt(query.get("offset") ?? "0", 10);

    return service.listPosts({ status, account_id, post_type, limit, offset });
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

  // ── Metrics ───────────────────────────────────────

  server.route("GET", "/api/twitter/metrics", ({ query }) => {
    const account_id = query.get("account_id") ?? "";
    const days = parseInt(query.get("days") ?? "30", 10);
    return service.getMetricsTrend(account_id, days);
  });
}
