import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { eventsMigrations } from "./migrations/001_events.js";
import { EventsService } from "./service.js";
import { eventsTools } from "./tools.js";
import { agentEventsTools } from "./agent-tools.js";
import { queryEvents } from "./dashboard-queries.js";
import { eventsRpcActions } from "./rpc-actions.js";
import { eventsDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { registerEventsRoutes } from "./routes.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { SystemRegistry } from "../../../../../src/core/system-registry.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export interface EventsModule extends ExtensibleModule {
  getService(): EventsService | null;
}

export function createEventsModule(): EventsModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: EventsService | null = null;
  let dbRef: SqliteDb | null = null;
  let systemRegistryRef: SystemRegistry | null = null;
  let eventsRef: EventBus | null = null;

  return {
    name: "events",

    async initialize(ctx: ModuleContext) {
      // Run SQLite migrations
      runMigrations(ctx.sqlite, "events", eventsMigrations);
      dbRef = ctx.sqlite;
      systemRegistryRef = ctx.systemRegistry;
      eventsRef = ctx.events;

      // Create service with EventBus for notifications
      const service = new EventsService(ctx.sqlite, ctx.events);
      serviceRef = service;

      // Build tools — legacy CRUD + agent-shaped intent verbs.
      tools = [...eventsTools(service), ...agentEventsTools(service)];
    },

    getTools() {
      return tools;
    },

    getService() {
      return serviceRef;
    },

    getRpcActions() {
      return dbRef ? eventsRpcActions(dbRef) : [];
    },

    getDashboardRpcActions() {
      return dbRef && systemRegistryRef
        ? eventsDashboardRpcActions({ db: dbRef, systemRegistry: systemRegistryRef })
        : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
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
          if (dbRef) {
            registerEventsRoutes(server, dbRef, eventsRef ?? undefined);
          }
        },
      };
    },

    async shutdown() {
      // No cleanup needed
    },
  };
}

// Re-export types for external use
export type { Event, EventAttendee, EventWithSummary, AttendanceSummary } from "./types.js";
export { EventsService } from "./service.js";
