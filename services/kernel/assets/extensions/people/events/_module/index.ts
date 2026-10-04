import { type ExtensibleModule, defineModule, normalizeInstants } from "@kernl/extension-sdk";
import { eventsMigrations } from "./migrations/001_events.js";
import { EventsService } from "./service.js";
import { eventsTools } from "./tools.js";
import { agentEventsTools } from "./agent-tools.js";
import { queryEvents } from "./dashboard-queries.js";
import { eventsRpcActions } from "./rpc-actions.js";
import { eventsCalendarSource } from "./calendar.js";
import { registerEventsRoutes } from "./routes.js";

export interface EventsModule extends ExtensibleModule {
  getService(): EventsService | null;
}

export function createEventsModule(): EventsModule {
  let serviceRef: EventsService | null = null;

  const mod = defineModule({
    name: "events",
    migrations: eventsMigrations,

    init(ctx) {
      // Starts stored without a zone predate the "UTC instant" rule; every
      // day window and the calendar compare them as instants.
      normalizeInstants(ctx.sqlite, "events", ["start_at", "end_at"]);

      // Create service with EventBus for notifications
      const service = new EventsService(ctx.sqlite, ctx.events);
      serviceRef = service;
      return { service, db: ctx.sqlite, events: ctx.events };
    },

    // Legacy CRUD + agent-shaped intent verbs.
    tools: (s) => [...eventsTools(s.service), ...agentEventsTools(s.service)],
    rpc: (s) => eventsRpcActions(s.service),
    // The `dashboard.calendar` RPC is the dashboard's own operation now (it
    // composes every module's calendar source); events contributes its
    // entries through `calendarSources` below.
    dashboard: (s) => ({
      channels: [
        { name: "events", query: (db) => queryEvents(db) },
      ],
      channelMappings: [
        { moduleKey: "events", channels: ["events", "dashboard", "calendar"] },
      ],
      calendarSources: [eventsCalendarSource],
      stores: ["events"],
      fetchEndpoints: [
        { url: "/api/dashboard/events", store: "events" },
      ],
      registerRoutes: (server) => {
        if (s) {
          registerEventsRoutes(server, s.db, s.events ?? undefined);
        }
      },
    }),
  });

  return Object.assign(mod, {
    getService() {
      return serviceRef;
    },
  });
}

// Re-export types for external use
export type { Event, EventAttendee, EventWithSummary, AttendanceSummary } from "./types.js";
export { EventsService } from "./service.js";
