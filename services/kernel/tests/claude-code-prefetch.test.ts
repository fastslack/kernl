import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { ClaudeCodeExecutor } from "../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js";
import { TicketDossiers } from "../assets/extensions/agents/agent-advanced/_module/ticket-dossier.js";

describe("Claude Code prompt: the letters, the office and the ticket's dossier come already loaded", () => {
  it("builds them into the system prompt of a run woken by letters", async () => {
    const db = new Database(":memory:");
    runMigrations(db as any, "agents", agentsMigrations);
    const service = new AgentService(db as any, new EventBus());
    const flow = service.createFlow({ name: "Ops" } as any);
    const host = service.createAgent({ name: "Ops Integrador", description: "x", flow_id: flow.id, active: true } as any);
    const qa = service.createAgent({ name: "Ops QA", description: "x", flow_id: flow.id, active: true } as any);
    const { message } = service.postToColleague({ from_agent_id: host.id, to_agent_id: qa.id, subject: "REVISAR-MR web#7", body: "Please review MR !12 at abc123." });
    const ex = new ClaudeCodeExecutor();
    const dossiers = new TicketDossiers(db as any, async () => JSON.stringify({ "web#7": "Estado: MR !12 abierto. Archivos: src/a.ts" }));
    await dossiers.afterRun({ scope: flow.id, projectId: null, runId: "r0", agentName: "Ops QA", goal: "web#7", status: "completed", steps: 9, result: "reviewed", error: "" });
    ex.setDossiers(dossiers);
    const goal = `You have 1 unacknowledged letter(s) in your office inbox: "REVISAR-MR web#7" (id ${message!.id}).`;
    const prompt = (ex as any).buildSystemPrompt(service.getAgent(qa.id), goal, service, null) as string;
    expect(prompt).toContain("Please review MR !12 at abc123.");
    expect(prompt).toContain("Ops Integrador");
    expect(prompt).toContain(host.id);
    expect(prompt).toContain("Estado: MR !12 abierto.");
  });
});
