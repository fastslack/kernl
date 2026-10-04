import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { OutboxService } from "../src/modules/projects/outbox-service.js";
import { outboxTools } from "../src/modules/projects/tools.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { agentsTools } from "../src/modules/agents/tools.js";
import { EventBus } from "../src/core/event-bus.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";

describe("native executor runs for a project", () => {
  it("drafts through the outbox and stamps colleague letters with the project", async () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    const root = mkdtempSync(join(tmpdir(), "nat-"));
    const projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    const outbox = new OutboxService(db, events, projects, () => {});
    outbox.registerChannel("x_post", { validate: () => ({ ok: true }), preview: () => ({ title: "", body: "" }), send: async () => ({ ref: "r" }) });
    const agents = new AgentService(db, events);
    agents.setProjectGate(projects.gate());
    const flowId = agents.createFlow({ name: "Marketing" }).id;
    const writer = agents.createAgent({ name: "Writer", flow_id: flowId, system_prompt: "x", provider: "alpha", model: "a1" });
    const editor = agents.createAgent({ name: "Editor", flow_id: flowId, system_prompt: "x", wake_on_inbox: false });
    const pid = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.assignOffice(flowId, pid);
    projects.link(pid, "social_account", "twitter:1");

    const ex = new AgentExecutor();
    ex.setConfig({ language: "en", agents: { defaultModelChain: [{ provider: "alpha", model: "a1" }] } } as never);
    ex.setKernelTools([
      ...agentsTools(agents, ex, events),
      ...outboxTools(outbox, (id) => agents.getRun(id), (aid) => agents.getAgent(aid)?.flow_id ?? ""),
    ]);
    const script = [
      { content: "", tokens_used: 1, model: "a1", tool_calls: [{ type: "tool_use", id: "t1", name: "kernel_outbox_propose", input: { channel: "x_post", account_ref: "twitter:1", payload: { text: "hola" } } }] },
      { content: "", tokens_used: 1, model: "a1", tool_calls: [{ type: "tool_use", id: "t2", name: "kernel_agents_post_to_colleague", input: { to_agent_id: editor.id, subject: "review", body: "please" } }] },
      { content: "done", tokens_used: 1, model: "a1" },
    ];
    let i = 0;
    const alpha = { name: "alpha", available: () => true, async chatCompletion() { return script[Math.min(i++, script.length - 1)]; } } as unknown as ChatLlmProvider;
    ex.setProviders(new Map([["alpha", alpha]]), "alpha");

    const run = agents.createRun({ agent_id: writer.id, goal: "post", project_id: pid });
    const res = await ex.execute({ agent: agents.getAgent(writer.id)!, goal: "post", run, service: agents, events });
    expect(res.status).toBe("completed");
    expect(outbox.list({ project_id: pid }).map((d) => ({ status: d.status, run_id: d.run_id, flow_id: d.flow_id })))
      .toEqual([{ status: "draft", run_id: run.id, flow_id: flowId }]);
    expect(agents.getUnreadInbox(editor.id)[0].project_id).toBe(pid);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
