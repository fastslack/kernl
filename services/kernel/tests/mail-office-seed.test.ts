import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { seedMailOffice, SEND_TOOLS } from "../scripts/seeds/mail-office.js";

let db: Database;
let service: AgentService;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db as any, new EventBus());
  const ops = service.createFlow({ name: "Operaciones" } as any);
  const career = service.createFlow({ name: "Career Office" } as any);
  for (const [n, f] of [["Iris", ops.id], ["Tobias", ops.id], ["Nadia", ops.id], ["Pitch", career.id], ["Career Lead", career.id]] as const) {
    service.createAgent({ name: n, description: n, flow_id: f, active: true } as any);
  }
});
afterEach(() => db.close());

function tools(name: string): string[] {
  return JSON.parse((db.query("SELECT allowed_tools FROM agents WHERE name = ?").get(name) as any).allowed_tools);
}

function denied(name: string): string[] {
  return JSON.parse((db.query("SELECT denied_tools FROM agents WHERE name = ?").get(name) as any).denied_tools);
}

describe("seedMailOffice", () => {
  it("Tobias and Pitch can draft for Gmail-only mail; Tobias can also reply-draft", () => {
    seedMailOffice(db as any, service);
    expect(tools("Tobias")).toContain("kernel_comms_create");
    expect(tools("Tobias")).toContain("kernel_comms_reply");
    expect(tools("Pitch")).toContain("kernel_comms_create");
    const pitch = (db.query("SELECT system_prompt FROM agents WHERE name='Pitch'").get() as any).system_prompt as string;
    expect(pitch).toContain("google_emails");
    expect(pitch).toContain("kernel_comms_create");
  });

  it("Tobias is told never to write to Email Triage", () => {
    seedMailOffice(db as any, service);
    const prompt = (db.query("SELECT system_prompt FROM agents WHERE name='Tobias'").get() as any).system_prompt as string;
    expect(prompt).toContain("Never write to Email Triage; it is an automated sender.");
  });

  it("an older Pitch addendum is replaced in place, not left stale", () => {
    db.prepare("UPDATE agents SET system_prompt = ? WHERE name = 'Pitch'")
      .run("You are Pitch.\n\n## Mail hand-offs from Tobias\nOLD-LINE\n\n## Other section\nkeep me");
    seedMailOffice(db as any, service);
    const prompt = (db.query("SELECT system_prompt FROM agents WHERE name='Pitch'").get() as any).system_prompt as string;
    expect(prompt).not.toContain("OLD-LINE");
    expect(prompt).toContain("kernel_comms_create");
    expect(prompt).toContain("## Other section\nkeep me");
    expect(prompt.split("## Mail hand-offs from Tobias").length - 1).toBe(1);
  });

  it("every Career Office agent with a tool list gets inbox + ack; an all-tools agent stays all-tools and is reported", () => {
    const career = (db.query("SELECT id FROM agent_flows WHERE name='Career Office'").get() as any).id;
    for (const n of ["Analyst", "Writer", "Recruiter Desk"]) {
      service.createAgent({ name: n, description: n, flow_id: career, active: true } as any);
      db.prepare("UPDATE agents SET allowed_tools = ? WHERE name = ?").run(JSON.stringify(["kernel_notes_search"]), n);
    }
    service.createAgent({ name: "Scout", description: "Scout", flow_id: career, active: true } as any);
    const res = seedMailOffice(db as any, service) as any;
    for (const n of ["Analyst", "Writer", "Recruiter Desk", "Pitch", "Career Lead"]) {
      expect(tools(n)).toContain("kernel_agents_inbox");
      expect(tools(n)).toContain("kernel_agents_inbox_ack");
    }
    expect(tools("Analyst")).toContain("kernel_notes_search");
    expect(tools("Scout")).toEqual([]);
    expect(res.unrestricted).toContain("Career Office/Scout");
    // idempotent
    seedMailOffice(db as any, service);
    expect(tools("Analyst").filter((t) => t === "kernel_agents_inbox").length).toBe(1);
  });

  it("writes the send tools into denied_tools of every circuit agent, keeping what was there", () => {
    db.prepare("UPDATE agents SET denied_tools = ? WHERE name = 'Pitch'").run(JSON.stringify(["kernel_fs_delete"]));
    seedMailOffice(db as any, service);
    for (const n of ["Iris", "Tobias", "Nadia", "Pitch", "Career Lead"]) {
      for (const t of SEND_TOOLS) expect(denied(n)).toContain(t);
    }
    expect(denied("Pitch")).toContain("kernel_fs_delete");
    expect(denied("Pitch")).not.toContain("kernel_comms_request_missing_info");
    seedMailOffice(db as any, service);
    expect(denied("Pitch").length).toBe(SEND_TOOLS.length + 1);
  });

  it("no office agent keeps the all-tools default", () => {
    seedMailOffice(db as any, service);
    for (const n of ["Iris", "Tobias", "Nadia", "Pitch", "Career Lead"]) expect(tools(n).length).toBeGreaterThan(0);
  });

  it("only Pitch can send, and only through request_missing_info", () => {
    seedMailOffice(db as any, service);
    for (const n of ["Iris", "Tobias", "Nadia", "Pitch", "Career Lead"]) {
      for (const t of SEND_TOOLS) expect(tools(n)).not.toContain(t);
    }
    expect(tools("Pitch")).toContain("kernel_comms_request_missing_info");
    expect(tools("Tobias")).not.toContain("kernel_comms_request_missing_info");
  });

  it("everyone who gets letters can ack them", () => {
    seedMailOffice(db as any, service);
    for (const n of ["Tobias", "Nadia", "Pitch", "Career Lead"]) expect(tools(n)).toContain("kernel_agents_inbox_ack");
  });

  it("Nadia opts out of reflection", () => {
    seedMailOffice(db as any, service);
    const v = JSON.parse((db.query("SELECT variables FROM agents WHERE name='Nadia'").get() as any).variables || "{}");
    expect(v.reflection_opt_out).toBe(true);
  });

  it("is idempotent", () => {
    seedMailOffice(db as any, service);
    const first = tools("Tobias");
    seedMailOffice(db as any, service);
    expect(tools("Tobias")).toEqual(first);
  });

  it("running the seed twice leaves exactly 1 Iris schedule", () => {
    seedMailOffice(db as any, service);
    seedMailOffice(db as any, service);
    expect(db.query("SELECT COUNT(*) n FROM agent_schedules").get()).toEqual({ n: 1 });
  });

  it("a missing agent is reported in missing and doesn't throw", () => {
    db.prepare("DELETE FROM agents WHERE name = ?").run("Nadia");
    let result: { updated: string[]; missing: string[] } | undefined;
    expect(() => { result = seedMailOffice(db as any, service); }).not.toThrow();
    expect(result!.missing).toContain("Operaciones/Nadia");
    expect(result!.updated).not.toContain("Operaciones/Nadia");
  });

  it("deletes a dangling chain row but keeps a valid one", () => {
    const tobias = (db.query("SELECT id FROM agents WHERE name='Tobias'").get() as any).id;
    const nadia = (db.query("SELECT id FROM agents WHERE name='Nadia'").get() as any).id;
    db.prepare(
      "INSERT INTO agent_chains (id, source_agent_id, target_agent_id, created_at) VALUES (?, ?, ?, ?)",
    ).run("valid-chain", tobias, nadia, new Date().toISOString());
    db.prepare(
      "INSERT INTO agent_chains (id, source_agent_id, target_agent_id, created_at) VALUES (?, ?, ?, ?)",
    ).run("dangling-chain", tobias, "ghost-agent-id", new Date().toISOString());
    seedMailOffice(db as any, service);
    expect(db.query("SELECT id FROM agent_chains WHERE id = 'valid-chain'").get()).toBeTruthy();
    expect(db.query("SELECT id FROM agent_chains WHERE id = 'dangling-chain'").get()).toBeFalsy();
  });

  it("Pitch's prompt addendum is not appended twice on a second run", () => {
    seedMailOffice(db as any, service);
    const first = (db.query("SELECT system_prompt FROM agents WHERE name='Pitch'").get() as any).system_prompt as string;
    seedMailOffice(db as any, service);
    const second = (db.query("SELECT system_prompt FROM agents WHERE name='Pitch'").get() as any).system_prompt as string;
    expect(second).toEqual(first);
    const occurrences = second.split("## Mail hand-offs from Tobias").length - 1;
    expect(occurrences).toBe(1);
  });

  it("Tobias's prompt routes cross-office hand-offs with real to_agent_id UUIDs", () => {
    seedMailOffice(db as any, service);
    const prompt = (db.query("SELECT system_prompt FROM agents WHERE name='Tobias'").get() as any).system_prompt as string;
    const careerLeadId = (db.query("SELECT id FROM agents WHERE name='Career Lead'").get() as any).id as string;
    const pitchId = (db.query("SELECT id FROM agents WHERE name='Pitch'").get() as any).id as string;
    const nadiaId = (db.query("SELECT id FROM agents WHERE name='Nadia'").get() as any).id as string;
    expect(prompt).toContain("to_agent_id");
    expect(prompt).toContain(careerLeadId);
    expect(prompt).toContain(pitchId);
    expect(prompt).toContain(nadiaId);
  });

  it("with Pitch missing, Tobias's prompt has no Pitch id and marks that branch unavailable", () => {
    db.prepare("DELETE FROM agents WHERE name = ?").run("Pitch");
    seedMailOffice(db as any, service);
    const prompt = (db.query("SELECT system_prompt FROM agents WHERE name='Tobias'").get() as any).system_prompt as string;
    expect(prompt).not.toContain("(Pitch)");
    expect(prompt.toLowerCase()).toContain("pitch is unavailable");
    // Career Lead and Nadia are still resolvable — only the Pitch branch degrades.
    const careerLeadId = (db.query("SELECT id FROM agents WHERE name='Career Lead'").get() as any).id as string;
    const nadiaId = (db.query("SELECT id FROM agents WHERE name='Nadia'").get() as any).id as string;
    expect(prompt).toContain(careerLeadId);
    expect(prompt).toContain(nadiaId);
  });

  it("running the seed twice yields an identical Tobias prompt", () => {
    seedMailOffice(db as any, service);
    const first = (db.query("SELECT system_prompt FROM agents WHERE name='Tobias'").get() as any).system_prompt as string;
    seedMailOffice(db as any, service);
    const second = (db.query("SELECT system_prompt FROM agents WHERE name='Tobias'").get() as any).system_prompt as string;
    expect(second).toEqual(first);
  });
});

import { createBuiltinHandlers } from "../src/modules/agents/builtin-handlers.js";

describe("reflectAll", () => {
  it("skips agents with reflection_opt_out", async () => {
    seedMailOffice(db as any, service);
    const seen: string[] = [];
    const handlers = createBuiltinHandlers({
      services: { agentService: service, reflectionOptimizer: { runCycle: async (id: string) => { seen.push(id); return null; } } },
    } as any);
    await handlers.get("evolution:reflect-all")!();
    const nadia = (db.query("SELECT id FROM agents WHERE name='Nadia'").get() as any).id;
    expect(seen).not.toContain(nadia);
  });
});
