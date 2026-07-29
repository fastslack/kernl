/**
 * AgendaBrainScheduler — polls every minute and fires morning (08:00) and
 * evening (23:00) briefs in Europe/Amsterdam time, idempotent across restarts.
 */
import type { SqliteDb } from '../../../../../src/core/db/sqlite.js';
import type { Notifier } from '../../../../../src/core/notify/notifier.js';
import type { SystemRegistry } from '../../../../../src/core/system-registry.js';
import { log } from '../../../../../src/core/logger.js';
import { planToday } from './brain-service.js';
import { buildBrief, alreadySent, recordSent } from './brief.js';

const TZ = 'Europe/Amsterdam';

export function localDateKey(): string {
  return nowParts().dateKey;
}

function nowParts(): { dateKey: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // ICU edge-case at midnight
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour };
}

export class AgendaBrainScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private registryId = '';
  private readonly pollMs = 60_000;

  constructor(
    private db: SqliteDb,
    private notifier: Notifier,
    private channel: string,
    private systemRegistry?: SystemRegistry,
  ) {}

  start(): void {
    log.info('Agenda Brain scheduler started (morning 08:00, evening 23:00 Europe/Amsterdam)');
    if (this.systemRegistry) {
      this.registryId = this.systemRegistry.register({
        name: 'agenda-brain',
        module: 'agenda-brain',
        type: 'interval',
        description: 'Morning + evening agenda briefs in Europe/Amsterdam time',
        intervalMs: this.pollMs,
      });
    }
    this.timer = setInterval(() => this.tick().catch((e) => log.error('agenda-brain tick failed', e)), this.pollMs);
    this.tick().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.registryId) this.systemRegistry?.updateStatus(this.registryId, 'stopped');
  }

  async tick(): Promise<void> {
    const { dateKey, hour } = nowParts();
    const slot = hour === 8 ? 'morning' : hour === 23 ? 'evening' : null;
    if (!slot) return;
    if (alreadySent(this.db, dateKey, slot)) return;

    const plan = planToday(this.db, dateKey);
    const { title, body } = buildBrief(plan, slot as 'morning' | 'evening');
    await this.notifier.send({ title, body, channel: this.channel, source: 'agenda-brain' });
    recordSent(this.db, dateKey, slot, this.channel, plan.items.length);
    log.info(`Agenda Brain "${slot}" brief sent for ${dateKey} via ${this.channel}`);
  }
}
