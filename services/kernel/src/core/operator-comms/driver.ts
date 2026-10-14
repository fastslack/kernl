import type { Database } from "bun:sqlite";
import { newId, isoNow } from "../helpers.js";
import { log } from "../logger.js";
import type { AgentService, AgentQuestion } from "../../modules/agents/service.js";
import type { AnswerPort, OperatorChannelAdapter, OperatorMessage } from "./types.js";
import { buttonsFor, headline, openOptions, textFor } from "./format.js";

type Deps = {
  db: Database;
  service: Pick<AgentService, "getQuestion" | "getAgent">;
  adapters: () => OperatorChannelAdapter[];
  preference: () => string[];
  dashboard: (n: { title: string; body: string; priority: "normal" | "high" }) => Promise<void>;
  answer: AnswerPort;
  linkFor: (questionId: string) => string;
  now?: () => number;
};

const HOUR = 3_600_000;

export class OperatorComms {
  private lastNoChannelWarn = 0;
  constructor(private readonly d: Deps) {}

  async ask(id: string): Promise<void> { await this.send(id, "ask"); }
  async owed(id: string): Promise<void> { await this.send(id, "owed"); }
  /** Only sends; the question triager marks the reminder. */
  async remind(id: string): Promise<void> { await this.send(id, "remind"); }

  async resolved(id: string): Promise<void> {
    const q = this.d.service.getQuestion(id);
    if (!q) return;
    const rows = this.d.db.query("SELECT id, channel, target, message_id FROM operator_messages WHERE question_id = ? AND status = 'sent'")
      .all(id) as Array<{ id: string; channel: string; target: string; message_id: string }>;
    const text = `✓ Resuelta: ${q.status === "dismissed" ? "DESCARTADA" : q.selected_option}\n${q.question}`;
    for (const r of rows) {
      const a = this.d.adapters().find((x) => x.id === r.channel);
      try { if (a?.edit) await a.edit({ target: r.target, messageId: r.message_id }, text); }
      catch (err) { log.warn(`operator-comms: edit on ${r.channel} failed: ${String(err)}`); }
      this.d.db.run("UPDATE operator_messages SET status = 'resolved' WHERE id = ?", [r.id]);
    }
  }

  async inform(n: { title: string; body: string; source: string }): Promise<void> {
    await this.d.dashboard({ title: n.title, body: n.body, priority: "normal" });
    await this.deliver(() => ({ text: `${n.title}\n${n.body}`, silent: true }), null);
  }

  async handleCallback(data: string): Promise<string> {
    const m = /^oq:([0-9a-f-]{36}):(\d+|task|done|dismiss)$/i.exec(data);
    if (!m) return "";
    const [, id, c] = m;
    const choice = /^\d+$/.test(c) ? { kind: "option" as const, index: Number(c) } : { kind: c.toLowerCase() as "task" | "done" | "dismiss" };
    return this.reply(this.d.answer(id, choice));
  }

  async tryCodeReply(text: string): Promise<string | null> {
    const m = /^\s*q(\d+)\s+(\d+|l|d)\s*$/i.exec(text);
    if (!m) return null;
    const row = this.d.db.query("SELECT question_id FROM operator_messages WHERE code = ? LIMIT 1").get(Number(m[1])) as { question_id: string } | undefined;
    if (!row) return null;
    const q = this.d.service.getQuestion(row.question_id);
    if (!q) return null;
    const k = m[2].toLowerCase();
    if (k === "d") return this.reply(this.d.answer(q.id, { kind: "dismiss" }));
    if (k === "l") return this.reply(this.d.answer(q.id, q.status === "owed" ? { kind: "done" } : { kind: "task" }));
    const opt = openOptions(q)[Number(k) - 1];
    if (!opt) return "Esa opción no vale para esta pregunta.";
    return this.reply(this.d.answer(q.id, { kind: "option", index: opt.index }));
  }

  private reply(r: ReturnType<AnswerPort>): string {
    if (r.ok) return `Listo, respondida: ${r.status}`;
    return r.reason === "not_open" ? "Esta pregunta ya no está abierta." : "Esa opción no vale para esta pregunta.";
  }

  private async send(id: string, kind: "ask" | "owed" | "remind"): Promise<void> {
    const q = this.d.service.getQuestion(id);
    if (!q || (q.status !== "pending" && q.status !== "owed")) return;
    const who = this.d.service.getAgent(q.from_agent_id)?.name ?? "Un agente";
    await this.d.dashboard({ title: headline(q, who, kind).split("\n")[0], body: q.question, priority: kind === "ask" ? "high" : "normal" });
    const code = this.codeFor(q.id);
    const link = this.d.linkFor(q.id);
    await this.deliver((a) => a.buttons
      ? { text: `${headline(q, who, kind)}\n\n${link}`, buttons: buttonsFor(q) }
      : { text: textFor(q, who, kind, code, link) }, q, code);
  }

  /** First ready channel in preference order; the next one if it fails. */
  private async deliver(build: (a: OperatorChannelAdapter) => OperatorMessage, q: AgentQuestion | null, code = 0): Promise<void> {
    const all = this.d.adapters();
    const order = this.d.preference().length ? this.d.preference() : all.map((a) => a.id);
    for (const id of order) {
      const a = all.find((x) => x.id === id);
      if (!a || !a.isReady()) continue;
      try {
        const ref = await a.send(build(a));
        if (!ref) continue;
        if (q) this.d.db.run(
          "INSERT INTO operator_messages (id, question_id, channel, target, message_id, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)",
          [newId(), q.id, a.id, ref.target, ref.messageId, code, isoNow()]);
        return;
      } catch (err) {
        log.warn(`operator-comms: ${a.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const now = (this.d.now ?? Date.now)();
    if (now - this.lastNoChannelWarn > HOUR) {
      this.lastNoChannelWarn = now;
      log.warn("operator-comms: no external channel ready — the operator only sees the dashboard");
    }
  }

  private codeFor(questionId: string): number {
    const had = this.d.db.query("SELECT code FROM operator_messages WHERE question_id = ? LIMIT 1").get(questionId) as { code: number } | undefined;
    if (had) return had.code;
    const max = this.d.db.query("SELECT coalesce(max(code), 0) AS m FROM operator_messages").get() as { m: number };
    return max.m + 1;
  }
}
