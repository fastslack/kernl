import { describe, expect, test, afterEach } from "bun:test";
import { AgentScheduler } from "../src/modules/agents/scheduler.js";
import { clearClaudeLimits, rememberClaudeLimit } from "../src/sdk/claude-limits.js";

// A scheduled run the Claude usage limit cut was lost: the slot had already
// advanced, so the work waited for the next slot (a day, for a daily schedule).

const LIMIT_ERROR = "claude_code: 429 usage limit reached on claude-sonnet-5-5 (five_hour, resets 2026-11-06T04:40:00.000Z) — quota exhausted";

function harness(agentModel: string, result: { status: string; error: string }) {
  const started: string[] = [];
  const nextRuns: Array<{ id: string; next: string }> = [];
  const service = {
    getDueSchedules: () => [{ id: "s1", agent_id: "a1", agent_name: "a1", interval_ms: 86_400_000, cron_expression: "", goal_override: "go", project_id: null }],
    getAgent: (id: string) => ({ id, name: id, active: 1, builtin_handler: "", goal_template: "", flow_id: "", executor_type: "claude_code", model: agentModel }),
    isAgentOfficePaused: () => false,
    getProjectGate: () => null,
    checkScheduledSlot: () => null,
    updateScheduleNextRun: (id: string, next: string) => { nextRuns.push({ id, next }); },
    createRun: (r: { agent_id: string }) => ({ id: `run-${started.length}`, ...r }),
    updateRun: () => {},
    recordRunOutcome: () => {},
  };
  const executor = {
    execute: async ({ agent }: { agent: { id: string } }) => {
      started.push(agent.id);
      return { ...result, result: "", steps_count: 40, tokens_used: 0 };
    },
  };
  const events = { emit: () => {} };
  const scheduler = new AgentScheduler(service as never, executor as never, events as never, 1000, "UTC");
  const tick = () => (scheduler as unknown as { tick(): Promise<void> }).tick();
  return { tick, started, nextRuns };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => clearClaudeLimits());

describe("scheduled runs and the Claude usage limit", () => {
  test("a run the limit cut is due again right away, not at the next slot", async () => {
    const h = harness("claude-sonnet-5-5", { status: "failed", error: LIMIT_ERROR });
    const before = Date.now();
    await h.tick();
    await settle();
    const last = h.nextRuns[h.nextRuns.length - 1];
    expect(Date.parse(last.next)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(last.next)).toBeGreaterThanOrEqual(before - 1000);
  });

  test("while the agent's model is limited the slot is not fired and stays due", async () => {
    rememberClaudeLimit("claude-sonnet-5-5", { kind: "rate_limit", detail: "limit", resetsAt: Date.now() + 3_600_000 });
    const h = harness("claude-sonnet-5-5", { status: "completed", error: "" });
    await h.tick();
    expect(h.started).toEqual([]);
    expect(h.nextRuns).toEqual([]);
  });

  test("any other failure waits for the next slot as before", async () => {
    const h = harness("claude-sonnet-5-5", { status: "failed", error: "tool crashed" });
    await h.tick();
    await settle();
    expect(h.nextRuns).toHaveLength(1);
    expect(Date.parse(h.nextRuns[0].next)).toBeGreaterThan(Date.now() + 3_600_000);
  });
});
