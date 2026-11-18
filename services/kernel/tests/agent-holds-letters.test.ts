import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { letterProblem, letterTypeOf, jsonObjectsIn, parseLetterSchemas } from "../src/modules/agents/letter-schemas.js";

const NOW = new Date("2026-11-15T13:08:00Z");

describe("holds and snoozes on a work item", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
  });
  afterEach(() => db.close());

  // A "keep waiting" answer snoozed an item for 24 h; nobody could see who did it or lift it.
  it("a snooze is listed with its reason and owner until its time, then it is gone on its own", () => {
    const h = service.holds.place({ flow_id: "dev", subject_key: "APP#42", kind: "snooze", minutes: 24 * 60,
      reason: "keep waiting", owner: "operator", now: NOW });
    expect(h.until).toBe("2026-11-16T13:08:00.000Z");
    expect(service.holds.active("dev", "app#42", NOW).map((x) => x.reason)).toEqual(["keep waiting"]);
    expect(service.holds.active("dev", "app#42", new Date("2026-11-16T13:09:00Z"))).toEqual([]);
  });

  it("a hold stays until lifted, and lifting it tells the agent named for it", () => {
    const watcher = service.createAgent({ name: "Lead" });
    const h = service.placeSubjectHold({ flow_id: "dev", subject_key: "app#42", kind: "hold", reason: "the operator has it",
      owner: "operator", notify_agent_id: watcher.id });
    expect(service.holds.active("dev").length).toBe(1);
    expect(service.liftSubjectHold(h.id, "operator")?.lifted_by).toBe("operator");
    expect(service.holds.active("dev")).toEqual([]);
    expect(service.liftSubjectHold(h.id, "operator")).toBeNull();
    const letters = db.query("SELECT subject, body FROM agent_office_inbox WHERE to_agent_id=?").all(watcher.id) as Array<{ subject: string; body: string }>;
    expect(letters.map((l) => l.subject)).toEqual(["HOLD-LIFTED app#42"]);
    expect(letters[0].body).toContain("the operator has it");
  });

  it("a new hold replaces the item's active one; other offices and items are untouched", () => {
    service.holds.place({ flow_id: "dev", subject_key: "app#1", kind: "hold", reason: "a", owner: "x", now: NOW });
    service.holds.place({ flow_id: "dev", subject_key: "app#2", kind: "hold", reason: "b", owner: "x", now: NOW });
    service.holds.place({ flow_id: "other", subject_key: "app#1", kind: "hold", reason: "c", owner: "x", now: NOW });
    service.holds.place({ flow_id: "dev", subject_key: "app#1", kind: "snooze", minutes: 10, reason: "d", owner: "y", now: NOW });
    expect(service.holds.active("dev", undefined, NOW).map((h) => `${h.subject_key}:${h.reason}`).sort()).toEqual(["app#1:d", "app#2:b"]);
    expect(service.holds.active("other", undefined, NOW).map((h) => h.reason)).toEqual(["c"]);
  });

  it("refuses a hold with no reason, a snooze with no end or one in the past", () => {
    expect(() => service.holds.place({ flow_id: "dev", subject_key: "app#1", kind: "hold", reason: " ", owner: "x" })).toThrow();
    expect(() => service.holds.place({ flow_id: "dev", subject_key: "app#1", kind: "snooze", reason: "r", owner: "x" })).toThrow();
    expect(() => service.holds.place({ flow_id: "dev", subject_key: "app#1", kind: "snooze", until: "2026-11-01T00:00:00Z",
      reason: "r", owner: "x", now: NOW })).toThrow();
  });
});

const E2E_RED = { type: "E2E-RED", required: ["key", "e2e_file", "tail"], equals: { verdict: "red" },
  example: '{"key": "app#123", "verdict": "red", "e2e_file": "e2e/issue-123.json", "tail": "Total 2, Failed 1"}' };

describe("letter schemas", () => {
  it("reads the type and the JSON blocks", () => {
    expect(letterTypeOf("E2E-RED app#42")).toBe("E2E-RED");
    expect(letterTypeOf("APPROVED: app#1")).toBe("APPROVED");
    expect(jsonObjectsIn("texto\n```json\n{\"a\":1}\n```\nmás ```{\"b\":2}```")).toEqual([{ a: 1 }, { b: 2 }]);
    expect(jsonObjectsIn('{"a": 1}')).toEqual([{ a: 1 }]);
    expect(jsonObjectsIn("sin json")).toEqual([]);
  });

  // A red end-to-end report carried no verdict; the orchestrator answered "invalid letter" after the run.
  it("refuses a letter of a registered type that lacks its fields, and says what to send", () => {
    const body = "Red after the merge.\n```json\n{\"key\": \"app#42\", \"failed\": 1, \"e2e_file\": \"e2e/x.json\", \"tail\": \"…\"}\n```";
    const p = letterProblem([E2E_RED], "E2E-RED app#42", body);
    expect(p).toContain('lacks "verdict": "red"');
    expect(p).toContain("e2e/issue-123.json");
    expect(letterProblem([E2E_RED], "E2E-RED app#42", "no block")).toContain("has no ```json block");
  });

  it("passes a complete letter, and any letter of a type with no schema", () => {
    const ok = "```json\n{\"key\": \"app#42\", \"verdict\": \"Red\", \"e2e_file\": \"e2e/x.json\", \"tail\": \"Failed 1\"}\n```";
    expect(letterProblem([E2E_RED], "E2E-RED app#42", ok)).toBeNull();
    expect(letterProblem([E2E_RED], "NOTE app#42", "anything")).toBeNull();
  });

  it("parses what an API client sends, and refuses a malformed list", () => {
    expect(parseLetterSchemas([E2E_RED])[0]).toMatchObject({ type: "E2E-RED", required: ["key", "e2e_file", "tail"] });
    expect(() => parseLetterSchemas([{ type: "lower", required: ["a"] }])).toThrow();
    expect(() => parseLetterSchemas([{ type: "OK" }])).toThrow();
    expect(() => parseLetterSchemas({})).toThrow();
  });

  it("postToColleague refuses the letter to an office that registered its type, and lets others through", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const service = new AgentService(db, new EventBus());
    const flow = service.createFlow({ name: "Dev" });
    const qa = service.createAgent({ name: "QA", flow_id: flow.id });
    const lead = service.createAgent({ name: "Lead", flow_id: flow.id });
    const outsider = service.createAgent({ name: "Outsider" });
    service.letterSchemas.replace(flow.id, [E2E_RED]);
    const bad = service.postToColleague({ from_agent_id: qa.id, to_agent_id: lead.id, subject: "E2E-RED app#42", body: "{}" });
    expect(bad.message).toBeNull();
    expect(bad.error).toContain("verdict");
    expect(service.postToColleague({ from_agent_id: qa.id, to_agent_id: lead.id, subject: "NOTE app#42", body: "x" }).message).not.toBeNull();
    expect(service.postToColleague({ from_agent_id: lead.id, to_agent_id: outsider.id, subject: "E2E-RED app#1", body: "{}" }).message).not.toBeNull();
    db.close();
  });
});

describe("a host process asking the same open question twice", () => {
  it("finds the open question by its text, spacing and case aside, and not an answered one", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const service = new AgentService(db, new EventBus());
    const a = service.createAgent({ name: "QA" });
    const opts = [{ label: "Yes" }, { label: "No" }];
    const { id } = service.createQuestion({ from_agent_id: a.id, flow_id: "dev", question: "Approve api!7?", options: opts, for_operator: true });
    expect(service.findOpenQuestionByText("dev", "  approve   API!7? ")?.id).toBe(id);
    expect(service.findOpenQuestionByText("other", "Approve api!7?")).toBeNull();
    service.answerQuestion(id, { selected_index: 0, selected_option: "Yes", answered_by: "human" });
    expect(service.findOpenQuestionByText("dev", "Approve api!7?")).toBeNull();
    db.close();
  });
});
