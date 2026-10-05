/** A chat turn (agents.run with chat: true) is not handed down the agent's chains. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor, isChatRun } from "../src/modules/agents/executor.js";
import { EventBus } from "../src/core/event-bus.js";
import { agentsRpcActions } from "../src/modules/agents/rpc-actions.js";

let db: InstanceType<typeof Database>;
let service: AgentService;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db, new EventBus());
});
afterEach(() => db.close());

const run = (input: Record<string, unknown>) => {
  const found = agentsRpcActions({ service, executor: new AgentExecutor() }).find((a) => a.name === "agents.run");
  if (!found) throw new Error("no rpc action named agents.run");
  return found.handler(input) as Promise<{ run_id: string }> | { run_id: string };
};

describe("isChatRun", () => {
  it("reads the chat flag from the run payload", () => {
    expect(isChatRun({ trigger_payload: JSON.stringify({ chat: true }) })).toBe(true);
    expect(isChatRun({ trigger_payload: JSON.stringify({ workspace: "x" }) })).toBe(false);
    expect(isChatRun({ trigger_payload: "" })).toBe(false);
    expect(isChatRun({ trigger_payload: "not json" })).toBe(false);
  });
});

describe("agents.run chat flag", () => {
  it("marks chat runs and leaves the others unmarked", async () => {
    const agent = service.createAgent({ name: "Thumbnail Director" });
    const chat = await run({ agent_id: agent.id, goal: "hola", chat: true });
    const plain = await run({ agent_id: agent.id, goal: "work" });
    expect(isChatRun(service.getRun(chat.run_id)!)).toBe(true);
    expect(isChatRun(service.getRun(plain.run_id)!)).toBe(false);
  });

  it("keeps the workspace override next to the chat flag", async () => {
    const agent = service.createAgent({ name: "Designer" });
    const out = await run({ agent_id: agent.id, goal: "hola", chat: true, workspace: "ws1" });
    expect(JSON.parse(service.getRun(out.run_id)!.trigger_payload)).toEqual({ workspace: "ws1", chat: true });
  });
});
