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
      dashboardUrl: () => "https://k.example.com/agents-flow",
      language: () => "es",
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
    expect(await comms.handleCallback(`oq:${id}:0`)).toBe("✓ Resuelta: Aprobar\n¿Aprobar web!5?");
    expect(await comms.handleCallback(`oq:${id}:2`)).toBe("Esta pregunta ya no está abierta.");
    expect(service.getQuestion(id)!.selected_option).toBe("Aprobar");
  });

  it("task button → owed message with Listo and Descartar; Listo closes it", async () => {
    const id = ask(); await comms.ask(id);
    expect(await comms.handleCallback(`oq:${id}:task`)).toBe("Te toca — elegiste: Lo veo yo\n¿Aprobar web!5?");
    await comms.owed(id);
    const data = tg.sent[1].buttons!.flat().map((b) => b.data);
    expect(data).toEqual([`oq:${id}:0`, `oq:${id}:2`, `oq:${id}:3`, `oq:${id}:done`, `oq:${id}:dismiss`]);
    expect(await comms.handleCallback(`oq:${id}:done`)).toBe("✓ Resuelta: Listo: Lo veo yo\n¿Aprobar web!5?");
    expect(service.getQuestion(id)!.status).toBe("answered");
  });

  it("text channels answer with Q<code> <n>; unknown codes are not ours", async () => {
    pref = ["whatsapp"]; const id = ask(); await comms.ask(id);
    expect(await comms.tryCodeReply("q1 3", "whatsapp")).toBe("✓ Resuelta: Cambios\n¿Aprobar web!5?");
    expect(service.getQuestion(id)!.selected_option).toBe("Cambios");
    expect(await comms.tryCodeReply("Q99 1", "whatsapp")).toBeNull();
    expect(await comms.tryCodeReply("hola", "whatsapp")).toBeNull();
  });

  it("resolved edits what was sent", async () => {
    const id = ask(); await comms.ask(id);
    await comms.handleCallback(`oq:${id}:0`); await comms.resolved(id);
    expect(tg.edits[0]).toContain("Resuelta: Aprobar");
  });

  it("concurrent asks get distinct codes and each code answers its own question", async () => {
    pref = ["whatsapp"]; const a = ask(); const b = ask();
    await Promise.all([comms.ask(a), comms.ask(b)]);
    const codes = wa.sent.map((m) => /Q(\d+) </.exec(m.text)![1]);
    expect(new Set(codes).size).toBe(2);
    await comms.tryCodeReply(`Q${codes[1]} 1`, "whatsapp");
    expect(service.getQuestion(b)!.selected_option).toBe("Aprobar");
    expect(service.getQuestion(a)!.status).toBe("pending");
  });

  it("a text channel that cannot receive gets no Q-code instruction", async () => {
    const mute = new FakeChannel("sms", false, false);
    const c2 = new OperatorComms({ db, service, adapters: () => [mute], preference: () => ["sms"], dashboard: async () => { throw new Error("bell down"); }, answer: () => ({ ok: false, reason: "not_open" }), dashboardUrl: () => "https://k/x", language: () => "es" });
    await c2.ask(ask());
    expect(mute.sent.length).toBe(1);
    expect(mute.sent[0].text).not.toContain("Respondé");
    expect(mute.sent[0].text).toContain("Entrá a https://k/x");
  });

  it("without a public URL there is no link: the dashboard is named instead", async () => {
    const c2 = new OperatorComms({ db, service, adapters: () => [tg, wa], preference: () => pref, dashboard: async () => {}, answer: () => ({ ok: false, reason: "not_open" }), dashboardUrl: () => null, language: () => "es" });
    pref = ["whatsapp"]; await c2.ask(ask());
    expect(wa.sent[0].text).toContain('Respondé "Q1 <número>" o en el dashboard: Oficina → Preguntas.');
    expect(wa.sent[0].text).not.toContain("question=");
    pref = ["telegram"]; await c2.ask(ask());
    expect(tg.sent[0].text).not.toContain("http");
    expect(tg.sent[0].text).not.toContain("/agents-flow");
  });

  it("speaks the kernel language: English texts, buttons and replies", async () => {
    const en = new OperatorComms({ db, service, adapters: () => [tg, wa], preference: () => pref, dashboard: async (n) => { bell.push(n.title); }, answer: (id, c) => resolveHumanChoice(service, executor, new EventBus(), id, c), dashboardUrl: () => null, language: () => "en" });
    const id = ask(); await en.ask(id);
    expect(bell[0]).toBe("Needs you — QA");
    expect(tg.sent[0].buttons!.flat().map((b) => b.text)).toContain("I'll handle it");
    expect(await en.handleCallback(`oq:${id}:task`)).toBe("Your turn — you chose: I'll handle it\n¿Aprobar web!5?");
    await en.owed(id);
    expect(tg.sent[1].text.startsWith("Your turn (you chose: I'll handle it) — QA")).toBe(true);
    expect(tg.sent[1].buttons!.flat().map((b) => b.text).slice(-2)).toEqual(["Done", "Dismiss"]);
    expect(await en.handleCallback(`oq:${id}:dismiss`)).toBe("✓ Resolved: DISMISSED\n¿Aprobar web!5?");
    expect(await en.handleCallback(`oq:${id}:dismiss`)).toBe("This question is no longer open.");
    expect(await en.handleCallback("garbage")).toBe("Invalid button.");
    pref = ["whatsapp"]; await en.ask(ask());
    expect(wa.sent[0].text).toContain('Reply "Q2 <number>" or in the dashboard: Office → Questions.');
    expect(wa.sent[0].text).toContain("L. I'll handle it");
  });

  it("a malformed button gets 'Botón inválido.' in Spanish", async () => {
    expect(await comms.handleCallback("oq:nope")).toBe("Botón inválido.");
  });

  it("resolved() writes the same text the button reply did", async () => {
    const id = ask(); await comms.ask(id);
    const reply = await comms.handleCallback(`oq:${id}:0`);
    await comms.resolved(id);
    expect(tg.edits[0]).toBe(reply);
  });

  describe("candidate channels", () => {
    const irc = () => new FakeChannel("irc", false);
    const mm = () => new FakeChannel("mattermost", false);

    it("with no OPERATOR_CHANNELS, broadcast channels never get the question", async () => {
      const i = irc(); const m = mm();
      const c2 = new OperatorComms({ db, service, adapters: () => [i, m, tg, wa], preference: () => [], dashboard: async () => {}, answer: () => ({ ok: false, reason: "not_open" }), dashboardUrl: () => null, language: () => "es" });
      await c2.ask(ask());
      expect(i.sent.length).toBe(0); expect(m.sent.length).toBe(0);
      expect(tg.sent.length).toBe(1);
      tg.ready = false; await c2.ask(ask());
      expect(wa.sent.length).toBe(1);
      wa.ready = false; await c2.ask(ask());
      expect(i.sent.length).toBe(0); expect(m.sent.length).toBe(0);
    });

    it("telegram without buttons (no default chat) is not a candidate", async () => {
      const bare = new FakeChannel("telegram", false);
      const c2 = new OperatorComms({ db, service, adapters: () => [bare], preference: () => [], dashboard: async () => {}, answer: () => ({ ok: false, reason: "not_open" }), dashboardUrl: () => null, language: () => "es" });
      await c2.ask(ask());
      expect(bare.sent.length).toBe(0);
    });

    it("a code only answers from a candidate channel", async () => {
      const i = irc();
      let prefs: string[] = [];
      const c2 = new OperatorComms({ db, service, adapters: () => [i, tg, wa], preference: () => prefs, dashboard: async () => {}, answer: (qid, c) => resolveHumanChoice(service, executor, new EventBus(), qid, c), dashboardUrl: () => null, language: () => "es" });
      prefs = ["whatsapp"]; const id = ask(); await c2.ask(id);
      expect(await c2.tryCodeReply("Q1 1", "irc")).toBeNull();
      expect(await c2.tryCodeReply("Q1 1", "telegram")).toBeNull();
      expect(service.getQuestion(id)!.status).toBe("pending");
      prefs = [];
      expect(await c2.tryCodeReply("Q1 1", "irc")).toBeNull();
      expect(await c2.tryCodeReply("Q1 1", "whatsapp")).toBe("✓ Resuelta: Aprobar\n¿Aprobar web!5?");
    });
  });
});
