import type {
  ExtensibleModule,
  DashboardDescriptor,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { tasksMigrations } from "./migrations/001_tasks.js";
import { TaskService } from "./service.js";
import { taskTools } from "./tools.js";
import { registerTasksRoutes } from "./api-routes.js";
import { tasksRpcActions } from "./rpc-actions.js";
import { tasksDashboardRpcActions } from "./dashboard-rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export interface TasksModule extends ExtensibleModule {
  getService(): TaskService | null;
}

export function createTasksModule(): TasksModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: TaskService | null = null;
  let dbRef: SqliteDb | null = null;
  let eventsRef: EventBus | null = null;

  return {
    name: "tasks",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "tasks", tasksMigrations);

      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT task_id IF NOT EXISTS FOR (t:Task) REQUIRE t.id IS UNIQUE",
        );
      }

      const service = new TaskService(ctx.sqlite, () => ctx.graph);
      serviceRef = service;
      dbRef = ctx.sqlite;
      eventsRef = ctx.events;
      tools = taskTools(service);

      ctx.events.on("task.completed", async (payload) => {
        const { taskId } = payload as { taskId: string };
        service.update(taskId, { status: "done" });
      });
    },

    getTools() { return tools; },
    getService() { return serviceRef; },

    getRpcActions() {
      return serviceRef ? tasksRpcActions(serviceRef) : [];
    },

    getDashboardRpcActions() {
      return dbRef ? tasksDashboardRpcActions({ db: dbRef }) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        registerRoutes: (server) => {
          if (dbRef && eventsRef) registerTasksRoutes(server, dbRef, eventsRef);
        },
      };
    },

    async shutdown() {},
  };
}
