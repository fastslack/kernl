import { type ExtensibleModule, type ModuleContext, type ToolDefinition, runMigrations } from "@kernl/extension-sdk";
import { redditMigrations } from "./migrations/001_reddit.js";
import { RedditService } from "./service.js";
import { redditTools } from "./tools.js";

export interface RedditModule extends ExtensibleModule {
  getService(): RedditService | null;
}

export function createRedditModule(): RedditModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: RedditService | null = null;

  return {
    name: "reddit",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "reddit", redditMigrations);
      const service = new RedditService(ctx.sqlite);
      serviceRef = service;
      tools = redditTools(service);
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

export default createRedditModule;
