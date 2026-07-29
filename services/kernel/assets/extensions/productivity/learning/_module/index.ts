import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { learningMigrations } from "./migrations/001_learning.js";
import { LearningService } from "./service.js";
import { learningTools } from "./tools.js";
import { learningRpcActions } from "./rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export function createLearningModule(): KernelModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "learning",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "learning", learningMigrations);
      dbRef = ctx.sqlite;
      const service = new LearningService(ctx.sqlite);
      tools = learningTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? learningRpcActions(dbRef) : [];
    },

    async shutdown() {},
  };
}
