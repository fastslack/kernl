/**
 * Agenda Brain extension module — schedules morning/evening task briefs.
 */
import type { KernelModule, ModuleContext, ToolDefinition } from '../../../../../src/core/types.js';
import type { SqliteDb } from '../../../../../src/core/db/sqlite.js';
import type { RpcAction } from '../../../../../src/core/mtw/rpc-handler.js';
import { runMigrations } from '../../../../../src/core/db/migrations.js';
import { log } from '../../../../../src/core/logger.js';
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

export function createAgendaBrainModule(): KernelModule {
  let scheduler: AgendaBrainScheduler | null = null;
  let dbRef: SqliteDb | null = null;
  const tools: ToolDefinition[] = [];

  return {
    name: 'agenda-brain',

    async initialize(ctx: ModuleContext): Promise<void> {
      runMigrations(ctx.sqlite, 'agenda_brain', migrations);
      dbRef = ctx.sqlite;

      const channel = readChannel(ctx.sqlite);
      scheduler = new AgendaBrainScheduler(
        ctx.sqlite,
        ctx.notifier,
        channel,
        ctx.systemRegistry,
      );
      scheduler.start();
      log.info(`Agenda Brain initialized — channel="${channel}"`);
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    getDashboardRpcActions(): RpcAction[] {
      return [
        {
          name: 'agendaBrain.today',
          handler: async (_args: Record<string, unknown>) => {
            if (!dbRef) return null;
            const dateKey = localDateKey();
            return planToday(dbRef, dateKey);
          },
        },
      ];
    },

    async shutdown(): Promise<void> {
      scheduler?.stop();
    },
  };
}

export default createAgendaBrainModule;
