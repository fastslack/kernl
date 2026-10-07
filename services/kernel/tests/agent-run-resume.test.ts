/**
 * Runs that survive a kernel restart: a native run checkpoints its loop, the
 * startup pass keeps the fresh ones in flight, and the resume continues the
 * conversation without re-running a tool whose outcome died with the process.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { EventBus } from "../src/core/event-bus.js";
import { resumeRun, autoResumePolicy } from "../src/modules/agents/run-resume.js";
import { serializeCheckpoint } from "../src/modules/agents/executor/run-checkpoint.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";
import type { ChatMessage } from "../src/core/llm/chat-types.js";
import type { KernelConfig } from "../src/core/config.js";
import type { ToolDefinition } from "../src/core/types.js";
import type { AgentRun } from "../src/modules/agents/types.js";
import * as providerHealth from "../src/core/llm/provider-health.js";

let db: InstanceType<typeof Database>;
let service: AgentService;
let events: EventBus;
let executor: AgentExecutor;
let sends: number;
let seen: ChatMessage[][];

const sendTool = {
  name: "kernel_test_send",
  description: "Send something (not idempotent)",
  inputSchema: z.object({ to: z.string() }),
  handler: async () => {
    sends++;
    return { content: [{ type: "text", text: "sent" }] };
  },
} as unknown as ToolDefinition;

function provider(replies: Array<Record<string, unknown>>): ChatLlmProvider {
  let i = 0;
  return {
    name: "stub",
    available: () => true,
    async chatCompletion(messages: ChatMessage[]) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      return replies[Math.min(i++, replies.length - 1)];
    },
  } as unknown as ChatLlmProvider;
}

/** A run the previous process left in flight, after the model asked to send. */
function interruptedRun(): AgentRun {
  const agent = service.createAgent({ name: "Mailer" });
  const run = service.createRun({ agent_id: agent.id, goal: "email the report" });
  service.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });
  const messages: ChatMessage[] = [
    { role: "user", content: "email the report" },
    { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "kernel_test_send", input: { to: "boss" } }] },
  ];
  // As the loop really leaves it: the checkpoint is written once the assistant
  // turn is in, then the tool_call step is recorded — so the checkpoint's step
  // number trails the steps table by one.
  service.addStep({ run_id: run.id, step_number: 1, type: "thought", content: "sending" });
  service.saveCheckpoint(
    run.id,
    serializeCheckpoint({ messages, iterations: 1, totalTokens: 40, elapsedMs: 2_000 }, 0, 1),
  );
  service.addStep({ run_id: run.id, step_number: 2, type: "tool_call", tool_name: "kernel_test_send" });
  return service.getRun(run.id)!;
}


beforeEach(() => {
  providerHealth._resetForTests();
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  events = new EventBus();
  service = new AgentService(db, events);
  executor = new AgentExecutor();
  executor.setConfig({ language: "en", agents: {} } as unknown as KernelConfig);
  executor.setKernelTools([sendTool]);
  sends = 0;
  seen = [];
});

afterEach(() => {
  db.close();
  providerHealth._resetForTests();
});

describe("startup recovery", () => {
  it("keeps a run with a fresh checkpoint in flight and marks it interrupted", () => {
    const run = interruptedRun();
    const { resume, failed } = service.recoverStaleRuns({ resumeWithinMs: 60_000, maxResumes: 2 });
    expect(resume).toEqual([run.id]);
    expect(failed).toBe(0);
    expect(service.getRun(run.id)!.status).toBe("running");
    expect(service.getRunConditions(run.id)).toMatchObject([
      { type: "Interrupted", status: "True", reason: "KernelRestart" },
    ]);
  });

  it("fails a run without a checkpoint, as before", () => {
    const agent = service.createAgent({ name: "Plain" });
    const run = service.createRun({ agent_id: agent.id, goal: "x" });
    service.updateRun(run.id, { status: "running" });
    const { resume, failed } = service.recoverStaleRuns({ resumeWithinMs: 60_000, maxResumes: 2 });
    expect(resume).toEqual([]);
    expect(failed).toBe(1);
    expect(service.getRun(run.id)!.error).toBe("Stale run cleaned up on startup");
  });

  it("stops retrying a run that already used its automatic resumes, but keeps it resumable by hand", () => {
    const run = interruptedRun();
    service.markCheckpointResumed(run.id);
    service.markCheckpointResumed(run.id);
    const { resume } = service.recoverStaleRuns({ resumeWithinMs: 60_000, maxResumes: 2 });
    expect(resume).toEqual([]);
    const after = service.getRun(run.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/not retried again/);
    expect(service.getCheckpoint(run.id)).toBeDefined();
  });

  it("leaves a stale checkpoint for a manual resume instead of acting on old context", () => {
    const run = interruptedRun();
    const { resume } = service.recoverStaleRuns({ resumeWithinMs: 0, maxResumes: 2 });
    expect(resume).toEqual([]);
    expect(service.getRun(run.id)!.error).toMatch(/resumable with kernel_agents_resume/);
  });

  it("reads its policy from the environment", () => {
    expect(autoResumePolicy({})).toEqual({ resumeWithinMs: 1_800_000, maxResumes: 2 });
    expect(autoResumePolicy({ KERNEL_AGENT_RESUME_WINDOW_MS: "0", KERNEL_AGENT_MAX_AUTO_RESUMES: "5" }))
      .toEqual({ resumeWithinMs: 0, maxResumes: 5 });
  });
});

describe("resumeRun", () => {
  it("continues the conversation without re-sending, and finishes the run", async () => {
    const run = interruptedRun();
    executor.setProviders(new Map([["stub", provider([{ content: "Checked: it went out.", tokens_used: 10, model: "stub" }])]]), "stub");

    const outcome = resumeRun({ service, executor, events }, run.id, "automatic");
    expect(outcome).toMatchObject({ ok: true, fromTurn: 1 });
    if (outcome.ok) await outcome.done;

    const done = service.getRun(run.id)!;
    expect(done.status).toBe("completed");
    expect(done.tokens_used).toBe(50);
    expect(sends).toBe(0);

    // The model saw the unanswered call resolved as "unknown", not re-run.
    const lastSent = seen[0][seen[0].length - 1];
    expect(lastSent.role).toBe("user");
    expect(JSON.stringify(lastSent.content)).toMatch(/outcome is unknown/);

    // Steps continue the numbering, the checkpoint is gone, the story is told.
    const steps = service.getSteps(run.id);
    expect(steps.map((s) => s.step_number)).toEqual([1, 2, 3]);
    expect(service.getCheckpoint(run.id)).toBeUndefined();
    const types = service.getRunConditions(run.id).map((c) => `${c.type}=${c.status}`);
    expect(types).toEqual(expect.arrayContaining(["Interrupted=False", "Resumed=True", "ModelReady=True"]));
  });

  it("refuses a run that is still running when asked by hand", () => {
    const run = interruptedRun();
    expect(resumeRun({ service, executor, events }, run.id, "manual")).toEqual({
      ok: false, error: "Run is still running",
    });
  });

  it("refuses a run its token budget stopped, instead of aborting again at once", () => {
    const run = interruptedRun();
    service.setRunCondition(run.id, { type: "Aborted", status: "True", reason: "TokenBudget", message: "Token budget exhausted (174209/150000)" });
    const outcome = resumeRun({ service, executor, events }, run.id, "automatic");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/token budget.*max_tokens/);
  });

  it("refuses a checkpoint that already spent the agent's budget", () => {
    const run = interruptedRun();
    service.updateAgent(run.agent_id, { max_tokens: 40 });
    const outcome = resumeRun({ service, executor, events }, run.id, "automatic");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/40 spent of 40/);
  });

  it("refuses a run without a checkpoint", () => {
    const agent = service.createAgent({ name: "Plain" });
    const run = service.createRun({ agent_id: agent.id, goal: "x" });
    service.updateRun(run.id, { status: "failed" });
    expect(resumeRun({ service, executor, events }, run.id, "manual")).toEqual({
      ok: false, error: "This run has no usable checkpoint",
    });
  });
});

describe("live checkpoints", () => {
  it("writes a checkpoint while the run is in flight and drops it when the run finishes", async () => {
    const agent = service.createAgent({ name: "Live" });
    const run = service.createRun({ agent_id: agent.id, goal: "send it" });
    service.updateRun(run.id, { status: "running" });

    let midRun: string | undefined;
    const sendAndPeek = {
      ...sendTool,
      handler: async () => {
        midRun = service.getCheckpoint(run.id)?.data;
        sends++;
        return { content: [{ type: "text", text: "sent" }] };
      },
    } as unknown as ToolDefinition;
    executor.setKernelTools([sendAndPeek]);
    executor.setProviders(new Map([["stub", provider([
      { content: "", tokens_used: 5, model: "stub", tool_calls: [{ type: "tool_use", id: "tu-9", name: "kernel_test_send", input: { to: "x" } }] },
      { content: "done", tokens_used: 5, model: "stub" },
    ])]]), "stub");

    const result = await executor.execute({ agent, goal: "send it", run, service, events });
    service.updateRun(run.id, { status: result.status });

    expect(result.status).toBe("completed");
    expect(sends).toBe(1);
    expect(midRun).toContain('"tu-9"');
    expect(service.getCheckpoint(run.id)).toBeUndefined();
  });
});
