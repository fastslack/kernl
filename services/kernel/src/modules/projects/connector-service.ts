import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import { newId, isoNow } from "../../core/helpers.js";
import type { ProjectsService } from "./projects-service.js";
import {
  SnapshotV1Schema, WebhookEventSchema, verifySignature, describeZodError, type SnapshotV1,
} from "./connector-contract.js";

/** How often a project is pulled; webhooks fill the gaps in between. */
export const PULL_EVERY_MS = 6 * 60 * 60 * 1000;
/** Re-read this much before the last snapshot: covers records written while it was generated, and clock skew. Upserts make the overlap harmless. */
const PULL_OVERLAP_MS = 5 * 60 * 1000;

type Institution = SnapshotV1["institutions"][number];
type WaitlistEntry = SnapshotV1["waitlist"][number];

/**
 * A project's data in Kernl: pulled from its snapshot endpoint every 6 hours
 * and pushed by its signed webhooks. Stores a local copy (project_records),
 * turns admins and waitlist entries into CRM leads of the project, and
 * emits `project:<event>` with the project_id so office triggers run for it.
 */
export class ConnectorService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private projects: ProjectsService,
    private fetchFn: typeof fetch = fetch,
  ) {}

  records(projectId: string, kind: string): Array<{ external_id: string; data: unknown; updated_at: string }> {
    return (this.db.prepare(
      "SELECT external_id, data, updated_at FROM project_records WHERE project_id = ? AND kind = ? ORDER BY updated_at DESC",
    ).all(projectId, kind) as Array<{ external_id: string; data: string; updated_at: string }>)
      .map((r) => ({ ...r, data: JSON.parse(r.data) as unknown }));
  }

  private upsertRecord(projectId: string, kind: string, externalId: string, data: unknown): void {
    this.db.prepare(
      `INSERT INTO project_records (project_id, kind, external_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, kind, external_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(projectId, kind, externalId, JSON.stringify(data), isoNow());
  }

  /** `contacts` belongs to the CRM extension; without it, records still land. */
  private upsertContact(
    projectId: string,
    c: { name: string; email: string; phone?: string; company?: string },
    source: "signup" | "waitlist",
  ): void {
    if (!c.email) return;
    try {
      const existing = this.db.prepare("SELECT id FROM contacts WHERE email = ? AND project_id = ?")
        .get(c.email, projectId) as { id: string } | undefined;
      const now = isoNow();
      if (existing) {
        this.db.prepare("UPDATE contacts SET name = ?, phone = ?, company = ?, updated_at = ? WHERE id = ?")
          .run(c.name, c.phone ?? "", c.company ?? "", now, existing.id);
      } else {
        this.db.prepare(
          `INSERT INTO contacts (id, name, email, phone, company, notes, lead_status, lead_source, project_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '', 'new', ?, ?, ?, ?)`,
        ).run(newId(), c.name, c.email, c.phone ?? "", c.company ?? "", source, projectId, now, now);
      }
    } catch (err) {
      if (!/no such (table|column)/.test(String(err))) throw err;
    }
  }

  private ingestInstitution(projectId: string, i: Institution): void {
    this.upsertRecord(projectId, "institution", i.id, i);
    this.upsertContact(projectId, { name: i.admin.name, email: i.admin.email, phone: i.admin.phone, company: i.name }, "signup");
  }

  private ingestWaitlist(projectId: string, w: WaitlistEntry): void {
    this.upsertRecord(projectId, "waitlist_entry", w.email, w);
    this.upsertContact(projectId, { name: w.name, email: w.email, company: w.institution }, "waitlist");
  }

  async pull(projectId: string): Promise<{ institutions: number; waitlist: number }> {
    const p = this.projects.get(projectId);
    if (!p) throw new Error(`Project not found: ${projectId}`);
    const { url, token } = this.projects.connectorSecrets(p.id);
    if (!url) throw new Error(`Project ${p.slug} has no connector`);
    const since = this.projects.pullSince(p.id) ?? "1970-01-01T00:00:00Z";
    const startedAt = new Date().toISOString();
    try {
      const res = await this.fetchFn(`${url.replace(/\/$/, "")}/snapshot?since=${encodeURIComponent(since)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const parsed = SnapshotV1Schema.safeParse(await res.json());
      if (!parsed.success) throw new Error(`snapshot out of schema — ${describeZodError(parsed.error)}`);
      const snap = parsed.data;
      const tx = this.db.transaction(() => {
        for (const i of snap.institutions) this.ingestInstitution(p.id, i);
        for (const w of snap.waitlist) this.ingestWaitlist(p.id, w);
      });
      tx();
      const generated = snap.generated_at && !Number.isNaN(Date.parse(snap.generated_at)) ? snap.generated_at : startedAt;
      const cursor = new Date(Date.parse(generated) - PULL_OVERLAP_MS).toISOString();
      this.projects.markConnector(p.id, { last_pull_at: isoNow(), connector_error: "", pull_since: cursor });
      this.events.emit("project:snapshot", { project_id: p.id, institutions: snap.institutions.length, waitlist: snap.waitlist.length });
      return { institutions: snap.institutions.length, waitlist: snap.waitlist.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.projects.markConnector(p.id, { connector_error: msg });
      throw new Error(msg);
    }
  }

  /** `rawBody` is the request body exactly as received — the HMAC covers those bytes. */
  handleWebhook(slug: string, rawBody: string, signatureHeader: string): { status: 200 | 400 | 401 | 404; body: string } {
    const p = this.projects.get(slug);
    if (!p) return { status: 404, body: "unknown project" };
    const { webhookSecret } = this.projects.connectorSecrets(p.id);
    if (!verifySignature(rawBody, signatureHeader, webhookSecret)) return { status: 401, body: "bad signature" };
    let json: unknown;
    try { json = JSON.parse(rawBody); } catch { return { status: 400, body: "invalid json" }; }
    const parsed = WebhookEventSchema.safeParse(json);
    if (!parsed.success) return { status: 400, body: describeZodError(parsed.error) };
    const ev = parsed.data;
    const fresh = this.db.prepare("INSERT OR IGNORE INTO project_webhook_events (project_id, event_id, received_at) VALUES (?, ?, ?)")
      .run(p.id, ev.event_id, isoNow());
    if (Number(fresh.changes) === 0) return { status: 200, body: "duplicate" };
    if (ev.type === "institution.created") this.ingestInstitution(p.id, ev.data);
    if (ev.type === "waitlist.joined") this.ingestWaitlist(p.id, ev.data);
    this.projects.markConnector(p.id, { last_webhook_at: isoNow() });
    this.events.emit(`project:${ev.type}`, { ...ev.data, project_id: p.id, project_slug: p.slug, event_id: ev.event_id });
    return { status: 200, body: "ok" };
  }

  async pullAllDue(now: Date = new Date()): Promise<void> {
    for (const p of this.projects.list({ status: "active" })) {
      if (!p.connector_url) continue;
      if (p.last_pull_at && now.getTime() - Date.parse(p.last_pull_at) < PULL_EVERY_MS) continue;
      await this.pull(p.id).catch(() => { /* recorded in connector_error */ });
    }
  }
}
