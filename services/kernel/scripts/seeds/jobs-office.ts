/**
 * Seed the "Jobs Hunter" office — script scrapers + LLM curator.
 *
 * Idempotent: the flow is looked up by name, scraper agents by their
 * `builtin_handler` value, and the curator by `slug`. Re-running refreshes
 * editable fields (description, cron, system_prompt) but never reactivates an
 * agent the operator paused by hand. Same convention as `seed-flights-agent.ts`.
 *
 * Layout produced:
 *   • Flow: "Jobs Hunter" (cyan)
 *   • One scraper agent per entry in `JOB_SCRAPER_DEFS`, each with a default
 *     `variables` JSON (skill_keywords / exclude_keywords / search_queries /
 *     min_hourly_usd / max_per_run). All edit-from-dashboard.
 *   • One LLM agent "Job Hunter Curator" that consumes the #job-pending-review
 *     notes the scrapers leave, scores them against the same profile, and
 *     pushes the top hits to the dashboard/notifier.
 *
 * The scrapers themselves live in `./job-scrapers.ts`; the builtin-handlers
 * registry wires them in already. This seeder just creates the rows so the
 * scheduler actually fires them.
 */

import type { SqliteDb } from "../../src/core/db/sqlite.js";
import type { AgentService } from "../../src/modules/agents/service.js";
import { isoNow } from "../../src/core/helpers.js";
import { log } from "../../src/core/logger.js";
import { JOB_SCRAPER_DEFS } from "../../src/modules/agents/job-scrapers.js";
import type { WorkspaceServiceLike } from "../../src/modules/agents/advanced-types.js";

const FLOW = {
  name: "Jobs Hunter",
  description: "Job-board scrapers + LLM curator (Upwork, Freelancer, Workana, Arc.dev, Gun.io, RemoteOK).",
  color: "#06b6d4", // cyan-500
};

// Default profile — Linux/DevOps + TypeScript/Node. Stored as agents.variables
// JSON on each scraper row; the operator can edit it per-agent from the
// dashboard without redeploying the kernel.
const DEFAULT_VARS: Record<string, Record<string, unknown>> = {
  upwork: {
    skill_keywords: "devops,kubernetes,proxmox,ansible,terraform,linux,sysadmin,typescript,node,nodejs,react,nextjs,postgres",
    exclude_keywords: "wordpress,shopify,php,seo,plagiarism,academic writing",
    min_hourly_usd: 35,
    max_per_run: 8,
    search_queries: "devops,linux sysadmin,typescript backend",
  },
  freelancer: {
    skill_keywords: "devops,linux,kubernetes,docker,ansible,terraform,typescript,node,nodejs,postgres,proxmox",
    exclude_keywords: "wordpress,php,academic writing,content writing,data entry",
    min_hourly_usd: 30,
    max_per_run: 8,
    search_queries: "devops,linux,nodejs,typescript",
  },
  workana: {
    skill_keywords: "devops,linux,kubernetes,docker,ansible,terraform,typescript,node,nodejs,backend",
    exclude_keywords: "wordpress,php,content,redacción",
    min_hourly_usd: 25,
    max_per_run: 8,
    search_queries: "it-programming",
  },
  "arc-dev": {
    skill_keywords: "devops,kubernetes,terraform,ansible,linux,typescript,node,react,nextjs",
    exclude_keywords: "java,salesforce,php",
    min_hourly_usd: 60,
    max_per_run: 6,
    search_queries: "devops-engineer,typescript-developer,nodejs-developer",
  },
  "gun-io": {
    skill_keywords: "devops,linux,typescript,node,react,kubernetes,postgres",
    exclude_keywords: "java,salesforce",
    min_hourly_usd: 60,
    max_per_run: 6,
    search_queries: "",
  },
  remoteok: {
    skill_keywords: "devops,kubernetes,terraform,linux,typescript,node,nodejs,react,nextjs",
    exclude_keywords: "java,salesforce,php,blockchain",
    min_hourly_usd: 0, // RemoteOK lists annual salaries — let the curator judge.
    max_per_run: 8,
    search_queries: "",
  },
  // ── ATS adapters (full-time, Linux + Claude-Code adjacency) ──
  //
  // search_queries is the company-slug list per ATS board. Adding a company is
  // just adding its slug here and `./scripts/dev.sh reload kernel`. The
  // skill/exclude keyword sets are tuned for the operator profile: Linux/infra
  // + DevOps + TypeScript backend + AI-coding-agent companies.
  //
  // min_annual_usd: 120000 is the locked sprint-1 floor (see
  // docs/jobs-pipeline-v2.md §10). senior_only_strict, require_remote, and
  // allow_latam are read by the sprint-2 quality gate; the scraper itself
  // ignores them today.
  greenhouse: {
    skill_keywords: "linux,devops,sre,kubernetes,terraform,ansible,typescript,node,nodejs,backend,distributed,systems,rust,go,golang,postgres",
    exclude_keywords: "wordpress,php,salesforce,sap,oracle erp,unity,gamedev",
    min_annual_usd: 120000,
    max_per_run: 12,
    senior_only_strict: 0,
    require_remote: 1,
    allow_latam: 1,
    search_queries: "anthropic,sourcegraph,tabnine,gitlab,cloudflare,tailscale,fastly,vercel",
  },
  lever: {
    skill_keywords: "linux,devops,sre,kubernetes,terraform,typescript,node,nodejs,backend,systems,rust,go,distributed",
    exclude_keywords: "wordpress,php,salesforce,unity",
    min_annual_usd: 120000,
    max_per_run: 12,
    senior_only_strict: 0,
    require_remote: 1,
    allow_latam: 1,
    search_queries: "anysphere",
  },
  ashby: {
    skill_keywords: "linux,devops,sre,kubernetes,terraform,typescript,node,nodejs,backend,systems,distributed,llm,ai-agent,coding-agent,rust,go,postgres,sqlite",
    exclude_keywords: "wordpress,php,salesforce,unity",
    min_annual_usd: 120000,
    max_per_run: 12,
    senior_only_strict: 0,
    require_remote: 1,
    allow_latam: 1,
    search_queries: "replit,cognition,codeium,continue,modal,railway,turso",
  },
};

// Curator defaults — read by the deterministic curator script handler from
// agents.variables on every run. `owned_stack` is the high-value-signal list
// (a hit is +3 to the score); `red_flags` is the −3 list.
DEFAULT_VARS.curate = {
  top_n: 5,
  owned_stack: "proxmox,kubernetes,terraform,ansible,typescript,nodejs,postgres,linux,sysadmin,docker,nextjs,react,sre,devops",
  red_flags: "wordpress,academic writing,plagiarism,urgent fix tonight,paid in equity,no budget,unpaid trial",
};

// Dispatcher defaults — read by `scraper:jobs:dispatch`. The dispatcher
// finds #job-curated notes and fires one LLM drafter run per note via the
// local /api/agents/run endpoint. Cap on per-tick fan-out is critical:
// runaway dispatch + LLM = real spend.
DEFAULT_VARS.dispatch = {
  max_per_run: 3,
  // Comma-separated tags a note MUST have to dispatch. Default: only top hits.
  require_tags: "#job-top",
};

// ── Curator agent (legacy LLM curator — kept off by default) ──
// Earlier iteration was an LLM agent that hallucinated URLs and burned 488k
// tokens per run. The active curator is the deterministic script handler
// `scraper:jobs:curate` in job-scrapers.ts. We still create the LLM curator
// row so the operator can opt back in (e.g. for richer semantic dedupe) by
// flipping `active = 1`, but it's seeded paused.

const CURATOR_SLUG = "jobs-curator";

const CURATOR_PROMPT = [
  "You are the Job Hunter Curator. Your job is to scan the inbox of fresh job notes left by the scraper handlers and surface the few that genuinely match the operator's profile.",
  "",
  "## The pipeline you live inside",
  "Each scraper (Upwork, Freelancer, Workana, Arc.dev, Gun.io, RemoteOK) writes one note per fresh job ad with tags like `#job #job-<platform> #job-<platform>-alerted #job-pending-review`. The match is already keyword-filtered, but NOT yet ranked, deduped across platforms, or sanity-checked for the budget/scope being real.",
  "",
  "## EXACT tool calls (do not invent variants)",
  "  1. **List pending jobs** — call `kernel_notes_list` with `{ \"tag\": \"#job-pending-review\", \"limit\": 50 }`. This returns ID + title + tags for every fresh listing. NEVER use `kernel_notes_search` with `#`-prefixed tags — FTS5 strips the `#` and the search misses everything. Tag-prefix filter is the only reliable path.",
  "  2. **Fetch one note's full body** — `kernel_notes_get` with `{ \"id\": \"<note-id>\" }`. The body has URL, Budget, Matched keywords, Posted date, and the original description. Read the body — that's what you actually score against.",
  "  3. **Rewrite tags after scoring** — `kernel_notes_update` with `{ \"id\": \"<note-id>\", \"tags\": \"<new full tag string>\" }`. Note: `tags` REPLACES the existing string, so you must include every tag you want to keep. The note body already shows the current tag set; preserve `#job #job-<platform> #job-<platform>-alerted` and replace `#job-pending-review` with either `#job-curated` (top hits) or `#job-reviewed` (rest).",
  "",
  "## Scoring rubric (0-10)",
  "  - +3 if the budget is concrete (hourly rate stated, or fixed >$500).",
  "  - +2 if the description names a stack you actually own (Proxmox / Kubernetes / Terraform / TypeScript / Node / Postgres / Linux).",
  "  - +2 if the client looks legitimate (named company, longer description, English/Spanish fluent).",
  "  - −3 for red flags: 'urgent fix tonight', 'no budget', plagiarism/academic, fixed-price <$50, paid-in-revenue-share, vague 'rate negotiable'.",
  "  - Cluster cross-postings (same role across platforms) — keep the highest-scoring instance, demote the rest to `#job-reviewed`.",
  "",
  "## Output: one short summary block",
  "Top 3-5 listings only. Per item: `title — score/10 — platform — budget — URL`, then one sentence why it's interesting. The operator reads this on a phone. Terse > complete.",
  "",
  "## Tools you can call",
  "  • kernel_notes_list   — tag-filtered listing (your ONLY way to find pending notes).",
  "  • kernel_notes_get    — full body of one note.",
  "  • kernel_notes_update — rewrite tags after scoring.",
  "  • kernel_notes_search — FTS5 over title/body/tags. Useless for `#tag` filters but fine for keyword cross-checks (e.g. `query=\"proxmox\"` to find related notes).",
  "  • kernel_webintel_fetch_url — OPTIONAL, only when a listing's body is too thin to score. Use sparingly.",
  "",
  "## Hard rules",
  "  • If `kernel_notes_list` returns 0 results, say `No pending-review job notes.` and STOP. Do not retry with other tools.",
  "  • Never invent budgets, client names, or URLs not present in the note body. If a field is missing, write 'not stated'.",
  "  • Never re-promote a note already tagged `#job-curated` — a previous run already surfaced it.",
].join("\n");

const CURATOR_ALLOWED_TOOLS = [
  "kernel_notes_search",
  "kernel_notes_get",
  "kernel_notes_update",
  "kernel_notes_list",
  "kernel_webintel_fetch_url",
];

// goal_template seeds every run with an unambiguous first action so the LLM
// can't drift into "list everything" mode. Default model picked up notes_list
// but called it with {} last time — making the first call explicit fixes it.
const CURATOR_GOAL = [
  "Curate today's freshest job-board hits.",
  "",
  "STEP 1 — your FIRST action this run MUST be exactly this tool call (no variations):",
  "  kernel_notes_list",
  "  arguments: { \"tag\": \"#job-pending-review\", \"limit\": 50 }",
  "",
  "If that call returns 0 notes, reply `No pending-review job notes.` and stop the run.",
  "Otherwise, for the most interesting 3-5 notes (judged by title + tags):",
  "  • Call kernel_notes_get to read the full body.",
  "  • Score 0-10 using the rubric in your system prompt.",
  "  • Call kernel_notes_update to rewrite tags — replace `#job-pending-review` with `#job-curated` (top hits) or `#job-reviewed` (rest), preserve every other tag verbatim.",
  "",
  "Finish with one terse summary block — top 3-5 listings only, each line `Title — N/10 — platform — budget — URL` + one sentence why.",
].join("\n");

// ── Seeder ────────────────────────────────────────────────────

export function seedJobsOffice(
  db: SqliteDb,
  service: AgentService,
  workspaces: WorkspaceServiceLike,
): void {
  // 1) Flow ────────────────────────────────────────────────────
  let flow = db
    .prepare("SELECT id FROM agent_flows WHERE name = ? AND active = 1")
    .get(FLOW.name) as { id: string } | undefined;
  if (!flow) {
    const created = service.createFlow(FLOW);
    flow = { id: created.id };
    log.info(`Jobs Hunter: created flow "${FLOW.name}"`);
  }

  // 1b) Proposals workspace ────────────────────────────────────
  // Create the workspace at seed time so we can pin its UUID into the
  // drafter + dispatcher `__workspace__` variable — the dashboard's
  // agent-detail modal uses that variable to populate the Workspace tab.
  // Without it the tab falls back to `agent-<uuid>` which doesn't exist
  // on disk, and the user sees an empty tab.
  let proposalsWs = workspaces.getByOwnerName(flow.id, "proposals");
  if (!proposalsWs) {
    proposalsWs = workspaces.create({
      owner_flow_id: flow.id,
      name: "proposals",
      description: "Job application drafts (one file per #job-drafted note).",
    });
    log.info(`Jobs Hunter: created workspace "proposals" (${proposalsWs.id})`);
  }

  // 2) Scraper agents (one per JOB_SCRAPER_DEFS entry) ─────────
  // Lookup by builtin_handler — that's the stable identity for script agents
  // (slug is unused on builtin_handler rows historically).
  for (const def of JOB_SCRAPER_DEFS) {
    // Each handler key looks like "scraper:jobs:upwork"; the platform suffix
    // is what we key the default vars on.
    const platform = def.handler.split(":").slice(-1)[0];
    // Pin __workspace__ onto every scraper so the agent-detail modal's
    // Workspace tab points at the right files. Scrapers don't write to
    // workspaces directly, but pointing them at "proposals" lets the
    // operator browse the pipeline output from any scraper card too.
    const baseVars = { ...(DEFAULT_VARS[platform] ?? {}), __workspace__: proposalsWs.id };
    const variables = JSON.stringify(baseVars);

    const existing = db
      .prepare("SELECT id, variables FROM agents WHERE builtin_handler = ? LIMIT 1")
      .get(def.handler) as { id: string; variables: string } | undefined;

    let agentId: string;
    if (existing) {
      // Refresh description + show_on_dashboard + flow_id but DO NOT overwrite
      // `variables` — the operator may have tuned the keywords on the dashboard.
      // (We only initialise variables on first create.)
      // EXCEPTION: merge __workspace__ in if missing/stale so the dashboard's
      // agent-detail Workspace tab can resolve the right workspace.
      let exVars: Record<string, unknown> = {};
      try { exVars = JSON.parse(existing.variables || "{}"); } catch { /* defaults */ }
      if (exVars.__workspace__ !== proposalsWs.id) {
        const merged = { ...exVars, __workspace__: proposalsWs.id };
        db.prepare("UPDATE agents SET variables = ? WHERE id = ?")
          .run(JSON.stringify(merged), existing.id);
      }
      db.prepare(
        `UPDATE agents SET
           description = ?,
           flow_id = ?,
           show_on_dashboard = 1,
           updated_at = ?
         WHERE id = ?`,
      ).run(def.description, flow.id, isoNow(), existing.id);
      agentId = existing.id;
    } else {
      const created = service.createAgent({
        name: def.name,
        description: def.description,
        system_prompt: "", // builtin handlers ignore prompts
        flow_id: flow.id,
        allowed_tools: [],
        max_iterations: 1,
        timeout_ms: 120_000,
        variables: variables as unknown as Record<string, string>,
        show_on_dashboard: true,
        builtin_handler: def.handler,
      });
      agentId = created.id;
      // createAgent strips builtin_handler defaults — re-assert just in case
      // a future refactor changes the default.
      db.prepare(
        `UPDATE agents SET builtin_handler = ?, variables = ?, updated_at = ? WHERE id = ?`,
      ).run(def.handler, variables, isoNow(), agentId);
      log.info(`Jobs Hunter: created scraper agent "${def.name}" (${agentId})`);
    }

    // 2b) Schedule — ensure exactly one cron row per agent.
    const sched = db
      .prepare("SELECT id, cron_expression FROM agent_schedules WHERE agent_id = ? AND active = 1 LIMIT 1")
      .get(agentId) as { id: string; cron_expression: string } | undefined;
    if (sched) {
      if (sched.cron_expression !== def.cron) {
        db.prepare(
          "UPDATE agent_schedules SET cron_expression = ?, interval_ms = 0 WHERE id = ?",
        ).run(def.cron, sched.id);
      }
    } else {
      service.addSchedule({ agent_id: agentId, cron_expression: def.cron });
    }
  }

  // 3) Curator agent (LLM) ─────────────────────────────────────
  // Force a tool-use-capable model so the curator doesn't slop the
  // kernel_notes_list args away (default gpt-4o-mini sometimes calls tools
  // with {} when the schema is rich). Claude Sonnet → Grok fallback.
  const CURATOR_MODEL_CHAIN = JSON.stringify([
    { provider: "claude_code", model: "claude-sonnet-4-5" },
    { provider: "grok",   model: "grok-4-fast-non-reasoning" },
  ]);

  const existingCurator = service.getAgentBySlug(CURATOR_SLUG);
  if (existingCurator) {
    // Refresh editable fields but force-pause this agent. The deterministic
    // `scraper:jobs:curate` row (auto-seeded via JOB_SCRAPER_DEFS) is the
    // active curator now; this LLM row is kept for opt-in reactivation only.
    db.prepare(
      `UPDATE agents SET
         name = ?,
         description = ?,
         system_prompt = ?,
         goal_template = ?,
         flow_id = ?,
         allowed_tools = ?,
         model_chain = ?,
         max_iterations = ?,
         timeout_ms = ?,
         show_on_dashboard = 0,
         active = 0,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      "Job Hunter Curator (LLM, paused)",
      "[paused — see scraper:jobs:curate for the active curator] LLM-based curator. Hallucinated URLs in early testing; kept seeded but inactive. Set active=1 to reactivate.",
      CURATOR_PROMPT,
      CURATOR_GOAL,
      flow.id,
      JSON.stringify(CURATOR_ALLOWED_TOOLS),
      CURATOR_MODEL_CHAIN,
      20,
      300_000,
      isoNow(),
      existingCurator.id,
    );
  } else {
    const created = service.createAgent({
      name: "Job Hunter Curator (LLM, paused)",
      description: "[paused — see scraper:jobs:curate for the active curator] LLM-based curator. Hallucinated URLs in early testing; kept seeded but inactive. Set active=1 to reactivate if you want richer semantic clustering on top of the deterministic pass.",
      system_prompt: CURATOR_PROMPT,
      goal_template: CURATOR_GOAL,
      flow_id: flow.id,
      allowed_tools: CURATOR_ALLOWED_TOOLS,
      model_chain: [
        { provider: "claude_code", model: "claude-sonnet-4-5" },
        { provider: "grok",   model: "grok-4-fast-non-reasoning" },
      ],
      max_iterations: 20,
      timeout_ms: 300_000,
      show_on_dashboard: false,
    });
    db.prepare(
      `UPDATE agents SET slug = ?, active = 0, show_on_dashboard = 0, updated_at = ? WHERE id = ?`,
    ).run(CURATOR_SLUG, isoNow(), created.id);
    log.info(`Jobs Hunter: created LLM curator agent "Job Hunter Curator" (${created.id}) — paused.`);
  }

  // 4) Job Application Drafter (LLM) ───────────────────────────
  // Single-note worker. Triggered by `scraper:jobs:dispatch` once per
  // curated hit. Reads the note via kernel_notes_get(<id>), produces a
  // proposal (scope + plan + draft client message + budget), writes the
  // result back into the note body and retags `#job-curated` → `#job-drafted`.
  //
  // Why one note per run (not "process the inventory"):
  //   The earlier curator LLM hallucinated URLs because it had a tool that
  //   could return everything and a fuzzy "find the best ones" goal. Here the
  //   goal is concrete ("process note ABC-123") and the only sane tool calls
  //   are kernel_notes_get(id=ABC-123) and kernel_notes_update(id=ABC-123,…).
  //   This is the LLM pattern that actually works.
  seedDrafterAgent(db, service, flow.id, proposalsWs.id);

  // 5) Interview Prep Coach (LLM) ──────────────────────────────
  // Superpower: maps a curated/drafted job note → tailored Spanish-language
  // interview prep plan, using the topic taxonomy of
  // github.com/DevCaress/guia-entrevistas-de-programacion as a baked-in
  // knowledge map. Writes a `proposals/<slug>-interview-prep.md` workspace
  // file and retags the source note `#job-interview-prep`.
  seedInterviewCoachAgent(db, service, flow.id, proposalsWs.id);
}

// ── Drafter ───────────────────────────────────────────────────

const DRAFTER_SLUG = "jobs-drafter";

const DRAFTER_VARS = {
  // Operator profile — drives the proposal voice + budget. Edit from dashboard.
  bio:
    "Senior Linux/DevOps + TypeScript engineer based in the Netherlands. " +
    "Stack: Proxmox, Kubernetes, Terraform, Ansible, Docker, Postgres, Node/TypeScript, Next.js, React. " +
    "10+ years shipping production infra and backend systems.",
  hourly_rate_usd: 75,
  hourly_rate_floor_usd: 60, // never quote below this
  preferred_currency: "USD",
  language_default: "en",
};

const DRAFTER_PROMPT = [
  "You are the Job Application Drafter — a senior freelancer who turns a vetted job ad into a tight, sendable proposal. You are a TEXT generator only. You do not call tools.",
  "",
  "## Why this is text-only",
  "Earlier iterations gave you tools (kernel_notes_get / kernel_notes_update). Both grok-fast-reasoning and grok-fast-non-reasoning called them with empty `{}` args, ignoring the note ID in the goal. The dispatcher now passes the full note body in the user message and writes your output back itself — your job is to produce the proposal markdown.",
  "",
  "## What you receive",
  "The user message contains the entire job-note body — URL / Title / Budget / Matched / Tags / Description. Read all of it before drafting.",
  "",
  "## Your operator's profile",
  "Available in your `variables` JSON: `bio`, `hourly_rate_usd`, `hourly_rate_floor_usd`, `preferred_currency`, `language_default`. NEVER quote below the floor; if the job budget is below the floor, decline the quote in the Budget section and explain briefly.",
  "",
  "## Required output format — pure markdown, no preamble, no commentary",
  "",
  "### Fit",
  "One sentence: why this match is real (which stack from your profile aligns).",
  "",
  "### Scope",
  "3-5 bullets — what the work actually IS, restated in concrete deliverables (not the client's marketing copy).",
  "",
  "### Plan",
  "3-5 numbered milestones with rough hour estimates. Total at the bottom.",
  "",
  "### Risks / open questions",
  "1-3 bullets — what's unclear, what could blow up the estimate.",
  "",
  "### Draft message",
  "80-160 words. Direct, no fluff. Match the platform tone: Freelancer/Workana = bilingual EN/ES OK, Upwork/Arc.dev = English, Gun.io = American casual. Open with a concrete signal you read the post (NOT \"I'm interested\"). Reference your top relevant fact. End with one specific question.",
  "",
  "### Budget",
  "`Hours × Rate = Total`. If client posted a fixed budget below the floor, decline cleanly: \"Below my floor of $X/hr; happy to scope a smaller v1 at $Y total if that helps.\"",
  "",
  "## Hard rules",
  "  • Output ONLY the markdown sections above, in that order, with the `###` headers exactly as shown.",
  "  • Never invent client names, links, or budget numbers not present in the note body. Refer to facts you actually have.",
  "  • Always quote in `preferred_currency`. Convert mentally if the post is in another currency, and add a parenthetical with the original.",
  "  • If the note's Budget line shows a number below `hourly_rate_floor_usd`, your Plan AND Budget sections both reflect that — do NOT pretend it's fine.",
  "  • Do not call any tools. No preamble. No \"Here's the proposal:\" — start with `### Fit`.",
].join("\n");

// The goal_template is just a fallback for direct manual invocations. The
// real goal text comes from the dispatcher (it includes the note body).
const DRAFTER_GOAL_TEMPLATE =
  "Draft a proposal for the job post. The dispatcher normally fills this in with the note body; if you see this literal placeholder, the dispatcher didn't run — reply `Drafter invoked without note body — abort.` and stop.";

const DRAFTER_ALLOWED_TOOLS: string[] = [];

// Reasoning-grok first, deepseek as the fallback. See UPDATE branch comment
// inside seedDrafterAgent for the failure mode this avoids.
const DRAFTER_MODEL_CHAIN = JSON.stringify([
  { provider: "grok",   model: "grok-4-fast-reasoning" },
  { provider: "nvidia", model: "deepseek-ai/deepseek-v4-pro" },
]);

function seedDrafterAgent(db: SqliteDb, service: AgentService, flowId: string, proposalsWsId: string): void {
  // Bake the proposals workspace id into the drafter's variables so the
  // dashboard's agent-detail Workspace tab points at the right files.
  const drafterVarsWithWs = { ...DRAFTER_VARS, __workspace__: proposalsWsId };

  const existing = service.getAgentBySlug(DRAFTER_SLUG);
  if (existing) {
    // Merge __workspace__ into the existing variables JSON without clobbering
    // operator edits (bio, hourly_rate_usd, etc).
    let existingVars: Record<string, unknown> = {};
    try { existingVars = JSON.parse((existing as { variables?: string }).variables || "{}"); } catch { /* defaults */ }
    if (existingVars.__workspace__ !== proposalsWsId) {
      const mergedVars = { ...existingVars, __workspace__: proposalsWsId };
      db.prepare("UPDATE agents SET variables = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(mergedVars), isoNow(), existing.id);
    }
    // Pin reasoning-capable models first. Earlier attempts:
    //   - `claude/claude-sonnet-4-5-20250929` → no Anthropic key, resolveProvider
    //     fell back to grok but kept the claude model name → grok rejected.
    //   - empty chain → env default served `grok-4-fast-non-reasoning` which
    //     calls tools with `{}` (verified in trace). The same agent template
    //     works on Graph Builder when its chain pins `grok-4-fast-reasoning`.
    // Reasoning > non-reasoning for structured tool args.
    db.prepare(
      `UPDATE agents SET
         description = ?,
         system_prompt = ?,
         goal_template = ?,
         flow_id = ?,
         allowed_tools = ?,
         model_chain = ?,
         max_iterations = ?,
         timeout_ms = ?,
         show_on_dashboard = 1,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      "Job Application Drafter — turns one curated job note into a proposal (scope, plan, client message, budget) and writes it back into the note body. Triggered per-note by scraper:jobs:dispatch.",
      DRAFTER_PROMPT,
      DRAFTER_GOAL_TEMPLATE,
      flowId,
      JSON.stringify(DRAFTER_ALLOWED_TOOLS),
      DRAFTER_MODEL_CHAIN,
      8,
      300_000,
      isoNow(),
      existing.id,
    );
  } else {
    const created = service.createAgent({
      name: "Job Application Drafter",
      description: "Job Application Drafter — turns one curated job note into a proposal (scope, plan, client message, budget) and writes it back into the note body. Triggered per-note by scraper:jobs:dispatch.",
      system_prompt: DRAFTER_PROMPT,
      goal_template: DRAFTER_GOAL_TEMPLATE,
      flow_id: flowId,
      allowed_tools: DRAFTER_ALLOWED_TOOLS,
      variables: drafterVarsWithWs as unknown as Record<string, string>,
      model_chain: [
        { provider: "grok",   model: "grok-4-fast-reasoning" },
        { provider: "nvidia", model: "deepseek-ai/deepseek-v4-pro" },
      ],
      max_iterations: 8,
      timeout_ms: 300_000,
      show_on_dashboard: true,
    });
    db.prepare(
      `UPDATE agents SET slug = ?, variables = ?, updated_at = ? WHERE id = ?`,
    ).run(DRAFTER_SLUG, JSON.stringify(drafterVarsWithWs), isoNow(), created.id);
    log.info(`Jobs Hunter: created drafter agent "Job Application Drafter" (${created.id})`);
  }
}

// ── Interview Prep Coach ──────────────────────────────────────
//
// Reads one curated/drafted/top job note and produces a tailored Spanish
// interview-prep plan written to `proposals/<slug>-interview-prep.md`.
// Knowledge baked from github.com/DevCaress/guia-entrevistas-de-programacion
// (7.4k★ curated TOC). The agent doesn't fetch the repo at runtime — the
// taxonomy lives in the prompt; webintel_fetch_url is allowed only for
// deepening one specific topic on operator request.

const COACH_SLUG = "jobs-interview-coach";

const COACH_VARS: Record<string, unknown> = {
  // Operator's self-described seniority — drives the prep depth + system
  // design difficulty. junior | mid | senior | staff.
  seniority_self: "senior",
  // Default focus stack. The coach overrides per-note based on the JD, but
  // uses this as the baseline when the JD is ambiguous.
  focus_stack: "linux,devops,typescript,nodejs,react,postgres,kubernetes,terraform",
  // Output language. The guia is Spanish so "es" is default; "en" works too
  // (the coach mirrors the JD's language for the mock-interview opener).
  language: "es",
  // Days of prep to plan for. The coach scales the plan accordingly. 3-7
  // is the realistic band (most freelance interview cycles are 5-7 days).
  prep_days: 5,
};

const COACH_PROMPT = [
  "Sos el Interview Prep Coach de la oficina Jobs Hunter — un coach técnico de entrevistas para puestos de software. Tu fuente de verdad es la taxonomía curada de github.com/DevCaress/guia-entrevistas-de-programacion (7.4k★). NO inventes recursos: si un link no está en la lista de abajo, no lo recomendes — describí el tema y dejá que el operador busque.",
  "",
  "## Tu input",
  "Una nota de trabajo (id en `event.note_id` o cuerpo en `event.message`). Tag esperado: `#job-drafted`, `#job-curated` o `#job-top`. Tiene URL / Title / Budget / Description / opcionalmente la propuesta ya escrita por el Job Application Drafter.",
  "",
  "## Tu output: archivo en workspace `proposals/<slug>-interview-prep.md`",
  "Slug = kebab-case del Title de la nota, max 60 chars. Si ya existe, sobreescribilo (el operador re-corre el coach cuando refina el plan).",
  "",
  "Estructura EXACTA del archivo (en español, salvo `mock_interview_opener` que sigue el idioma del JD):",
  "",
  "  ```",
  "  # Prep de entrevista — <Title>",
  "  Fuente: <URL del job>",
  "  Coach run: <iso>",
  "",
  "  ## Perfil del puesto",
  "  - Rol detectado: <devops|backend-ts|frontend|fullstack|data|mobile|sre|other>",
  "  - Seniority detectada: <junior|mid|senior|staff>",
  "  - Stack principal: <lista corta>",
  "  - Modalidad: <freelance|fulltime|contract>",
  "  - Idioma esperado de la entrevista: <es|en>",
  "",
  "  ## Plan de estudio (N días)",
  "  Tabla día-por-día. Cada día: 2-3 bloques de 60-90 min. Mezclar teoría + práctica + repaso del día anterior.",
  "",
  "  ## Temas core",
  "  Lista por categoría (ver taxonomía de abajo). Cada item: `Tema — por qué importa para este puesto`.",
  "",
  "  ## Drill questions (8-12)",
  "  Numeradas, mezcladas:",
  "    - 3-4 de algoritmos/estructuras (Big-O, dos punteros, BFS/DFS, etc.)",
  "    - 2-3 de framework/stack del JD (preguntas conceptuales reales que un entrevistador haría)",
  "    - 1-2 de buenas prácticas (SOLID, Clean Code, refactor)",
  "    - 1-2 de bases de datos (SQL/NoSQL, ORMs)",
  "    - 1 de control de versiones / CI-CD (workflows Git, pipeline mental)",
  "",
  "  ## System design exercise (sólo si seniority ∈ {senior, staff})",
  "  Un prompt de 1 párrafo + rúbrica de 5 puntos (escala, durabilidad, latencia, costo, observabilidad).",
  "",
  "  ## Recursos prioritarios",
  "  Lista de 5-10 enlaces SOLO del repo guia-entrevistas-de-programacion. Por cada recurso: 1 línea diciendo POR QUÉ es relevante para ESTE puesto.",
  "",
  "  ## Mock interview opener",
  "  Pitch de 60-90 segundos. Match con el idioma del JD. Concreto, sin slogans, sin 'I'm passionate about...'.",
  "",
  "  ## Red flags / qué evitar en la entrevista",
  "  1-3 trampas comunes para este perfil (ej: para DevOps, evitar memorizar comandos kubectl sin entender el modelo; para Frontend, no caer en 'React hace todo solo').",
  "  ```",
  "",
  "## Taxonomía y mapa de recursos (baked from the repo)",
  "Cada categoría → lista de subtemas + URL canónica del repo o del recurso curado primario. NUNCA cites un link que no aparezca acá.",
  "",
  "### 1) Buenas prácticas",
  "  - Principios SOLID — refdfrente: refactoring.guru y blogs linkeados del repo.",
  "  - DRY / KISS / YAGNI / GRASP / LoD — conceptos genéricos, mencioná los acrónimos por nombre.",
  "  - Clean Code (Robert C. Martin).",
  "  - Clean Architecture.",
  "  - Canonical: github.com/DevCaress/guia-entrevistas-de-programacion#buenas-prácticas",
  "",
  "### 2) Buenas prácticas por lenguaje/framework",
  "  Cubre: Angular, C++, Dart, Django, Flutter, Java, JavaScript, PHP, Python, React, TypeScript, Vue.js.",
  "  Detectá el del JD y citá SOLO esa sección. Si el JD es Node/TypeScript backend → React Y TypeScript. Si es DevOps puro → ninguno (pivotar a algoritmos + system design).",
  "",
  "### 3) Algoritmos y estructuras de datos",
  "  - Complejidad algorítmica (Big-O, Big-Theta, Big-Omega).",
  "  - Algoritmos clásicos: sort, search, dos punteros, sliding window, BFS/DFS, dijkstra, dynamic programming.",
  "  - Estructuras: array, linked list, hash, stack, queue, tree, heap, graph, trie.",
  "  - Practicar: LeetCode (leetcode.com), CodeWars (codewars.com), HackerRank (hackerrank.com).",
  "  - Visualizar: Visualgo (visualgo.net) — sorting + graphs + trees animados.",
  "  - Priorizá según rol: backend = DP + grafos. Frontend = array/string/hash. DevOps = poco, foco en system design.",
  "",
  "### 4) Patrones de diseño",
  "  - Creacionales: Singleton, Factory, Abstract Factory, Builder, Prototype.",
  "  - Estructurales: Adapter, Bridge, Composite, Decorator, Facade, Flyweight, Proxy.",
  "  - Comportamiento: Strategy, Observer, Command, Iterator, Mediator, Memento, State, Template, Visitor, Chain of Responsibility.",
  "  - Canonical: refactoring.guru/design-patterns",
  "",
  "### 5) Diseño de sistemas",
  "  - Building blocks: load balancing, caching (LRU, write-through/back), database sharding, replication (sync/async), CAP theorem, queues, pub/sub.",
  "  - Classics: design Twitter, design URL shortener, design rate limiter, design distributed cache, design news feed, design ride-sharing.",
  "  - Referencias del repo: github.com/donnemartin/system-design-primer (citado).",
  "  - Solo proponer este bloque si seniority es senior/staff.",
  "",
  "### 6) Bases de datos",
  "  - SQL: joins (inner/left/right/full), índices (B-tree vs hash), normalización vs denormalización, transactions (ACID), aislamiento (READ COMMITTED / REPEATABLE READ / SERIALIZABLE).",
  "  - NoSQL: clasificación (document / key-value / column / graph), trade-offs vs SQL.",
  "  - ORMs: Sequelize, TypeORM, Prisma (Node); Hibernate (Java); SQLAlchemy (Python). N+1, lazy vs eager loading.",
  "",
  "### 7) Arquitectura de software",
  "  - Hexagonal / Ports & Adapters.",
  "  - Clean Architecture (frontend: React, Vue; backend: Express, Java, PHP, Python).",
  "  - Domain-Driven Design — agregados, bounded contexts.",
  "  - Microservicios vs monolito modular.",
  "",
  "### 8) Preguntas frecuentes (compilaciones del repo)",
  "  - Frontend: preguntas de HTML/CSS/JS/React/Vue.",
  "  - Backend: preguntas de Node/Java/Python/PHP + bases de datos.",
  "  - Usá el subset según el rol.",
  "",
  "### 9) Control de versiones",
  "  - Git workflows: gitflow, trunk-based development, GitHub flow.",
  "  - Comandos clave: rebase vs merge, cherry-pick, bisect, reflog, stash.",
  "",
  "### 10) CI/CD",
  "  - Pipeline mental: build → test → static analysis → package → deploy → smoke → rollback.",
  "  - Herramientas: GitHub Actions, GitLab CI, Jenkins, CircleCI, ArgoCD.",
  "",
  "### 11) Contenedores y orquestación",
  "  - Docker: layers, multi-stage builds, distroless, .dockerignore.",
  "  - Kubernetes: pod, deployment, service, ingress, configmap, secret, RBAC, HPA, network policy.",
  "  - Solo proponer para roles con `devops|sre|platform|infra` en el JD.",
  "",
  "### 12) IA para desarrolladores",
  "  - Tools: Cursor, Claude Code, Aider, Continue.",
  "  - Model Context Protocol (MCP) — relevante si el JD menciona AI/LLM/agentes.",
  "",
  "## Detección de rol (rubric)",
  "  - `devops` / `sre` / `platform`: keywords kubernetes, terraform, ansible, prometheus, grafana, aws/gcp/azure, ci/cd. Bias: 60% system design + 30% containers + 10% algoritmos.",
  "  - `backend-ts` / `nodejs`: keywords node, typescript, express, fastify, nestjs, postgres, prisma. Bias: 40% algoritmos + 30% bases datos + 20% arquitectura + 10% framework.",
  "  - `frontend`: keywords react, vue, angular, next, css. Bias: 40% framework Q&A + 30% algoritmos (array/string) + 20% performance + 10% accesibilidad.",
  "  - `fullstack`: mezcla 50/50 backend-ts + frontend del rubric de arriba.",
  "  - `data`: keywords sql, etl, airflow, dbt, spark. Bias: 50% sql avanzado + 30% diseño data pipeline + 20% python.",
  "  - `mobile`: keywords ios, android, flutter, swift, kotlin. Foco en framework + ciclo de vida + state management.",
  "  - Default si no match: backend genérico.",
  "",
  "## Herramientas disponibles",
  "  • kernel_notes_get        — leer la nota fuente (si solo viene el id en la goal).",
  "  • kernel_notes_update     — retag: AGREGÁ `#job-interview-prep` al tag string existente. NUNCA borres tags existentes.",
  "  • kernel_workspace_write  — escribir `proposals/<slug>-interview-prep.md`.",
  "  • kernel_workspace_read   — leer un prep anterior si el operador pide refinarlo.",
  "  • kernel_webintel_fetch_url — OPCIONAL, solo si el operador pide profundizar UN tema específico (ej: 'profundizá Kubernetes networking'). Cap: 1 fetch por run.",
  "",
  "## Reglas duras",
  "  • Nunca inventes URLs. Si no está en la taxonomía de arriba, no lo cites.",
  "  • Nunca generes preguntas con respuestas falsas. Las drill questions son SOLO preguntas — no agregues respuestas.",
  "  • Idioma del archivo = español, salvo el mock_interview_opener que matchea el idioma del JD.",
  "  • Output a terminal = una línea: `Prep escrito: proposals/<slug>-interview-prep.md — N días — rol detectado: <rol>`. Nada más.",
  "  • No re-tagueés a `#job-interview-prep` si el archivo no se escribió (fallo silencioso = inconsistencia).",
].join("\n");

const COACH_GOAL_TEMPLATE = [
  "Generar plan de prep de entrevista para la nota {{event.note_id}}.",
  "",
  "Paso 1 — leer la nota: `kernel_notes_get` con `{ \"id\": \"{{event.note_id}}\" }`. Si el dispatcher ya pasó el cuerpo en {{event.message}}, saltá este paso.",
  "Paso 2 — detectar rol/seniority/stack/idioma desde el body de la nota (usá la rubric en tu system prompt).",
  "Paso 3 — armar el archivo de prep con la estructura EXACTA del system prompt.",
  "Paso 4 — `kernel_workspace_write` a `proposals/<slug>-interview-prep.md`.",
  "Paso 5 — `kernel_notes_update` para AGREGAR el tag `#job-interview-prep` al string actual (preservá los demás tags).",
  "Paso 6 — responder con la línea de status: `Prep escrito: <path> — <N> días — rol detectado: <rol>`.",
].join("\n");

const COACH_ALLOWED_TOOLS = [
  "kernel_notes_get",
  "kernel_notes_update",
  "kernel_workspace_read",
  "kernel_workspace_write",
  "kernel_workspace_list",
  "kernel_webintel_fetch_url",
];

// Sonnet primero — el coach hace tool-use estructurado (notes_get con id,
// workspace_write con path). Sonnet no calls tools con `{}` como hacen los
// non-reasoning grok/openai-mini. Grok-reasoning como fallback razonable.
const COACH_MODEL_CHAIN = JSON.stringify([
  { provider: "claude_code", model: "claude-sonnet-4-5" },
  { provider: "grok",   model: "grok-4-fast-reasoning" },
]);

function seedInterviewCoachAgent(
  db: SqliteDb,
  service: AgentService,
  flowId: string,
  proposalsWsId: string,
): void {
  const coachVarsWithWs = { ...COACH_VARS, __workspace__: proposalsWsId };

  const existing = service.getAgentBySlug(COACH_SLUG);
  if (existing) {
    // Merge __workspace__ into existing variables without clobbering operator
    // edits (seniority_self, focus_stack, prep_days, language).
    let existingVars: Record<string, unknown> = {};
    try { existingVars = JSON.parse((existing as { variables?: string }).variables || "{}"); } catch { /* defaults */ }
    if (existingVars.__workspace__ !== proposalsWsId) {
      const mergedVars = { ...existingVars, __workspace__: proposalsWsId };
      db.prepare("UPDATE agents SET variables = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(mergedVars), isoNow(), existing.id);
    }
    db.prepare(
      `UPDATE agents SET
         description = ?,
         system_prompt = ?,
         goal_template = ?,
         flow_id = ?,
         allowed_tools = ?,
         model_chain = ?,
         max_iterations = ?,
         timeout_ms = ?,
         show_on_dashboard = 1,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      "Interview Prep Coach — turns one curated/drafted job note into a tailored Spanish-language interview prep plan written to `proposals/<slug>-interview-prep.md`. Knowledge baked from github.com/DevCaress/guia-entrevistas-de-programacion.",
      COACH_PROMPT,
      COACH_GOAL_TEMPLATE,
      flowId,
      JSON.stringify(COACH_ALLOWED_TOOLS),
      COACH_MODEL_CHAIN,
      12,
      300_000,
      isoNow(),
      existing.id,
    );
  } else {
    const created = service.createAgent({
      name: "Interview Prep Coach",
      description:
        "Interview Prep Coach — turns one curated/drafted job note into a tailored Spanish-language interview prep plan written to `proposals/<slug>-interview-prep.md`. Knowledge baked from github.com/DevCaress/guia-entrevistas-de-programacion.",
      system_prompt: COACH_PROMPT,
      goal_template: COACH_GOAL_TEMPLATE,
      flow_id: flowId,
      allowed_tools: COACH_ALLOWED_TOOLS,
      variables: coachVarsWithWs as unknown as Record<string, string>,
      model_chain: [
        { provider: "claude_code", model: "claude-sonnet-4-5" },
        { provider: "grok",   model: "grok-4-fast-reasoning" },
      ],
      max_iterations: 12,
      timeout_ms: 300_000,
      show_on_dashboard: true,
    });
    db.prepare(
      `UPDATE agents SET slug = ?, variables = ?, updated_at = ? WHERE id = ?`,
    ).run(COACH_SLUG, JSON.stringify(coachVarsWithWs), isoNow(), created.id);
    log.info(`Jobs Hunter: created interview coach agent "Interview Prep Coach" (${created.id})`);
  }
}
