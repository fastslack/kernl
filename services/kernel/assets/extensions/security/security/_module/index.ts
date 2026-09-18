import { type KernelModule, type ModuleContext, type ToolDefinition, runMigrations } from "@kernl/extension-sdk";
import { securityMigrations } from "./migrations/001_security.js";
import { SecurityService } from "./service.js";
import { securityTools } from "./tools.js";

export function createSecurityModule(): KernelModule {
  let tools: ToolDefinition[] = [];

  return {
    name: "security",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "security", securityMigrations);
      const service = new SecurityService(ctx.sqlite);
      tools = securityTools(service);
    },

    getTools() {
      return tools;
    },

    async shutdown() {},
  };
}
