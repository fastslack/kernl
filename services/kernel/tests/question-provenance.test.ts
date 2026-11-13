import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService, subjectKeyOf, normalizeCategory } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { resolveHumanChoice, answerAndDeliver } from "../src/modules/agents/question-delivery.js";
import { answerSourceOf } from "../src/modules/agents/api-routes.js";
import { OperatorComms } from "../src/core/operator-comms/driver.js";
import type { OperatorChannelAdapter, OperatorMessage } from "../src/core/operator-comms/types.js";

// In one office 1,157 of 1,844 answers recorded as "human" came 15–60 s after
// the question, at any hour — an orchestrator answering through the API, most
// likely, but nothing recorded said so. Every answer now carries its channel
// and sender, and every question what it is about.

class FakeChannel implements OperatorChannelAdapter {
  sent: OperatorMessage[] = [];
  constructor(readonly id: string, readonly buttons: boolean, readonly receive = true) {}
  isReady() { return true; }
  async send(m: OperatorMessage) { this.sent.push(m); return { target: "1", messageId: String(this.sent.length) }; }
  async edit() {}
}

const OPTS = [{ label: "Aprobar y mergear" }, { label: "Lo reviso yo", task: true }, { label: "Pedir cambios" }];

describe("what a question is about", () => {
  it("takes the subject from the first issue reference, part included", () => {
    expect(subjectKeyOf("web#2653:a-b (api!905): el Resolver no puede seguir")).toBe("web#2653:a-b");
    expect(subjectKeyOf("¿Apruebo api!83 (web#2601: los mails…)?")).toBe("web#2601");
    expect(subjectKeyOf("Para WEB#2600 parte 2: ¿qué ruta?")).toBe("web#2600");
    expect(subjectKeyOf("La corrida programada no corre")).toBe("");
    expect(normalizeCategory("  Approve MR! ")).toBe("approve-mr");
    expect(normalizeCategory(undefined)).toBe("");
  });

  it("files the subject and category given, or the subject read from the text", () => {
    const db = new Database(":memory:"); runMigrations(db, "agents", agentsMigrations);
    const s = new AgentService(db, new EventBus());
    const a = s.createAgent({ name: "Cerrador" }).id;
    const given = s.createQuestion({ from_agent_id: a, question: "¿Cierro?", options: OPTS, for_operator: true, subject_key: "WEB#1:R2", category: "Closer Blocked" });
    const read = s.createQuestion({ from_agent_id: a, question: "web#2816: el Cerrador no lo cierra", options: OPTS, for_operator: true });
    expect([s.getQuestion(given.id)?.subject_key, s.getQuestion(given.id)?.category]).toEqual(["web#1:r2", "closer-blocked"]);
    expect([s.getQuestion(read.id)?.subject_key, s.getQuestion(read.id)?.category]).toEqual(["web#2816", ""]);
    db.close();
  });
});

describe("who answered, and through what", () => {
  let db: InstanceType<typeof Database>; let service: AgentService; let events: EventBus; let agent: string;
  const executor = { execute: async () => ({ status: "completed", result: "", steps_count: 0, tokens_used: 0 }) } as never;
  beforeEach(() => {
    db = new Database(":memory:"); runMigrations(db, "agents", agentsMigrations);
    events = new EventBus(); service = new AgentService(db, events);
    agent = service.createAgent({ name: "QA" }).id;
  });
  afterEach(() => db.close());
  const ask = () => service.createQuestion({ from_agent_id: agent, question: "¿Apruebo web!5 (web#9)?", options: OPTS, for_operator: true }).id;

  it("an API client names itself; the dashboard says it is the dashboard; nobody saying is an unnamed API client", () => {
    expect(answerSourceOf({ "x-kernl-via": "host-ops", "x-kernl-actor": "orchestrator@fedora" }, {})).toEqual({ via: "host-ops", actor: "orchestrator@fedora" });
    expect(answerSourceOf({ "x-kernl-via": "dashboard" }, {})).toEqual({ via: "dashboard" });
    expect(answerSourceOf({}, { via: "Host Ops", actor: "x" })).toEqual({ via: "host-ops", actor: "x" });
    expect(answerSourceOf({}, {})).toEqual({ via: "api" });

    const id = ask();
    resolveHumanChoice(service, executor, events, id, { kind: "option", index: 0 }, answerSourceOf({ "x-kernl-via": "host-ops" }, {}));
    const q = service.getQuestion(id)!;
    expect([q.status, q.answered_by, q.answered_via, q.answered_actor]).toEqual(["answered", "human", "host-ops", ""]);
  });

  it("a task picked and then marked done keeps the channel of each step; a dismissal records who dismissed", () => {
    const id = ask();
    resolveHumanChoice(service, executor, events, id, { kind: "task" }, { via: "whatsapp", actor: "whatsapp:549" });
    expect(service.getQuestion(id)?.answered_via).toBe("whatsapp");
    resolveHumanChoice(service, executor, events, id, { kind: "done" }, { via: "dashboard" });
    expect([service.getQuestion(id)?.status, service.getQuestion(id)?.answered_via]).toEqual(["answered", "dashboard"]);

    const other = ask();
    resolveHumanChoice(service, executor, events, other, { kind: "dismiss" }, { via: "telegram", actor: "telegram:77" });
    expect([service.getQuestion(other)?.status, service.getQuestion(other)?.answered_actor]).toEqual(["dismissed", "telegram:77"]);
  });

  it("the answered event carries the source, and the chief's answers say they came from the chief over MCP", () => {
    const seen: Array<Record<string, unknown>> = [];
    events.on("agent:flow:question_answered" as never, (p: never) => { seen.push(p); });
    const chief = service.createAgent({ name: "Chief" }).id;
    const q = service.createQuestion({ from_agent_id: agent, question: "¿Sigo? web#3", options: OPTS });
    db.run("UPDATE agent_questions SET status = 'triage' WHERE id = ?", [q.id]);
    answerAndDeliver(service, executor, events, q.id, { selected_index: 0, selected_option: "Aprobar y mergear", answered_by: "chief", source: { via: "mcp", actor: `agent:${chief}` } });
    expect(service.getQuestion(q.id)?.answered_actor).toBe(`agent:${chief}`);
    expect(seen[0]).toMatchObject({ answered_by: "chief", via: "mcp", actor: `agent:${chief}` });
  });

  it("a Telegram button and a WhatsApp code reply record the platform and the sender", async () => {
    const tg = new FakeChannel("telegram", true); const wa = new FakeChannel("whatsapp", false);
    const comms = new OperatorComms({
      db, service, adapters: () => [tg, wa], preference: () => ["telegram", "whatsapp"], dashboard: async () => {},
      answer: (id, c, src) => resolveHumanChoice(service, executor, events, id, c, src),
      dashboardUrl: () => null, language: () => "es",
    });
    const viaButton = ask();
    await comms.handleCallback(`oq:${viaButton}:0`, "4242");
    expect([service.getQuestion(viaButton)?.answered_via, service.getQuestion(viaButton)?.answered_actor]).toEqual(["telegram", "telegram:4242"]);

    const viaCode = ask();
    await comms.ask(viaCode);
    const code = (db.query("SELECT code FROM operator_messages WHERE question_id = ?").get(viaCode) as { code: number }).code;
    expect(await comms.tryCodeReply(`Q${code} 3`, "whatsapp", "5491100")).toContain("Resuelta");
    expect([service.getQuestion(viaCode)?.answered_via, service.getQuestion(viaCode)?.answered_actor]).toEqual(["whatsapp", "whatsapp:5491100"]);
  });
});
