import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { RunRecorder } from "../src/modules/agents/executor/run-recorder.js";

// A tool result's error flag used to reach only the event log; the stored
// step and the live flow event had nothing, so the dashboard had to guess.

describe("RunRecorder — tool result error flag", () => {
  let db: Database;
  let events: EventBus;
  let service: AgentService;
  let recorder: RunRecorder;
  let runId: string;
  const flow: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    const agent = service.createAgent({ name: "Scout" });
    const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "x" });
    runId = run.id;
    flow.length = 0;
    events.on("agent:flow:step", (data: unknown) => { flow.push(data as Record<string, unknown>); });
    recorder = new RunRecorder(agent, run, service, events);
  });

  afterEach(() => db.close());

  const zodError = '[{"code":"invalid_type","expected":"string","received":"undefined","path":["text"],"message":"Required"}]';

  it("persists is_error: true on the step row and the flow event for an error result", () => {
    recorder.loopHooks().onToolResult!({ tool_name: "kernel_career_liveness", text: zodError, isError: true });

    const [step] = service.getSteps(runId);
    expect(step.type).toBe("tool_result");
    expect(JSON.parse(step.tool_input)).toEqual({ is_error: true });
    expect(step.tool_output).toBe(zodError);

    const ev = flow.find((e) => e.type === "tool_result")!;
    expect(ev.is_error).toBe(true);
  });

  it("persists is_error: false for a successful result", () => {
    recorder.loopHooks().onToolResult!({ tool_name: "kernel_career_liveness", text: '[{"id":1}]', isError: false });

    const [step] = service.getSteps(runId);
    expect(JSON.parse(step.tool_input)).toEqual({ is_error: false });

    const ev = flow.find((e) => e.type === "tool_result")!;
    expect(ev.is_error).toBe(false);
  });

  it("leaves tool_call steps and their events without the flag", () => {
    recorder.loopHooks().onToolCall!({ tool_name: "kernel_career_liveness", tool_input: { job_id: "j1" }, preview: "" });

    const [step] = service.getSteps(runId);
    expect(JSON.parse(step.tool_input)).toEqual({ job_id: "j1" });
    expect("is_error" in flow[0]).toBe(false);
  });
});
