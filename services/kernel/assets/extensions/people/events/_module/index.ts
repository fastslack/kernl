import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { eventsMigrations } from "./migrations/001_events.js";
import { EventsService } from "./service.js";
import { eventsTools } from "./tools.js";
import { agentEventsTools } from "./agent-tools.js";
import { queryEvents } from "./dashboard-queries.js";
import { eventsRpcActions } from "./rpc-actions.js";
import { eventsDashboardRpcActions } from "./dashboard-rpc-actions.js";
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
      // Create service with EventBus for notifications
      const service = new EventsService(ctx.sqlite, ctx.events);
      serviceRef = service;
      return { service, db: ctx.sqlite, systemRegistry: ctx.systemRegistry, events: ctx.events };
    },

    // Legacy CRUD + agent-shaped intent verbs.
    tools: (s) => [...eventsTools(s.service), ...agentEventsTools(s.service)],
    rpc: (s) => eventsRpcActions(s.service),
    dashboardRpc: (s) =>
      s.systemRegistry
        ? eventsDashboardRpcActions({ db: s.db, systemRegistry: s.systemRegistry })
        : [],

    dashboard: (s) => ({
      channels: [
        { name: "events", query: (db) => queryEvents(db) },
      ],
      channelMappings: [
        { moduleKey: "events", channels: ["events", "dashboard", "calendar"] },
      ],
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
