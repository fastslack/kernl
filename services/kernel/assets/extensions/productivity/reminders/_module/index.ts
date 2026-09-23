import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { remindersMigrations } from "./migrations/001_reminders.js";
import { ReminderService } from "./service.js";
import { ReminderScheduler } from "./scheduler.js";
import { reminderTools } from "./tools.js";
import { registerRemindersRoutes } from "./api-routes.js";
import { remindersRpcActions } from "./rpc-actions.js";
import { queryReminders } from "./dashboard-queries.js";
import { remindersCalendarSource } from "./calendar.js";

export interface RemindersModule extends ExtensibleModule {
  getService(): ReminderService | null;
}

export function createRemindersModule(): RemindersModule {
  let serviceRef: ReminderService | null = null;

  const mod = defineModule({
    name: "reminders",
    migrations: remindersMigrations,

    async init(ctx) {
      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT reminder_id IF NOT EXISTS FOR (r:Reminder) REQUIRE r.id IS UNIQUE",
        );
      }

      const service = new ReminderService(ctx.sqlite, () => ctx.graph);
      serviceRef = service;

      const scheduler = new ReminderScheduler(
        service,
        ctx.notifier,
        ctx.events,
        ctx.config.reminders.pollIntervalMs,
        ctx.systemRegistry,
      );
      scheduler.start();

      // ARCH 3D beam bridge — surface fired reminders to the dashboard
      // visor as a generic cross_module beam.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.events.on("reminder.fired" as any, () => {
        ctx.events.emit("arch.cross_module", {
          source: "reminders",
          target: "dashboard",
          label: "reminder fired",
        }).catch(() => {});
      });

      return { service, events: ctx.events, scheduler };
    },

    tools: (s, ctx) => reminderTools(s.service, ctx.notifier),
    rpc: (s) => remindersRpcActions(s.service, s.events),

    dashboard: (s) => ({
      channels: [{ name: "reminders", query: (db) => queryReminders(db) }],
      calendarSources: [remindersCalendarSource],
      registerRoutes: (server) => {
        if (s && s.events) registerRemindersRoutes(server, s.service, s.events);
      },
    }),

    shutdown: (s) => s.scheduler.stop(),
  });

  return Object.assign(mod, {
    getService() {
      return serviceRef;
    },
  });
}
