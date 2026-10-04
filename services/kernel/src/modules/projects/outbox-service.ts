import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import { newId, isoNow } from "../../core/helpers.js";
import type { ProjectsService } from "./projects-service.js";
import type { OutboxChannelHandler, OutboxItem, OutboxPreview, OutboxStatus } from "./types.js";

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
export class OutboxService {
  private channels = new Map<string, OutboxChannelHandler>();

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

  private handler(channel: string): OutboxChannelHandler {
    const h = this.channels.get(channel);
    if (!h) throw new Error(`No outbox channel "${channel}" is registered`);
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
    project_id: string; flow_id: string; agent_id: string; run_id: string;
    channel: string; account_ref: string; payload: unknown; scheduled_for?: string | null;
  }): OutboxItem {
    const h = this.handler(input.channel);
    const when = normalizeWhen(input.scheduled_for) ?? null;
    const linked = this.projects.links(input.project_id).some((l) => l.ref_id === input.account_ref);
    if (!linked) throw new Error(`Account ${input.account_ref} is not linked to this project`);
    const v = h.validate(input.payload, input.account_ref);
    if (!v.ok) throw new Error(v.error);
    const now = isoNow();
    const id = newId();
    this.db.prepare(
      `INSERT INTO outbox_items (id, project_id, flow_id, agent_id, run_id, channel, account_ref, payload, scheduled_for, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(id, input.project_id, input.flow_id, input.agent_id, input.run_id, input.channel, input.account_ref,
      JSON.stringify(input.payload ?? {}), when, now, now);
    const item = this.mustGet(id);
    this.changed(item);
    return item;
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

  reject(id: string, note: string): OutboxItem {
    const now = isoNow();
    const res = this.db.prepare(
      "UPDATE outbox_items SET status = 'rejected', review_note = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
    ).run(note.trim(), now, now, id);
    if (Number(res.changes) === 0) throw new Error("Only a draft can be rejected");
    const it = this.mustGet(id);
    if (note.trim()) this.onReject(it, note.trim());
    this.changed(it);
    return it;
  }

  async approve(id: string, opts: { scheduled_for?: string | null } = {}): Promise<OutboxItem> {
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

  /** approved → sending atomically; whoever wins the UPDATE sends. */
  private async sendClaimed(id: string): Promise<OutboxItem> {
    const claim = this.db.prepare("UPDATE outbox_items SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'approved'")
      .run(isoNow(), id);
    if (Number(claim.changes) === 0) return this.mustGet(id);
    const it = this.mustGet(id);
    try {
      const { ref } = await this.handler(it.channel).send(it.payload, it.account_ref);
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
