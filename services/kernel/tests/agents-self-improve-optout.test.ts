import { describe, expect, test } from "bun:test";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import type { Agent, AgentRun } from "../src/modules/agents/types.js";
import type { AgentService } from "../src/modules/agents/service.js";

// Self-grading after every run (and the prompt reflection it feeds) costs a call
// per run. An office that drives its agents by protocol opts out per agent with
// the variable `__self_improve__: false`.

function harness() {
  const graded: string[] = [];
  const ex = new AgentExecutor();
  ex.setEvalService({
    isEnabled: () => true,
    evaluate: async ({ agent }: { agent?: Agent }) => {
      graded.push(agent?.id ?? "");
      return null;
    },
  } as never);
  const run = { id: "r1" } as AgentRun;
  const result = { status: "completed", result: "ok", steps_count: 1, tokens_used: 0 } as never;
  const grade = (agent: Partial<Agent>) =>
    ex.runAutoEvaluate({ id: "a", name: "a", variables: "{}", ...agent } as Agent, run, "goal", result, [], {} as AgentService);
  return { graded, grade };
}

describe("self-improvement opt-out", () => {
  test("an agent is graded by default", async () => {
    const h = harness();
    await h.grade({ id: "plain" });
    expect(h.graded).toEqual(["plain"]);
  });

  test("an agent with __self_improve__ false is not graded", async () => {
    const h = harness();
    await h.grade({ id: "office", variables: JSON.stringify({ __self_improve__: false }) });
    expect(h.graded).toEqual([]);
  });

  test("the string \"false\" (extension seeds only carry strings) also opts out", async () => {
    const h = harness();
    await h.grade({ id: "seeded", variables: JSON.stringify({ __self_improve__: "false" }) });
    expect(h.graded).toEqual([]);
  });

  test("unreadable variables do not stop the grading", async () => {
    const h = harness();
    await h.grade({ id: "broken", variables: "{not json" });
    expect(h.graded).toEqual(["broken"]);
  });
});
