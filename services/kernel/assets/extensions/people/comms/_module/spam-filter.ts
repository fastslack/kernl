/**
 * Spam filter — acts on the triage's spam verdict, per account.
 *
 * Off by default. "dry_run" only records what would have moved; "move" moves
 * the message to the server's spam folder (or a chosen one). Every decision
 * is kept in communications.metadata.spam so it can be listed and undone:
 * "not spam" moves the message back to INBOX and keeps the row in step with
 * its new UID, so the fetcher does not import it a second time.
 */

import { type SqliteDb, isoNow, log } from "@kernl/extension-sdk";
import type { EmailProvider } from "./providers/types.js";

export type SpamMode = "off" | "dry_run" | "move";

export interface SpamSettings {
  mode: SpamMode;
  /** Minimum triage confidence (0–1) to act on. */
  min_confidence: number;
  /** Destination folder; "" = the server's spam folder. */
  folder: string;
}

export const DEFAULT_SPAM_SETTINGS: SpamSettings = { mode: "off", min_confidence: 0.85, folder: "" };

export type SpamAction = "moved" | "would_move" | "move_failed" | "restored" | "dismissed";

export interface SpamRecord {
  action: SpamAction;
  confidence: number;
  reason: string;
  mode: SpamMode;
  at: string;
  folder?: string;
  /** UID of the message in `folder` after the move. */
  uid?: string;
  /** UID it had in INBOX before the move. */
  original_uid?: string;
  error?: string;
  restored_at?: string;
}

export interface SpamVerdict {
  /** communications.id */
  id: string;
  spam: boolean;
  confidence: number;
  reason: string;
}

export interface SpamLogEntry {
  id: string;
  account_id: string | null;
  subject: string;
  from: string;
  date: string;
  spam: SpamRecord;
}

const settingsKey = (accountId: string) => `comms.spam.${accountId}`;

export function normalizeSpamSettings(raw: unknown): SpamSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SpamSettings>;
  const mode: SpamMode = r.mode === "dry_run" || r.mode === "move" ? r.mode : "off";
  const c = Number(r.min_confidence);
  const min_confidence = Number.isFinite(c) ? Math.min(Math.max(c, 0.5), 1) : DEFAULT_SPAM_SETTINGS.min_confidence;
  const folder = typeof r.folder === "string" ? r.folder.trim().slice(0, 200) : "";
  return { mode, min_confidence, folder };
}

/** What to do with one verdict under these settings; null = nothing. */
export function spamActionFor(v: Pick<SpamVerdict, "spam" | "confidence">, s: SpamSettings): "move" | "would_move" | null {
  if (s.mode === "off" || !v.spam || !(v.confidence >= s.min_confidence)) return null;
  return s.mode === "move" ? "move" : "would_move";
}

export class SpamFilter {
  constructor(
    private db: SqliteDb,
    private providerFor: (accountId: string) => EmailProvider | null,
  ) {}

  getSettings(accountId: string): SpamSettings {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(settingsKey(accountId)) as { value: string } | undefined;
    if (!row) return { ...DEFAULT_SPAM_SETTINGS };
    try {
      return normalizeSpamSettings(JSON.parse(row.value));
    } catch {
      return { ...DEFAULT_SPAM_SETTINGS };
    }
  }

  setSettings(accountId: string, input: unknown): SpamSettings {
    const s = normalizeSpamSettings(input);
    // app_settings.updated_at is NOT NULL with no default.
    this.db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(settingsKey(accountId), JSON.stringify(s), isoNow());
    return s;
  }

  /**
   * Act on the triage verdicts of communications rows. Returns the ids
   * treated as spam (moved or flagged), which get no draft and no letter.
   */
  async apply(verdicts: SpamVerdict[]): Promise<{ spamIds: Set<string>; moved: number; flagged: number; failed: number }> {
    const spamIds = new Set<string>();
    let moved = 0, flagged = 0, failed = 0;
    for (const v of verdicts) {
      if (!v.spam) continue;
      const row = this.row(v.id);
      if (!row?.account_id) continue;
      const settings = this.getSettings(row.account_id);
      const action = spamActionFor(v, settings);
      if (!action) continue;
      spamIds.add(v.id);
      const base = { confidence: v.confidence, reason: v.reason.slice(0, 300), mode: settings.mode, at: isoNow() };
      if (action === "would_move") {
        this.record(v.id, { ...base, action: "would_move" });
        flagged++;
        continue;
      }
      const result = await this.move(row, settings.folder || "junk");
      if (result.ok) {
        this.record(v.id, { ...base, action: "moved", folder: result.folder, uid: result.uid, original_uid: row.gmail_message_id });
        moved++;
      } else {
        this.record(v.id, { ...base, action: "move_failed", error: result.error });
        failed++;
      }
    }
    return { spamIds, moved, flagged, failed };
  }

  /** Move a flagged (dry-run or failed) message to spam now. */
  async moveNow(id: string): Promise<SpamRecord> {
    const row = this.row(id);
    if (!row?.account_id) throw new Error("Email not found");
    const current = row.spam;
    if (!current || (current.action !== "would_move" && current.action !== "move_failed" && current.action !== "dismissed")) {
      throw new Error("This email is not waiting to be moved");
    }
    const settings = this.getSettings(row.account_id);
    const result = await this.move(row, settings.folder || "junk");
    if (!result.ok) throw new Error(result.error);
    const rec: SpamRecord = {
      ...current, action: "moved", folder: result.folder, uid: result.uid,
      original_uid: row.gmail_message_id, at: isoNow(), error: undefined,
    };
    this.record(id, rec);
    return rec;
  }

  /** "Not spam": a moved message goes back to INBOX; a flagged one is just cleared. */
  async restore(id: string): Promise<SpamRecord> {
    const row = this.row(id);
    if (!row?.account_id || !row.spam) throw new Error("Email not found");
    const current = row.spam;
    if (current.action !== "moved") {
      const rec: SpamRecord = { ...current, action: "dismissed", restored_at: isoNow() };
      this.record(id, rec);
      return rec;
    }
    const provider = this.providerFor(row.account_id);
    if (!provider?.moveMessage) throw new Error("This account cannot move messages");
    const back = await provider.moveMessage({ uid: current.uid, messageId: row.message_id }, "inbox", current.folder || "junk");
    // Keep the row on the message's new INBOX UID: the fetcher dedups on it,
    // and would otherwise import the restored mail as a new one.
    if (back.uid) {
      this.db.prepare("UPDATE communications SET gmail_message_id = ?, updated_at = ? WHERE id = ?").run(back.uid, isoNow(), id);
    }
    const rec: SpamRecord = { ...current, action: "restored", restored_at: isoNow(), uid: undefined };
    this.record(id, rec);
    return rec;
  }

  /** Recent spam decisions, newest first. */
  list(opts: { accountId?: string; limit?: number } = {}): SpamLogEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = this.db.prepare(`
      SELECT id, account_id, subject, COALESCE(json_extract(metadata, '$.from'), '') AS sender,
             COALESCE(NULLIF(sent_at, ''), created_at) AS date, json_extract(metadata, '$.spam') AS spam
      FROM communications
      WHERE channel = 'email' AND direction = 'inbound'
        AND json_extract(metadata, '$.spam') IS NOT NULL
        AND (? = '' OR account_id = ?)
      ORDER BY json_extract(metadata, '$.spam.at') DESC
      LIMIT ?
    `).all(opts.accountId ?? "", opts.accountId ?? "", limit) as Array<{
      id: string; account_id: string | null; subject: string; sender: string; date: string; spam: string;
    }>;
    return rows.map((r) => ({
      id: r.id, account_id: r.account_id, subject: r.subject, from: r.sender, date: r.date,
      spam: JSON.parse(r.spam) as SpamRecord,
    }));
  }

  private async move(row: Row, to: string): Promise<{ ok: true; folder: string; uid: string } | { ok: false; error: string }> {
    const provider = this.providerFor(row.account_id!);
    if (!provider?.moveMessage) return { ok: false, error: "This account cannot move messages" };
    try {
      const r = await provider.moveMessage({ uid: row.gmail_message_id, messageId: row.message_id }, to, "INBOX");
      return { ok: true, folder: r.folder, uid: r.uid };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`Comms: spam move of ${row.id} failed: ${error}`);
      return { ok: false, error };
    }
  }

  private row(id: string): Row | null {
    const r = this.db.prepare(`
      SELECT id, account_id, gmail_message_id,
             COALESCE(json_extract(metadata, '$.message_id_header'), '') AS message_id,
             json_extract(metadata, '$.spam') AS spam
      FROM communications WHERE id = ?
    `).get(id) as (Omit<Row, "spam"> & { spam: string | null }) | undefined;
    if (!r) return null;
    let spam: SpamRecord | null = null;
    try { spam = r.spam ? JSON.parse(r.spam) as SpamRecord : null; } catch { spam = null; }
    return { ...r, spam };
  }

  private record(id: string, rec: SpamRecord): void {
    const clean = Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined));
    this.db.prepare(`
      UPDATE communications
      SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.spam', json(?)), updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(clean), isoNow(), id);
  }
}

interface Row {
  id: string;
  account_id: string | null;
  gmail_message_id: string;
  message_id: string;
  spam: SpamRecord | null;
}
