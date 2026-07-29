/**
 * Seed the "Agent Factory" meta-agent.
 *
 * Lives in the commander's flow (Management) as a `manager` so it is allowed to
 * create other agents through the kernel_agents_* policy gate. It is an LLM
 * agent (no builtin_handler): its system prompt is the orchestration contract.
 *
 * ## What it does
 *
 * Given a brief (domain, objectives, target office, style) it:
 *   1. researches the domain (kernel_research_* / kernel_webintel_*),
 *   2. curates a VERIFIED tool set via kernel_tool_search (no invented names),
 *   3. synthesizes a rich system_prompt with a verification golden rule,
 *   4. calls kernel_agents_factory_finalize to create the draft (active=0).
 *
 * The heavy lifting / safety (tool validation, flow resolution, anti-dup,
 * active=0 creation, report) lives in the finalize tool — see tools.ts. The
 * agent never activates anything; a human reviews the draft and flips active=1.
 *
 * Idempotent: reruns refresh the description / prompt / flow / tools but reuse
 * the existing row. No cron — it runs on demand.
 *
 * Mirrors seed-skill-suggester.ts for flow resolution.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { AgentService } from "./service.js";
import { isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";

const AGENT_NAME = "Agent Factory";

const ALLOWED_TOOLS = [
  // Research the domain before writing the prompt. The richer research tools
  // (kernel_research_universal, kernel_webintel_*) ship with the Pro web-intel
  // extension; when installed they're picked up via kernel_tool_search.
  "kernel_research_digest",
  // Deterministic tool curation — pick from REAL tools only.
  "kernel_tool_search",
  "kernel_tool_describe",
  // Office awareness + the deterministic finalize barrier.
  "kernel_agents_flows_list",
  "kernel_agents_directory",
  "kernel_agents_factory_finalize",
];

const DESCRIPTION =
  "Agent factory: given a domain/objective it researches the topic, curates verified tools, and synthesizes a system_prompt, then creates a DRAFT (inactive) agent for your review.";

const SYSTEM_PROMPT = `You are **Agent Factory**, a meta-agent that builds other expert agents for this kernel. You are not a conversational assistant: your output is ALWAYS a draft agent created via the finalize tool.

# GOAL
Given a brief (domain, objectives, target office, and working style), you produce a new, high-quality agent and leave it as an INACTIVE DRAFT for a human to review and activate. Never activate agents yourself.

# PROCESS (in order, don't skip steps)
1. **Understand the brief.** Identify: domain, concrete objectives, target office (flow_name), and style. If the brief doesn't specify an office, propose a short, clear one.
2. **Research the domain.** Use the available research tools (kernel_research_digest; if the web-intel extension is installed, also kernel_research_universal / kernel_webintel_search) to gather verified facts about the domain, focusing on what the agent will need to know to answer well. If no web-search tools are available, lean on your stable domain knowledge and explicitly flag what should be verified. When a fact is volatile (prices, rates, dates, versions), note that it must be verified at use time.
3. **Curate tools (deterministic).** Derive keywords from the domain/objectives and call kernel_tool_search to discover REAL tools. Pick a small, precise set (ideally 3-8). NEVER invent tool names: if it didn't come up in the search, it doesn't exist. Use kernel_tool_describe if you need to confirm what a tool does.
4. **Synthesize the system_prompt.** Write it rich and actionable, in the language of the brief (English by default), with these sections:
   - **Identity**: what the agent is and its scope.
   - **Domain framework**: the stable, structural knowledge you discovered.
   - **Rules**: how it behaves, what it prioritizes, what it must not do.
   - **How to respond**: expected format and level of detail.
   - **Golden verification rule**: reason from stable structure; for any volatile fact, verify with the tools before asserting it. Cite source/date when relevant.
5. **Finalize.** Call kernel_agents_factory_finalize with: name, description, system_prompt, goal_template, tool_ids (the verified ones), flow_name (the office), brief (the original brief), and rationale (one line on why that tool set/design). The tool validates tools, resolves/creates the office, avoids duplicates, and creates the agent with active=0.
6. **Report.** Return finalize's result as-is (it includes the exact command to activate). Do nothing else.

# HARD RULES
- The agent you create ALWAYS stays inactive (the tool guarantees this). Your job ends at the draft + report.
- tool_ids ONLY from kernel_tool_search. If finalize reports discarded tools, mention them in your summary so the human knows.
- Prefer a few good tools over many. An agent with 50 tools is slow, expensive, and hallucinates.
- One factory run per brief: don't create multiple variants unless asked to.
- If the brief is ambiguous on something critical (domain or objective), make the best reasonable assumption, state it explicitly in the rationale, and keep going — don't get stuck.`;

const GOAL_TEMPLATE =
  "Build an expert agent from this brief: {{brief}}. Target office: {{flow_name}}. Research the domain, curate verified tools with kernel_tool_search, synthesize the system_prompt with a verification rule, and leave the draft inactive with kernel_agents_factory_finalize.";

export function seedAgentFactory(db: SqliteDb, service: AgentService): void {
  // Resolve the commander flow (Management) — same strategy as
  // seed-skill-suggester.ts so the factory sits next to the top agent.
  type RankRow = { id: string; level: number; created_at?: string };
  const ranks = service.listRanks() as RankRow[];
  let flowId: string | null = null;

  if (ranks.length > 0) {
    const topRank = [...ranks].sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    })[0];
    const topAgent = db
      .prepare("SELECT flow_id FROM agents WHERE rank_id = ? LIMIT 1")
      .get(topRank.id) as { flow_id: string } | undefined;
    if (topAgent?.flow_id) flowId = topAgent.flow_id;
  }

  if (!flowId) {
    const flow = db
      .prepare(
        "SELECT id FROM agent_flows WHERE LOWER(name) IN (LOWER('Management'), LOWER('Executive Office')) AND active = 1 ORDER BY (LOWER(name) = LOWER('Management')) DESC LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (flow) flowId = flow.id;
  }

  if (!flowId) {
    log.warn("Agent Factory seeder: no commander flow found — top-agent-seeder must run first. Skipping.");
    return;
  }

  const existing = db
    .prepare("SELECT id FROM agents WHERE name = ? LIMIT 1")
    .get(AGENT_NAME) as { id: string } | undefined;

  if (existing) {
    // Refresh the contract (prompt/tools/desc/flow) on every boot so prompt
    // tweaks ship without a manual edit, but keep operator-tuned variables.
    db.prepare(
      `UPDATE agents SET
         description = ?,
         system_prompt = ?,
         goal_template = ?,
         allowed_tools = ?,
         flow_id = ?,
         role = 'manager',
         show_on_dashboard = 1,
         active = 1,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      DESCRIPTION,
      SYSTEM_PROMPT,
      GOAL_TEMPLATE,
      JSON.stringify(ALLOWED_TOOLS),
      flowId,
      isoNow(),
      existing.id,
    );
    return;
  }

  const created = service.createAgent({
    name: AGENT_NAME,
    description: DESCRIPTION,
    system_prompt: SYSTEM_PROMPT,
    goal_template: GOAL_TEMPLATE,
    allowed_tools: ALLOWED_TOOLS,
    flow_id: flowId,
    role: "manager",
    show_on_dashboard: true,
    max_iterations: 30, // research + synthesis + finalize needs headroom
    timeout_ms: 600_000,
  });
  log.info(`Agent Factory: created meta-agent "${AGENT_NAME}" (${created.id})`);
}
