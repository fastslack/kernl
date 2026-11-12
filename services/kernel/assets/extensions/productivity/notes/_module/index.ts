import { defineModule, dashboardChannel } from "@kernl/extension-sdk";
import { notesMigrations } from "./migrations/001_notes.js";
import { NotesService } from "./service.js";
import { notesTools } from "./tools.js";
import { queryNotes } from "./dashboard-queries.js";
import { notesRpcActions } from "./rpc-actions.js";

export function createNotesModule() {
  return defineModule({
    name: "notes",
    migrations: notesMigrations,
    async init(ctx) {
      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT note_id IF NOT EXISTS FOR (n:Note) REQUIRE n.id IS UNIQUE",
        );
      }
      return new NotesService(ctx.sqlite, () => ctx.graph);
    },
    tools: notesTools,
    graphBackfill: (s) => ({ name: "notes", version: 1, order: 20, run: (g) => s.graphBackfill(g) }),
    rpc: notesRpcActions,
    dashboard: dashboardChannel("notes", (db) => queryNotes(db)),
  });
}
