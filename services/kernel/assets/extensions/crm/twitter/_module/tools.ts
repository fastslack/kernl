import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { TwitterService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

export function twitterTools(service: TwitterService): ToolDefinition[] {
  return [
    // ── Account Management ──────────────────────────

    {
      name: "kernel_twitter_add_account",
      description:
        "Add an X/Twitter account. Driver controls how posts are published: 'api' uses official X API (OAuth1) credentials; 'xactions' uses a browser-session cookie (configured later with kernel_twitter_set_cookie).",
      inputSchema: z.object({
        handle: z.string().describe("X handle without @ (e.g. 'elonmusk')"),
        display_name: z.string().optional().describe("Display name"),
        driver: z
          .enum(["api", "xactions"])
          .optional()
          .describe("Posting driver (default: api). Use 'xactions' for browser-cookie auth."),
        role: z
          .enum(["brand", "founder", "community", "support", "other"])
          .optional()
          .describe("Role in the coordinated-orbit strategy (default: brand)"),
        partner_account_id: z
          .string()
          .optional()
          .describe("Sibling account ID — never cross-RT each other during launch (Grox anti-circle-jerk)"),
        voice_persona: z
          .string()
          .optional()
          .describe(
            "Free-text voice rules baked into content-creator prompts (e.g. 'confident, slightly arrogant, technical')",
          ),
        api_key: z.string().optional().describe("X API key (consumer key) — only for driver=api"),
        api_secret: z.string().optional().describe("X API secret — only for driver=api"),
        access_token: z.string().optional().describe("X access token — only for driver=api"),
        access_secret: z.string().optional().describe("X access token secret — only for driver=api"),
      }),
      handler: async (args) => {
        const input = args as {
          handle: string;
          display_name?: string;
          driver?: string;
          role?: string;
          partner_account_id?: string;
          voice_persona?: string;
          api_key?: string;
          api_secret?: string;
          access_token?: string;
          access_secret?: string;
        };
        const account = service.addAccount(input);
        const driverHint =
          account.driver === "xactions"
            ? "\n  Next step: run kernel_twitter_set_cookie to attach the auth_token cookie."
            : account.api_key
              ? ""
              : "\n  Next step: provide API credentials via kernel_twitter_add_account update.";
        return textResult(
          `Account added:\n  ID: ${account.id}\n  Handle: @${account.handle}\n  Name: ${account.display_name || account.handle}\n  Driver: ${account.driver}\n  Role: ${account.role}\n  Status: ${account.status}${driverHint}`,
        );
      },
    },

    {
      name: "kernel_twitter_list_accounts",
      description: "List all configured X/Twitter accounts with driver + cookie status.",
      inputSchema: z.object({}),
      handler: async () => {
        const accounts = service.listAccounts();
        if (accounts.length === 0) return textResult("No X accounts configured.");

        const lines = accounts.map((a) => {
          const authStatus =
            a.driver === "xactions"
              ? a.auth_cookie_ref
                ? `cookie configured${a.last_login_at ? ` (last login OK ${a.last_login_at})` : " (untested)"}`
                : "cookie missing"
              : a.api_key
                ? "API keys configured"
                : "API keys missing";
          return `[${a.status.toUpperCase()}] @${a.handle} (${a.display_name || "no name"})\n  Driver: ${a.driver}\n  Role: ${a.role}\n  Auth: ${authStatus}\n  ID: ${a.id}`;
        });
        return textResult(`${accounts.length} account(s):\n\n${lines.join("\n\n")}`);
      },
    },

    // ── Cookie / session management (xactions driver) ──────────

    {
      name: "kernel_twitter_set_cookie",
      description:
        "Store the auth_token browser cookie for an account whose driver is 'xactions'. The cookie is what xactions__x_login expects. Cookies expire — re-run this when x_login starts returning unauthenticated.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
        cookie: z.string().describe("auth_token cookie value from x.com (the long base64-ish string)"),
      }),
      handler: async (args) => {
        const { account_id, cookie } = args as { account_id: string; cookie: string };
        const account = service.getAccount(account_id);
        if (!account) return errorResult(`Account not found: ${account_id}`);
        if (account.driver !== "xactions")
          return errorResult(
            `Account @${account.handle} uses driver '${account.driver}', not 'xactions'. Cookies only apply to the xactions driver.`,
          );
        if (!cookie || cookie.length < 16)
          return errorResult("Cookie looks invalid (too short). Expecting the auth_token value from x.com cookies.");

        // Store cookie inline in auth_cookie_ref. Future enhancement: route to kernel_vault.
        service.updateAccount(account_id, { auth_cookie_ref: cookie });
        return textResult(
          `Cookie stored for @${account.handle}.\n  Next step: run kernel_twitter_get_cookie to retrieve it, then xactions__x_login to activate the session, then xactions__x_get_profile (your handle) to confirm.`,
        );
      },
    },

    {
      name: "kernel_twitter_get_cookie",
      description:
        "Retrieve the stored auth_token cookie for an account. Used by agents to call xactions__x_login(cookie) before doing any xactions__x_* operations on this account's behalf.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
      }),
      handler: async (args) => {
        const { account_id } = args as { account_id: string };
        const account = service.getAccount(account_id);
        if (!account) return errorResult(`Account not found: ${account_id}`);
        if (account.driver !== "xactions")
          return errorResult(`Account @${account.handle} is not on the xactions driver.`);
        if (!account.auth_cookie_ref)
          return errorResult(
            `No cookie stored for @${account.handle}. Run kernel_twitter_set_cookie first.`,
          );
        return textResult(account.auth_cookie_ref);
      },
    },

    {
      name: "kernel_twitter_mark_login",
      description:
        "Record that xactions__x_login succeeded for this account (call this AFTER you successfully logged in and verified via x_get_profile). Updates last_login_at.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
      }),
      handler: async (args) => {
        const { account_id } = args as { account_id: string };
        const account = service.markLoginSuccess(account_id);
        if (!account) return errorResult(`Account not found: ${account_id}`);
        return textResult(`Marked @${account.handle} login OK at ${account.last_login_at}.`);
      },
    },

    // ── Account state (campaign phase + crisis tracking) ──────

    {
      name: "kernel_twitter_get_state",
      description:
        "Get the current campaign state for an account: phase (seeding/authority/launch/capitalize/sustain/crisis_recovery), rolling 7-day OON %, mute rate, and whether crisis recovery has been triggered.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
      }),
      handler: async (args) => {
        const { account_id } = args as { account_id: string };
        const state = service.getAccountState(account_id);
        if (!state) return errorResult(`No state for account: ${account_id}`);
        return textResult(
          `Phase: ${state.phase} (since ${state.phase_started_at})\nOON % (7d): ${(state.oon_pct_7d * 100).toFixed(1)}%\nMute rate (7d): ${(state.mute_rate_7d * 100).toFixed(3)}%\nCrisis triggered: ${state.crisis_triggered_at || "never"}`,
        );
      },
    },

    {
      name: "kernel_twitter_set_phase",
      description:
        "Set the campaign phase for an account. Valid phases: foundation, seeding, authority, launch, capitalize, sustain, crisis_recovery, idle.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
        phase: z
          .enum(["foundation", "seeding", "authority", "launch", "capitalize", "sustain", "crisis_recovery", "idle"])
          .describe("New phase"),
      }),
      handler: async (args) => {
        const { account_id, phase } = args as { account_id: string; phase: string };
        const state = service.setPhase(account_id, phase);
        if (!state) return errorResult(`Account state not found: ${account_id}`);
        return textResult(`Phase set to '${state.phase}' for account ${account_id}.`);
      },
    },

    {
      name: "kernel_twitter_trigger_crisis_recovery",
      description:
        "Manually trigger crisis recovery for an account (use when OON %_7d <20% or mute rate spikes). Switches phase to 'crisis_recovery'; content-creators STOP original posting for 48h and only do replies.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
        oon_pct_7d: z.number().describe("Current rolling 7-day OON %"),
        mute_rate_7d: z.number().describe("Current rolling 7-day mute rate"),
      }),
      handler: async (args) => {
        const { account_id, oon_pct_7d, mute_rate_7d } = args as {
          account_id: string;
          oon_pct_7d: number;
          mute_rate_7d: number;
        };
        const state = service.triggerCrisisRecovery(account_id, oon_pct_7d, mute_rate_7d);
        if (!state) return errorResult(`Account state not found: ${account_id}`);
        return textResult(
          `Crisis recovery triggered for account ${account_id}.\n  Phase: ${state.phase}\n  OON % 7d: ${(state.oon_pct_7d * 100).toFixed(1)}%\n  Mute rate 7d: ${(state.mute_rate_7d * 100).toFixed(3)}%`,
        );
      },
    },

    // ── Analytics (per-post KPI snapshots) ─────────────────────

    {
      name: "kernel_twitter_record_analytics",
      description:
        "Record a snapshot of per-post KPIs (impressions, OON impressions, likes, RTs, replies, quotes, bookmarks, mutes, blocks). Used by the Engagement Tracker after pulling stats from xactions__x_get_post_analytics or the X API.",
      inputSchema: z.object({
        post_id: z.string().describe("Internal post ID (twitter_posts.id)"),
        impressions: z.number().optional(),
        oon_impressions: z.number().optional(),
        likes: z.number().optional(),
        retweets: z.number().optional(),
        replies: z.number().optional(),
        quotes: z.number().optional(),
        bookmarks: z.number().optional(),
        profile_clicks: z.number().optional(),
        mute_count: z.number().optional(),
        block_count: z.number().optional(),
      }),
      handler: async (args) => {
        const input = args as {
          post_id: string;
          impressions?: number;
          oon_impressions?: number;
          likes?: number;
          retweets?: number;
          replies?: number;
          quotes?: number;
          bookmarks?: number;
          profile_clicks?: number;
          mute_count?: number;
          block_count?: number;
        };
        const post = service.getPost(input.post_id);
        if (!post) return errorResult(`Post not found: ${input.post_id}`);
        const snap = service.recordAnalyticsSnapshot(input);
        return textResult(
          `Analytics snapshot recorded.\n  Impressions: ${snap.impressions}\n  OON %: ${(snap.oon_pct * 100).toFixed(1)}%\n  Engagement rate: ${(snap.engagement_rate * 100).toFixed(2)}%\n  Mute rate: ${(snap.mute_rate * 100).toFixed(3)}%`,
        );
      },
    },

    {
      name: "kernel_twitter_rolling_kpis",
      description:
        "Compute rolling 7-day OON % and mute rate across all posts for an account. Returns the same numbers used to decide crisis_recovery.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
        days: z.number().optional().describe("Rolling window in days (default: 7)"),
      }),
      handler: async (args) => {
        const { account_id, days } = args as { account_id: string; days?: number };
        const kpis = service.computeRollingKpis(account_id, days ?? 7);
        const updated = service.updateRollingKpis(account_id, kpis.oon_pct_7d, kpis.mute_rate_7d);
        const phase = updated?.phase ?? "unknown";
        return textResult(
          `Rolling KPIs (last ${days ?? 7} days):\n  OON %: ${(kpis.oon_pct_7d * 100).toFixed(1)}%\n  Mute rate: ${(kpis.mute_rate_7d * 100).toFixed(3)}%\n  Current phase: ${phase}\n  Crisis threshold: OON % <20% OR mute rate >0.1% triggers crisis_recovery.`,
        );
      },
    },

    {
      name: "kernel_twitter_record_audit",
      description:
        "Record the Algorithm Auditor's score (0-100) and notes for a post. Posts with audit_score <60 should not be approved without manual review.",
      inputSchema: z.object({
        post_id: z.string().describe("Post ID"),
        score: z.number().describe("0-100 score from auditor"),
        notes: z.string().describe("Free-text issues raised (one per line)"),
      }),
      handler: async (args) => {
        const { post_id, score, notes } = args as { post_id: string; score: number; notes: string };
        const post = service.recordAudit(post_id, score, notes);
        if (!post) return errorResult(`Post not found: ${post_id}`);
        return textResult(`Audit recorded for post ${post_id}.\n  Score: ${score}/100\n  Notes:\n${notes}`);
      },
    },

    // ── Post Management ─────────────────────────────

    {
      name: "kernel_twitter_create_post",
      description:
        "Create a draft or queued X/Twitter post. Posts can be tweets, replies, threads, or quotes. Use 'queued' status for posts awaiting approval. Campaign metadata fields (format, signal_target, phase, campaign_anchor) are used by the Algorithm Auditor and Engagement Tracker.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
        content: z.string().describe("Post content (max 280 chars for single tweet)"),
        post_type: z
          .enum(["tweet", "reply", "thread", "quote"])
          .optional()
          .describe("Post type (default: tweet)"),
        status: z
          .enum(["draft", "queued"])
          .optional()
          .describe("Initial status (default: draft)"),
        scheduled_at: z.string().optional().describe("ISO datetime to schedule posting"),
        reply_to_x_id: z.string().optional().describe("X post ID to reply to (for reply type)"),
        quote_x_id: z.string().optional().describe("X post ID to quote (for quote type)"),
        format: z
          .enum(["native_video", "gif", "image", "text", "thread", "self_reply"])
          .optional()
          .describe("Content format (drives reach hierarchy in the algorithm playbook)"),
        signal_target: z
          .enum([
            "reply",
            "quote",
            "dwell",
            "repost",
            "share",
            "follow_author",
            "profile_click",
            "bookmark",
            "video_view",
            "photo_expand",
            "click",
            "favorite",
          ])
          .optional()
          .describe(
            "Primary engagement signal this post targets. The auditor checks the post is engineered for ONE target, not all 15.",
          ),
        phase: z
          .enum([
            "foundation",
            "seeding",
            "authority",
            "launch",
            "capitalize",
            "sustain",
            "crisis_recovery",
            "idle",
          ])
          .optional()
          .describe("Campaign phase at the time of drafting. Auditor enforces phase-specific rules (e.g. no product links during seeding)."),
        campaign_anchor: z
          .number()
          .optional()
          .describe(
            "1 if this post was loaded from a scripted anchor in docs/launch/*.md; 0 if free-generated by an agent. Default 0.",
          ),
        parent_post_id: z
          .string()
          .optional()
          .describe(
            "Parent post ID (for thread continuations or self-replies). Use the link-in-reply pattern: hero tweet → reply containing the link.",
          ),
      }),
      handler: async (args) => {
        const input = args as {
          account_id: string;
          content: string;
          post_type?: string;
          status?: string;
          scheduled_at?: string;
          reply_to_x_id?: string;
          quote_x_id?: string;
          format?: string;
          signal_target?: string;
          phase?: string;
          campaign_anchor?: number;
          parent_post_id?: string;
        };

        const account = service.getAccount(input.account_id);
        if (!account) return errorResult(`Account not found: ${input.account_id}`);

        const post = service.createPost(input);
        const charCount = post.content.length;
        const meta = [
          post.format ? `Format: ${post.format}` : "",
          post.signal_target ? `Signal: ${post.signal_target}` : "",
          post.phase ? `Phase: ${post.phase}` : "",
          post.campaign_anchor ? "Anchor: yes" : "",
        ]
          .filter(Boolean)
          .join(" | ");
        return textResult(
          `Post created:\n  ID: ${post.id}\n  Type: ${post.post_type}\n  Status: ${post.status}\n  Chars: ${charCount}/280\n  Account: @${account.handle}${post.scheduled_at ? `\n  Scheduled: ${post.scheduled_at}` : ""}${meta ? `\n  ${meta}` : ""}`,
        );
      },
    },

    {
      name: "kernel_twitter_get_queue",
      description: "Get posts waiting in the queue (status='queued') for approval.",
      inputSchema: z.object({
        account_id: z.string().optional().describe("Filter by account ID"),
      }),
      handler: async (args) => {
        const { account_id } = args as { account_id?: string };
        const posts = service.getQueue(account_id);
        if (posts.length === 0) return textResult("Queue is empty.");

        const lines = posts.map(
          (p) =>
            `**${p.post_type}** | ${p.content.slice(0, 80)}${p.content.length > 80 ? "..." : ""}\n  Scheduled: ${p.scheduled_at ?? "unscheduled"} | Chars: ${p.content.length}/280\n  ID: ${p.id}`,
        );
        return textResult(`${posts.length} queued post(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_twitter_approve",
      description:
        "Approve a queued or draft post, changing its status to 'approved'. Approved posts are ready for publishing.",
      inputSchema: z.object({
        id: z.string().describe("Post ID to approve"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const post = service.approvePost(id);
        if (!post) return errorResult(`Post not found or not in draft/queued status: ${id}`);
        return textResult(`Post approved:\n  ID: ${post.id}\n  Content: ${post.content.slice(0, 100)}${post.content.length > 100 ? "..." : ""}`);
      },
    },

    {
      name: "kernel_twitter_list_posts",
      description: "List X/Twitter posts with optional filters by status, account, and type.",
      inputSchema: z.object({
        status: z
          .enum(["draft", "queued", "approved", "posted", "failed"])
          .optional()
          .describe("Filter by status"),
        account_id: z.string().optional().describe("Filter by account ID"),
        post_type: z
          .enum(["tweet", "reply", "thread", "quote"])
          .optional()
          .describe("Filter by post type"),
        limit: z.number().optional().describe("Max results (default: 50)"),
        offset: z.number().optional().describe("Offset for pagination"),
      }),
      handler: async (args) => {
        const opts = args as {
          status?: string;
          account_id?: string;
          post_type?: string;
          limit?: number;
          offset?: number;
        };
        const posts = service.listPosts(opts);
        if (posts.length === 0) return textResult("No posts found.");

        const lines = posts.map((p) => {
          const metrics =
            p.status === "posted"
              ? ` | imp: ${p.metrics_impressions} | likes: ${p.metrics_likes} | RT: ${p.metrics_retweets} | replies: ${p.metrics_replies}`
              : "";
          return `[${p.status.toUpperCase()}] ${p.post_type} | ${p.content.slice(0, 80)}${p.content.length > 80 ? "..." : ""}${metrics}\n  Posted: ${p.posted_at ?? "not yet"} | ID: ${p.id}`;
        });
        return textResult(`${posts.length} post(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_twitter_get_post",
      description: "Get a single X/Twitter post by ID with full content and metrics.",
      inputSchema: z.object({
        id: z.string().describe("Post ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const post = service.getPost(id);
        if (!post) return errorResult(`Post not found: ${id}`);

        const lines = [
          `## Post ${post.id}`,
          ``,
          `**Type:** ${post.post_type}`,
          `**Status:** ${post.status}`,
          `**Content:**\n${post.content}`,
          `**Chars:** ${post.content.length}/280`,
          ``,
          `**Scheduled:** ${post.scheduled_at ?? "none"}`,
          `**Posted:** ${post.posted_at ?? "not yet"}`,
          `**X Post ID:** ${post.x_post_id || "none"}`,
        ];

        if (post.reply_to_x_id) lines.push(`**Reply to:** ${post.reply_to_x_id}`);
        if (post.quote_x_id) lines.push(`**Quote of:** ${post.quote_x_id}`);

        if (post.status === "posted") {
          lines.push(
            ``,
            `### Metrics`,
            `- Impressions: ${post.metrics_impressions}`,
            `- Likes: ${post.metrics_likes}`,
            `- Retweets: ${post.metrics_retweets}`,
            `- Replies: ${post.metrics_replies}`,
          );
        }

        if (post.error_message) {
          lines.push(``, `**Error:** ${post.error_message}`);
        }

        return textResult(lines.join("\n"));
      },
    },

    // ── Mentions ────────────────────────────────────

    {
      name: "kernel_twitter_list_mentions",
      description: "List mentions for an account. Optionally filter to only unreplied mentions.",
      inputSchema: z.object({
        account_id: z.string().optional().describe("Filter by account ID"),
        unread_only: z.boolean().optional().describe("Only show unreplied mentions (default: false)"),
        limit: z.number().optional().describe("Max results (default: 50)"),
      }),
      handler: async (args) => {
        const opts = args as { account_id?: string; unread_only?: boolean; limit?: number };
        const mentions = service.listMentions(opts);
        if (mentions.length === 0) return textResult("No mentions found.");

        const lines = mentions.map((m) => {
          const status = m.replied ? "[REPLIED]" : "[NEW]";
          return `${status} @${m.author_handle} (${m.author_name || "unknown"})\n  ${m.content.slice(0, 120)}${m.content.length > 120 ? "..." : ""}\n  Detected: ${m.detected_at} | X ID: ${m.x_post_id}\n  ID: ${m.id}`;
        });
        return textResult(`${mentions.length} mention(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_twitter_reply_mention",
      description:
        "Create a reply post for a mention. Links the reply to the mention and marks the mention as replied.",
      inputSchema: z.object({
        mention_id: z.string().describe("Mention ID to reply to"),
        content: z.string().describe("Reply content"),
        account_id: z.string().describe("Account ID to post from"),
      }),
      handler: async (args) => {
        const { mention_id, content, account_id } = args as {
          mention_id: string;
          content: string;
          account_id: string;
        };

        const account = service.getAccount(account_id);
        if (!account) return errorResult(`Account not found: ${account_id}`);

        // Get the mention to find the X post ID to reply to
        const mentions = service.listMentions({ account_id });
        const mention = mentions.find((m) => m.id === mention_id);
        if (!mention) return errorResult(`Mention not found: ${mention_id}`);

        // Create a reply post
        const post = service.createPost({
          account_id,
          content,
          post_type: "reply",
          status: "draft",
          reply_to_x_id: mention.x_post_id,
        });

        // Mark mention as replied
        service.markMentionReplied(mention_id, post.id);

        return textResult(
          `Reply draft created:\n  Post ID: ${post.id}\n  Reply to: @${mention.author_handle} (${mention.x_post_id})\n  Content: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}\n  Status: draft (approve to publish)`,
        );
      },
    },

    // ── Metrics & Performance ───────────────────────

    {
      name: "kernel_twitter_metrics",
      description: "Get follower/following metrics trend for an account over the last N days.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
        days: z.number().optional().describe("Number of days to look back (default: 30)"),
      }),
      handler: async (args) => {
        const { account_id, days } = args as { account_id: string; days?: number };
        const trend = service.getMetricsTrend(account_id, days ?? 30);
        if (trend.length === 0) return textResult("No metrics snapshots found.");

        const lines = trend.map(
          (s) =>
            `${s.snapshot_date}: followers=${s.followers} following=${s.following} tweets=${s.tweets_count}`,
        );

        // Compute growth if we have at least 2 data points
        let growth = "";
        if (trend.length >= 2) {
          const first = trend[0];
          const last = trend[trend.length - 1];
          const followerDelta = last.followers - first.followers;
          const sign = followerDelta >= 0 ? "+" : "";
          growth = `\nFollower growth: ${sign}${followerDelta} (${first.snapshot_date} to ${last.snapshot_date})`;
        }

        return textResult(`${trend.length} snapshot(s):\n\n${lines.join("\n")}${growth}`);
      },
    },

    {
      name: "kernel_twitter_performance",
      description:
        "Get a performance report for an account: aggregated post metrics, top posts, and breakdown by type/status.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
        days: z.number().optional().describe("Number of days to look back (default: 30)"),
      }),
      handler: async (args) => {
        const { account_id, days } = args as { account_id: string; days?: number };

        const account = service.getAccount(account_id);
        if (!account) return errorResult(`Account not found: ${account_id}`);

        const report = service.getPerformanceReport(account_id, days ?? 30);

        const lines = [
          `## Performance Report: @${account.handle}`,
          `Period: last ${days ?? 30} days`,
          ``,
          `### Totals`,
          `- Posts: ${report.total_posts}`,
          `- Impressions: ${report.total_impressions}`,
          `- Likes: ${report.total_likes}`,
          `- Retweets: ${report.total_retweets}`,
          `- Replies: ${report.total_replies}`,
          ``,
          `### Averages per post`,
          `- Impressions: ${Math.round(report.avg_impressions)}`,
          `- Likes: ${Math.round(report.avg_likes)}`,
          `- Retweets: ${Math.round(report.avg_retweets)}`,
          `- Replies: ${Math.round(report.avg_replies)}`,
        ];

        if (report.posts_by_type.length > 0) {
          lines.push(``, `### Posts by type`);
          for (const t of report.posts_by_type) {
            lines.push(`- ${t.post_type}: ${t.count}`);
          }
        }

        if (report.posts_by_status.length > 0) {
          lines.push(``, `### Posts by status`);
          for (const s of report.posts_by_status) {
            lines.push(`- ${s.status}: ${s.count}`);
          }
        }

        if (report.top_posts.length > 0) {
          lines.push(``, `### Top posts`);
          for (const p of report.top_posts) {
            const engagement = p.metrics_likes + p.metrics_retweets + p.metrics_replies;
            lines.push(
              `- ${p.content.slice(0, 60)}${p.content.length > 60 ? "..." : ""} (engagement: ${engagement}, imp: ${p.metrics_impressions})\n  ID: ${p.id}`,
            );
          }
        }

        return textResult(lines.join("\n"));
      },
    },
  ];
}
