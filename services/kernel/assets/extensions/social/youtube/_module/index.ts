import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { youtubeMigrations } from "./migrations/001_youtube.js";
import { YouTubeService } from "./service.js";
import { youtubeTools } from "./tools.js";

export interface YouTubeModule extends ExtensibleModule {
  getService(): YouTubeService | null;
}

export function createYouTubeModule(): YouTubeModule {
  let serviceRef: YouTubeService | null = null;

  const mod = defineModule({
    name: "youtube",
    migrations: youtubeMigrations,
    init(ctx) {
      serviceRef = new YouTubeService(ctx.sqlite);
      return serviceRef;
    },
    tools: youtubeTools,
  });
  return Object.assign(mod, { getService: () => serviceRef });
}

export default createYouTubeModule;
