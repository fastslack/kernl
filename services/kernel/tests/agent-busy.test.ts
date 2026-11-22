import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { setAgentsBusy, listAgentsBusy, clearAgentsBusy } from "../src/sdk/agent-busy.js";

afterEach(clearAgentsBusy);

describe("agents busy outside a run", () => {
  it("keeps one set per source, replaced on each report and cleared by an empty one", () => {
    setAgentsBusy("devops", [{ agent: "coder-1", tag: "web #12", title: "preview-up" }]);
    setAgentsBusy("other", [{ agent: "coder-2" }]);
    setAgentsBusy("devops", [{ agent: "coder-3", tag: "api #7" }]);
    expect(listAgentsBusy().map((b) => `${b.source}:${b.agent}`).sort()).toEqual(["devops:coder-3", "other:coder-2"]);
    setAgentsBusy("devops", []);
    expect(listAgentsBusy().map((b) => b.agent)).toEqual(["coder-2"]);
  });

  // A source that stopped reporting (an extension turned off mid-check) must not leave its agents working for good.
  it("a set not renewed within its TTL drops", () => {
    setAgentsBusy("devops", [{ agent: "coder-1" }], 1_000, 10_000);
    expect(listAgentsBusy(10_500)).toHaveLength(1);
    expect(listAgentsBusy(11_000)).toHaveLength(0);
  });

  it("ignores items with no agent", () => {
    setAgentsBusy("devops", [{ agent: "" }, { agent: "coder-1" }, null as never]);
    expect(listAgentsBusy().map((b) => b.agent)).toEqual(["coder-1"]);
  });

  it("the agent graph lists them by id, whether reported by id or by slug, and drops agents it does not know", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const service = new AgentService(db, new EventBus());
    const a = service.createAgent({ name: "Coder A" });
    const b = service.createAgent({ name: "Coder B" });
    db.run("UPDATE agents SET slug = 'coder-b' WHERE id = ?", [b.id]);
    setAgentsBusy("devops", [{ agent: a.id, tag: "web #1", title: "e2e-url" }, { agent: "coder-b", tag: "api #2" }, { agent: "nobody" }]);
    expect(service.getAgentGraph().busy).toEqual([
      { agent_id: a.id, tag: "web #1", title: "e2e-url" },
      { agent_id: b.id, tag: "api #2", title: "" },
    ]);
    db.close();
  });
});
