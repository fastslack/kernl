import {
  type ExtensibleModule,
  type DashboardDescriptor,
  type ModuleContext,
  type ToolDefinition,
  runMigrations,
  type SqliteDb,
  type EventBus,
} from "@kernl/extension-sdk";
import { tasksMigrations } from "./migrations/001_tasks.js";
import { TaskService } from "./service.js";
import { taskTools } from "./tools.js";
import { registerTasksRoutes } from "./api-routes.js";
import { tasksRpcActions } from "./rpc-actions.js";
import { queryTasks } from "./dashboard-queries.js";

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

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [{ name: "tasks", query: (db) => queryTasks(db) }],
        registerRoutes: (server) => {
          if (dbRef && eventsRef) registerTasksRoutes(server, dbRef, eventsRef);
        },
      };
    },

    async shutdown() {},
  };
}
