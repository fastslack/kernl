import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { resolveHumanChoice } from "../src/modules/agents/question-delivery.js";
import { OperatorComms } from "../src/core/operator-comms/driver.js";
import type { OperatorChannelAdapter, OperatorMessage } from "../src/core/operator-comms/types.js";

class FakeChannel implements OperatorChannelAdapter {
  sent: OperatorMessage[] = []; edits: string[] = []; ready = true; fail = false;
  constructor(readonly id: string, readonly buttons: boolean, readonly receive = true) {}
  isReady() { return this.ready; }
  async send(m: OperatorMessage) { if (this.fail) return null; this.sent.push(m); return { target: "1", messageId: String(this.sent.length) }; }
  async edit(_r: unknown, text: string) { this.edits.push(text); }
}

const TASKY = [{ label: "Aprobar" }, { label: "Lo reviso yo", task: true }, { label: "Cambios" }, { label: "Esperar" }];

describe("OperatorComms", () => {
  let db: InstanceType<typeof Database>; let service: AgentService; let bell: string[];
  let tg: FakeChannel; let wa: FakeChannel; let pref: string[]; let comms: OperatorComms;
  const executor = { execute: async () => ({ status: "completed", result: "", steps_count: 0, tokens_used: 0 }) } as never;

  beforeEach(() => {
    db = new Database(":memory:"); runMigrations(db, "agents", agentsMigrations);
    const events = new EventBus(); service = new AgentService(db, events); bell = [];
    tg = new FakeChannel("telegram", true); wa = new FakeChannel("whatsapp", false); pref = ["telegram", "whatsapp"];
    comms = new OperatorComms({
      db, service, adapters: () => [tg, wa], preference: () => pref,
      dashboard: async (n) => { bell.push(n.title); },
      answer: (id, c) => resolveHumanChoice(service, executor, events, id, c),
      linkFor: (id) => `/agents-flow?question=${id}`,
    });
  });
  afterEach(() => db.close());
  const ask = () => service.createQuestion({ from_agent_id: service.createAgent({ name: "QA" }).id, question: "¿Aprobar web!5?", options: TASKY, for_operator: true }).id;

  it("rings the dashboard and uses the first ready channel, with buttons", async () => {
    const id = ask(); await comms.ask(id);
    expect(bell.length).toBe(1);
    expect(tg.sent.length).toBe(1); expect(wa.sent.length).toBe(0);
    const data = tg.sent[0].buttons!.flat().map((b) => b.data);
    expect(data).toEqual([`oq:${id}:0`, `oq:${id}:1`, `oq:${id}:2`, `oq:${id}:3`, `oq:${id}:task`]);
  });

  it("falls back to the next channel when the first one fails or is not ready", async () => {
    tg.fail = true; const id = ask(); await comms.ask(id);
    expect(wa.sent.length).toBe(1);
    expect(wa.sent[0].text).toMatch(/Respondé "Q1 <número>"/);
    tg.fail = false; tg.ready = false; const id2 = ask(); await comms.ask(id2);
    expect(wa.sent[1].text).toContain("Q2");
  });

  it("still works with no external channel", async () => {
    tg.ready = false; wa.ready = false; const id = ask();
    await comms.ask(id);
    expect(bell.length).toBe(1);
  });

  it("a button answers, a second press gets 'ya no está abierta'", async () => {
    const id = ask(); await comms.ask(id);
    expect(await comms.handleCallback(`oq:${id}:0`)).toContain("respondida");
    expect(await comms.handleCallback(`oq:${id}:2`)).toBe("Esta pregunta ya no está abierta.");
    expect(service.getQuestion(id)!.selected_option).toBe("Aprobar");
  });

  it("task button → owed message with Listo and Descartar; Listo closes it", async () => {
    const id = ask(); await comms.ask(id);
    await comms.handleCallback(`oq:${id}:task`);
    await comms.owed(id);
    const data = tg.sent[1].buttons!.flat().map((b) => b.data);
    expect(data).toEqual([`oq:${id}:0`, `oq:${id}:2`, `oq:${id}:3`, `oq:${id}:done`, `oq:${id}:dismiss`]);
    await comms.handleCallback(`oq:${id}:done`);
    expect(service.getQuestion(id)!.status).toBe("answered");
  });

  it("text channels answer with Q<code> <n>; unknown codes are not ours", async () => {
    pref = ["whatsapp"]; const id = ask(); await comms.ask(id);
    expect(await comms.tryCodeReply("q1 3")).toContain("respondida");
    expect(service.getQuestion(id)!.selected_option).toBe("Cambios");
    expect(await comms.tryCodeReply("Q99 1")).toBeNull();
    expect(await comms.tryCodeReply("hola")).toBeNull();
  });

  it("resolved edits what was sent", async () => {
    const id = ask(); await comms.ask(id);
    await comms.handleCallback(`oq:${id}:0`); await comms.resolved(id);
    expect(tg.edits[0]).toContain("Resuelta: Aprobar");
  });
});
