import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { agentsTools } from "../src/modules/agents/tools.js";
import { EventBus } from "../src/core/event-bus.js";
import { stripInternalArgs } from "../src/core/helpers.js";
import { runWithContext } from "../src/core/request-context.js";
import type { ToolDefinition } from "../src/core/types.js";

// Agents run by the claude_code executor call tools over MCP. That path
// (server.ts) strips every `__*` arg and only carries the caller in the
// request context, so the caller-aware tools must read it from there.

let db: InstanceType<typeof Database>;
let service: AgentService;
let tools: ToolDefinition[];

function text(r: Awaited<ReturnType<ToolDefinition["handler"]>>): string {
  return (r as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
}

/** Same steps as the MCP dispatch in server.ts: strip, parse, run inside the caller context. */
async function callOverMcp(name: string, args: Record<string, unknown>, callerAgentId: string) {
  const tool = tools.find((t) => t.name === name)!;
  const parsed = tool.inputSchema.parse(stripInternalArgs(args));
  return runWithContext({ callerAgentId, callerRunId: "", callerDepth: 1 }, () => tool.handler(parsed as any));
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  const events = new EventBus();
  service = new AgentService(db as any, events);
  tools = agentsTools(service, new AgentExecutor(), events);
});
afterEach(() => db.close());

function mk(name: string) {
  const flow = service.createFlow({ name: "Ops" } as any);
  return service.createAgent({ name, description: name, flow_id: flow.id, active: true } as any);
}

describe("caller-aware agent tools over the MCP path", () => {
  it("post_to_colleague works with the caller only in the request context", async () => {
    const a = mk("Sender");
    const b = mk("Receiver");
    const res = await callOverMcp("kernel_agents_post_to_colleague", { to_agent_id: b.id, subject: "hola", body: "x" }, a.id);
    expect(text(res)).toContain("Posted to");
    const inbox = service.getUnreadInbox(b.id);
    expect(inbox.length).toBe(1);
    expect(inbox[0].from_agent_id).toBe(a.id);
  });

  it("a forged __caller_agent_id is stripped; the context caller wins", async () => {
    const a = mk("Sender");
    const b = mk("Receiver");
    const c = mk("Impostor");
    await callOverMcp("kernel_agents_post_to_colleague", { to_agent_id: b.id, subject: "hola", body: "x", __caller_agent_id: c.id }, a.id);
    expect(service.getUnreadInbox(b.id)[0].from_agent_id).toBe(a.id);
  });

  it("inbox defaults to the context caller", async () => {
    const a = mk("Sender");
    const b = mk("Receiver");
    service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "letter-one", body: "x" });
    const res = await callOverMcp("kernel_agents_inbox", {}, b.id);
    expect(text(res)).toContain("letter-one");
  });

  it("inbox_ack acks with the caller only in the request context", async () => {
    const a = mk("Sender");
    const b = mk("Receiver");
    const { message } = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    const res = await callOverMcp("kernel_agents_inbox_ack", { message_ids: [message!.id] }, b.id);
    expect(text(res)).toContain("Acknowledged 1");
    expect(service.getUnreadInbox(b.id).length).toBe(0);
  });

  it("inbox_ack does not ack letters addressed to someone else", async () => {
    const a = mk("Sender");
    const b = mk("Receiver");
    const c = mk("Other");
    const { message } = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    const res = await callOverMcp("kernel_agents_inbox_ack", { message_ids: [message!.id] }, c.id);
    expect(text(res)).toContain("None of those ids");
    expect(service.getUnreadInbox(b.id).length).toBe(1);
  });

  it("inbox_ack reaches a letter beyond the 200 oldest unread", async () => {
    const a = mk("Sender");
    const b = mk("Receiver");
    let last = "";
    for (let i = 0; i < 205; i++) {
      last = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: `l${i}`, body: "x" }).message!.id;
    }
    const res = await callOverMcp("kernel_agents_inbox_ack", { message_ids: [last] }, b.id);
    expect(text(res)).toContain("Acknowledged 1");
  });

  it("inbox_ack without any caller errors", async () => {
    const tool = tools.find((t) => t.name === "kernel_agents_inbox_ack")!;
    const res = await tool.handler(tool.inputSchema.parse({ message_ids: ["x"] }) as any);
    expect(text(res)).toMatch(/Caller agent context missing/);
  });

  // A woken run gets its letters in the system prompt, which marks them read
  // before the first turn. Its own inbox then came back empty and its ack was
  // refused, so it went looking and burned its budget.
  describe("letters the run's prompt already delivered", () => {
    async function inRun(name: string, args: Record<string, unknown>, callerAgentId: string, runId: string) {
      const tool = tools.find((t) => t.name === name)!;
      const parsed = tool.inputSchema.parse(stripInternalArgs(args));
      return runWithContext({ callerAgentId, callerRunId: runId, callerDepth: 1 }, () => tool.handler(parsed as any));
    }
    function delivered() {
      const a = mk("Career Lead");
      const b = mk("Recruiter Desk");
      const { message } = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "Despachá el lote", body: "x" });
      const run = service.createRun({ agent_id: b.id, goal: "You have 1 unacknowledged letter(s)" });
      service.markInboxRead([message!.id]);
      return { a, b, message: message!, run };
    }

    it("still lists them in the run's own default inbox", async () => {
      const { b, run } = delivered();
      const res = text(await inRun("kernel_agents_inbox", {}, b.id, run.id));
      expect(res).toContain("Despachá el lote");
      expect(res).toContain("already in your context");
    });

    it("acknowledges them", async () => {
      const { b, message, run } = delivered();
      const res = text(await inRun("kernel_agents_inbox_ack", { message_ids: [message.id] }, b.id, run.id));
      expect(res).toContain("Acknowledged 1");
    });

    it("warns an agent that reads a colleague's inbox by mistake", async () => {
      const { a, b, run } = delivered();
      const res = text(await inRun("kernel_agents_inbox", { agent_id: a.id }, b.id, run.id));
      expect(res).toMatch(/Career Lead's inbox, not yours/);
    });

    it("does not resurface letters read before the run", async () => {
      const a = mk("Sender");
      const b = mk("Receiver");
      const { message } = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "old news", body: "x" });
      service.markInboxRead([message!.id]);
      db.prepare("UPDATE agent_office_inbox SET read_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", message!.id);
      const run = service.createRun({ agent_id: b.id, goal: "g" });
      const res = text(await inRun("kernel_agents_inbox", {}, b.id, run.id));
      expect(res).toContain("No unread messages");
    });
  });
});
