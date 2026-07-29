/**
 * Twitter dashboard RPC slice — `twitter.*` RPCs plus the `dashboard.twitter`
 * panel data feed.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import type { TwitterService } from "./service.js";
import type { TwitterPublisher } from "./publisher.js";
import { queryTwitter } from "./dashboard-query.js";

export interface TwitterDashboardRpcDeps {
  db: SqliteDb;
  twitterService: TwitterService | null;
  twitterPublisher: TwitterPublisher | null;
}

export function twitterDashboardRpcActions(deps: TwitterDashboardRpcDeps): RpcAction[] {
  const { db, twitterService: tw, twitterPublisher: pub } = deps;

  const actions: RpcAction[] = [
    {
      name: "dashboard.twitter",
      handler: async () => {
        try {
          return { available: true, ...queryTwitter(db) };
        } catch {
          return { available: false };
        }
      },
    },
  ];

  if (!tw) return actions;

  actions.push(
    {
      name: "twitter.posts.create",
      handler: async (args) => {
        const accountId = typeof args.account_id === "string" ? args.account_id : "";
        const content = typeof args.content === "string" ? args.content : "";
        if (!accountId || !content) return { error: "account_id and content are required" };
        const post = tw.createPost({
          account_id: accountId,
          content,
          post_type: typeof args.post_type === "string" ? args.post_type : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          scheduled_at: typeof args.scheduled_at === "string" ? args.scheduled_at : undefined,
          reply_to_x_id: typeof args.reply_to_x_id === "string" ? args.reply_to_x_id : undefined,
          quote_x_id: typeof args.quote_x_id === "string" ? args.quote_x_id : undefined,
        });
        return { ok: true, post };
      },
    },
    {
      name: "twitter.posts.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const post = tw.updatePost(id, {
          content: typeof args.content === "string" ? args.content : undefined,
          post_type: typeof args.post_type === "string" ? args.post_type : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          scheduled_at: args.scheduled_at === null ? null : typeof args.scheduled_at === "string" ? args.scheduled_at : undefined,
        });
        if (!post) return { error: "Post not found" };
        return { ok: true, post };
      },
    },
    {
      name: "twitter.posts.approve",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const post = tw.approvePost(id);
        if (!post) return { error: "Post not found or not in draft/queued status" };
        return { ok: true, post };
      },
    },
    {
      name: "twitter.posts.publish",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        if (!pub) return { error: "Twitter publisher not available" };
        const result = await pub.publishNow(id);
        if (!result.ok) return { error: result.error };
        return { ok: true, x_post_id: result.x_post_id };
      },
    },
    {
      name: "twitter.posts.delete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const post = tw.getPost(id);
        if (!post) return { error: "Post not found" };
        if (post.status === "posted") return { error: "Cannot delete a posted tweet" };
        tw.deletePost(id);
        return { ok: true };
      },
    },
    {
      name: "twitter.accounts.create",
      handler: async (args) => {
        const handle = typeof args.handle === "string" ? args.handle : "";
        if (!handle) return { error: "handle is required" };
        const account = tw.addAccount({
          handle,
          display_name: typeof args.display_name === "string" ? args.display_name : undefined,
          api_key: typeof args.api_key === "string" ? args.api_key : undefined,
          api_secret: typeof args.api_secret === "string" ? args.api_secret : undefined,
          access_token: typeof args.access_token === "string" ? args.access_token : undefined,
          access_secret: typeof args.access_secret === "string" ? args.access_secret : undefined,
        });
        return { ok: true, account };
      },
    },
    {
      name: "twitter.accounts.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const { id: _id, ...changes } = args as Record<string, unknown>;
        const account = tw.updateAccount(id, changes as Parameters<typeof tw.updateAccount>[1]);
        if (!account) return { error: "Account not found" };
        return { ok: true, account };
      },
    },
    {
      name: "twitter.syncMetrics",
      handler: async (args) => {
        const accountId = typeof args.account_id === "string" ? args.account_id : "";
        if (!accountId) return { error: "account_id is required" };
        if (!pub) return { error: "Twitter publisher not available" };
        const synced = await pub.syncMetrics(accountId);
        return { ok: true, synced };
      },
    },
    {
      name: "twitter.checkMentions",
      handler: async (args) => {
        const accountId = typeof args.account_id === "string" ? args.account_id : "";
        if (!accountId) return { error: "account_id is required" };
        if (!pub) return { error: "Twitter publisher not available" };
        const added = await pub.checkMentions(accountId);
        return { ok: true, new_mentions: added };
      },
    },
    {
      name: "twitter.performance",
      handler: async (args) => {
        const accountId = typeof args.account_id === "string" ? args.account_id : "";
        if (!accountId) return { error: "account_id is required" };
        const days = typeof args.days === "number" ? args.days : 30;
        return tw.getPerformanceReport(accountId, days);
      },
    },
  );

  return actions;
}
