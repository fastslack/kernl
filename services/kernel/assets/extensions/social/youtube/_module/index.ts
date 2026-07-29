import type {
  ExtensibleModule,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { youtubeMigrations } from "./migrations/001_youtube.js";
import { YouTubeService } from "./service.js";
import { youtubeTools } from "./tools.js";

export interface YouTubeModule extends ExtensibleModule {
  getService(): YouTubeService | null;
}

export function createYouTubeModule(): YouTubeModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: YouTubeService | null = null;

  return {
    name: "youtube",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "youtube", youtubeMigrations);
      const service = new YouTubeService(ctx.sqlite);
      serviceRef = service;
      tools = youtubeTools(service);
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

export default createYouTubeModule;
