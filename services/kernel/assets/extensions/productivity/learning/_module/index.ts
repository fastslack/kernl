import { defineModule } from "@kernl/extension-sdk";
import { learningMigrations } from "./migrations/001_learning.js";
import { LearningService } from "./service.js";
import { learningTools } from "./tools.js";
import { learningRpcActions } from "./rpc-actions.js";

export function createLearningModule() {
  return defineModule({
    name: "learning",
    migrations: learningMigrations,
    init: (ctx) => new LearningService(ctx.sqlite),
    tools: (s) => learningTools(s),
    rpc: (s) => learningRpcActions(s),
  });
}
