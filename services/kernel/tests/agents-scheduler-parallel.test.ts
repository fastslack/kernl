import { describe, expect, test } from "bun:test";
import { AgentScheduler } from "../src/modules/agents/scheduler.js";

// A scheduled run used to block the whole scheduler until it finished: one long
// agent kept every other office's schedule waiting, sometimes for an hour.

type Sched = { id: string; agent_id: string; agent_name: string; interval_ms: number; cron_expression: string; goal_override: string; project_id: null };

function harness(due: Sched[]) {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const nextRuns: string[] = [];
  let pending = [...due];
  const service = {
    getDueSchedules: () => pending.filter((s) => !nextRuns.includes(s.id)),
    getAgent: (id: string) => ({ id, name: id, active: 1, builtin_handler: "", goal_template: "", flow_id: "" }),
    isAgentOfficePaused: () => false,
    getProjectGate: () => null,
    updateScheduleNextRun: (id: string) => { nextRuns.push(id); },
    createRun: (r: { agent_id: string }) => ({ id: `run-${r.agent_id}-${started.length}`, ...r }),
    updateRun: () => {},
    recordRunOutcome: () => {},
  };
  const executor = {
    execute: ({ agent }: { agent: { id: string } }) => {
      started.push(agent.id);
      return new Promise((resolve) => {
        release.set(agent.id, () => resolve({ status: "completed", result: "", error: "", steps_count: 1, tokens_used: 0 }));
      });
    },
  };
  const events = { emit: () => {} };
  const scheduler = new AgentScheduler(service as never, executor as never, events as never, 1000, "UTC");
  const tick = () => (scheduler as unknown as { tick(): Promise<void> }).tick();
  return {
    tick, started, release, nextRuns,
    makeDueAgain: (ids: string[]) => { for (const id of ids) nextRuns.splice(nextRuns.indexOf(id), 1); },
    setDue: (d: Sched[]) => { pending = d; },
  };
}

const sched = (id: string, agent: string): Sched => ({
  id, agent_id: agent, agent_name: agent, interval_ms: 60_000, cron_expression: "", goal_override: "go", project_id: null,
});

describe("agent scheduler", () => {
  test("a long scheduled run does not hold back the other due schedules", async () => {
    const h = harness([sched("s1", "slow"), sched("s2", "vigia")]);
    await h.tick();
    expect(h.started).toEqual(["slow", "vigia"]);
    expect(h.nextRuns.sort()).toEqual(["s1", "s2"]);
  });

  test("an agent whose scheduled run is still going is not started again", async () => {
    const h = harness([sched("s1", "slow")]);
    await h.tick();
    h.makeDueAgain(["s1"]);
    await h.tick();
    expect(h.started).toEqual(["slow"]);
    expect(h.nextRuns).toEqual(["s1"]); // the busy slot is skipped, not queued
    h.release.get("slow")!();
    await new Promise((r) => setTimeout(r, 0));
    h.makeDueAgain(["s1"]);
    await h.tick();
    expect(h.started).toEqual(["slow", "slow"]);
  });

  test("no more than 4 scheduled runs at once; the rest wait for a free slot", async () => {
    const h = harness(["a", "b", "c", "d", "e"].map((x) => sched(`s-${x}`, x)));
    await h.tick();
    expect(h.started).toEqual(["a", "b", "c", "d"]);
    expect(h.nextRuns).not.toContain("s-e");
    h.release.get("a")!();
    await new Promise((r) => setTimeout(r, 0));
    await h.tick();
    expect(h.started).toEqual(["a", "b", "c", "d", "e"]);
  });
});
