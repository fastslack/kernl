import type { Database } from "bun:sqlite";
import { newId, isoNow } from "../helpers.js";
import { log } from "../logger.js";
import type { AgentService, AgentQuestion } from "../../modules/agents/service.js";
import type { AnswerPort, OperatorChannelAdapter, OperatorMessage } from "./types.js";
import type { KernelLanguage } from "../config.js";
import { buttonsFor, headline, openOptions, owedText, resolvedText, strings, textFor } from "./format.js";

type Deps = {
  db: Database;
  service: Pick<AgentService, "getQuestion" | "getAgent">;
  adapters: () => OperatorChannelAdapter[];
  preference: () => string[];
  dashboard: (n: { title: string; body: string; priority: "normal" | "high" }) => Promise<void>;
  answer: AnswerPort;
  /** Public URL of the questions view, or null when the kernel has no public URL. */
  dashboardUrl: () => string | null;
  /** Kernel language for every operator-facing text (read live: Settings can change it). */
  language?: () => KernelLanguage;
  now?: () => number;
};

const HOUR = 3_600_000;

/**
 * With no OPERATOR_CHANNELS, only channels that reach the operator directly
 * are used — never a broadcast room or a webhook (irc, mattermost…), where
 * anyone could read the question and answer it with its code.
 */
function isDirect(a: OperatorChannelAdapter): boolean {
  return (a.id === "telegram" && a.buttons) || a.id === "whatsapp";
}

export class OperatorComms {
  private lastNoChannelWarn = 0;
  private highWater = 0;
  private reserved = new Map<string, number>();
  constructor(private readonly d: Deps) {}

  async ask(id: string): Promise<void> { await this.send(id, "ask"); }
  async owed(id: string): Promise<void> { await this.send(id, "owed"); }
  /** Only sends; the reminder timer marks the reminder. */
  async remind(id: string): Promise<void> { await this.send(id, "remind"); }

  async resolved(id: string): Promise<void> {
    const q = this.d.service.getQuestion(id);
    if (!q) return;
    const rows = this.d.db.query("SELECT id, channel, target, message_id FROM operator_messages WHERE question_id = ? AND status = 'sent'")
      .all(id) as Array<{ id: string; channel: string; target: string; message_id: string }>;
    const text = resolvedText(q, this.lang());
    for (const r of rows) {
      const a = this.d.adapters().find((x) => x.id === r.channel);
      try { if (a?.edit) await a.edit({ target: r.target, messageId: r.message_id }, text); }
      catch (err) { log.warn(`operator-comms: edit on ${r.channel} failed: ${String(err)}`); }
      this.d.db.run("UPDATE operator_messages SET status = 'resolved' WHERE id = ?", [r.id]);
    }
  }

  async inform(n: { title: string; body: string; source: string }): Promise<void> {
    await this.safeDashboard({ title: n.title, body: n.body, priority: "normal" });
    await this.deliver(() => ({ text: `${n.title}\n${n.body}`, silent: true }), null);
  }

  async handleCallback(data: string): Promise<string> {
    const m = /^oq:([0-9a-f-]{36}):(\d+|task|done|dismiss)$/i.exec(data);
    if (!m) return strings(this.lang()).invalidButton;
    const [, id, c] = m;
    const choice = /^\d+$/.test(c) ? { kind: "option" as const, index: Number(c) } : { kind: c.toLowerCase() as "task" | "done" | "dismiss" };
    return this.reply(id, this.d.answer(id, choice));
  }

  /**
   * "Q<code> <k>" from a text channel. Only from a channel the questions go
   * to (`platform` not in the candidate set → not ours, null).
   */
  async tryCodeReply(text: string, platform: string): Promise<string | null> {
    const m = /^\s*q(\d+)\s+(\d+|l|d)\s*$/i.exec(text);
    if (!m) return null;
    if (!this.candidates(this.d.adapters()).includes(platform)) return null;
    const row = this.d.db.query("SELECT question_id FROM operator_messages WHERE code = ? LIMIT 1").get(Number(m[1])) as { question_id: string } | undefined;
    if (!row) return null;
    const q = this.d.service.getQuestion(row.question_id);
    if (!q) return null;
    const k = m[2].toLowerCase();
    if (k === "d") return this.reply(q.id, this.d.answer(q.id, { kind: "dismiss" }));
    if (k === "l") return this.reply(q.id, this.d.answer(q.id, q.status === "owed" ? { kind: "done" } : { kind: "task" }));
    const opt = openOptions(q)[Number(k) - 1];
    if (!opt) return strings(this.lang()).badChoice;
    return this.reply(q.id, this.d.answer(q.id, { kind: "option", index: opt.index }));
  }

  /**
   * The text the question's message ends up showing. On Telegram the
   * transport edits the pressed message with it, so it is the same text
   * resolved() writes ("✓ Resuelta: …"), or "Te toca — elegiste: …" while the
   * owed message with Listo/Descartar follows.
   */
  private reply(id: string, r: ReturnType<AnswerPort>): string {
    const s = strings(this.lang());
    if (!r.ok) return r.reason === "not_open" ? s.notOpen : s.badChoice;
    const q = this.d.service.getQuestion(id);
    if (!q) return s.notOpen;
    return r.status === "owed" ? owedText(q, this.lang()) : resolvedText(q, this.lang());
  }

  private lang(): KernelLanguage {
    return this.d.language?.() ?? "en";
  }

  /** Channel ids questions may go to, in order. */
  private candidates(all: OperatorChannelAdapter[]): string[] {
    const pref = this.d.preference();
    return pref.length ? pref : all.filter(isDirect).map((a) => a.id);
  }

  private async send(id: string, kind: "ask" | "owed" | "remind"): Promise<void> {
    const q = this.d.service.getQuestion(id);
    if (!q || (q.status !== "pending" && q.status !== "owed")) return;
    const lang = this.lang();
    const who = this.d.service.getAgent(q.from_agent_id)?.name ?? strings(lang).someone;
    const code = this.codeFor(q.id); // reserved synchronously, before any await
    await this.safeDashboard({ title: headline(q, who, kind, lang).split("\n")[0], body: q.question, priority: kind === "ask" ? "high" : "normal" });
    const link = this.d.dashboardUrl();
    await this.deliver((a) => a.buttons
      ? { text: `${headline(q, who, kind, lang)}${link ? `\n\n${link}` : ""}`, buttons: buttonsFor(q, lang) }
      : { text: textFor(q, who, kind, code, link, a.receive, lang) }, q, code);
  }

  /** First ready channel in preference order; the next one if it fails. */
  private async deliver(build: (a: OperatorChannelAdapter) => OperatorMessage, q: AgentQuestion | null, code = 0): Promise<void> {
    const all = this.d.adapters();
    for (const id of this.candidates(all)) {
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

  private async safeDashboard(n: Parameters<Deps["dashboard"]>[0]): Promise<void> {
    try { await this.d.dashboard(n); }
    catch (err) { log.warn(`operator-comms: dashboard failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private codeFor(questionId: string): number {
    const had = this.d.db.query("SELECT code FROM operator_messages WHERE question_id = ? LIMIT 1").get(questionId) as { code: number } | undefined;
    if (had) return had.code;
    const mine = this.reserved.get(questionId);
    if (mine) return mine;
    const max = this.d.db.query("SELECT coalesce(max(code), 0) AS m FROM operator_messages").get() as { m: number };
    const code = Math.max(max.m, this.highWater) + 1;
    this.highWater = code;
    this.reserved.set(questionId, code);
    return code;
  }
}
