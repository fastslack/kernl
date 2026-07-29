import { log } from "../../../../../src/core/logger.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { SystemRegistry } from "../../../../../src/core/system-registry.js";
import type { TwitterService } from "./service.js";
import { XApiClient } from "./x-client.js";

// ── Twitter Publisher ─────────────────────────────────────
// Polls for approved posts that are due to be published.
// Runs on an interval alongside the agent scheduler.

export class TwitterPublisher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processId: string | null = null;

  constructor(
    private service: TwitterService,
    private events: EventBus,
    private systemRegistry: SystemRegistry,
    private pollIntervalMs: number = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;

    this.processId = this.systemRegistry.register({
      name: "Twitter Publisher",
      type: "interval",
      module: "twitter",
      description: "Publishes approved/scheduled X posts",
      intervalMs: this.pollIntervalMs,
      status: "running",
    });

    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    this.timer.unref();
    log.info(`TwitterPublisher started (poll every ${this.pollIntervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.processId) {
      this.systemRegistry.updateStatus(this.processId, "stopped");
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      if (this.processId) this.systemRegistry.recordRun(this.processId);

      // Find posts ready to publish: approved + (no schedule OR schedule <= now)
      const now = new Date().toISOString();
      const approved = this.service.listPosts({ status: "approved" });
      const due = approved.filter(
        (p) => !p.scheduled_at || p.scheduled_at <= now,
      );

      if (due.length === 0) return;

      log.info(`TwitterPublisher: ${due.length} post(s) ready to publish`);

      for (const post of due) {
        const account = this.service.getAccount(post.account_id);
        if (!account || account.status !== "active") {
          log.warn(`TwitterPublisher: skipping post ${post.id} — account ${post.account_id} not active`);
          continue;
        }

        if (!account.api_key || !account.access_token) {
          log.warn(`TwitterPublisher: skipping post ${post.id} — account @${account.handle} missing API credentials`);
          this.service.updatePost(post.id, {
            status: "failed",
            error_message: "Account missing API credentials",
          });
          continue;
        }

        const client = new XApiClient({
          apiKey: account.api_key,
          apiSecret: account.api_secret,
          accessToken: account.access_token,
          accessSecret: account.access_secret,
        });

        // Determine reply/quote options
        const opts: { reply_to_id?: string; quote_tweet_id?: string } = {};
        if (post.post_type === "reply" && post.reply_to_x_id) {
          opts.reply_to_id = post.reply_to_x_id;
        }
        if (post.post_type === "quote" && post.quote_x_id) {
          opts.quote_tweet_id = post.quote_x_id;
        }

        const result = await client.postTweet(post.content, opts);

        if (result.ok) {
          this.service.publishPost(post.id, result.data.id);
          log.info(`TwitterPublisher: posted ${post.id} → X ID ${result.data.id} (@${account.handle})`);

          this.events.emit("twitter.posted", {
            post_id: post.id,
            x_post_id: result.data.id,
            account_handle: account.handle,
            content_preview: post.content.slice(0, 80),
          });
        } else {
          this.service.updatePost(post.id, {
            status: "failed",
            error_message: result.error,
          });
          log.error(`TwitterPublisher: failed to post ${post.id}: ${result.error}`);

          this.events.emit("twitter.post_failed", {
            post_id: post.id,
            account_handle: account.handle,
            error: result.error,
          });
        }
      }
    } catch (err) {
      log.error("TwitterPublisher tick error:", err);
    } finally {
      this.running = false;
    }
  }

  /** Publish a single post immediately (manual trigger) */
  async publishNow(postId: string): Promise<{ ok: boolean; error?: string; x_post_id?: string }> {
    const post = this.service.getPost(postId);
    if (!post) return { ok: false, error: "Post not found" };
    if (post.status === "posted") return { ok: false, error: "Already posted" };

    const account = this.service.getAccount(post.account_id);
    if (!account) return { ok: false, error: "Account not found" };
    if (!account.api_key || !account.access_token) {
      return { ok: false, error: "Account missing API credentials" };
    }

    const client = new XApiClient({
      apiKey: account.api_key,
      apiSecret: account.api_secret,
      accessToken: account.access_token,
      accessSecret: account.access_secret,
    });

    const opts: { reply_to_id?: string; quote_tweet_id?: string } = {};
    if (post.post_type === "reply" && post.reply_to_x_id) opts.reply_to_id = post.reply_to_x_id;
    if (post.post_type === "quote" && post.quote_x_id) opts.quote_tweet_id = post.quote_x_id;

    const result = await client.postTweet(post.content, opts);

    if (result.ok) {
      this.service.publishPost(post.id, result.data.id);
      this.events.emit("twitter.posted", {
        post_id: post.id,
        x_post_id: result.data.id,
        account_handle: account.handle,
      });
      return { ok: true, x_post_id: result.data.id };
    }

    this.service.updatePost(post.id, {
      status: "failed",
      error_message: result.error,
    });
    return { ok: false, error: result.error };
  }

  /** Sync metrics for recent posted tweets */
  async syncMetrics(accountId: string): Promise<number> {
    const account = this.service.getAccount(accountId);
    if (!account || !account.api_key) return 0;

    const client = new XApiClient({
      apiKey: account.api_key,
      apiSecret: account.api_secret,
      accessToken: account.access_token,
      accessSecret: account.access_secret,
    });

    // Get posted tweets from last 7 days
    const posts = this.service.listPosts({ account_id: accountId, status: "posted", limit: 50 });
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = posts.filter((p) => p.posted_at && p.posted_at >= sevenDaysAgo && p.x_post_id);

    let synced = 0;
    for (const post of recent) {
      const metrics = await client.getTweetMetrics(post.x_post_id);
      if (metrics?.public_metrics) {
        const m = metrics.public_metrics;
        this.service.updatePostMetrics(post.id, {
          impressions: m.impression_count,
          likes: m.like_count,
          retweets: m.retweet_count,
          replies: m.reply_count,
        });
        synced++;
      }
    }

    // Also snapshot account metrics
    const me = await client.getMe();
    if (me?.public_metrics) {
      this.service.snapshotMetrics({
        account_id: accountId,
        followers: me.public_metrics.followers_count,
        following: me.public_metrics.following_count,
        tweets_count: me.public_metrics.tweet_count,
      });
    }

    return synced;
  }

  /** Check mentions for an account */
  async checkMentions(accountId: string): Promise<number> {
    const account = this.service.getAccount(accountId);
    if (!account || !account.api_key) return 0;

    const client = new XApiClient({
      apiKey: account.api_key,
      apiSecret: account.api_secret,
      accessToken: account.access_token,
      accessSecret: account.access_secret,
    });

    const me = await client.getMe();
    if (!me) return 0;

    const mentions = await client.getMentions(me.id);
    if (!mentions?.data) return 0;

    let added = 0;
    for (const mention of mentions.data) {
      // Check if we already have this mention
      const existing = this.service.listMentions({ account_id: accountId });
      if (existing.some((m) => m.x_post_id === mention.id)) continue;

      const author = mentions.includes?.users?.find((u) => u.id === mention.author_id);

      this.service.addMention({
        account_id: accountId,
        x_post_id: mention.id,
        author_handle: author?.username ?? "",
        author_name: author?.name ?? "",
        content: mention.text,
        detected_at: mention.created_at,
      });
      added++;
    }

    if (added > 0) {
      this.events.emit("twitter.mentions", {
        account_id: accountId,
        account_handle: account.handle,
        new_mentions: added,
      });
    }

    return added;
  }
}
