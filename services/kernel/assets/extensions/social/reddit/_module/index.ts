import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { redditMigrations } from "./migrations/001_reddit.js";
import { RedditService } from "./service.js";
import { redditTools } from "./tools.js";

export interface RedditModule extends ExtensibleModule {
  getService(): RedditService | null;
}

export function createRedditModule(): RedditModule {
  let serviceRef: RedditService | null = null;

  const mod = defineModule({
    name: "reddit",
    migrations: redditMigrations,
    init(ctx) {
      serviceRef = new RedditService(ctx.sqlite);
      return serviceRef;
    },
    tools: redditTools,
  });
  return Object.assign(mod, { getService: () => serviceRef });
}

export default createRedditModule;
