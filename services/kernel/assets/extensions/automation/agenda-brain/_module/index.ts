/**
 * Agenda Brain extension module — schedules morning/evening task briefs.
 */
import { type SqliteDb, defineModule, log } from "@kernl/extension-sdk";
import { migrations } from './migrations/001_agenda_brain.js';
import { planToday } from './brain-service.js';
import { AgendaBrainScheduler, localDateKey } from './scheduler.js';

/**
 * Read the configured notification channel from app_settings.
 *
 * Defaults to 'all' (broadcast to every registered provider) rather than to a
 * specific one: pinning a channel the operator hasn't configured makes
 * `Notifier.send` return false and drop the brief silently. Setting
 * `agenda_brain.channel` still narrows it to a single provider on purpose.
 */
function readChannel(db: SqliteDb): string {
  try {
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = 'agenda_brain.channel'")
      .get() as { value: string } | undefined;
    return row?.value?.trim() || 'all';
  } catch {
    return 'all';
  }
}

export function createAgendaBrainModule() {
  return defineModule({
    name: 'agenda-brain',
    migrations,
    migrationsKey: 'agenda_brain',
    init(ctx) {
      const channel = readChannel(ctx.sqlite);
      const scheduler = new AgendaBrainScheduler(
        ctx.sqlite,
        ctx.notifier,
        channel,
        ctx.systemRegistry,
      );
      scheduler.start();
      log.info(`Agenda Brain initialized — channel="${channel}"`);
      return { db: ctx.sqlite, scheduler };
    },
    dashboardRpc: ({ db }) => [
      {
        name: 'agendaBrain.today',
        handler: async (_args: Record<string, unknown>) => planToday(db, localDateKey()),
      },
    ],
    shutdown({ scheduler }) {
      scheduler.stop();
    },
  });
}

export default createAgendaBrainModule;
