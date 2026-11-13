import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { answerByPrecedent, resolveHumanChoice } from "../src/modules/agents/question-delivery.js";
import { isHoldout } from "../src/modules/agents/services/decisions-service.js";
import { OperatorComms } from "../src/core/operator-comms/driver.js";
import type { OperatorChannelAdapter, OperatorMessage } from "../src/core/operator-comms/types.js";

// Replayed on one office's five weeks: a category's usual answer was right
// 86–92 % where it was clear; the last answer on the same subject only 48 %.
// So the first is suggested with its measured precision (and may answer alone
// when the office allows it); the second is only shown.

const OPTS = [{ label: "Aprobar y mergear" }, { label: "Pedir cambios" }, { label: "Lo reviso yo", task: true }];
const FLOW = "office-1";
const executor = { execute: async () => ({ status: "completed", result: "", steps_count: 0, tokens_used: 0 }) } as never;

describe("decisions", () => {
  let db: InstanceType<typeof Database>; let s: AgentService; let events: EventBus; let qa: string; let asked: string[];
  beforeEach(() => {
    db = new Database(":memory:"); runMigrations(db, "agents", agentsMigrations);
    events = new EventBus(); s = new AgentService(db, events);
    qa = s.createAgent({ name: "QA", flow_id: FLOW } as never).id;
    asked = [];
    events.on("agent:question_asked" as never, (p: never) => { asked.push((p as { question_id: string }).question_id); });
  });
  afterEach(() => db.close());

  const ask = (subject = "web#1", category = "approve-mr") =>
    s.createQuestion({ from_agent_id: qa, flow_id: FLOW, question: `¿Apruebo el MR de ${subject}?`, options: OPTS, for_operator: true, subject_key: subject, category }).id;
  /** n earlier answers in the category, `usual` of them the first option, all a day back. */
  const history = (n: number, usual: number, category = "approve-mr") => {
    for (let i = 0; i < n; i++) {
      const id = ask(`web#${100 + i}`, category);
      s.answerQuestion(id, i < usual ? { selected_index: 0, selected_option: OPTS[0].label, answered_by: "human" } : { selected_index: 1, selected_option: OPTS[1].label, answered_by: "human" });
    }
    db.run("UPDATE agent_questions SET created_at = '2026-11-01T10:00:00.000Z', answered_at = '2026-11-01T10:05:00.000Z'");
    db.run("DELETE FROM agent_question_suggestions");
  };

  it("suggests a category's usual answer once it is clear, and measures whether the operator then chose it", () => {
    history(12, 11);
    const id = ask("web#9");
    const sug = s.decisions.suggestionFor(id)!;
    expect([sug.label, sug.option_index, sug.samples, sug.precision, sug.mode]).toEqual(["Aprobar y mergear", 0, 12, null, "suggest"]);
    expect(sug.share).toBeCloseTo(11 / 12, 5);
    expect(asked).toContain(id);

    resolveHumanChoice(s, executor, events, id, { kind: "option", index: 0 }, { via: "dashboard" });
    expect(s.decisions.precision(FLOW, "approve-mr")).toEqual({ precision: 1, measured: 1 });
    const other = ask("web#10");
    resolveHumanChoice(s, executor, events, other, { kind: "option", index: 1 }, { via: "dashboard" });
    expect(s.decisions.precision(FLOW, "approve-mr")).toEqual({ precision: 0.5, measured: 2 });
  });

  it("suggests nothing without a category, with a thin or split history, or when the office turned it off", () => {
    history(8, 8);
    expect(s.decisions.suggestionFor(ask("web#9"))).toBeNull(); // 8 < 10 earlier answers
    expect(s.decisions.suggestionFor(ask("web#9", ""))).toBeNull();
    history(12, 7, "split");
    expect(s.decisions.suggestionFor(ask("web#9", "split"))).toBeNull(); // 7/12 < 70 %
    history(12, 12, "quiet");
    s.decisions.setPolicy(FLOW, "quiet", { mode: "off" });
    expect(s.decisions.suggestionFor(ask("web#9", "quiet"))).toBeNull();
  });

  it("on auto, a precedent answers alone only while its measured precision holds, its condition is met and the environment is sound; 1 in 10 still goes to the operator", () => {
    s.setAutoAnswer((q, sug) => answerByPrecedent(s, executor, events, q, sug));
    history(40, 39);
    s.decisions.setPolicy(FLOW, "approve-mr", { mode: "auto", min_precision: 0.9, min_samples: 20 });

    // Not measured yet: suggested, asked.
    const first = ask("web#7");
    expect(s.getQuestion(first)?.status).toBe("pending");

    const seed = db.prepare(`INSERT INTO agent_question_suggestions (question_id, flow_id, category, label, option_index, share, samples, mode, outcome, created_at, resolved_at)
                             VALUES (?, ?, 'approve-mr', 'Aprobar y mergear', 0, 0.97, 40, 'suggest', ?, '2026-11-02', '2026-11-02')`);
    for (let i = 0; i < 25; i++) seed.run(`seed-${i}`, FLOW, i < 24 ? "hit" : "miss"); // 96 %

    // Measured, but no condition registered for the category: history alone never answers.
    const noEvidence = Array.from({ length: 6 }, (_, i) => ask(`web#${150 + i}`));
    expect(noEvidence.every((id) => s.getQuestion(id)?.status === "pending")).toBe(true);
    expect(s.decisions.condition({ id: "x", flow_id: FLOW, category: "approve-mr", subject_key: "web#1", question: "" }, { label: "Aprobar y mergear" }).reason).toBe("no condition registered for this category");

    // The MR's own checks say no for web#13: that one goes to the operator whatever the precedent says.
    s.decisions.setCondition("approve-mr", (q) => (q.subject_key === "web#213" ? { ok: false, reason: "criterion #2 failed on web!1" } : { ok: true, reason: "all criteria passed" }));

    const outcomes = Array.from({ length: 15 }, (_, i) => {
      const id = ask(`web#${200 + i}`);
      const q = s.getQuestion(id)!;
      return { holdout: isHoldout(id), status: q.status, by: q.answered_by, via: q.answered_via, asked: asked.includes(id) };
    });
    outcomes.forEach((o, i) => {
      if (o.holdout || i === 13) expect([o.status, o.asked]).toEqual(["pending", true]);
      else expect([o.status, o.by, o.via, o.asked]).toEqual(["answered", "rule", "rule", false]);
    });
    // Auto answers do not count as hits: the measurement only moves with the operator's choices.
    expect(s.decisions.precision(FLOW, "approve-mr").measured).toBe(25);

    // DEV down: the same precedent no longer answers alone.
    s.envFacts.report({ flow_id: FLOW, key: "dev-e2e", by: "test" });
    const whileDown = Array.from({ length: 5 }, (_, i) => ask(`web#${300 + i}`));
    expect(whileDown.every((id) => s.getQuestion(id)?.status === "pending")).toBe(true);
  });

  it("below the bar, auto falls back to suggesting", () => {
    s.setAutoAnswer((q, sug) => answerByPrecedent(s, executor, events, q, sug));
    history(40, 39);
    s.decisions.setPolicy(FLOW, "approve-mr", { mode: "auto", min_precision: 0.97, min_samples: 20 });
    const seed = db.prepare(`INSERT INTO agent_question_suggestions (question_id, flow_id, category, label, option_index, share, samples, mode, outcome, created_at, resolved_at)
                             VALUES (?, ?, 'approve-mr', 'x', 0, 1, 40, 'suggest', ?, '2026-11-02', '2026-11-02')`);
    for (let i = 0; i < 25; i++) seed.run(`seed-${i}`, FLOW, i < 22 ? "hit" : "miss"); // 88 %
    const ids = Array.from({ length: 6 }, (_, i) => ask(`web#${400 + i}`));
    expect(ids.every((id) => s.getQuestion(id)?.status === "pending")).toBe(true);
  });

  it("shows the last decision on the same subject and what changed in the environment since, without applying it", () => {
    const before = ask("web#2653:a-b", "closer-blocked");
    s.answerQuestion(before, { selected_index: 1, selected_option: "Pedir cambios", answered_by: "human", source: { via: "whatsapp", actor: "whatsapp:1" } });
    db.run("UPDATE agent_questions SET created_at = '2026-11-01T10:00:00.000Z', answered_at = '2026-11-01T10:05:00.000Z' WHERE id = ?", [before]);
    s.envFacts.report({ flow_id: FLOW, key: "dev-e2e", by: "test" });
    db.run("UPDATE agent_env_facts SET valid_from = '2026-11-02T08:00:00.000Z'");
    s.closeEnvFact({ flow_id: FLOW, key: "dev-e2e", by: "test" });

    const again = ask("web#2653:a-b", "closer-blocked");
    const q = s.getQuestion(again)!;
    expect(q.status).toBe("pending");
    const prev = s.decisions.previousOnSubject(q)!;
    expect([prev.question_id, prev.label, prev.via]).toEqual([before, "Pedir cambios", "whatsapp"]);
    expect(prev.env_changes.map((c) => `${c.key}:${c.change}`)).toEqual(["dev-e2e:opened", "dev-e2e:closed"]);
    expect(s.decisions.hint(q)).toContain("La última vez (2026-11-01 10:05): «Pedir cambios» — desde entonces: dev-e2e se abrió, dev-e2e se cerró");
  });

  it("the operator's message carries the hint", async () => {
    history(12, 12);
    const sent: OperatorMessage[] = [];
    const wa: OperatorChannelAdapter = { id: "whatsapp", buttons: false, receive: true, isReady: () => true, send: async (m) => { sent.push(m); return { target: "1", messageId: "1" }; } };
    const comms = new OperatorComms({
      db, service: s, adapters: () => [wa], preference: () => ["whatsapp"], dashboard: async () => {},
      answer: (id, c, src) => resolveHumanChoice(s, executor, events, id, c, src), dashboardUrl: () => null, language: () => "es",
      hint: (q) => s.decisions.hint(q),
    });
    const id = ask("web#9");
    await comms.ask(id);
    expect(sent[0].text).toContain("💡 Lo habitual: «Aprobar y mergear» (100% de 12 casos)");
  });
});

describe("environment facts", () => {
  let db: InstanceType<typeof Database>; let s: AgentService; let events: EventBus;
  beforeEach(() => { db = new Database(":memory:"); runMigrations(db, "agents", agentsMigrations); events = new EventBus(); s = new AgentService(db, events); });
  afterEach(() => db.close());

  it("the first report opens a problem, the next ones join it, and closing it wakes each waiting agent once", () => {
    const a = s.createAgent({ name: "Resolver", flow_id: FLOW } as never).id;
    const b = s.createAgent({ name: "QA", flow_id: FLOW } as never).id;
    const woke: string[] = [];
    events.on("agent:inbox:posted" as never, (p: never) => { woke.push((p as { to_agent_id: string }).to_agent_id); });

    const first = s.envFacts.report({ flow_id: FLOW, key: "Credential DEV_PATIENT_JWT", description: "no hay JWT", by: "agent:a", blocked: { agent_id: a, subject_key: "web#2098" } });
    const second = s.envFacts.report({ flow_id: FLOW, key: "credential-dev-patient-jwt", by: "agent:b", blocked: { agent_id: b, subject_key: "web#2600:2-b" } });
    const third = s.envFacts.report({ flow_id: FLOW, key: "credential-dev-patient-jwt", by: "agent:a", blocked: { agent_id: a, subject_key: "web#2601" } });
    expect([first.opened, second.opened, third.opened, third.blocked]).toEqual([true, false, false, 3]);
    expect(first.fact.id).toBe(third.fact.id);
    expect(s.envFacts.listOpen(FLOW).length).toBe(1);

    db.run("UPDATE agent_env_facts SET valid_from = '2026-11-01T00:00:00.000Z'");
    const closed = s.closeEnvFact({ flow_id: FLOW, key: "credential-dev-patient-jwt", by: "operator", note: "cargado en DEV" });
    expect([closed.closed, closed.woken]).toEqual([true, 2]);
    expect(woke.sort()).toEqual([a, b].sort());
    const letter = db.query("SELECT subject, body FROM agent_office_inbox WHERE to_agent_id = ?").get(a) as { subject: string; body: string };
    expect(letter.subject).toBe("ENV-OK: credential-dev-patient-jwt");
    expect(letter.body).toContain("web#2098, web#2601");
    expect(s.closeEnvFact({ flow_id: FLOW, key: "credential-dev-patient-jwt", by: "operator" }).closed).toBe(false);

    // A new outage of the same thing is a new fact; the old one keeps its dates.
    expect(s.envFacts.report({ flow_id: FLOW, key: "credential-dev-patient-jwt", by: "x" }).opened).toBe(true);
    expect(s.envFacts.history(FLOW).length).toBe(2);
    expect(s.envFacts.openAt(FLOW, closed.fact!.valid_from).map((f) => f.id)).toEqual([first.fact.id]);
  });
});
