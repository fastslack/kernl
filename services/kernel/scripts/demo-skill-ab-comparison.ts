/**
 * A/B comparison: agent response WITHOUT a skill vs WITH a skill attached.
 *
 * The hypothesis being tested: a procedural skill (Anthropic-style SKILL.md)
 * attached to an agent measurably changes its behaviour on prompts that match
 * the skill's trigger pattern.
 *
 * What this script does:
 *   1. Pings the running kernel via HTTP (uses KERNEL_AUTH_TOKEN).
 *   2. Creates an isolated test agent (or reuses one matching slug).
 *   3. Sets agent.skills_json = []  → runs `goal` → captures response + steps.
 *   4. Sets agent.skills_json = ["ab-testing"]  → runs same goal → captures.
 *   5. Writes a markdown comparison report at:
 *        experiments/skill-ab-comparison-<ISO>.md
 *      with both responses, the tool calls each made, token usage,
 *      side-by-side diff hints.
 *
 * Run:  bun scripts/demo-skill-ab-comparison.ts
 *
 * Requires: kernel running on http://localhost:3087, the marketingskills
 * repo subscribed (so `ab-testing` is installed), and KERNEL_AUTH_TOKEN env
 * (or it falls back to the value in .env).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const BASE = process.env.KERNEL_BASE ?? "http://localhost:3087";
const TOKEN = (() => {
  if (process.env.KERNEL_AUTH_TOKEN) return process.env.KERNEL_AUTH_TOKEN;
  // Fall back to the .env file in repo root.
  try {
    const env = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    const m = env.match(/^KERNEL_AUTH_TOKEN=([^\n]+)/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
})();
const SKILL_SLUG = "ab-testing";
const TEST_GOAL = `I'm launching the redesigned pricing page for our SaaS product on Friday.
The hypothesis I want to test: a benefit-focused headline ("Stop chasing leads
— close them") will convert more visitors to free-trial than the current
feature-focused one ("All-in-one CRM with email + calendar"). Help me set up
this A/B test properly: traffic split, sample size, primary + guardrail
metrics, what to do if results are inconclusive, and how long to run it.`;

if (!TOKEN) {
  console.error("KERNEL_AUTH_TOKEN not set in env or .env");
  process.exit(1);
}

interface RunStep {
  step_index?: number;
  type?: string;
  tool_name?: string;
  tool_input?: string;
  content?: string;
  text?: string;
}
interface Run {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Final LLM message for the run (the "answer"). Stored as TEXT in agent_runs.result. */
  result?: string;
  error?: string;
  steps_count?: number;
  tokens_used?: number;
  started_at?: string;
  completed_at?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${method} ${path} → HTTP ${r.status} ${text.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

function bar(t: string): void {
  console.log("\n" + "─".repeat(72));
  console.log("  " + t);
  console.log("─".repeat(72));
}

async function findOrCreateAgent(): Promise<{ id: string; name: string }> {
  const SLUG = "test-skill-ab-comparison";
  const NAME = "Skill A/B Test Agent";

  const list = await api<{ agents: Array<{ id: string; name: string; slug?: string }> }>(
    "GET", "/api/agents",
  );
  const existing = list.agents.find((a) => a.slug === SLUG || a.name === NAME);
  if (existing) {
    console.log(`  reusing existing agent: ${existing.id.slice(0, 8)}…`);
    return { id: existing.id, name: existing.name };
  }
  const created = await api<{ agent: { id: string; name: string } }>("POST", "/api/agents", {
    name: NAME,
    description: "Throwaway agent for skill-impact A/B comparison",
    system_prompt: "You are a meticulous growth-experiments expert. Give concrete, actionable plans — not generic advice. Cite specific numbers, formulas and decision rules.",
    goal_template: "{{goal}}",
    provider: "claude",
    model: "claude-sonnet-4-6",
    max_iterations: 6,
    timeout_ms: 180000,
    show_on_dashboard: false,
  });
  console.log(`  created fresh agent: ${created.agent.id.slice(0, 8)}…`);
  return created.agent;
}

async function setSkills(agentId: string, skills: string[]): Promise<void> {
  await api("PUT", `/api/agents/${agentId}`, { skills });
}

async function runAndWait(agentId: string, goal: string, label: string): Promise<{ run: Run; steps: RunStep[] }> {
  const t0 = Date.now();
  const start = await api<{ success: boolean; run_id: string; status: string }>(
    "POST", "/api/agents/run", { agent_id: agentId, goal },
  );
  const runId = start.run_id;
  console.log(`    → ${label} run ${runId.slice(0, 8)}… started`);

  // Poll until done.
  for (let i = 0; i < 120; i++) {  // up to 4 min
    await new Promise((r) => setTimeout(r, 2000));
    const detail = await api<{ run: Run; steps: RunStep[] }>(
      "GET", `/api/agents/runs/${runId}`,
    );
    if (detail.run.status === "completed" || detail.run.status === "failed" || detail.run.status === "cancelled") {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`    → ${label} ${detail.run.status} in ${elapsed}s, ${detail.run.steps_count ?? "?"} steps, ${detail.run.tokens_used ?? "?"} tok`);
      return detail;
    }
    if (i % 5 === 0) process.stdout.write(".");
  }
  throw new Error(`Run ${runId} never finished`);
}

function summariseSteps(steps: RunStep[], run: Run): { toolCalls: string[]; assistantText: string } {
  const toolCalls: string[] = [];
  for (const s of steps) {
    if (s.type === "tool_call" && s.tool_name) {
      let argSummary = "";
      try {
        const parsed = JSON.parse(s.tool_input ?? "{}");
        argSummary = JSON.stringify(parsed).slice(0, 80);
      } catch { argSummary = (s.tool_input ?? "").slice(0, 80); }
      toolCalls.push(`${s.tool_name}(${argSummary})`);
    }
  }
  // The final assistant message lives in run.result (executor stores the
  // last LLM output there). Steps with type='final' carry the same text.
  const assistantText = run.result ?? "";
  return { toolCalls, assistantText };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  bar("0. preflight");
  // Check the skill is installed.
  try {
    const skills = await api<{ items: Array<{ slug: string; manifest?: { description?: string } }> }>(
      "GET", `/api/extensions?type=skill&status=active`,
    );
    if (!skills.items.find((s) => s.slug === SKILL_SLUG)) {
      console.error(`  ! skill "${SKILL_SLUG}" not installed.`);
      console.error("    Add the marketingskills repo first via /extensions or:");
      console.error('    curl -X POST .../api/marketplace/repos -d \'{"url":"https://github.com/coreyhaines31/marketingskills"}\'');
      process.exit(1);
    }
    console.log(`  ✓ skill "${SKILL_SLUG}" installed`);
  } catch (err) {
    console.error(`  ! kernel preflight failed: ${err}`);
    process.exit(1);
  }

  const reuse = process.argv.includes("--reuse");

  bar("1. find or create test agent");
  const agent = await findOrCreateAgent();

  let A: { run: Run; steps: RunStep[] };
  let B: { run: Run; steps: RunStep[] };

  if (reuse) {
    bar("2. --reuse mode: pull the latest 2 completed runs");
    const list = await api<{ runs: Array<{ id: string; status: string }> }>(
      "GET", `/api/agents/${agent.id}/runs`,
    );
    const completed = list.runs.filter((r) => r.status === "completed").slice(0, 2);
    if (completed.length < 2) {
      throw new Error(`Need at least 2 completed runs to reuse, found ${completed.length}`);
    }
    // Latest is B (with-skill, by run order), prior is A (no-skill).
    const fetchRun = async (id: string) =>
      api<{ run: Run; steps: RunStep[] }>("GET", `/api/agents/runs/${id}`);
    B = await fetchRun(completed[0].id);
    A = await fetchRun(completed[1].id);
    console.log(`    A run: ${A.run.id.slice(0, 8)}  steps=${A.run.steps_count}  tok=${A.run.tokens_used}`);
    console.log(`    B run: ${B.run.id.slice(0, 8)}  steps=${B.run.steps_count}  tok=${B.run.tokens_used}`);
  } else {
    bar("2. baseline — no skills attached");
    await setSkills(agent.id, []);
    A = await runAndWait(agent.id, TEST_GOAL, "no-skill");

    bar("3. with skill — ab-testing attached");
    await setSkills(agent.id, [SKILL_SLUG]);
    B = await runAndWait(agent.id, TEST_GOAL, "with-skill");
  }

  bar("4. write comparison report");
  const sumA = summariseSteps(A.steps, A.run);
  const sumB = summariseSteps(B.steps, B.run);
  const usedSkillLoad = sumB.toolCalls.some((c) => c.startsWith("kernel_skill_load"));

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = resolve(process.cwd(), `experiments/skill-ab-comparison-${ts}.md`);
  mkdirSync(dirname(outPath), { recursive: true });

  const md = `# Skill impact A/B comparison — ${ts}

**Agent**: ${agent.name} (\`${agent.id}\`)
**Skill under test**: \`${SKILL_SLUG}\`
**Goal**:

> ${TEST_GOAL.split("\n").join("\n> ")}

---

## Verdict at a glance

| metric                        | A — no skill | B — with skill |
|-------------------------------|--------------|----------------|
| status                        | ${A.run.status} | ${B.run.status} |
| steps                         | ${A.run.steps_count ?? "?"} | ${B.run.steps_count ?? "?"} |
| tokens used                   | ${A.run.tokens_used ?? "?"} | ${B.run.tokens_used ?? "?"} |
| tool calls                    | ${sumA.toolCalls.length} | ${sumB.toolCalls.length} |
| called \`kernel_skill_load\`?   | n/a (not attached) | **${usedSkillLoad ? "yes ✓" : "no ✗"}** |
| response chars                | ${sumA.assistantText.length} | ${sumB.assistantText.length} |

${usedSkillLoad
  ? `> ✅ **The model loaded the skill on demand**. Compare both responses below.`
  : `> ⚠️ **The model did NOT call \`kernel_skill_load\`**. Either the goal didn't trigger
> the description heuristic, or the model chose to answer from base knowledge.
> Tweak the goal to match the skill's trigger pattern more clearly.`}

---

## A — without skill (raw response)

**Tool calls** (${sumA.toolCalls.length}):
${sumA.toolCalls.length === 0 ? "_(none — the model answered from training)_" : sumA.toolCalls.map((c) => `- \`${c}\``).join("\n")}

**Final response**:

${sumA.assistantText || "_(empty)_"}

---

## B — with \`${SKILL_SLUG}\` skill attached

**Tool calls** (${sumB.toolCalls.length}):
${sumB.toolCalls.length === 0 ? "_(none)_" : sumB.toolCalls.map((c) => `- \`${c}\``).join("\n")}

**Final response**:

${sumB.assistantText || "_(empty)_"}

---

## Reading the report

- If B called \`kernel_skill_load(${SKILL_SLUG})\` and its response references concepts from
  the skill body (e.g. specific sample-size formulas, ICE scoring, Bayesian decision rules),
  the wiring is working as intended.
- If both responses look ~identical, either the goal is generic enough that base knowledge
  suffices, or the skill body added no useful guardrails.
- If B is *worse* than A, the skill may be over-prescribing or its body might conflict with
  the agent's system_prompt — investigate by reading the loaded skill body
  (kernel_skill_load output appears as a step of type \`tool_result\` in the run details).

Generated by \`scripts/demo-skill-ab-comparison.ts\`
`;

  writeFileSync(outPath, md);
  console.log(`\n  ✓ report written: ${outPath}`);
  console.log(`    open with:  less ${outPath}`);

  if (usedSkillLoad) {
    console.log(`\n✓ Skill activation confirmed — the agent loaded ${SKILL_SLUG} on demand.`);
  } else {
    console.log(`\n⚠️ Agent did not auto-load the skill. Compare the two responses to decide
   whether the trigger pattern needs tuning.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
