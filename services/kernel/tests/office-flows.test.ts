import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { applyRepoIsolation, hostIsolationAllowed } from "../src/modules/agents/repo-isolation.js";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";
const UUID_C = "33333333-3333-3333-3333-333333333333";

describe("migration 42 — backfills rows that predate it", () => {
  it("derives kind, source_extension_id and repo_isolation", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations.filter((m) => m.version < 42));
    const now = new Date().toISOString();
    const insertFlow = db.prepare(
      "INSERT INTO agent_flows (id, name, description, color, active, created_at, updated_at) VALUES (?, ?, '', '#000000', 1, ?, ?)",
    );
    insertFlow.run(UUID_A, "DevOps Team", now, now);
    insertFlow.run(UUID_B, "Comunicaciones", now, now);
    insertFlow.run("creativos", "CREATIVOS", now, now);
    insertFlow.run(UUID_C, "Research", now, now);

    const service = new AgentService(db, new EventBus());
    const scene = service.createAgent({ name: "Dibujante", flow_id: "creativos" });
    db.prepare("UPDATE agents SET source_extension_id = ? WHERE id = ?").run("ext-scene", scene.id);
    const builder = service.createAgent({ name: "Builder", flow_id: UUID_A });
    db.prepare("UPDATE agents SET variables = ? WHERE id = ?")
      .run(JSON.stringify({ __cwd_path__: "/repo", __sandbox__: false }), builder.id);

    runMigrations(db, "agents", agentsMigrations);

    const row = (id: string) =>
      db.prepare("SELECT kind, source_extension_id, repo_isolation FROM agent_flows WHERE id = ?").get(id) as {
        kind: string; source_extension_id: string; repo_isolation: string;
      };
    expect(row(UUID_A)).toEqual({ kind: "devops", source_extension_id: "", repo_isolation: "host" });
    expect(row(UUID_B).kind).toBe("communications");
    expect(row("creativos")).toEqual({ kind: "creative", source_extension_id: "ext-scene", repo_isolation: "" });
    expect(row(UUID_C).kind).toBe("general");
    db.close();
  });
});

describe("applyRepoIsolation", () => {
  it("host writes the unsandboxed posture", () => {
    expect(applyRepoIsolation({ __cwd_path__: "/r" }, "host")).toEqual({
      __cwd_path__: "/r", __sandbox__: false, __permission_mode__: "bypassPermissions",
    });
  });
  it("sandbox removes both variables so the executor's safe default applies", () => {
    expect(applyRepoIsolation({ __cwd_path__: "/r", __sandbox__: false, __permission_mode__: "bypassPermissions", keep: 1 }, "sandbox"))
      .toEqual({ __cwd_path__: "/r", keep: 1 });
  });
  it("does not mutate its input", () => {
    const vars = { __sandbox__: false };
    applyRepoIsolation(vars, "sandbox");
    expect(vars).toEqual({ __sandbox__: false });
  });
});

describe("hostIsolationAllowed", () => {
  it("is true only when KERNEL_ALLOW_UNSANDBOXED_AGENTS is exactly 1", () => {
    expect(hostIsolationAllowed({ KERNEL_ALLOW_UNSANDBOXED_AGENTS: "1" })).toBe(true);
    expect(hostIsolationAllowed({ KERNEL_ALLOW_UNSANDBOXED_AGENTS: "true" })).toBe(false);
    expect(hostIsolationAllowed({})).toBe(false);
  });
});

describe("flows — kind and isolation", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
  });
  afterEach(() => db.close());

  it("createFlow stores kind and defaults to general", () => {
    const ops = service.createFlow({ name: "Ops", kind: "devops" });
    const plain = service.createFlow({ name: "Plain" });
    expect(service.getFlow(ops.id)!.kind).toBe("devops");
    expect(service.getFlow(plain.id)!.kind).toBe("general");
  });

  it("createFlow rejects an unknown kind", () => {
    expect(() => service.createFlow({ name: "Castle", kind: "castle" as never })).toThrow(/Invalid office kind/);
  });

  it("updateFlow changes kind and rejects an unknown one", () => {
    const flow = service.createFlow({ name: "Room" });
    expect(service.updateFlow(flow.id, { kind: "creative" })!.kind).toBe("creative");
    expect(() => service.updateFlow(flow.id, { kind: "castle" as never })).toThrow(/Invalid office kind/);
  });

  it("updateFlow repo_isolation rewrites only the office's repo agents", () => {
    const flow = service.createFlow({ name: "Repo office" });
    const repoAgent = service.createAgent({ name: "Builder", flow_id: flow.id });
    db.prepare("UPDATE agents SET variables = ? WHERE id = ?").run(
      JSON.stringify({ __cwd_path__: "/r", __sandbox__: false, __permission_mode__: "bypassPermissions", keep: "yes" }),
      repoAgent.id,
    );
    const writer = service.createAgent({ name: "Writer", flow_id: flow.id });

    service.updateFlow(flow.id, { repo_isolation: "sandbox" });
    expect(JSON.parse(service.getAgent(repoAgent.id)!.variables)).toEqual({ __cwd_path__: "/r", keep: "yes" });
    expect(JSON.parse(service.getAgent(writer.id)!.variables || "{}").__sandbox__).toBeUndefined();
    expect(service.getFlow(flow.id)!.repo_isolation).toBe("sandbox");

    service.updateFlow(flow.id, { repo_isolation: "host" });
    expect(JSON.parse(service.getAgent(repoAgent.id)!.variables)).toEqual({
      __cwd_path__: "/r", keep: "yes", __sandbox__: false, __permission_mode__: "bypassPermissions",
    });
  });

  it("updateFlow rejects an unknown repo_isolation", () => {
    const flow = service.createFlow({ name: "Room" });
    expect(() => service.updateFlow(flow.id, { repo_isolation: "yolo" as never })).toThrow(/Invalid repo_isolation/);
  });
});

describe("deleteFlow", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
  });
  afterEach(() => db.close());

  it("unassigns and pauses the office's agents and reports how many moved", () => {
    const flow = service.createFlow({ name: "Code Review" });
    const lead = service.createAgent({ name: "Lead", flow_id: flow.id });
    const qa = service.createAgent({ name: "QA", flow_id: flow.id });
    const other = service.createAgent({ name: "Elsewhere" });

    expect(service.deleteFlow(flow.id)).toEqual({ unassigned: 2 });
    for (const id of [lead.id, qa.id]) {
      const a = service.getAgent(id)!;
      expect(a.flow_id).toBe("");
      expect(a.active).toBe(0);
    }
    expect(service.getAgent(other.id)!.active).toBe(1);
    expect(service.getFlow(flow.id)!.active).toBe(0);
  });

  it("keeps the top-rank agent active", () => {
    const now = new Date().toISOString();
    const insertRank = db.prepare("INSERT INTO agent_ranks (id, name, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    insertRank.run("rank-top-test", "Top", 99, now, now);
    insertRank.run("rank-low-test", "Low", 0, now, now);
    const flow = service.createFlow({ name: "Management" });
    const chief = service.createAgent({ name: "Chief", flow_id: flow.id, rank_id: "rank-top-test" });
    const aide = service.createAgent({ name: "Aide", flow_id: flow.id, rank_id: "rank-low-test" });

    service.deleteFlow(flow.id);
    expect(service.getAgent(chief.id)!.active).toBe(1);
    expect(service.getAgent(chief.id)!.flow_id).toBe("");
    expect(service.getAgent(aide.id)!.active).toBe(0);
  });

  it("returns null for an unknown office", () => {
    expect(service.deleteFlow("nope")).toBeNull();
  });

  it("rolls back the agent updates when the flow update fails (single transaction)", () => {
    const flow = service.createFlow({ name: "Rollback Office" });
    const lead = service.createAgent({ name: "Lead", flow_id: flow.id });

    db.run(
      `CREATE TRIGGER office_delete_boom
         BEFORE UPDATE ON agent_flows
         WHEN NEW.active = 0 AND OLD.id = '${flow.id}'
       BEGIN
         SELECT RAISE(ABORT, 'boom');
       END`,
    );

    expect(() => service.deleteFlow(flow.id)).toThrow(/boom/);

    const leadAfter = service.getAgent(lead.id)!;
    expect(leadAfter.flow_id).toBe(flow.id);
    expect(leadAfter.active).toBe(1);
    expect(service.getFlow(flow.id)!.active).toBe(1);
  });
});
