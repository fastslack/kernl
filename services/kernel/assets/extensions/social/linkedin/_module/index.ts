import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { linkedinMigrations } from "./migrations/001_linkedin.js";
import { LinkedInService } from "./service.js";
import { linkedinTools } from "./tools.js";

export interface LinkedInModule extends ExtensibleModule {
  getService(): LinkedInService | null;
}

export function createLinkedInModule(): LinkedInModule {
  let serviceRef: LinkedInService | null = null;

  const mod = defineModule({
    name: "linkedin",
    migrations: linkedinMigrations,
    init(ctx) {
      serviceRef = new LinkedInService(ctx.sqlite);
      return serviceRef;
    },
    tools: linkedinTools,
  });
  return Object.assign(mod, { getService: () => serviceRef });
}

export default createLinkedInModule;
