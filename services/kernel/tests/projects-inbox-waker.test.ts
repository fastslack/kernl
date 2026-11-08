import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { InboxWaker } from "../assets/extensions/agents/agent-advanced/_module/inbox-waker.js";
import { EventBus } from "../src/core/event-bus.js";

describe("inbox waker and projects", () => {
  let db: InstanceType<typeof Database>; let agents: AgentService; let projects: ProjectsService; let root: string;
  let from: string; let to: string; let acme: string; let waker: InboxWaker;

  const letter = (subject: string, projectId: string | null, minutesAgo: number) =>
    db.prepare(
      `INSERT INTO agent_office_inbox (id, flow_id, from_agent_id, to_agent_id, subject, body, status, related_run_id, created_at, read_at, project_id)
       VALUES (?, '', ?, ?, ?, 'b', 'unread', '', ?, NULL, ?)`,
    ).run(`m-${subject}`, from, to, subject, new Date(Date.now() - minutesAgo * 60_000).toISOString(), projectId);

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "wake-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    agents = new AgentService(db, events);
    agents.setProjectGate(projects.gate());
    const flowId = agents.createFlow({ name: "Ventas" }).id;
    from = agents.createAgent({ name: "Scout", flow_id: flowId }).id;
    to = agents.createAgent({ name: "Closer", flow_id: flowId }).id;
    acme = projects.create({ slug: "acme", name: "Acme", brief: { value_prop: "v", audience: "a" } }).id;
    projects.assignOffice(flowId, acme);
    const executor = new AgentExecutor();
    (executor as unknown as { execute: unknown }).execute = async () =>
      ({ status: "completed", result: "ok", error: "", steps_count: 0, tokens_used: 0 });
    waker = new InboxWaker(agents, executor, events, { quietMs: 1000 });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  // 20/10: switching the Acme office off left host-ops' letters waking its agents: the switch must hold them.
  it("an office switched off is not woken by its letters, which wait for it to come back on", async () => {
    const flowId = agents.getAgent(to)!.flow_id;
    agents.setFlowPaused(flowId, true);
    letter("held", null, 30);
    await (waker as unknown as { onInboxPost(p: unknown): Promise<void> }).onInboxPost({
      message_id: "m-held", to_agent_id: to, from_agent_id: from, subject: "held", project_id: null,
    });
    expect(await waker.sweep()).toBe(0);
    expect(agents.listRuns({ agent_id: to })).toHaveLength(0);
    expect(db.prepare("SELECT status, wake_attempts FROM agent_office_inbox WHERE id = 'm-held'").get()).toMatchObject({ status: "unread", wake_attempts: 0 });
    agents.setFlowPaused(flowId, false);
    expect(await waker.sweep()).toBe(1);
  });

  it("a post-triggered wake runs for the letter's project", async () => {
    letter("lead", acme, 0);
    await (waker as unknown as { onInboxPost(p: unknown): Promise<void> }).onInboxPost({
      message_id: "m-lead", to_agent_id: to, from_agent_id: from, subject: "lead", project_id: acme,
    });
    expect(agents.listRuns({ agent_id: to })[0].project_id).toBe(acme);
  });

  it("the sweep wakes for the oldest letter's project and only counts that project's letters", async () => {
    letter("old-acme", acme, 30);
    letter("plain", null, 20);
    expect(await waker.sweep()).toBe(1);
    const run = agents.listRuns({ agent_id: to })[0];
    expect(run.project_id).toBe(acme);
    expect(JSON.parse(run.trigger_payload).inbox_message_ids.sort()).toEqual(["m-old-acme", "m-plain"]);
  });

  it("a letter for a project the office no longer serves does not crash the sweep", async () => {
    projects.update(acme, { status: "paused" });
    letter("old-acme", acme, 30);
    expect(await waker.sweep()).toBe(0);
    expect(agents.listRuns({ agent_id: to }).length).toBe(0);
  });
});
