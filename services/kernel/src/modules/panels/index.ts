// src/modules/panels/index.ts
import { runMigrations } from "../../core/db/migrations.js";
import { getRequestContext } from "../../core/request-context.js";
import type { ExtensibleModule, ModuleContext, ToolDefinition, DashboardDescriptor } from "../../core/types.js";
import { panelsMigrations } from "./migrations.js";
import { PanelStore } from "./store.js";
import { PanelGateway, type PanelDeps } from "./gateway.js";
import { registerPanelsRoutes } from "./api-routes.js";
import { panelTools } from "./tools.js";

type Deps = PanelDeps & {
  ownerOfRun: (runId: string) => string | null;
  officeAgentSlugs: (flowId: string) => string[];
  officeRoot: (flowId: string) => string;
};

export function createPanelsModule(): ExtensibleModule & { setDeps(d: Deps): void; getStore(): PanelStore | null } {
  let store: PanelStore | null = null;
  let deps: Deps | null = null;
  let tools: ToolDefinition[] = [];
  let dashboard: DashboardDescriptor | null = null;
  // Deps arrive after every module initialised (agents is needed); until then actions refuse.
  const lazy: PanelDeps = {
    agentInOffice: (f, s) => deps?.agentInOffice(f, s) ?? null,
    postLetter: (l) => deps ? deps.postLetter(l) : { ok: false, error: "panels not wired yet" },
    startRun: (r) => { if (!deps) throw new Error("panels not wired yet"); return deps.startRun(r); },
    setSchedulesActive: (a, on) => deps?.setSchedulesActive(a, on) ?? 0,
    readChannel: (name, params) => deps?.readChannel ? deps.readChannel(name, params) : Promise.resolve(undefined),
  };
  return {
    name: "panels",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "panels", panelsMigrations);
      store = new PanelStore(ctx.sqlite);
      const gw = new PanelGateway(store, lazy);
      const s = store;
      tools = panelTools(s, () => {
        const runId = getRequestContext().callerRunId;
        return runId && deps ? deps.ownerOfRun(runId) : null;
      });
      dashboard = {
        registerRoutes: (server) => registerPanelsRoutes(server, gw, s, {
          officeAgentSlugs: (f) => deps?.officeAgentSlugs(f) ?? [],
          officeRoot: (f) => deps?.officeRoot(f) ?? "",
        }),
      };
    },
    getTools() { return tools; },
    getDashboardDescriptor() { return dashboard; },
    setDeps(d: Deps) { deps = d; },
    getStore() { return store; },
    async shutdown() {},
  };
}
