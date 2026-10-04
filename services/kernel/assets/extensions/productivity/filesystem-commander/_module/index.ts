/**
 * Filesystem Commander — dual-pane file manager module.
 *
 * Distributed as an installable extension (see
 * `assets/extensions/productivity/filesystem-commander/extension.json`). The canonical
 * TypeScript source lives here; the extension wrapper re-exports
 * `createFilesystemCommanderModule()` as `createModule()` so the loader can
 * find it via `import()`.
 */

import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { fsCommanderMigrations } from "./migrations.js";
import { FsCommanderService } from "./service.js";
import { filesystemCommanderTools } from "./tools.js";
import { registerFilesystemCommanderRoutes } from "./api-routes.js";

export interface FilesystemCommanderModule extends ExtensibleModule {
  getService(): FsCommanderService | null;
}

export function createFilesystemCommanderModule(): FilesystemCommanderModule {
  let service: FsCommanderService | null = null;

  const mod = defineModule({
    name: "filesystem-commander",
    migrations: fsCommanderMigrations,

    init(ctx) {
      service = new FsCommanderService(ctx.sqlite, ctx.config);
      return { service, config: ctx.config };
    },

    tools: (s) => filesystemCommanderTools(s.service),

    dashboard: (s) => ({
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
        // Routes stay off once the module has shut down.
        if (s && service) {
          registerFilesystemCommanderRoutes(server, s.service, {
            maxPreviewBytes: s.config.fsCommander.maxPreviewBytes,
            maxEditorBytes: s.config.fsCommander.maxEditorBytes,
          });
        }
      },
    }),

    async shutdown() {
      if (service) await service.shutdown();
      service = null;
    },
  });

  return Object.assign(mod, {
    getService() {
      return service;
    },
  });
}
