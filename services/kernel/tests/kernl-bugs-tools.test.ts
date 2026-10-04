import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { KernlBugService } from "../src/modules/agents/kernl-bugs-service.js";
import { kernlBugTools } from "../src/modules/agents/kernl-bugs-tools.js";
import { buildBugContext } from "../src/modules/agents/kernl-bugs-context.js";

let service: AgentService; let bugs: KernlBugService; let chiefId: string; let workerId: string;
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

beforeEach(() => {
  const db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db, new EventBus());
  bugs = new KernlBugService(db, "a".repeat(64));
  const rank = service.createRank({ name: "Chief", level: 99 });
  const chief = service.createAgent({ name: "Chief" });
  service.assignRankToAgent(chief.id, rank.id);
  chiefId = chief.id;
  workerId = service.createAgent({ name: "Scout" }).id;
});

describe("buildBugContext", () => {
  it("collects the run, redacted, without private tool bodies", () => {
    const run = service.createRun({ agent_id: workerId, trigger_type: "manual", goal: "g" });
    service.updateRun(run.id, { status: "failed", error: "boom at /home/fastslack/x.ts" });
    service.addStep({ run_id: run.id, step_number: 1, type: "tool_call", tool_name: "Bash", tool_input: { command: "echo ghp_ABCDEFGHIJKLMNOPQRSTUVWX12" } });
    service.addStep({ run_id: run.id, step_number: 2, type: "tool_result", tool_name: "mcp__kernel__kernel_email_get", tool_output: "Dear Ana, the contract…" });
    const ctx = buildBugContext(service, run.id)!;
    const s = JSON.stringify(ctx);
    expect(ctx.agent_name).toBe("Scout");
    expect(ctx.error).toContain("~/x.ts");
    expect(s).not.toContain("ghp_");
    expect(s).not.toContain("Dear Ana");
    expect(s).toContain("kernel_email_get");
  });
});

describe("kernel_kernl_bug_report", () => {
  it("is for the chief only", async () => {
    const tool = kernlBugTools({ bugs, service }).find((t) => t.name === "kernel_kernl_bug_report")!;
    const res = await tool.handler({ title: "t", area: "a", diagnosis: "d", __caller_agent_id: workerId });
    expect(text(res)).toMatch(/Only the chief/);
    expect(bugs.list()).toHaveLength(0);
  });

  it("files a report with the run's context and says when it repeats", async () => {
    const run = service.createRun({ agent_id: workerId, trigger_type: "manual", goal: "g" });
    service.updateRun(run.id, { status: "failed", error: "Results paired with the wrong tool" });
    const tool = kernlBugTools({ bugs, service }).find((t) => t.name === "kernel_kernl_bug_report")!;
    const args = { title: "Tool results mislabelled", area: "executor/claude-code", diagnosis: "pairs by last call", run_id: run.id, __caller_agent_id: chiefId };
    expect(text(await tool.handler(args))).toMatch(/Filed Kernl bug/);
    expect(bugs.list()[0]).toMatchObject({ source: "chief", agent_id: workerId, area: "executor/claude-code" });
    expect(text(await tool.handler(args))).toMatch(/already reported/);
  });
});

describe("kernel_kernl_bugs_list", () => {
  it("lists reports by status", async () => {
    bugs.report({ title: "one", error: "e1", source: "operator" });
    const tool = kernlBugTools({ bugs, service }).find((t) => t.name === "kernel_kernl_bugs_list")!;
    expect(text(await tool.handler({ status: "new" }))).toContain("one");
  });
});

describe("buildBugContext · review fixes", () => {
  it("drops the input of message tools too", () => {
    const run = service.createRun({ agent_id: workerId, trigger_type: "manual", goal: "g" });
    service.addStep({ run_id: run.id, step_number: 1, type: "tool_call", tool_name: "mcp__kernel__kernel_email_send", tool_input: { body: "Hola Ana, te paso el contrato" } });
    expect(JSON.stringify(buildBugContext(service, run.id))).not.toContain("contrato");
  });
});
