/**
 * The read-only investigator behind "What would the AI answer?": what it may
 * call (and that the kernel holds it to that), the opinion's lifecycle on the
 * question, and that a model it cannot reach is "unavailable" — never a
 * fallback to another model.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { callerToolDenial, unrestrictCallerTools } from "../src/core/caller-tool-gate.js";
import {
  INVESTIGATOR_DENIED, INVESTIGATOR_ROLE, INVESTIGATOR_TOOLS, createQuestionInvestigator, investigatorDefinition,
} from "../src/modules/agents/question-investigator.js";
import { resolveSandboxDriverSlug, toolPolicy } from "../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js";

const OPTS = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];

/** Tool names that write something somewhere: none may be in the investigator's set. */
const WRITERS = /(_create|_update|_delete|_remove|_write|_exec|_add|_apply|_set|_post|_send|_ack|_answer|_invoke|_run|_register|_unregister|_close|_comment|_approve|_merge|_push|_propose|ask_supervisor|call_meeting)\b/;

describe("what the investigator may call", () => {
  const def = investigatorDefinition("es", "claude-opus-5-5");

  it("only reads: every allowed tool is a read, none matches a writer's name", () => {
    expect(def.allowed_tools.length).toBeGreaterThan(0);
    for (const t of def.allowed_tools) expect(t).not.toMatch(WRITERS);
    expect(def.allowed_tools).toEqual([...INVESTIGATOR_TOOLS]);
  });

  it("every built-in that writes, runs commands or reaches the web is denied, and so is ask_supervisor", () => {
    for (const t of ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "Task", "WebFetch", "WebSearch", "kernel_agents_ask_supervisor"]) {
      expect(def.denied_tools).toContain(t);
    }
    expect(def.denied_tools).toEqual([...INVESTIGATOR_DENIED]);
  });

  it("runs outside the Docker sandbox, so the SDK enforces its rules with dontAsk, and gets no Bash", () => {
    expect(resolveSandboxDriverSlug(def.variables, "docker")).toBeNull();
    expect(def.variables.__permission_mode__).toBe("dontAsk");
    const policy = toolPolicy({ usingSandbox: false, allowUnsandboxedBash: false, allowed: new Set(def.allowed_tools), projectRun: false });
    expect(policy.includeBash).toBe(false);
    expect(policy.includeWebFetch).toBe(false);
  });

  it("the instance default still applies to everyone else", () => {
    expect(resolveSandboxDriverSlug({}, "docker")).toBe("docker");
    expect(resolveSandboxDriverSlug({ __sandbox_driver__: "docker" }, "")).toBe("docker");
    expect(resolveSandboxDriverSlug({}, "")).toBeNull();
  });

  it("one model, no chain", () => {
    expect(def.model).toBe("claude-opus-5-5");
    expect((def as Record<string, unknown>).model_chain).toBeUndefined();
  });
});

describe("the investigator's lifecycle", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let finishRun: (r: { status: string; result?: string; error?: string }) => void;
  let goals: string[];
  const executor = {
    execute: (p: { goal: string }) => {
      goals.push(p.goal);
      return new Promise((resolve) => {
        finishRun = (r) => resolve({ status: r.status, result: r.result ?? "", error: r.error, steps_count: 1, tokens_used: 1 });
      });
    },
  } as never;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    goals = [];
  });
  afterEach(() => {
    const id = service.getSystemAgentId(INVESTIGATOR_ROLE);
    if (id) unrestrictCallerTools(id);
    db.close();
  });

  const ask = () => {
    const w = service.createAgent({ name: "Resolver" });
    return service.createQuestion({ from_agent_id: w.id, question: "¿Pego la descripción en api!83?", options: OPTS, direct_to_human: true }).id;
  };

  it("starts a claude_code run of a hidden, read-only agent and stores the opinion when it ends", async () => {
    const inv = createQuestionInvestigator({ service, executor, events, language: "es" });
    const qid = ask();
    const started = inv.start(qid);
    expect(started.status).toBe("running");
    expect(goals[0]).toContain(`question_id: ${qid}`);
    expect(goals[0]).toContain("MR api!83");

    const agent = service.getAgent(service.getSystemAgentId(INVESTIGATOR_ROLE))!;
    expect(agent.executor_type).toBe("claude_code");
    expect(agent.show_on_dashboard).toBeFalsy();
    expect(agent.model).toBe("claude-opus-5-5");

    // Starting again while it runs joins the same run.
    expect(inv.start(qid).run_id).toBe(started.run_id);
    expect(goals.length).toBe(1);

    finishRun({ status: "completed", result: '{"answer":"Sí, pegala con glab mr update 83","matches_option":1,"extends_option":true,"evidence":["api!83 nota 14/10"]}' });
    await settle();
    await events.emit("agent:flow:run_completed", { run_id: started.run_id, status: "completed" });
    const st = inv.state(qid)!;
    expect(st.status).toBe("ready");
    expect(st.opinion).toMatchObject({ answer: "Sí, pegala con glab mr update 83", matches_option: 0, extends_option: true, evidence: ["api!83 nota 14/10"] });
    // Nothing was answered: the question still waits for the operator.
    expect(service.getQuestion(qid)!.status).toBe("pending");
  });

  it("run_completed arriving before the run's row is written still stores the opinion (the real order)", async () => {
    const inv = createQuestionInvestigator({ service, executor, events, language: "es" });
    const qid = ask();
    const { run_id } = inv.start(qid);
    // The executor emits first; startAgentRun writes status and result after.
    void events.emit("agent:flow:run_completed", { run_id, status: "completed" });
    await settle();
    expect(inv.state(qid)!.status).toBe("running");
    finishRun({ status: "completed", result: '```json\n{"answer":"Opción 2 con condiciones","matches_option":2,"extends_option":true}\n```' });
    await new Promise((r) => setTimeout(r, 600));
    expect(inv.state(qid)).toMatchObject({ status: "ready", opinion: { answer: "Opción 2 con condiciones", matches_option: 1, extends_option: true } });
  });

  it("the kernel refuses it any tool outside its set, whatever its executor was told", () => {
    const inv = createQuestionInvestigator({ service, executor, events, language: "es" });
    inv.start(ask());
    const id = service.getSystemAgentId(INVESTIGATOR_ROLE);
    expect(callerToolDenial(id, "kernel_repos_read")).toBeNull();
    for (const t of ["kernel_repos_write", "kernel_repos_exec", "kernel_agents_post_to_colleague", "kernel_triage_apply", "kernel_agents_inbox_ack"]) {
      expect(callerToolDenial(id, t)).toContain("read-only");
    }
    // Other agents are not affected.
    expect(callerToolDenial("someone-else", "kernel_repos_write")).toBeNull();
  });

  it("a model it cannot reach is 'unavailable', with no second try on another model", async () => {
    const inv = createQuestionInvestigator({ service, executor, events, language: "es" });
    const qid = ask();
    const { run_id } = inv.start(qid);
    finishRun({ status: "failed", error: "Not logged in · Please run /login" });
    await settle();
    await events.emit("agent:flow:run_completed", { run_id, status: "failed" });
    const st = inv.state(qid)!;
    expect(st.status).toBe("failed");
    expect(st.reason).toBe("unavailable");
    expect(goals.length).toBe(1);
  });

  it("a run that ends without the JSON is 'no_answer'", async () => {
    const inv = createQuestionInvestigator({ service, executor, events, language: "es" });
    const qid = ask();
    const { run_id } = inv.start(qid);
    finishRun({ status: "completed", result: "Estuve mirando y no llegué a una conclusión." });
    await settle();
    await events.emit("agent:flow:run_completed", { run_id, status: "completed" });
    expect(inv.state(qid)).toMatchObject({ status: "failed", reason: "no_answer" });
  });

  it("an edit in the agent panel cannot widen it: the next start puts its tools back", () => {
    const inv = createQuestionInvestigator({ service, executor, events, language: "es" });
    inv.start(ask());
    const id = service.getSystemAgentId(INVESTIGATOR_ROLE);
    service.updateAgent(id, { allowed_tools: ["Bash", "kernel_repos_write"], variables: { __sandbox_driver__: "docker" } });
    finishRun({ status: "completed", result: "{}" });
    inv.start(ask());
    const agent = service.getAgent(id)!;
    expect(JSON.parse(agent.allowed_tools as unknown as string)).toEqual([...INVESTIGATOR_TOOLS]);
    expect(JSON.parse(agent.variables as unknown as string).__sandbox_driver__).toBe("none");
  });
});
