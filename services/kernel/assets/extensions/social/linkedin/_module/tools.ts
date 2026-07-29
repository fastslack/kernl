import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { LinkedInService } from "./service.js";

export function linkedinTools(service: LinkedInService): ToolDefinition[] {
  return [
    // ── Account management ──────────────────────

    {
      name: "kernel_linkedin_add_account",
      description:
        "Add a LinkedIn account. Auth is OAuth2 — complete the consent flow manually at https://www.linkedin.com/developers/ (scopes: openid, profile, w_member_social) and paste the access_token here. URN can be left blank if you'll run kernel_linkedin_me to backfill.",
      inputSchema: z.object({
        urn: z.string().describe("LinkedIn URN (e.g. 'urn:li:person:xyz' or just 'xyz' — kernel will prefix) — empty string OK, fetched via /userinfo"),
        display_name: z.string().optional(),
        account_type: z.enum(["person", "organization"]).optional().describe("Default: person"),
        client_id: z.string().optional().describe("OAuth client_id (only if you want refresh capability)"),
        client_secret: z.string().optional().describe("OAuth client_secret"),
        access_token: z.string().describe("OAuth access_token from the consent flow"),
        refresh_token: z.string().optional(),
        role: z.enum(["brand", "founder", "community", "other"]).optional(),
      }),
      handler: async (args) => {
        const acc = service.addAccount(args as Parameters<typeof service.addAccount>[0]);
        return textResult(
          `LinkedIn account added:\n  ID: ${acc.id}\n  URN: ${acc.urn}\n  Type: ${acc.account_type}\n  Role: ${acc.role}\n  Next: run kernel_linkedin_me to verify and backfill display name.`,
        );
      },
    },

    {
      name: "kernel_linkedin_list_accounts",
      description: "List all configured LinkedIn accounts.",
      inputSchema: z.object({}),
      handler: async () => {
        const accounts = service.listAccounts();
        if (accounts.length === 0) return textResult("No LinkedIn accounts configured.");
        const lines = accounts.map(
          (a) =>
            `[${a.status.toUpperCase()}] ${a.display_name || a.urn}\n  Type: ${a.account_type} · Role: ${a.role}\n  Token expires: ${a.token_expires_at ?? "n/a"}\n  ID: ${a.id}`,
        );
        return textResult(`${accounts.length} account(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_linkedin_delete_account",
      description: "Remove a LinkedIn account from Kernl.",
      inputSchema: z.object({ account_id: z.string() }),
      handler: async (args) => {
        const { account_id } = args as { account_id: string };
        return service.deleteAccount(account_id)
          ? textResult(`LinkedIn account ${account_id} deleted.`)
          : errorResult(`Account ${account_id} not found.`);
      },
    },

    {
      name: "kernel_linkedin_set_token",
      description:
        "Manually update the access_token for an account. Use this when you've re-run the LinkedIn OAuth flow outside the kernel and need to refresh stored credentials.",
      inputSchema: z.object({
        account_id: z.string(),
        access_token: z.string(),
        expires_in_seconds: z.number().optional().describe("Token lifetime in seconds (LinkedIn usually returns 5184000)"),
        refresh_token: z.string().optional(),
      }),
      handler: async (args) => {
        const { account_id, access_token, expires_in_seconds, refresh_token } = args as {
          account_id: string;
          access_token: string;
          expires_in_seconds?: number;
          refresh_token?: string;
        };
        service.setToken(account_id, access_token, expires_in_seconds, refresh_token);
        return textResult(`LinkedIn token updated for account ${account_id}.`);
      },
    },

    {
      name: "kernel_linkedin_me",
      description: "Fetch authenticated profile via /userinfo (backfills URN + display name).",
      inputSchema: z.object({ account_id: z.string() }),
      handler: async (args) => {
        try {
          const { account_id } = args as { account_id: string };
          const me = await service.fetchMe(account_id);
          return textResult(`Authenticated as ${me.name}\n  URN: ${me.urn}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ── Posting ──────────────────────────────────

    {
      name: "kernel_linkedin_post_text",
      description:
        "Publish a text post (optionally with an article link card) to LinkedIn. The post is published immediately as PUBLIC by default — change 'visibility' to CONNECTIONS or LOGGED_IN for narrower reach.",
      inputSchema: z.object({
        account_id: z.string(),
        text: z.string().describe("Post body. Newlines work. Max ~3000 chars in practice."),
        article_url: z.string().optional().describe("If set, attaches a link-card preview"),
        article_title: z.string().optional(),
        article_desc: z.string().optional(),
        visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).optional(),
      }),
      handler: async (args) => {
        try {
          const post = await service.createTextPost(args as Parameters<typeof service.createTextPost>[0]);
          return textResult(
            `Posted to LinkedIn:\n  Visibility: ${post.visibility}\n  Kind: ${post.kind}\n  Post URN: ${post.post_urn}\n  Status: ${post.status}\n  Local entry: ${post.id}`,
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    {
      name: "kernel_linkedin_post_image",
      description:
        "Publish a post with an image attachment. Image must exist locally — provide absolute path. JPEG/PNG up to ~5MB recommended.",
      inputSchema: z.object({
        account_id: z.string(),
        text: z.string().describe("Caption text"),
        image_path: z.string().describe("Absolute path to the image file"),
        visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).optional(),
      }),
      handler: async (args) => {
        try {
          const post = await service.createImagePost(args as Parameters<typeof service.createImagePost>[0]);
          return textResult(
            `Image posted to LinkedIn:\n  Visibility: ${post.visibility}\n  Post URN: ${post.post_urn}\n  Status: ${post.status}\n  Local entry: ${post.id}`,
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    {
      name: "kernel_linkedin_list_posts",
      description: "List LinkedIn posts tracked in Kernl.",
      inputSchema: z.object({
        account_id: z.string().optional(),
        status: z.enum(["draft", "scheduled", "published", "failed"]).optional(),
        limit: z.number().optional(),
      }),
      handler: async (args) => {
        const posts = service.listPosts(args as Parameters<typeof service.listPosts>[0]);
        if (posts.length === 0) return textResult("No posts found.");
        const lines = posts.map((p) => {
          const preview = p.text.length > 80 ? `${p.text.slice(0, 80)}…` : p.text;
          return `[${p.status.toUpperCase()}] ${p.kind}\n  "${preview}"\n  URN: ${p.post_urn || "n/a"}\n  ${p.likes} ❤ · ${p.comments_count} 💬 · ${p.shares} ↗\n  ID: ${p.id}${p.error ? `\n  Error: ${p.error}` : ""}`;
        });
        return textResult(`${posts.length} post(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_linkedin_delete_post",
      description:
        "Remove a post entry from Kernl's database. NOTE: this does NOT delete the post on LinkedIn — only from the local log.",
      inputSchema: z.object({ post_id: z.string() }),
      handler: async (args) => {
        const { post_id } = args as { post_id: string };
        return service.deletePost(post_id)
          ? textResult(`Post entry ${post_id} removed from log.`)
          : errorResult(`Post ${post_id} not found.`);
      },
    },
  ];
}
