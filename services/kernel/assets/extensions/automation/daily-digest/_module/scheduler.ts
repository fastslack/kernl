/**
 * Scheduling primitives for the daily digest — kept pure so the timezone +
 * fire-once logic is unit-testable without mocking the clock.
 */
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { SystemRegistry } from "../../../../../src/core/system-registry.js";
import { log } from "../../../../../src/core/logger.js";

export type DigestKind = "evening" | "morning";

export interface AmsterdamParts {
  hour: number;
  minute: number;
  dateKey: string; // YYYY-MM-DD in Europe/Amsterdam
}

export interface DigestConfig {
  eveningHour: number;
  morningHour: number;
}

/** Wall-clock parts in Europe/Amsterdam (DST-correct via Intl). */
export function amsterdamParts(d: Date): AmsterdamParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some ICU builds emit 24 at midnight
  return {
    hour,
    minute: parseInt(parts.minute, 10),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Which digests are due right now, given what was last sent (by date). */
export function dueDigests(
  parts: AmsterdamParts,
  lastSent: { evening?: string; morning?: string },
  cfg: DigestConfig,
): DigestKind[] {
  const out: DigestKind[] = [];
  if (parts.hour === cfg.morningHour && lastSent.morning !== parts.dateKey) out.push("morning");
  if (parts.hour === cfg.eveningHour && lastSent.evening !== parts.dateKey) out.push("evening");
  return out;
}

/**
 * Polls every minute; when a digest is due (and not yet sent today, even
 * across restarts via the daily_digest_log table) it invokes `onFire`.
 * Mirrors the ReminderScheduler shape (setInterval + SystemRegistry entry).
 */
export class DailyDigestScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private registryId = "";
  private readonly pollMs = 60_000;

  constructor(
    private db: SqliteDb,
    private cfg: DigestConfig,
    private onFire: (kind: DigestKind) => Promise<void>,
    private systemRegistry?: SystemRegistry,
  ) {}

  start(): void {
    log.info(
      `Daily digest scheduler started (evening ${this.cfg.eveningHour}:00, morning ${this.cfg.morningHour}:00 Europe/Amsterdam)`,
    );
    if (this.systemRegistry) {
      this.registryId = this.systemRegistry.register({
        name: "daily-digest",
        module: "daily-digest",
        type: "interval",
        description: "Sends evening (tomorrow) + morning (today) digests in Europe/Amsterdam time",
        intervalMs: this.pollMs,
      });
    }
    this.timer = setInterval(() => this.tick().catch((e) => log.error("digest tick failed", e)), this.pollMs);
    // Fire an immediate check so a restart inside the target minute still works.
    this.tick().catch(() => {});
  }

  private lastSent(): { evening?: string; morning?: string } {
    const rows = this.db
      .prepare("SELECT kind, sent_date FROM daily_digest_log")
      .all() as Array<{ kind: DigestKind; sent_date: string }>;
    const out: { evening?: string; morning?: string } = {};
    // Keep the most recent sent_date per kind.
    for (const r of rows) {
      if (!out[r.kind] || r.sent_date > (out[r.kind] as string)) out[r.kind] = r.sent_date;
    }
    return out;
  }

  private async tick(): Promise<void> {
    const parts = amsterdamParts(new Date());
    const due = dueDigests(parts, this.lastSent(), this.cfg);
    for (const kind of due) {
      await this.onFire(kind);
      this.db
        .prepare("INSERT OR IGNORE INTO daily_digest_log (kind, sent_date, created_at) VALUES (?, ?, ?)")
        .run(kind, parts.dateKey, new Date().toISOString());
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.registryId) this.systemRegistry?.updateStatus(this.registryId, "stopped");
  }
}
