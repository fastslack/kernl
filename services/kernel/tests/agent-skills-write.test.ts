/**
 * Attaching a skill has to survive the writer it is sent through.
 *
 * `agents.update` builds an explicit key list for `service.updateAgent()`,
 * and `skills` was missing from it. Nothing failed: the handler answered
 * `{ success: true, agent }` with the agent's UNCHANGED row, the dashboard
 * read "did not throw" as "saved", and the badge, the row and the token
 * estimate all moved for a write that never reached the column. The RPC is
 * the path the dashboard actually uses — it only falls back to HTTP when its
 * socket is down — and since the old attach-only panel was deleted, the
 * SKILLS tab is the only surface that writes this column at all.
 *
 * So the test that matters is not "does the normalizer work" but "does a
 * slug sent to each of the two writers come back out of the DB". Both are
 * covered, because a fix applied to one writer and not the other is the
 * exact shape of the bug being closed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { agentsRpcActions } from "../src/modules/agents/rpc-actions.js";
import {
  normalizeSkillsInput,
  MAX_AGENT_SKILLS,
} from "../src/modules/agents/chain-input.js";

function attachedOf(agent: { skills_json?: string } | undefined): string[] {
  if (!agent?.skills_json) return [];
  return JSON.parse(agent.skills_json) as string[];
}

describe("agents.update (RPC) writes skills", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let update: (args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    const action = agentsRpcActions({ service, events }).find((a) => a.name === "agents.update");
    if (!action) throw new Error("agents.update action missing");
    update = action.handler;
  });

  afterEach(() => db.close());

  it("persists an attached slug instead of dropping it (regression)", async () => {
    const agent = service.createAgent({ name: "Writer" });
    await update({ id: agent.id, skills: ["release-notes"] });
    expect(attachedOf(service.getAgent(agent.id))).toEqual(["release-notes"]);
  });

  it("hands back a row that already carries the write, so a caller can verify it", async () => {
    const agent = service.createAgent({ name: "Writer" });
    const res = (await update({ id: agent.id, skills: ["a", "b"] })) as { agent: { skills_json?: string } };
    expect(attachedOf(res.agent)).toEqual(["a", "b"]);
  });

  it("detaches on an explicit empty list", async () => {
    const agent = service.createAgent({ name: "Writer" });
    await update({ id: agent.id, skills: ["a"] });
    await update({ id: agent.id, skills: [] });
    expect(attachedOf(service.getAgent(agent.id))).toEqual([]);
  });

  it("leaves the column alone when the caller says nothing about skills", async () => {
    const agent = service.createAgent({ name: "Writer" });
    await update({ id: agent.id, skills: ["a"] });
    await update({ id: agent.id, name: "Renamed" });
    const after = service.getAgent(agent.id);
    expect(after!.name).toBe("Renamed");
    expect(attachedOf(after)).toEqual(["a"]);
  });

  it("does not clear the list when handed something it cannot read", async () => {
    const agent = service.createAgent({ name: "Writer" });
    await update({ id: agent.id, skills: ["a"] });
    await update({ id: agent.id, skills: "release-notes" });
    expect(attachedOf(service.getAgent(agent.id))).toEqual(["a"]);
  });

  it("drops members that are not slugs rather than storing them", async () => {
    const agent = service.createAgent({ name: "Writer" });
    await update({ id: agent.id, skills: ["ok", { slug: "nope" }, 7, null, "  ", " spaced "] });
    expect(attachedOf(service.getAgent(agent.id))).toEqual(["ok", "spaced"]);
  });
});

describe("PUT /api/agents/:id writes skills through the same normalizer", () => {
  // The route body reaches `service.updateAgent` as `{...body, skills:
  // normalizeSkillsInput(body.skills)}`; that expression is what is exercised
  // here, since KernelHttpServer is not built for unit-test isolation (same
  // reasoning as agent-api-routes.test.ts).
  it("accepts what the RPC accepts and refuses what it refuses", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    const service = new AgentService(db, new EventBus());
    const agent = service.createAgent({ name: "Route" });

    const body: { name?: string; skills?: unknown } = { name: "Route", skills: ["a", "a", "b"] };
    service.updateAgent(agent.id, { ...body, skills: normalizeSkillsInput(body.skills) });
    expect(attachedOf(service.getAgent(agent.id))).toEqual(["a", "b"]);

    const junk: { skills?: unknown } = { skills: { a: 1 } };
    service.updateAgent(agent.id, { ...junk, skills: normalizeSkillsInput(junk.skills) });
    expect(attachedOf(service.getAgent(agent.id))).toEqual(["a", "b"]);

    db.close();
  });
});

describe("normalizeSkillsInput", () => {
  it("says nothing when the caller said nothing", () => {
    expect(normalizeSkillsInput(undefined)).toBeUndefined();
    expect(normalizeSkillsInput(null)).toBeUndefined();
  });

  it("says nothing rather than detaching everything on a non-array", () => {
    expect(normalizeSkillsInput("a,b")).toBeUndefined();
    expect(normalizeSkillsInput(42)).toBeUndefined();
    expect(normalizeSkillsInput({ 0: "a" })).toBeUndefined();
  });

  it("treats an explicit empty array as detach everything", () => {
    expect(normalizeSkillsInput([])).toEqual([]);
  });

  it("keeps order and drops duplicates", () => {
    expect(normalizeSkillsInput(["b", "a", "b"])).toEqual(["b", "a"]);
  });

  it("rejects a slug long enough to be prompt payload", () => {
    // Every attached slug is written into the agent's system prompt on every
    // run (SkillBodyResolver.buildPromptIndex), which is why the cap exists.
    expect(normalizeSkillsInput(["x".repeat(129)])).toEqual([]);
    expect(normalizeSkillsInput(["x".repeat(128)])).toEqual(["x".repeat(128)]);
  });

  it("stops at the per-agent cap", () => {
    const many = Array.from({ length: MAX_AGENT_SKILLS + 10 }, (_, i) => `s${i}`);
    expect(normalizeSkillsInput(many)).toHaveLength(MAX_AGENT_SKILLS);
  });
});
