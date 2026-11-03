import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { findDuplicateQuestion, duplicateReply } from "../src/modules/agents/question-dedupe.js";
import type { AgentQuestion } from "../src/modules/agents/service.js";

// Growth asked the operator "which repo owns miniatura.lat?" six times, from
// different agents, each worded differently. A question the office already
// has open (or answered lately) is not filed again.

const q = (over: Partial<AgentQuestion>): AgentQuestion => ({
  id: "q1", from_agent_id: "a1", flow_id: "growth-office", meeting_id: "", run_id: "",
  question: "¿Qué repo es dueño de miniatura.lat?", context: "", options: [],
  status: "pending", selected_option: "", selected_index: -1, answered_note: "", answered_at: null,
  answered_by: "", chief_note: "", triage_started_at: null, created_at: "2026-10-28T14:03:33.113Z",
  opinion_status: "", opinion_run_id: "", opinion: null, opinion_error: "", opinion_at: null,
  owed_at: null, reminded_at: null, for_operator: true, ...over,
});

describe("findDuplicateQuestion", () => {
  test("the same text, punctuation aside, is caught without asking the judge", async () => {
    let calls = 0;
    const dup = await findDuplicateQuestion({ question: "¿qué repo es dueño de miniatura.lat", context: "" }, [q({})],
      async () => { calls++; return { duplicate_of: null }; });
    expect(dup?.id).toBe("q1");
    expect(calls).toBe(0);
  });

  test("a reworded question goes to the judge, and only an id it was shown counts", async () => {
    const cands = [q({}), q({ id: "q2", question: "¿Reactivás el Prospector?" })];
    const ask = { question: "¿A qué repo van los pedidos de Desarrollo para miniatura.lat?", context: "" };
    expect((await findDuplicateQuestion(ask, cands, async () => ({ duplicate_of: "q1" })))?.id).toBe("q1");
    expect(await findDuplicateQuestion(ask, cands, async () => ({ duplicate_of: "invented" }))).toBeNull();
    expect(await findDuplicateQuestion(ask, cands, async () => ({ duplicate_of: null }))).toBeNull();
  });

  test("a judge that fails files the question", async () => {
    const dup = await findDuplicateQuestion({ question: "otra cosa", context: "" }, [q({})], async () => { throw new Error("429"); });
    expect(dup).toBeNull();
  });

  test("the reply tells the agent the answer when there is one", () => {
    const answered = q({ status: "answered", answered_at: "2026-10-20T11:00:00.000Z", selected_option: "Embudo sin medición", answered_note: "no re-preguntar" });
    const text = duplicateReply(answered, () => "Growth Lead");
    expect(text).toContain("already answered on 2026-10-20");
    expect(text).toContain("«Embudo sin medición»");
    expect(duplicateReply(q({}), () => "Enlace Desarrollo")).toContain("waiting with the operator");
  });
});

describe("AgentService.findDuplicateQuestion", () => {
  let agents: AgentService;
  beforeEach(() => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    agents = new AgentService(db, new EventBus());
  });

  const ask = (from: string, flow: string, question: string) =>
    agents.createQuestion({ from_agent_id: from, flow_id: flow, question, options: [{ label: "Sí" }, { label: "No" }], for_operator: true });

  test("looks across the office, not only at the asking agent, and never at other offices", async () => {
    ask("liaison", "growth-office", "¿Qué repo es dueño de miniatura.lat?");
    ask("dev", "acme-dev", "¿Mergeo el MR 12?");
    const seen: string[] = [];
    agents.setQuestionJudge(async (o) => { seen.push(o.user); return { duplicate_of: null }; });

    const exact = await agents.findDuplicateQuestion({ from_agent_id: "seo", flow_id: "growth-office", question: "¿Qué repo es dueño de miniatura.lat?" });
    expect(exact?.from_agent_id).toBe("liaison");

    await agents.findDuplicateQuestion({ from_agent_id: "seo", flow_id: "growth-office", question: "¿Mergeo el MR 12?" });
    expect(seen[0]).toContain("miniatura.lat");
    expect(seen[0].split("OFFICE QUESTIONS:")[1]).not.toContain("Mergeo");
  });

  test("dismissed questions are not candidates", async () => {
    const { id } = ask("liaison", "growth-office", "¿Qué repo es dueño de miniatura.lat?");
    agents.dismissQuestion(id);
    const dup = await agents.findDuplicateQuestion({ from_agent_id: "seo", flow_id: "growth-office", question: "¿Qué repo es dueño de miniatura.lat?" });
    expect(dup).toBeNull();
  });
});
