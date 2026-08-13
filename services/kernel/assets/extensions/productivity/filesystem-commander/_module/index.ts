/**
 * Filesystem Commander — dual-pane file manager module.
 *
 * Distributed as an installable extension (see
 * `assets/extensions/productivity/filesystem-commander/extension.json`). The canonical
 * TypeScript source lives here; the extension wrapper re-exports
 * `createFilesystemCommanderModule()` as `createModule()` so the loader can
 * find it via `import()`.
 */

import type {
  DashboardDescriptor,
  ExtensibleModule,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { fsCommanderMigrations } from "./migrations.js";
import { FsCommanderService } from "./service.js";
import { filesystemCommanderTools } from "./tools.js";
import { registerFilesystemCommanderRoutes } from "./api-routes.js";

export interface FilesystemCommanderModule extends ExtensibleModule {
  getService(): FsCommanderService | null;
}

export function createFilesystemCommanderModule(): FilesystemCommanderModule {
  let service: FsCommanderService | null = null;
  let tools: ToolDefinition[] = [];
  let config: KernelConfig | null = null;

  return {
    name: "filesystem-commander",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "filesystem-commander", fsCommanderMigrations);
      service = new FsCommanderService(ctx.sqlite, ctx.config);
      config = ctx.config;
      tools = filesystemCommanderTools(service);
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        // Extension contributes its own top-level sidebar group — no need
        // to squat in the hardcoded "system" bucket anymore.
        navGroups: [
          {
            id: "tools",
            label: "Tools",
            icon: "🧰",          // 🧰
            order: 550,                      // between "ai" (6th) and "system" (last)
            defaultView: "commander",
          },
        ],
        nav: [
          {
            id: "commander",
            label: "Commander",
            icon: "⧉",
            group: "tools",
            order: 10,
          },
          // A "Workspaces" child tab used to live here, deep-linking the
          // Commander at /app/data/workspaces. It was a second door onto
          // AI → Workspace, under a different group and a different name, so
          // the same directory appeared twice in the sidebar with no way to
          // tell the two entries apart. The Commander reaches that path from
          // its own tree; the nav entry is AI → Workspace.
        ],
        registerRoutes: (server) => {
          if (service && config) {
            registerFilesystemCommanderRoutes(server, service, {
              maxPreviewBytes: config.fsCommander.maxPreviewBytes,
              maxEditorBytes: config.fsCommander.maxEditorBytes,
            });
          }
        },
      };
    },

    async shutdown() {
      if (service) await service.shutdown();
      service = null;
      tools = [];
      config = null;
    },
  };
}
