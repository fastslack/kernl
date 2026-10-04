/**
 * Kernl's own bugs, as the chief or the operator files them. Local first:
 * a report is published (kernl-bugs-routes.ts) only when the operator says so.
 * Every text field is redacted before it is stored; the same failure seen
 * again folds into its report (fingerprint), and a chief diagnosis of a run the
 * operator already reported merges into that report (run_id).
 */
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { encryptIfNeeded, decrypt } from "../../sdk/crypto.js";
import { redactForReport, bugFingerprint } from "./kernl-bugs-redact.js";

export type BugStatus = "new" | "published" | "fixed" | "dismissed";
export interface KernlBug {
  id: string; fingerprint: string; title: string; area: string; diagnosis: string; repro: string;
  context: Record<string, unknown>; source: "chief" | "operator"; run_id: string; agent_id: string;
  occurrences: number; status: BugStatus; issue_url: string;
  created_at: string; last_seen_at: string; published_at: string | null;
}
export interface BugInput {
  title: string; area?: string; diagnosis?: string; repro?: string; error?: string;
  context?: Record<string, unknown>; source: "chief" | "operator"; run_id?: string; agent_id?: string;
}

const DEFAULT_REPO = "fastslack/kernl";
const now = () => new Date().toISOString();
const clean = (s: string | undefined, max = 20_000) => redactForReport(String(s ?? "")).trim().slice(0, max);
const redactDeep = (v: unknown): unknown =>
  typeof v === "string" ? redactForReport(v)
  : Array.isArray(v) ? v.map(redactDeep)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]))
  : v;

type Row = Omit<KernlBug, "context"> & { context_json: string };
const toBug = (r: Row): KernlBug => {
  const { context_json, ...rest } = r;
  let context: Record<string, unknown> = {};
  try { context = JSON.parse(context_json || "{}"); } catch { /* keep {} */ }
  return { ...rest, context };
};

export class KernlBugService {
  constructor(private readonly db: SqliteDb, private readonly encryptionKey: string) {}

  report(input: BugInput): { bug: KernlBug; repeat: boolean } {
    const title = clean(input.title, 120) || "Untitled Kernl bug";
    const area = clean(input.area, 80);
    const diagnosis = clean(input.diagnosis);
    const repro = clean(input.repro);
    const context = JSON.stringify(redactDeep(input.context ?? {}));
    const t = now();

    // 1) The same run already reported (operator first, chief diagnosis later).
    const byRun = input.run_id
      ? (this.db.prepare(
          `SELECT r.* FROM kernl_bug_reports r
             LEFT JOIN kernl_bug_runs x ON x.bug_id = r.id
            WHERE r.run_id = ? OR x.run_id = ? LIMIT 1`,
        ).get(input.run_id, input.run_id) as Row | undefined)
      : undefined;
    if (byRun) {
      const chief = input.source === "chief";
      this.db.prepare(
        `UPDATE kernl_bug_reports SET
           title = CASE WHEN ? AND ? <> '' THEN ? ELSE title END,
           area = CASE WHEN ? <> '' AND (? OR area = '') THEN ? ELSE area END,
           diagnosis = CASE WHEN ? <> '' AND (? OR diagnosis = '') THEN ? ELSE diagnosis END,
           repro = CASE WHEN ? <> '' AND (? OR repro = '') THEN ? ELSE repro END,
           source = CASE WHEN ? THEN 'chief' ELSE source END,
           last_seen_at = ?
         WHERE id = ?`,
      ).run(chief, title, title, area, chief, area, diagnosis, chief, diagnosis, repro, chief, repro, chief, t, byRun.id);
      return { bug: this.get(byRun.id)!, repeat: true };
    }

    // 2) The same failure, seen before. With an error, the error alone is the
    // identity: the area is the reporter's guess (free text, and absent from an
    // operator report), so including it split one bug into several.
    const fingerprint = input.error ? bugFingerprint("", input.error) : bugFingerprint(area, title);
    const existing = this.db.prepare("SELECT * FROM kernl_bug_reports WHERE fingerprint = ?").get(fingerprint) as Row | undefined;
    if (existing) {
      this.db.prepare("UPDATE kernl_bug_reports SET occurrences = occurrences + 1, last_seen_at = ? WHERE id = ?").run(t, existing.id);
      this.linkRun(input.run_id, existing.id);
      return { bug: this.get(existing.id)!, repeat: true };
    }

    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO kernl_bug_reports
         (id, fingerprint, title, area, diagnosis, repro, context_json, source, run_id, agent_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, fingerprint, title, area, diagnosis, repro, context, input.source, input.run_id ?? "", input.agent_id ?? "", t, t);
    this.linkRun(input.run_id, id);
    return { bug: this.get(id)!, repeat: false };
  }

  private linkRun(runId: string | undefined, bugId: string): void {
    if (runId) this.db.prepare("INSERT OR IGNORE INTO kernl_bug_runs (run_id, bug_id) VALUES (?, ?)").run(runId, bugId);
  }

  list(status?: BugStatus): KernlBug[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM kernl_bug_reports WHERE status = ? ORDER BY last_seen_at DESC").all(status)
      : this.db.prepare("SELECT * FROM kernl_bug_reports ORDER BY last_seen_at DESC").all()) as Row[];
    return rows.map(toBug);
  }

  get(id: string): KernlBug | null {
    const r = this.db.prepare("SELECT * FROM kernl_bug_reports WHERE id = ?").get(id) as Row | undefined;
    return r ? toBug(r) : null;
  }

  update(id: string, patch: Partial<Pick<KernlBug, "title" | "area" | "diagnosis" | "repro" | "status">>): KernlBug | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = {
      title: patch.title !== undefined ? clean(patch.title, 120) || cur.title : cur.title,
      area: patch.area !== undefined ? clean(patch.area, 80) : cur.area,
      diagnosis: patch.diagnosis !== undefined ? clean(patch.diagnosis) : cur.diagnosis,
      repro: patch.repro !== undefined ? clean(patch.repro) : cur.repro,
      status: patch.status ?? cur.status,
    };
    this.db.prepare("UPDATE kernl_bug_reports SET title = ?, area = ?, diagnosis = ?, repro = ?, status = ? WHERE id = ?")
      .run(next.title, next.area, next.diagnosis, next.repro, next.status, id);
    return this.get(id);
  }

  markPublished(id: string, issueUrl: string): KernlBug | null {
    this.db.prepare("UPDATE kernl_bug_reports SET status = 'published', issue_url = ?, published_at = ? WHERE id = ?")
      .run(issueUrl, now(), id);
    return this.get(id);
  }

  private setting(key: string): string {
    return (this.db.prepare("SELECT value FROM kernl_bug_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? "";
  }
  private put(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kernl_bug_settings (key, value) VALUES (?, ?)").run(key, value);
  }

  getSettings(): { repo: string; token_set: boolean } {
    return { repo: this.setting("repo") || DEFAULT_REPO, token_set: !!this.setting("token") };
  }

  setSettings(input: { repo?: string; token?: string }): { repo: string; token_set: boolean } {
    if (input.repo !== undefined) {
      const repo = input.repo.trim();
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must look like owner/name");
      this.put("repo", repo);
    }
    if (input.token !== undefined) {
      const token = input.token.trim();
      this.put("token", token ? (this.encryptionKey ? encryptIfNeeded(token, this.encryptionKey) : token) : "");
    }
    return this.getSettings();
  }

  getToken(): string {
    const v = this.setting("token");
    if (!v) return "";
    try { return this.encryptionKey ? decrypt(v, this.encryptionKey) : v; } catch { return ""; }
  }
}
