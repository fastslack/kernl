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
          // Sub-tab showcased under /commander: jumps straight into the
          // agent workspaces root. Uses the `path` override to carry query
          // string, and `parent` so it only appears while the Commander
          // page is open.
          {
            id: "commander-workspaces",
            label: "Workspaces",
            icon: "🗂",          // 🗂
            group: "tools",
            parent: "commander",
            path: "/commander?provider=local&path=%2Fapp%2Fdata%2Fworkspaces&label=Agent%20workspaces",
            order: 20,
          },
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
