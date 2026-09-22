import {
  type ExtensibleModule,
  type DashboardDescriptor,
  type ModuleContext,
  type ToolDefinition,
  runMigrations,
  type EventBus,
} from "@kernl/extension-sdk";
import { remindersMigrations } from "./migrations/001_reminders.js";
import { ReminderService } from "./service.js";
import { ReminderScheduler } from "./scheduler.js";
import { reminderTools } from "./tools.js";
import { registerRemindersRoutes } from "./api-routes.js";
import { remindersRpcActions } from "./rpc-actions.js";
import { queryReminders } from "./dashboard-queries.js";

export interface RemindersModule extends ExtensibleModule {
  getService(): ReminderService | null;
}

export function createRemindersModule(): RemindersModule {
  let tools: ToolDefinition[] = [];
  let scheduler: ReminderScheduler | null = null;
  let serviceRef: ReminderService | null = null;
  let eventsRef: EventBus | null = null;

  return {
    name: "reminders",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "reminders", remindersMigrations);

      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT reminder_id IF NOT EXISTS FOR (r:Reminder) REQUIRE r.id IS UNIQUE",
        );
      }

      const service = new ReminderService(ctx.sqlite, () => ctx.graph);
      serviceRef = service;
      eventsRef = ctx.events;

      tools = reminderTools(service, ctx.notifier);

      scheduler = new ReminderScheduler(
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
    },

    getTools() { return tools; },
    getService() { return serviceRef; },

    getRpcActions() {
      return serviceRef ? remindersRpcActions(serviceRef, eventsRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [{ name: "reminders", query: (db) => queryReminders(db) }],
        registerRoutes: (server) => {
          if (serviceRef && eventsRef) registerRemindersRoutes(server, serviceRef, eventsRef);
        },
      };
    },

    async shutdown() {
      scheduler?.stop();
    },
  };
}
