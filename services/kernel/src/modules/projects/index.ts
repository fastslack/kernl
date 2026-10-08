import { resolve } from "node:path";
import type { DashboardDescriptor, ExtensibleModule, ModuleContext, ToolDefinition } from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { log } from "../../core/logger.js";
import { projectsMigrations } from "./migrations.js";
import { ProjectsService } from "./projects-service.js";
import { OutboxService } from "./outbox-service.js";
import { ConnectorService } from "./connector-service.js";
import { DraftNotifier } from "./draft-notifier.js";
import { placesTool } from "./places.js";
import { outboxTools, projectTools, type RunLookup, type FlowOfAgent } from "./tools.js";
import { registerProjectsRoutes } from "./api-routes.js";

/** data/projects/{slug}/ — each project's home (BRIEF.md, MEMORY.md, assets/). */
export const PROJECTS_ROOT = resolve(process.cwd(), "data", "projects");

const OUTBOX_TICK_MS = 60_000;
/** How often to look for projects due a pull (the 6h threshold is inside). */
const CONNECTOR_CHECK_MS = 15 * 60_000;

/**
 * Re-clone per_project schedules whenever an agent schedule is added, edited,
 * paused or removed — a template's clones follow it. The sync writes
 * agent_schedules directly and emits nothing, so this cannot loop.
 */
const SCHEDULE_CHANGES = new Set(["schedule_added", "schedule_updated", "schedule_removed"]);

export function watchScheduleChanges(events: import("../../core/event-bus.js").EventBus, svc: ProjectsService): void {
  events.on("data.changed", (p) => {
    const e = p as { module?: string; action?: string };
    if (e?.module !== "agents" || !SCHEDULE_CHANGES.has(e.action ?? "")) return;
    try { svc.syncAllOfficeSchedules(); } catch (err) { log.warn(`projects: schedule sync failed: ${String(err)}`); }
  });
}

export interface ProjectsModule extends ExtensibleModule {
  getService(): ProjectsService | null;
  getOutbox(): OutboxService | null;
  getConnector(): ConnectorService | null;
  /** How this module reads runs and agents' offices; bootstrap wires it after agents init. */
  setAgentLookups(lookups: {
    getRun: RunLookup;
    flowOf: FlowOfAgent;
    flowName?: (flowId: string) => string;
    listFlows?: () => Array<{ id: string; name: string }>;
  }): void;
}

/**
 * Projects: products/businesses that offices work for. Owns the project
 * tables and the outbox; the agents module only carries `project_id` and
 * reaches this one through the project gate bootstrap registers.
 */
export function createProjectsModule(): ProjectsModule {
  let service: ProjectsService | null = null;
  let outbox: OutboxService | null = null;
  let connector: ConnectorService | null = null;
  let connectorTimer: ReturnType<typeof setInterval> | null = null;
  let tools: ToolDefinition[] = [];
  let dashboard: DashboardDescriptor | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let lookups: {
    getRun: RunLookup;
    flowOf: FlowOfAgent;
    flowName?: (flowId: string) => string;
    listFlows?: () => Array<{ id: string; name: string }>;
  } = { getRun: () => undefined, flowOf: () => "" };

  return {
    name: "projects",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "projects", projectsMigrations);
      service = new ProjectsService(ctx.sqlite, ctx.events, {
        encryptionKey: ctx.config.encryption.key,
        projectsRoot: PROJECTS_ROOT,
      });
      outbox = new OutboxService(ctx.sqlite, ctx.events, service, (item, note) => {
        ctx.events.emit("outbox:rejected", { item_id: item.id, agent_id: item.agent_id, project_id: item.project_id, note });
      });
      watchScheduleChanges(ctx.events, service);
      const svcForNames = service;
      const drafts = new DraftNotifier(
        (msg) => ctx.notifier.send(msg),
        (pid) => svcForNames.get(pid)?.name ?? pid,
      );
      ctx.events.on("outbox:changed", (p) => drafts.onChanged(p as { id: string; project_id: string | null; status: string }));
      const interrupted = outbox.recoverInterrupted();
      if (interrupted > 0) log.warn(`projects: ${interrupted} outbox item(s) were interrupted while sending — marked failed`);
      tools = [
        ...outboxTools(outbox, (id) => lookups.getRun(id), (id) => lookups.flowOf(id)),
      ];
      dashboard = null;
      tickTimer = setInterval(() => {
        void outbox?.tick().catch((err) => log.warn(`projects: outbox tick failed: ${String(err)}`));
      }, OUTBOX_TICK_MS);
      tickTimer.unref?.();
      connector = new ConnectorService(ctx.sqlite, ctx.events, service);
      connectorTimer = setInterval(() => {
        void connector?.pullAllDue().catch((err) => log.warn(`projects: connector pull failed: ${String(err)}`));
      }, CONNECTOR_CHECK_MS);
      connectorTimer.unref?.();
      tools.push(...projectTools(service, outbox, connector));
      const db = ctx.sqlite;
      tools.push(placesTool({
        // Read live: Ajustes writes process.env and app_settings.
        apiKey: () => process.env.GOOGLE_PLACES_API_KEY
          ?? ((db.prepare("SELECT value FROM app_settings WHERE key = 'GOOGLE_PLACES_API_KEY'").get() as { value?: string } | undefined)?.value ?? ""),
      }));
      const svc = service;
      const ob = outbox;
      const cn = connector;
      dashboard = {
        registerRoutes: (server) => registerProjectsRoutes(server, {
          projects: svc,
          outbox: ob,
          connector: cn,
          flowName: (id) => lookups.flowName?.(id) ?? id,
          listFlows: () => lookups.listFlows?.() ?? [],
        }),
        nav: [
          { id: "projects", label: "Proyectos", icon: "📁", group: "work", order: 40 },
          { id: "outbox", label: "Aprobaciones", icon: "📤", group: "work", order: 50 },
        ],
      };
    },
    getTools() { return tools; },
    getDashboardDescriptor() { return dashboard; },
    getService() { return service; },
    getOutbox() { return outbox; },
    getConnector() { return connector; },
    setAgentLookups(l) { lookups = l; },
    async shutdown() {
      if (tickTimer) clearInterval(tickTimer);
      if (connectorTimer) clearInterval(connectorTimer);
      tickTimer = null;
      connectorTimer = null;
    },
  };
}
