import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
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
  let serviceRef: TaskService | null = null;

  const mod = defineModule({
    name: "tasks",
    migrations: tasksMigrations,

    async init(ctx) {
      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT task_id IF NOT EXISTS FOR (t:Task) REQUIRE t.id IS UNIQUE",
        );
      }

      const service = new TaskService(ctx.sqlite, () => ctx.graph);
      serviceRef = service;

      ctx.events.on("task.completed", async (payload) => {
        const { taskId } = payload as { taskId: string };
        service.update(taskId, { status: "done" });
      });

      return { service, events: ctx.events };
    },

    tools: (s) => taskTools(s.service),
    rpc: (s) => tasksRpcActions(s.service, s.events),

    dashboard: (s) => ({
      channels: [{ name: "tasks", query: (db) => queryTasks(db) }],
      registerRoutes: (server) => {
        if (s && s.events) registerTasksRoutes(server, s.service, s.events);
      },
    }),
  });

  return Object.assign(mod, {
    getService() {
      return serviceRef;
    },
  });
}
