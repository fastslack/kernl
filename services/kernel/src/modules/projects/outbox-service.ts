import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import { newId, isoNow } from "../../core/helpers.js";
import type { ProjectsService } from "./projects-service.js";
import type { OutboxChannelHandler, OutboxItem, OutboxPolicy, OutboxPreview, OutboxStatus } from "./types.js";

type Row = Omit<OutboxItem, "payload"> & { payload: string };

/** ISO 8601 with a date and time (any offset) → UTC ISO; null/undefined pass through. */
function normalizeWhen(v: string | null | undefined): string | null | undefined {
  if (v === null || v === undefined || v === "") return v === "" ? null : v;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(`scheduled_for must be an ISO date-time (e.g. 2026-10-05T09:00:00-03:00), got "${v}"`);
  }
  return new Date(Date.parse(v)).toISOString();
}
const toItem = (r: Row): OutboxItem => ({ ...r, payload: JSON.parse(r.payload || "{}") as unknown });

/**
 * Drafts that leave Kernl only after a human approves them. Core orchestrates;
 * each channel's handler (registered by its extension) validates, previews and
 * sends. Sending claims the row first (approved → sending in one UPDATE) so a
 * double approve or a tick racing an approve can never publish twice. Nothing
 * is ever retried automatically: a failed send waits for a human.
 */
/**
 * The item's project, inside what the channel receives when the draft did not carry it. A channel only sees
 * the payload: Growth's web_change could not tell which project a change was for when Growth works on several
 * (16/10: three approved requests to Desarrollo failed with "falta project_id").
 */
export function withProject(payload: unknown, projectId: string | null | undefined): unknown {
  if (!projectId || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  return typeof p.project_id === "string" && p.project_id ? p : { ...p, project_id: projectId };
}

export class OutboxService {
  private channels = new Map<string, OutboxChannelHandler>();
  private policies = new Map<string, OutboxPolicy>();

  /** An extension's auto-approval rule. Same name replaces; order of first registration is kept. */
  registerPolicy(name: string, fn: OutboxPolicy): void {
    this.policies.set(name, fn);
  }

  /** The extension went away (uninstall, disable): its rule must stop approving now, not at the next restart. */
  unregisterPolicy(name: string): void {
    this.policies.delete(name);
  }

  /** First `auto` wins. A throwing policy is skipped; a rehearsal draft is never auto. */
  private applyPolicies(item: OutboxItem): void {
    if ((item.payload as { rehearsal?: unknown } | null)?.rehearsal === true) return;
    for (const fn of this.policies.values()) {
      let d: ReturnType<OutboxPolicy>;
      try { d = fn(item); } catch { continue; }
      if (d.decision !== "auto") continue;
      this.db.prepare("UPDATE outbox_items SET review_note = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
        .run(d.note.slice(0, 500), isoNow(), item.id);
      queueMicrotask(() => { this.approve(item.id).catch(() => { /* stays a draft or failed; visible in Aprobaciones */ }); });
      return;
    }
  }

  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private projects: ProjectsService,
    private onReject: (item: OutboxItem, note: string) => void,
  ) {}

  registerChannel(channel: string, h: OutboxChannelHandler): void {
    this.channels.set(channel, h);
  }

  hasChannel(channel: string): boolean {
    return this.channels.has(channel);
  }

  listChannels(): string[] {
    return [...this.channels.keys()].sort();
  }

  /** account_ref format per channel, for the channels that document one. */
  refHints(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.listChannels()) {
      const hint = this.channels.get(name)!.refHint;
      if (hint) out[name] = hint;
    }
    return out;
  }

  private handler(channel: string): OutboxChannelHandler {
    const h = this.channels.get(channel);
    if (!h) {
      const known = this.listChannels();
      throw new Error(
        `No outbox channel "${channel}" is registered. Registered channels: ${known.length ? known.join(", ") : "(none)"}`,
      );
    }
    return h;
  }

  private changed(item: OutboxItem): void {
    this.events.emit("outbox:changed", { id: item.id, project_id: item.project_id, status: item.status });
  }

  get(id: string): OutboxItem | undefined {
    const r = this.db.prepare("SELECT * FROM outbox_items WHERE id = ?").get(id) as Row | undefined;
    return r ? toItem(r) : undefined;
  }

  private mustGet(id: string): OutboxItem {
    const it = this.get(id);
    if (!it) throw new Error(`Outbox item not found: ${id}`);
    return it;
  }

  propose(input: {
    project_id: string | null; flow_id: string; agent_id: string; run_id: string;
    channel: string; account_ref: string; payload: unknown; scheduled_for?: string | null;
  }): OutboxItem {
    const h = this.handler(input.channel);
    const when = normalizeWhen(input.scheduled_for) ?? null;
    const canon = (ref: string) => h.canonicalRef?.(ref) ?? ref;
    const accountRef = canon(input.account_ref);
    const isThisAccount = (l: { ref_id: string }) => l.ref_id === input.account_ref || canon(l.ref_id) === accountRef;
    let projectId = input.project_id;
    if (!projectId && input.flow_id) {
      // A run outside any project (an office-wide directive from the chief, a
      // chain it started) still drafts from a project's account. When exactly
      // one project of the office has that account linked, the draft is that
      // project's — otherwise it lands unscoped and out of the project's queue.
      // An internal channel has no account to match: the office's only project owns it.
      const office = this.projects.list({ flowId: input.flow_id });
      // An office serving several projects names the one in the payload (id or slug); only one it serves counts.
      const named = (input.payload as { project_id?: unknown } | null)?.project_id;
      const pick = typeof named === "string" && named ? office.find((p) => p.id === named || p.slug === named) : undefined;
      // The channel reads it from the payload by id (Growth's web_change looks up the project's repos by id).
      if (pick && named !== pick.id) (input.payload as Record<string, unknown>).project_id = pick.id;
      const owners = pick ? [pick] : h.needsAccount === false ? office : office.filter((p) => this.projects.links(p.id).some(isThisAccount));
      if (owners.length === 1) projectId = owners[0].id;
    }
    if (projectId && h.needsAccount !== false) {
      const links = this.projects.links(projectId);
      const linked = links.some(isThisAccount);
      if (!linked) {
        const known = links.filter((l) => l.kind === "social_account" || l.kind === "email_account").map((l) => l.ref_id);
        throw new Error(
          `Account ${input.account_ref} is not linked to this project. Linked accounts: ${known.length ? known.join(", ") : "(none)"}`,
        );
      }
    }
    const v = h.validate(input.payload, accountRef);
    if (!v.ok) throw new Error(v.error);
    const waiting = this.waitingCopy(h, input.channel, projectId, input.payload);
    if (waiting) {
      throw new Error(`Already waiting for the operator: ${waiting.id} («${this.preview(waiting.id).title}», ${waiting.status}). ` +
        "Do not propose it again: the operator decides in Approvals, and you hear back when it is decided.");
    }
    const now = isoNow();
    const id = newId();
    this.db.prepare(
      `INSERT INTO outbox_items (id, project_id, flow_id, agent_id, run_id, channel, account_ref, payload, scheduled_for, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(id, projectId, input.flow_id, input.agent_id, input.run_id, input.channel, accountRef,
      JSON.stringify(input.payload ?? {}), when, now, now);
    const item = this.mustGet(id);
    this.changed(item);
    this.applyPolicies(item);
    return item;
  }

  /** A draft of the same project and channel, not yet decided, that the channel calls the same request. */
  private waitingCopy(h: OutboxChannelHandler, channel: string, projectId: string | null, payload: unknown): OutboxItem | null {
    let key: string | null = null;
    try { key = h.dedupeKey?.(payload) ?? null; } catch { key = null; }
    if (!key) return null;
    const rows = this.db.prepare(
      "SELECT * FROM outbox_items WHERE channel = ? AND status IN ('draft', 'approved', 'sending') AND project_id IS ?",
    ).all(channel, projectId) as Row[];
    for (const it of rows.map(toItem)) {
      try { if (h.dedupeKey!(it.payload) === key) return it; } catch { /* a payload the channel cannot read is not a copy */ }
    }
    return null;
  }

  list(f: { project_id?: string; flow_id?: string; channel?: string; status?: OutboxStatus; limit?: number } = {}): OutboxItem[] {
    let sql = "SELECT * FROM outbox_items WHERE 1=1";
    const params: unknown[] = [];
    for (const k of ["project_id", "flow_id", "channel", "status"] as const) {
      if (f[k]) { sql += ` AND ${k} = ?`; params.push(f[k]); }
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(f.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as Row[]).map(toItem);
  }

  pendingCount(projectId?: string): number {
    const r = (projectId
      ? this.db.prepare("SELECT COUNT(*) AS c FROM outbox_items WHERE status = 'draft' AND project_id = ?").get(projectId)
      : this.db.prepare("SELECT COUNT(*) AS c FROM outbox_items WHERE status = 'draft'").get()) as { c: number };
    return r.c;
  }

  preview(id: string): OutboxPreview {
    const it = this.mustGet(id);
    return this.handler(it.channel).preview(it.payload);
  }

  edit(id: string, payload: unknown): OutboxItem {
    const it = this.mustGet(id);
    if (it.status !== "draft") throw new Error(`Only a draft can be edited (item is ${it.status})`);
    const v = this.handler(it.channel).validate(payload, it.account_ref);
    if (!v.ok) throw new Error(v.error);
    this.db.prepare("UPDATE outbox_items SET payload = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
      .run(JSON.stringify(payload ?? {}), isoNow(), id);
    const out = this.mustGet(id);
    this.changed(out);
    return out;
  }

  /**
   * A draft the operator turns down, or a failed send they drop. Only a draft's note teaches the agent: a failed
   * item was approved, so what went wrong was the channel (a token, a scope), not what the agent wrote.
   */
  reject(id: string, note: string): OutboxItem {
    const was = this.mustGet(id).status;
    const now = isoNow();
    const res = this.db.prepare(
      "UPDATE outbox_items SET status = 'rejected', review_note = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'failed')",
    ).run(note.trim(), now, now, id);
    if (Number(res.changes) === 0) throw new Error("Only a draft or a failed item can be rejected");
    const it = this.mustGet(id);
    if (was === "draft" && note.trim()) this.onReject(it, note.trim());
    this.changed(it);
    return it;
  }

  /**
   * Pass a draft or a failed item to an office to sort out (07/11: a web_change GitLab refused with 403 could only be
   * retried). The letter goes first; only once it is delivered does the item leave the queue, as rejected with a note
   * that says where it went. Nobody learns from it: it is a hand-off, not a verdict on the draft.
   */
  handoff(
    id: string,
    office: { flow_id: string; name: string },
    note: string,
    deliver: (letter: { flow_id: string; agent_id: string; project_id: string | null; subject: string; body: string }) => { ok: boolean; error?: string },
  ): OutboxItem {
    const it = this.mustGet(id);
    if (it.status !== "draft" && it.status !== "failed") throw new Error(`Only a draft or a failed item can be handed to an office (item is ${it.status})`);
    let pv: OutboxPreview;
    try { pv = this.preview(id); } catch { pv = { title: it.channel, body: JSON.stringify(it.payload, null, 2) } as OutboxPreview; }
    const body = [
      "El operador te pasa este pedido de Aprobaciones para que lo resuelvas.",
      ...(note.trim() ? ["", `Nota del operador: ${note.trim()}`] : []),
      "",
      `Pedido ${it.id} · canal ${it.channel} · sale desde ${it.account_ref} · estado ${it.status === "failed" ? "falló al enviarse" : "borrador sin aprobar"}`,
      ...(it.status === "failed" && it.error ? [`Error: ${it.error}`] : []),
      "",
      `## ${pv.title}`,
      "",
      pv.body,
      "",
      "Si para resolverlo hace falta mandar algo afuera, proponé un borrador nuevo (kernel_outbox_propose): este ya salió de la cola.",
    ].join("\n");
    const r = deliver({ flow_id: office.flow_id, agent_id: it.agent_id, project_id: it.project_id, subject: `Aprobaciones: ${pv.title}`.slice(0, 300), body });
    if (!r.ok) throw new Error(r.error || `The letter to ${office.name} did not go out`);
    const now = isoNow();
    const reviewNote = note.trim() ? `Pasado a ${office.name}: ${note.trim()}` : `Pasado a ${office.name}`;
    this.db.prepare("UPDATE outbox_items SET status = 'rejected', review_note = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'failed')")
      .run(reviewNote, now, now, id);
    const out = this.mustGet(id);
    this.changed(out);
    return out;
  }

  /** An approval waiting for its time goes back to draft (the operator's pause). Sending or sent: too late. */
  withdraw(id: string): OutboxItem {
    const res = this.db.prepare(
      "UPDATE outbox_items SET status = 'draft', scheduled_for = NULL, decided_at = NULL, updated_at = ? WHERE id = ? AND status = 'approved'",
    ).run(isoNow(), id);
    if (Number(res.changes) === 0) throw new Error("Only an approved item waiting to be sent can be withdrawn");
    const out = this.mustGet(id);
    this.changed(out);
    return out;
  }

  async approve(id: string, opts: { scheduled_for?: string | null } = {}): Promise<OutboxItem> {
    // A rehearsal draft is built exactly as the real one, to review it, and never leaves.
    if ((this.mustGet(id).payload as { rehearsal?: unknown } | null)?.rehearsal === true) {
      throw new Error("Borrador de ensayo: no se envía. Usá «Mandarme una prueba» para verlo en tu casilla.");
    }
    const now = isoNow();
    const sched = opts.scheduled_for === undefined ? this.mustGet(id).scheduled_for : normalizeWhen(opts.scheduled_for) ?? null;
    const res = this.db.prepare(
      "UPDATE outbox_items SET status = 'approved', scheduled_for = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
    ).run(sched, now, now, id);
    if (Number(res.changes) === 0) throw new Error("Only a draft can be approved");
    this.changed(this.mustGet(id));
    if (!sched || sched <= now) return this.sendClaimed(id);
    return this.mustGet(id);
  }

  async retry(id: string): Promise<OutboxItem> {
    const res = this.db.prepare("UPDATE outbox_items SET status = 'approved', error = '', updated_at = ? WHERE id = ? AND status = 'failed'")
      .run(isoNow(), id);
    if (Number(res.changes) === 0) throw new Error("Only a failed item can be retried");
    return this.sendClaimed(id);
  }

  /**
   * Send a copy of a draft to the operator's own address, to see it as the
   * recipient will. Only channels whose payload has a `to` list. The item is
   * not touched (status, payload, events): nothing about the real send changes.
   */
  async testSend(id: string, to: string): Promise<{ ref: string }> {
    const it = this.mustGet(id);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) throw new Error("La dirección de prueba no es un email válido");
    const p = { ...(it.payload as Record<string, unknown>) };
    if (!Array.isArray(p.to)) throw new Error(`El canal ${it.channel} no tiene envío de prueba`);
    p.to = [to.trim()];
    delete p.cc;
    delete p.rehearsal;
    delete p.contact_id;
    if (typeof p.subject === "string" && !p.subject.startsWith("[PRUEBA")) p.subject = `[PRUEBA] ${p.subject}`;
    const h = this.handler(it.channel);
    const v = h.validate(p, it.account_ref);
    if (!v.ok) throw new Error(v.error);
    const out = await h.send(p, it.account_ref);
    // Not a change of the item: whoever tracks sends (sales) learns that a copy went out.
    this.events.emit("outbox:test_sent", { id: it.id, project_id: it.project_id, to: to.trim(), ref: out.ref });
    return out;
  }

  /** approved → sending atomically; whoever wins the UPDATE sends. */
  private async sendClaimed(id: string): Promise<OutboxItem> {
    const claim = this.db.prepare("UPDATE outbox_items SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'approved'")
      .run(isoNow(), id);
    if (Number(claim.changes) === 0) return this.mustGet(id);
    const it = this.mustGet(id);
    try {
      const { ref } = await this.handler(it.channel).send(withProject(it.payload, it.project_id), it.account_ref);
      const now = isoNow();
      this.db.prepare("UPDATE outbox_items SET status = 'sent', sent_ref = ?, sent_at = ?, updated_at = ? WHERE id = ?")
        .run(ref, now, now, id);
    } catch (err) {
      this.db.prepare("UPDATE outbox_items SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run(err instanceof Error ? err.message : String(err), isoNow(), id);
    }
    const out = this.mustGet(id);
    this.changed(out);
    return out;
  }

  /** Send approved items whose time came. Never touches failed ones. */
  async tick(nowIso: string = isoNow()): Promise<number> {
    const due = this.db.prepare(
      "SELECT id FROM outbox_items WHERE status = 'approved' AND (scheduled_for IS NULL OR scheduled_for <= ?)",
    ).all(nowIso) as Array<{ id: string }>;
    let n = 0;
    for (const { id } of due) {
      if ((await this.sendClaimed(id)).status === "sent") n++;
    }
    return n;
  }

  /** At boot: an item left in 'sending' may or may not have gone out — a human decides. */
  recoverInterrupted(): number {
    const res = this.db.prepare(
      `UPDATE outbox_items SET status = 'failed',
         error = 'interrupted while sending — check the channel before retrying', updated_at = ?
       WHERE status = 'sending'`,
    ).run(isoNow());
    return Number(res.changes);
  }
}
