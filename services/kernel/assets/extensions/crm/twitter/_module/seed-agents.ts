import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { log } from "../../../../../src/core/logger.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

// ── Seed X/Twitter Agents ─────────────────────────────────
// Pre-configured agents for automated X content management.
// Creates a flow "X Manager" with agents for content generation,
// publishing, mention monitoring, and metrics collection.

const FLOW_NAME = "X Manager";

export function seedTwitterAgents(db: SqliteDb, agentService: any): void {
  try {
    // Check if flow already exists
    const flows = agentService.listFlows();
    if (flows.some((f: any) => f.name === FLOW_NAME)) return;

    const flow = agentService.createFlow({
      name: FLOW_NAME,
      description: "Automated X/Twitter content pipeline: generate → approve → publish → monitor",
      color: "#1DA1F2",
    });

    const flowId = flow.id;

    // ── Agent 1: Content Generator ────────────────────────
    const contentGen = agentService.createAgent({
      name: "X Content Creator",
      description: "Generates engaging tweets about AI, open source software, and Linux",
      system_prompt: `You are a tech content creator for X/Twitter. Your niche: AI, open source software, and Linux.

VOICE & STYLE:
- Direct, opinionated, conversational. No corporate speak.
- Use specific examples and real projects/tools (not generic buzzwords).
- Mix formats: hot takes, practical tips, tool discoveries, industry insights, questions.
- Thread long ideas (use kernel_twitter_create_post with post_type "thread").
- Keep tweets under 280 chars. Be punchy.

CONTENT PILLARS:
1. **AI & ML**: New models, tools (Ollama, LM Studio, HuggingFace), practical use cases, agent frameworks
2. **Open Source**: Cool repos, new releases, contribution stories, FOSS philosophy
3. **Linux**: Distro news, CLI tools, sysadmin tips, kernel updates, ricing/customization
4. **Intersections**: AI on Linux, open-source AI tools, self-hosted alternatives

RULES:
- Always create posts as "queued" status so they go through approval
- Check existing posts first (kernel_twitter_list_posts) to avoid duplicates
- Vary content types: tweet, thread, question, hot_take
- Include relevant hashtags sparingly (1-2 max, only if natural)
- NEVER use generic filler like "In today's digital landscape..." or "Let's dive in..."
- Be specific: name tools, versions, benchmarks, real use cases`,
      goal_template: `Generate {{count}} fresh tweet(s) for the X account.

Topic focus: {{topic}}

Steps:
1. List current accounts (kernel_twitter_list_accounts) — pick the active one
2. Check recent posts (kernel_twitter_list_posts with status=posted, limit=10) to avoid repeating
3. Create {{count}} new post(s) with status "queued"
4. Vary the format: mix insights, tips, questions, and hot takes`,
      allowed_tools: [
        "kernel_twitter_list_accounts",
        "kernel_twitter_create_post",
        "kernel_twitter_list_posts",
        "kernel_twitter_get_queue",
      ],
      provider: "",
      model: "",
      max_iterations: 10,
      timeout_ms: 120_000,
      flow_id: flowId,
      variables: {
        count: "3",
        topic: "AI, open source, Linux — pick what feels fresh today",
      },
      show_on_dashboard: true,
    });

    // ── Agent 2: Content Publisher ────────────────────────
    const contentPub = agentService.createAgent({
      name: "X Publisher",
      description: "Reviews and approves queued posts, then publishes them via the X API",
      system_prompt: `You are a content quality reviewer and publisher for X/Twitter.

REVIEW CRITERIA:
- Content is accurate and not misleading
- Tone matches the account's voice (tech-savvy, direct, opinionated)
- No sensitive/controversial statements that could harm reputation
- Proper length (< 280 chars for single tweets)
- No duplicate or near-duplicate content in recent history
- Hashtags are natural, not spammy

WORKFLOW:
1. Review each queued post for quality
2. Approve good posts (kernel_twitter_approve)
3. Skip/flag posts that need editing (leave as queued with a note)
4. The publisher service will automatically post approved tweets

If posts need editing, update them (kernel_twitter_list_posts to get IDs, then explain what needs changing).`,
      goal_template: `Review and approve queued X posts.

Steps:
1. Get the queue (kernel_twitter_get_queue)
2. For each post, evaluate against quality criteria
3. Approve good posts (kernel_twitter_approve)
4. Report what was approved and what was skipped`,
      allowed_tools: [
        "kernel_twitter_get_queue",
        "kernel_twitter_list_posts",
        "kernel_twitter_approve",
        "kernel_twitter_get_post",
      ],
      provider: "",
      model: "",
      max_iterations: 15,
      timeout_ms: 60_000,
      flow_id: flowId,
      variables: {},
      show_on_dashboard: true,
    });

    // ── Agent 3: Metrics Collector ────────────────────────
    const metricsAgent = agentService.createAgent({
      name: "X Metrics Tracker",
      description: "Collects engagement metrics and follower counts from X API",
      system_prompt: `You track X/Twitter performance metrics.

TASKS:
- Snapshot follower/following counts
- Report on engagement trends
- Identify top-performing content
- Flag any anomalies (sudden drops, viral posts)

Use kernel_twitter_performance and kernel_twitter_metrics to gather data.
Present findings in a concise, actionable format.`,
      goal_template: `Collect and report X metrics for all active accounts.

Steps:
1. List accounts (kernel_twitter_list_accounts)
2. For each active account, get performance report (kernel_twitter_performance)
3. Check metrics trend (kernel_twitter_metrics)
4. Summarize findings: what's working, what's not, top posts`,
      allowed_tools: [
        "kernel_twitter_list_accounts",
        "kernel_twitter_performance",
        "kernel_twitter_metrics",
        "kernel_twitter_list_posts",
      ],
      provider: "",
      model: "",
      max_iterations: 10,
      timeout_ms: 60_000,
      flow_id: flowId,
      variables: {},
      show_on_dashboard: false,
    });

    // ── Agent 4: Mention Responder ────────────────────────
    const mentionAgent = agentService.createAgent({
      name: "X Mention Handler",
      description: "Monitors and drafts replies to mentions",
      system_prompt: `You monitor X mentions and draft thoughtful replies.

REPLY GUIDELINES:
- Be helpful and genuine
- If someone asks a question, provide a useful answer
- If it's praise, thank them authentically
- If it's criticism, acknowledge respectfully
- Keep replies concise (< 200 chars ideally)
- Don't reply to spam or trolls (just skip them)
- All replies are created as drafts for manual approval

WORKFLOW:
1. Check for unread mentions
2. For each genuine mention, draft a reply
3. Skip spam/irrelevant mentions`,
      goal_template: `Check and respond to recent X mentions.

Steps:
1. List unread mentions (kernel_twitter_list_mentions with unread_only)
2. For each mention worth replying to, create a reply (kernel_twitter_reply_mention)
3. Skip spam or trolls
4. Report: how many mentions, how many replied to`,
      allowed_tools: [
        "kernel_twitter_list_accounts",
        "kernel_twitter_list_mentions",
        "kernel_twitter_reply_mention",
        "kernel_twitter_list_posts",
      ],
      provider: "",
      model: "",
      max_iterations: 15,
      timeout_ms: 90_000,
      flow_id: flowId,
      variables: {},
      show_on_dashboard: false,
    });

    // ── Schedules ─────────────────────────────────────────

    // Content Generator: 3x daily (9am, 2pm, 7pm)
    agentService.addSchedule({
      agent_id: contentGen.id,
      cron_expression: "0 9,14,19 * * *",
      goal_override: "",
    });

    // Publisher: every 2 hours during active hours
    agentService.addSchedule({
      agent_id: contentPub.id,
      cron_expression: "0 8,10,12,15,18,20 * * *",
      goal_override: "",
    });

    // Metrics: once daily at 23:00
    agentService.addSchedule({
      agent_id: metricsAgent.id,
      cron_expression: "0 23 * * *",
      goal_override: "",
    });

    // Mention Handler: every 4 hours
    agentService.addSchedule({
      agent_id: mentionAgent.id,
      cron_expression: "0 8,12,16,20 * * *",
      goal_override: "",
    });

    // ── Chains ────────────────────────────────────────────

    // Content Generator → Publisher (auto-review after generation)
    agentService.addChain({
      source_agent_id: contentGen.id,
      target_agent_id: contentPub.id,
      label: "Auto-review after generation",
      condition: { status: "completed" },
      pass_result: true,
      delay_ms: 5_000,
    });

    log.info(`Twitter: seeded ${FLOW_NAME} flow with 4 agents, 4 schedules, 1 chain`);
  } catch (err) {
    log.warn(`Twitter: failed to seed agents: ${err}`);
  }
}
