import {
  type KernelModule,
  type ModuleContext,
  type ToolDefinition,
  runMigrations,
} from "@kernl/extension-sdk";
import { learningMigrations } from "./migrations/001_learning.js";
import { LearningService } from "./service.js";
import { learningTools } from "./tools.js";
import { learningRpcActions } from "./rpc-actions.js";

export function createLearningModule(): KernelModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: LearningService | null = null;

  return {
    name: "learning",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "learning", learningMigrations);
      const service = new LearningService(ctx.sqlite);
      serviceRef = service;
      tools = learningTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return serviceRef ? learningRpcActions(serviceRef) : [];
    },

    async shutdown() {},
  };
}
