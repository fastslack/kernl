import { type ExtensibleModule, defineModule, registerOutboxChannel, log } from "@kernl/extension-sdk";
import { resolve } from "node:path";
import { linkedinChannel, linkedinAccountsView } from "./outbox-channel.js";
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
      // Outbox channel (projects): approved drafts are posted through here.
      try {
        registerOutboxChannel("linkedin_post", linkedinChannel({
          service: () => serviceRef,
          projectAssetsRoot: resolve(process.cwd(), "data", "projects"),
        }));
      } catch (err) {
        log.warn(`linkedin: outbox channel not registered (${err instanceof Error ? err.message : String(err)})`);
      }
      return serviceRef;
    },
    tools: linkedinTools,
    dashboard: {
      registerRoutes: (server) => {
        server.route("GET", "/api/linkedin/accounts", () => ({
          accounts: linkedinAccountsView(serviceRef?.listAccounts() ?? []),
        }));
      },
    },
  });
  return Object.assign(mod, { getService: () => serviceRef });
}

export default createLinkedInModule;
