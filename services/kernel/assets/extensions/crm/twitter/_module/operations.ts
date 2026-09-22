/**
 * Twitter operations the X Manager page reaches over both the WS RPC and HTTP.
 *
 * The page calls each of these through `rpcOrCall`, so the RPC action and the
 * HTTP route are the same request by two roads and have to answer alike.
 * They used to be written twice and had drifted: the RPC create/update kept a
 * short field list (dropping driver, voice_persona, role, format, phase…)
 * while the routes spread the raw body into the service unchecked; the RPC
 * wrapped rows in `{ ok, … }` and answered failures as a resolved `{ error }`.
 * Now dashboard-rpc-actions.ts exposes this map and api-routes.ts binds each
 * entry to its path. Where the two disagreed the fuller field list won, read
 * through `pickArgs` so only declared, well-typed fields reach the service,
 * and the HTTP body shape was kept.
 */

import { HttpError, pickArgs, type Operation } from "@kernl/extension-sdk";
import type { TwitterService } from "./service.js";
import type { TwitterPublisher } from "./publisher.js";

/** What the dashboard may set on an account, create and update alike. */
const ACCOUNT_FIELDS = {
  handle: "string",
  display_name: "string",
  api_key: "string",
  api_secret: "string",
  access_token: "string",
  access_secret: "string",
  driver: "string",
  voice_persona: "string",
  role: "string",
  partner_account_id: "string",
} as const;

export function twitterOperations(tw: TwitterService, pub: TwitterPublisher | null): Record<string, Operation> {
  const required = (input: Record<string, unknown>, key: string): string => {
    const value = typeof input[key] === "string" ? (input[key] as string) : "";
    if (!value) throw new HttpError(400, `${key} is required`);
    return value;
  };
  const publisher = (): TwitterPublisher => {
    if (!pub) throw new HttpError(503, "Twitter publisher not available");
    return pub;
  };

  return {
    "twitter.accounts.create": (input) => {
      const fields = pickArgs(input, ACCOUNT_FIELDS);
      if (!fields.handle) throw new HttpError(400, "handle is required");
      return tw.addAccount({ ...fields, handle: fields.handle });
    },

    "twitter.accounts.update": (input) => {
      const id = required(input, "id");
      const account = tw.updateAccount(id, pickArgs(input, { ...ACCOUNT_FIELDS, status: "string" }));
      if (!account) throw new HttpError(404, "Account not found");
      return account;
    },

    "twitter.posts.create": (input) => {
      const fields = pickArgs(input, {
        account_id: "string", content: "string", post_type: "string", status: "string",
        scheduled_at: "string", reply_to_x_id: "string", quote_x_id: "string",
        format: "string", signal_target: "string", phase: "string",
        campaign_anchor: "number", parent_post_id: "string",
      });
      if (!fields.account_id || !fields.content) throw new HttpError(400, "account_id and content are required");
      return tw.createPost({ ...fields, account_id: fields.account_id, content: fields.content });
    },

    // `scheduled_at: null` clears the schedule; absent leaves it alone.
    "twitter.posts.update": (input) => {
      const id = required(input, "id");
      const fields = pickArgs(input, {
        content: "string", post_type: "string", status: "string",
        scheduled_at: "string", reply_to_x_id: "string", quote_x_id: "string",
      });
      const post = tw.updatePost(id, { ...fields, ...(input.scheduled_at === null ? { scheduled_at: null } : {}) });
      if (!post) throw new HttpError(404, "Post not found");
      return post;
    },

    "twitter.posts.approve": (input) => {
      const post = tw.approvePost(required(input, "id"));
      if (!post) throw new HttpError(400, "Post not found or not in draft/queued status");
      return post;
    },

    "twitter.posts.publish": async (input) => {
      const id = required(input, "id");
      const result = await publisher().publishNow(id);
      if (!result.ok) throw new HttpError(400, result.error ?? "", { error: result.error });
      return { ok: true, x_post_id: result.x_post_id };
    },

    // Only drafts/queued/failed can be deleted.
    "twitter.posts.delete": (input) => {
      const id = required(input, "id");
      const post = tw.getPost(id);
      if (!post) throw new HttpError(404, "Post not found");
      if (post.status === "posted") throw new HttpError(400, "Cannot delete a posted tweet from here");
      tw.deletePost(id);
      return { ok: true };
    },

    "twitter.syncMetrics": async (input) => {
      const synced = await publisher().syncMetrics(required(input, "account_id"));
      return { ok: true, synced };
    },

    "twitter.checkMentions": async (input) => {
      const added = await publisher().checkMentions(required(input, "account_id"));
      return { ok: true, new_mentions: added };
    },

    "twitter.performance": (input) => {
      const accountId = required(input, "account_id");
      return tw.getPerformanceReport(accountId, pickArgs(input, { days: "number" }).days ?? 30);
    },
  };
}
