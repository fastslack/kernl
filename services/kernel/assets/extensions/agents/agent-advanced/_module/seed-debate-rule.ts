/**
 * Debate Rule seeder — teaches every capable agent to resolve doubts by
 * asking the SOURCE first, not by escalating to the Manager.
 *
 * The chain pattern (Architect → Developer → Estimator) is a one-way
 * hand-off. When a downstream agent has a real question about the upstream
 * agent's output, the default behaviour has been to abort and post to the
 * Manager's inbox — which turns every tiny ambiguity into a three-office
 * re-dispatch and starves the upstream agent of feedback.
 *
 * This seeder injects a shared DEBATE block into the system prompts of any
 * agent that already holds the tools required to act on it
 * (`kernel_agents_post_to_colleague` for same-flow messages or
 * `kernel_agents_invoke` for cross-flow calls). The block is wrapped in
 * explicit start/end markers so future runs replace-in-place instead of
 * appending duplicates.
 *
 * Idempotent: skips agents already on the current version of the block.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { log } from "../../../../../src/core/logger.js";
import { isoNow } from "../../../../../src/core/helpers.js";

export const DEBATE_RULE_START = "<!-- debate-rule:start -->";
export const DEBATE_RULE_END = "<!-- debate-rule:end -->";

function debateRuleBody(): string {
  return [
    "## Resolving doubts — ask the source FIRST",
    "",
    "When another agent's output is empty, unclear, contradicts your",
    "acceptance criteria, or references something you can't find, your",
    "**default response is NOT to post to the Manager**. Your default is to",
    "go straight back to the agent that produced the doubt and get them to",
    "clarify. Escalation over their head is a last resort, not step 1.",
    "",
    "### Three-step protocol",
    "",
    "1. **Identify the source.** The chained goal usually begins with",
    "   `Chained from agent \"<Name>\". Previous result: …`. That Name is",
    "   your counterparty. If the suspect artefact is a note, look at the",
    "   note's author field. If the artefact is a workspace analysis, the",
    "   author is in the `meta.author` line. In doubt, call",
    "   `kernel_agents_directory` once to map the name to an `agent_id`.",
    "",
    "2. **Open the clarification — one pointed question, not an interview.**",
    "   - Same office (you share a `flow_id` with the source): call",
    "     `kernel_agents_post_to_colleague({ to_agent_name: \"<source>\",",
    "     subject: \"Clarification — <one-line>\", body: \"<what you read,",
    "     what is ambiguous or missing, what you need to proceed>\" })` and",
    "     stop. The source picks it up on their next run and replies via",
    "     their own inbox. Your next scheduled run resumes with the answer.",
    "   - Different office: call",
    "     `kernel_agents_invoke({ agent_id: \"<source uuid>\", goal:",
    "     \"<pointed question with quoted fragment + what you need>\" })`.",
    "     One shot, wait for the return, then act on it.",
    "   - Three or more parties appear to contradict each other: call",
    "     `kernel_agents_call_meeting` with 2–3 peers. Two rounds max.",
    "",
    "3. **Only escalate to the Manager AFTER step 2 has failed.** If the",
    "   source bounced you back without a resolution, or if you already",
    "   asked this same question to this same source in the last hour",
    "   (check `kernel_agents_inbox` and your own run history), THEN post",
    "   to the Manager with the full paper trail: your question, the",
    "   source's reply, why it didn't resolve.",
    "",
    "### When DEBATE does not apply",
    "  - The input is syntactically valid and unambiguous but you disagree",
    "    with a design choice — that's the source's call, don't re-open it.",
    "  - You're blocked by something unrelated to another agent (env var",
    "    missing, service down, …). That goes to the Manager directly.",
    "  - You're the SOURCE of the doubt (someone pinged YOU). Answer — don't",
    "    bounce the question to the original asker's upstream.",
    "",
    "### Why this matters",
    "One round of peer clarification beats a three-office re-dispatch in",
    "every measurable way: fewer tokens, faster turnaround, and the",
    "upstream agent actually learns where their output was unclear. If the",
    "Developer silently escalates every time the Architect ships something",
    "imperfect, the Manager becomes a bottleneck and the Architect never",
    "improves.",
  ].join("\n");
}

export function seedDebateRule(db: SqliteDb): void {
  const block = `${DEBATE_RULE_START}\n${debateRuleBody()}\n${DEBATE_RULE_END}`;

  // Match any agent that has the wiring to actually follow the rule.
  // The tools are stored as JSON arrays in `allowed_tools`, so we match on
  // the tool name as a substring — good enough because the tool ids are
  // globally unique and never appear as substrings of other tools.
  const rows = db
    .prepare(
      `SELECT id, name, system_prompt, allowed_tools FROM agents
         WHERE active = 1
           AND ( allowed_tools LIKE '%kernel_agents_post_to_colleague%'
              OR allowed_tools LIKE '%kernel_agents_invoke%'
              OR allowed_tools LIKE '%kernel_agents_call_meeting%' )`,
    )
    .all() as Array<{ id: string; name: string; system_prompt: string; allowed_tools: string }>;

  const startRe = new RegExp(
    `${escapeRegExp(DEBATE_RULE_START)}[\\s\\S]*?${escapeRegExp(DEBATE_RULE_END)}`,
  );
  const now = isoNow();
  let patched = 0;
  for (const row of rows) {
    const prompt = row.system_prompt ?? "";
    let next: string;
    if (startRe.test(prompt)) {
      next = prompt.replace(startRe, block);
      if (next === prompt) continue; // already up-to-date
    } else {
      next = prompt.replace(/\s+$/, "") + `\n\n${block}\n`;
    }
    db.prepare("UPDATE agents SET system_prompt = ?, updated_at = ? WHERE id = ?")
      .run(next, now, row.id);
    patched++;
  }
  if (patched > 0) {
    log.info(`Debate rule: injected into ${patched} agent(s) that hold peer-messaging tools`);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
