import { z } from "zod";
import { type ToolDefinition, defineTool, defineToolNoInput, textResult, errorResult } from "@kernl/extension-sdk";
import type { RedditService } from "./service.js";

export function redditTools(service: RedditService): ToolDefinition[] {
  return [
    // ── Account management ──────────────────────

    defineTool({
      name: "kernel_reddit_add_account",
      description:
        "Add a Reddit account. Reddit uses OAuth2 password grant for 'script' apps: register an app at reddit.com/prefs/apps, set type 'script', then provide client_id/client_secret/password here.",
      schema: z.object({
        username: z.string().describe("Reddit username (without 'u/')"),
        client_id: z.string().describe("App client_id from reddit.com/prefs/apps"),
        client_secret: z.string().describe("App client_secret"),
        password: z.string().describe("Account password (script apps use password grant)"),
        user_agent: z
          .string()
          .optional()
          .describe("HTTP User-Agent — Reddit requires a meaningful one. Default: 'kernl:reddit:1.0 (by /u/<username>)'"),
        role: z
          .enum(["brand", "founder", "community", "other"])
          .optional()
          .describe("Role in the marketing strategy (default: founder)"),
      }),
      handler: async (input) => {
        const acc = service.addAccount(input);
        return textResult(
          `Reddit account added:\n  ID: ${acc.id}\n  Username: u/${acc.username}\n  Role: ${acc.role}\n  Status: ${acc.status}\n  Next: run kernel_reddit_authenticate to verify credentials and fetch karma.`,
        );
      },
    }),

    defineToolNoInput({
      name: "kernel_reddit_list_accounts",
      description: "List all configured Reddit accounts.",
      handler: async () => {
        const accounts = service.listAccounts();
        if (accounts.length === 0) return textResult("No Reddit accounts configured.");
        const lines = accounts.map(
          (a) =>
            `[${a.status.toUpperCase()}] u/${a.username}\n  Role: ${a.role}\n  Karma: ${a.karma_post} post / ${a.karma_comment} comment\n  Token expires: ${a.token_expires_at ?? "n/a"}\n  ID: ${a.id}`,
        );
        return textResult(`${accounts.length} account(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_reddit_delete_account",
      description: "Remove a Reddit account from Kernl.",
      schema: z.object({ account_id: z.string() }),
      handler: async ({ account_id }) => {
        return service.deleteAccount(account_id)
          ? textResult(`Reddit account ${account_id} deleted.`)
          : errorResult(`Account ${account_id} not found.`);
      },
    }),

    defineTool({
      name: "kernel_reddit_authenticate",
      description: "Verify credentials and refresh the OAuth access_token for an account.",
      schema: z.object({ account_id: z.string() }),
      handler: async ({ account_id }) => {
        await service.authenticate(account_id);
        const me = await service.fetchMe(account_id);
        return textResult(
          `Authenticated as u/${me.name}\n  Comment karma: ${me.comment_karma}\n  Link karma: ${me.link_karma}\n  Total karma: ${me.total_karma}`,
        );
      },
    }),

    // ── Posting ──────────────────────────────────

    defineTool({
      name: "kernel_reddit_submit",
      description:
        "Submit a post to a subreddit. Provide either 'body' for a text post OR 'url' for a link post — not both. Will fail if account lacks karma/age for that subreddit.",
      schema: z.object({
        account_id: z.string().describe("Kernl account ID"),
        subreddit: z.string().describe("Subreddit name without 'r/'"),
        title: z.string().describe("Post title (max 300 chars)"),
        body: z.string().optional().describe("Text body (markdown supported) — for self posts"),
        url: z.string().optional().describe("External URL — for link posts"),
        nsfw: z.boolean().optional(),
        spoiler: z.boolean().optional(),
      }),
      handler: async (input) => {
        const post = await service.submit(input);
        return textResult(
          `Submitted to r/${post.subreddit}:\n  Title: ${post.title}\n  Reddit ID: ${post.reddit_id}\n  Permalink: ${post.permalink}\n  Status: ${post.status}`,
        );
      },
    }),

    defineTool({
      name: "kernel_reddit_list_posts",
      description: "List submitted posts with optional filters.",
      schema: z.object({
        account_id: z.string().optional(),
        status: z.enum(["draft", "scheduled", "published", "failed", "removed"]).optional(),
        subreddit: z.string().optional(),
        limit: z.number().optional(),
      }),
      handler: async (input) => {
        const posts = service.listPosts(input);
        if (posts.length === 0) return textResult("No posts found.");
        const lines = posts.map(
          (p) =>
            `[${p.status.toUpperCase()}] r/${p.subreddit}\n  "${p.title}"\n  Permalink: ${p.permalink || "n/a"}\n  ${p.upvotes} ↑ · ${p.comments_count} 💬\n  ID: ${p.id}${p.error ? `\n  Error: ${p.error}` : ""}`,
        );
        return textResult(`${posts.length} post(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_reddit_delete_post",
      description:
        "Remove a post entry from Kernl's database. NOTE: this does NOT delete the post on Reddit — only from the local log.",
      schema: z.object({ post_id: z.string() }),
      handler: async ({ post_id }) => {
        return service.deletePost(post_id)
          ? textResult(`Post entry ${post_id} removed from log.`)
          : errorResult(`Post ${post_id} not found.`);
      },
    }),

    // ── Reading ──────────────────────────────────

    defineTool({
      name: "kernel_reddit_fetch_subreddit",
      description: "Fetch posts from a subreddit (read-only). Useful to research what works before posting.",
      schema: z.object({
        account_id: z.string(),
        subreddit: z.string().describe("Subreddit name without 'r/'"),
        sort: z.enum(["new", "hot", "top", "rising"]).optional().describe("Default: new"),
        limit: z.number().optional().describe("Max 100, default 25"),
      }),
      handler: async (input) => {
        const items = await service.fetchSubreddit(
          input,
        );
        if (items.length === 0) return textResult("No posts found.");
        const lines = items.map(
          (i, idx) =>
            `${idx + 1}. [${i.score} ↑] ${i.title}\n   u/${i.author}\n   ${i.permalink}`,
        );
        return textResult(`Top ${items.length} from r/${input.subreddit}:\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_reddit_me",
      description: "Fetch the authenticated account's profile (username + karma).",
      schema: z.object({ account_id: z.string() }),
      handler: async ({ account_id }) => {
        const me = await service.fetchMe(account_id);
        return textResult(
          `u/${me.name}\n  Comment karma: ${me.comment_karma}\n  Link karma: ${me.link_karma}\n  Total karma: ${me.total_karma}`,
        );
      },
    }),
  ];
}
