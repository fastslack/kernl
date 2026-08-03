import type {
  ExtensibleModule,
  DashboardDescriptor,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
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
  let tools: ToolDefinition[] = [];
  let service: TriageService | null = null;
  const registry = new RepoProviderRegistry();

  return {
    name: "triage",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "ext:triage", triageMigrations);
      service = new TriageService(ctx.sqlite, registry);
      tools = triageTools(service);

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
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        // The group has to be declared, not just referenced. Without this the
        // sidebar had a nav item pointing at a group nobody defined, so the
        // item was silently dropped — and once the dashboard started creating
        // missing groups on the fly, it appeared with an invented icon and no
        // ordering instead of the real ones.
        navGroups: [
          {
            id: "automation",
            label: "Automation",
            icon: "\u2699\ufe0f",
            order: 600,
          },
        ],
        nav: [
          {
            id: "triage",
            label: "Triage",
            icon: "\ud83e\ude7a",
            group: "automation",
            order: 50,
          },
        ],
      };
    },

    async shutdown() {},
  };
}

export default createTriageModule;
