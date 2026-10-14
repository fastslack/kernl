import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/core/event-bus.js";
import {
  isUnattended, goalForRun, UNATTENDED_NOTE, detectOperatorAsk, buildAskPrompt, UnattendedAskWatcher,
  type UnattendedAskService,
} from "../src/modules/agents/unattended-asks.js";
import type { Agent, AgentRun } from "../src/modules/agents/types.js";
import type { AgentQuestion } from "../src/modules/agents/service.js";

const run = (over: Partial<AgentRun> = {}) => ({
  id: "r1", agent_id: "a1", trigger_type: "schedule", parent_run_id: "", status: "completed", goal: "Weekly content",
  result: "Article written to assets/articulos/x.md and moved to review for your approval. What you have to do: approve it.",
  ...over,
}) as AgentRun;
const agent = (over: Partial<Agent> = {}) => ({ id: "a1", name: "Contenidos", flow_id: "marketing-office", builtin_handler: "", ...over }) as Agent;
const YES = { needs_operator: true, question: "The article is in review: what do I do?", context: "assets/articulos/x.md", options: ["Approve", "I review it", "Ask for changes", "Discard"] };

describe("isUnattended / goalForRun", () => {
  it("is a schedule or event run with no parent", () => {
    expect(isUnattended(run())).toBe(true);
    expect(isUnattended(run({ trigger_type: "event" }))).toBe(true);
    expect(isUnattended(run({ trigger_type: "manual" }))).toBe(false);
    expect(isUnattended(run({ trigger_type: "chain" }))).toBe(false);
    expect(isUnattended(run({ parent_run_id: "p" }))).toBe(false);
  });

  it("adds the note once, only to unattended LLM runs", () => {
    const g = goalForRun("Do it", run(), agent());
    expect(g).toBe("Do it" + UNATTENDED_NOTE);
    expect(g).toContain("kernel_agents_ask_supervisor");
    expect(goalForRun(g, run(), agent())).toBe(g);
    expect(goalForRun("Do it", run({ trigger_type: "manual" }), agent())).toBe("Do it");
    expect(goalForRun("Do it", run(), agent({ builtin_handler: "email:triage" }))).toBe("Do it");
  });
});

describe("detectOperatorAsk", () => {
  it("turns a yes into a question with 4 options", async () => {
    const ask = await detectOperatorAsk({ agentName: "A", goal: "g", result: "r", openQuestions: [] }, async () => YES);
    expect(ask?.question).toBe(YES.question);
    expect(ask?.options.map((o) => o.label)).toEqual(YES.options);
  });

  it("is null for a no, or for a malformed answer", async () => {
    const i = { agentName: "A", goal: "g", result: "r", openQuestions: [] };
    expect(await detectOperatorAsk(i, async () => ({ needs_operator: false }))).toBeNull();
    expect(await detectOperatorAsk(i, async () => ({ ...YES, options: ["a", "b"] }))).toBeNull();
    expect(await detectOperatorAsk(i, async () => ({ ...YES, question: "" }))).toBeNull();
  });

  it("shows the model the open questions and strips the note from the goal", () => {
    const p = buildAskPrompt({ agentName: "A", goal: "g" + UNATTENDED_NOTE, result: "r", openQuestions: ["Link an email account?"] });
    expect(p).toContain("- Link an email account?");
    expect(p).not.toContain("Nobody is watching");
  });
});

function fakeService(opts: { run?: AgentRun; agent?: Agent; steps?: string[]; open?: Partial<AgentQuestion>[] } = {}) {
  const created: Array<{ question: string; run_id?: string; from_agent_id: string; options: Array<{ label: string }> }> = [];
  const svc: UnattendedAskService = {
    getRun: () => opts.run ?? run(),
    getAgent: () => opts.agent ?? agent(),
    getSteps: () => (opts.steps ?? []).map((tool_name) => ({ tool_name })),
    listQuestions: (o) => (opts.open ?? []).filter((q) => q.status === o?.status) as AgentQuestion[],
    createQuestion: (q) => { created.push(q); return { id: `q${created.length}`, status: "triage" }; },
  };
  return { svc, created };
}

describe("UnattendedAskWatcher", () => {
  it("files the question to the chief for a run that left something for the operator", async () => {
    const { svc, created } = fakeService();
    const id = await new UnattendedAskWatcher(svc, new EventBus(), async () => YES).check("r1");
    expect(id).toBe("q1");
    expect(created[0]).toMatchObject({ from_agent_id: "a1", run_id: "r1", question: YES.question });
    expect(created[0].options).toHaveLength(4);
  });

  it("stays out of runs a person watched, builtin handlers, runs that asked, and failed runs", async () => {
    let calls = 0;
    const llm = async () => { calls++; return YES; };
    for (const o of [
      { run: run({ trigger_type: "manual" }) },
      { run: run({ parent_run_id: "p" }) },
      { agent: agent({ builtin_handler: "email:triage" }) },
      { steps: ["mcp__kernel__kernel_agents_ask_supervisor"] },
      { run: run({ status: "failed" }) },
      { run: run({ result: "Done." }) },
    ]) {
      const { svc, created } = fakeService(o);
      expect(await new UnattendedAskWatcher(svc, new EventBus(), llm).check("r1")).toBeNull();
      expect(created).toEqual([]);
    }
    expect(calls).toBe(0);
  });

  it("does not file what the model says needs nothing, nor the same open question twice", async () => {
    const no = fakeService();
    expect(await new UnattendedAskWatcher(no.svc, new EventBus(), async () => ({ needs_operator: false })).check("r1")).toBeNull();
    const dup = fakeService({ open: [{ from_agent_id: "a1", status: "pending", question: YES.question }] });
    expect(await new UnattendedAskWatcher(dup.svc, new EventBus(), async () => YES).check("r1")).toBeNull();
    expect(dup.created).toEqual([]);
  });

  it("listens to run_completed", async () => {
    const events = new EventBus();
    const { svc, created } = fakeService();
    new UnattendedAskWatcher(svc, events, async () => YES, 0).start();
    events.emit("agent:flow:run_completed", { run_id: "r1", agent_id: "a1", status: "completed" });
    await new Promise((r) => setTimeout(r, 20));
    expect(created).toHaveLength(1);
  });
});
