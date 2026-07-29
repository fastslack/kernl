/**
 * Daily Digest extension.
 *
 * Two scheduled, deterministic digests in Europe/Amsterdam time:
 *   - evening (21:00) → preview of tomorrow
 *   - morning (07:00) → today's agenda + overdue
 *
 * Pushed to the configured channels (Telegram/WhatsApp) and always to the
 * dashboard as a fallback. No LLM — pure SQL summaries of the user's own
 * tasks/events/reminders.
 */
import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { log } from "../../../../../src/core/logger.js";
import { dailyDigestMigrations } from "./migrations.js";
import { DailyDigestScheduler, type DigestKind } from "./scheduler.js";
import { buildEveningDigest, buildMorningDigest } from "./digest-service.js";
import { deliverDigest } from "./delivery.js";
import { digestTools } from "./tools.js";

interface DigestSettings {
  eveningHour: number;
  morningHour: number;
  channels: string[];
  enabled: boolean;
}

/** Read overrides from app_settings (graceful — defaults if absent/missing). */
function readSettings(db: SqliteDb): DigestSettings {
  const get = (key: string): string | undefined => {
    try {
      const r = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return r?.value;
    } catch {
      return undefined;
    }
  };
  const num = (key: string, def: number): number => {
    const v = get(key);
    const n = v != null ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : def;
  };
  const channels = (get("digest.channels") ?? "telegram,whatsapp")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    eveningHour: num("digest.evening_hour", 21),
    morningHour: num("digest.morning_hour", 7),
    channels,
    enabled: (get("digest.enabled") ?? "true") !== "false",
  };
}

export function createDailyDigestModule(): KernelModule {
  let scheduler: DailyDigestScheduler | null = null;
  let tools: ToolDefinition[] = [];

  return {
    name: "daily-digest",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "daily-digest", dailyDigestMigrations);

      const cfg = readSettings(ctx.sqlite);
      const registry = ctx.notifier.getRegistry();

      const dispatch = async (kind: DigestKind): Promise<Record<string, boolean>> => {
        const content =
          kind === "evening" ? buildEveningDigest(ctx.sqlite, new Date()) : buildMorningDigest(ctx.sqlite, new Date());
        return deliverDigest(registry, cfg.channels, {
          title: content.title,
          body: content.markdown,
          format: "markdown",
          source: "daily-digest",
          priority: "normal",
        });
      };

      scheduler = new DailyDigestScheduler(
        ctx.sqlite,
        { eveningHour: cfg.eveningHour, morningHour: cfg.morningHour },
        async (kind) => {
          const res = await dispatch(kind);
          log.info(`Daily digest "${kind}" sent: ${JSON.stringify(res)}`);
        },
        ctx.systemRegistry,
      );
      if (cfg.enabled) scheduler.start();
      else log.info("Daily digest disabled (digest.enabled=false)");

      tools = digestTools({ db: ctx.sqlite, sendNow: dispatch });
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    async shutdown() {
      scheduler?.stop();
    },
  };
}

export default createDailyDigestModule;
