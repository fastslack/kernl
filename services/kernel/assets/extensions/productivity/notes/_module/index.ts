import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { notesMigrations } from "./migrations/001_notes.js";
import { NotesService } from "./service.js";
import { notesTools } from "./tools.js";
import { queryNotes } from "./dashboard-queries.js";
import { notesRpcActions } from "./rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export function createNotesModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "notes",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "notes", notesMigrations);
      dbRef = ctx.sqlite;

      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT note_id IF NOT EXISTS FOR (n:Note) REQUIRE n.id IS UNIQUE",
        );
      }

      const service = new NotesService(ctx.sqlite, () => ctx.graph);
      tools = notesTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? notesRpcActions(dbRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [
          { name: "notes", query: (db) => queryNotes(db) },
        ],
        channelMappings: [
          { moduleKey: "notes", channels: ["notes"] },
        ],
        stores: ["notes"],
        fetchEndpoints: [
          { url: "/api/dashboard/notes", store: "notes" },
        ],
      };
    },

    async shutdown() {},
  };
}
