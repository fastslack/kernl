import { type ExtensibleModule, type ModuleContext, type ToolDefinition, runMigrations } from "@kernl/extension-sdk";
import { linkedinMigrations } from "./migrations/001_linkedin.js";
import { LinkedInService } from "./service.js";
import { linkedinTools } from "./tools.js";

export interface LinkedInModule extends ExtensibleModule {
  getService(): LinkedInService | null;
}

export function createLinkedInModule(): LinkedInModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: LinkedInService | null = null;

  return {
    name: "linkedin",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "linkedin", linkedinMigrations);
      const service = new LinkedInService(ctx.sqlite);
      serviceRef = service;
      tools = linkedinTools(service);
    },

    getTools() {
      return tools;
    },

    getService() {
      return serviceRef;
    },

    async shutdown() {},
  };
}

export default createLinkedInModule;
