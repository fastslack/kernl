import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { triageMigrations } from "./migrations.js";
import { TriageService } from "./service.js";
import { triageTools } from "./tools.js";
import {
  RepoProviderRegistry,
  TRIAGE_REGISTER_PROVIDER_EVENT,
  type RegisterProviderEvent,
} from "./repo-provider.js";

export interface TriageModule extends ExtensibleModule {
  getService(): TriageService | null;
}

export function createTriageModule(): TriageModule {
  let service: TriageService | null = null;
  const registry = new RepoProviderRegistry();

  return {
    ...defineModule({
      name: "triage",
      migrations: triageMigrations,
      migrationsKey: "ext:triage",
      init(ctx) {
        service = new TriageService(ctx.sqlite, registry);

        // Channel extensions (github, gitlab, …) emit this event after they
        // initialize. Their manifest must declare a dependency on triage so
        // that this listener is in place before they fire.
        ctx.events.on(
          TRIAGE_REGISTER_PROVIDER_EVENT,
          (payload: unknown) => {
            const ev = payload as RegisterProviderEvent;
            registry.register(ev.provider);
          },
          { module: "triage", description: "Receive repo provider registrations" },
        );
        return service;
      },
      tools: triageTools,

      // No dashboard descriptor on purpose.
      //
      // This module used to declare a whole "Automation" sidebar group whose
      // single item pointed at /triage — a view with no page behind it: no
      // static route, no `frontend.pages` bundle. The catch-all route resolved
      // it to <ExtensionGate/>, so the group was a rail icon leading only to an
      // "extension not installed" screen. Triage is backend-only (tools + the
      // repo-provider event bus); it earns a nav entry the day it ships a page.
    }),

    getService() {
      return service;
    },
  };
}

export default createTriageModule;
