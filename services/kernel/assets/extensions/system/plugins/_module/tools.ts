import { z } from "zod";
import { type ToolDefinition, defineTool, defineToolNoInput, textResult, errorResult } from "@kernl/extension-sdk";
import type { PluginManagerService } from "./service.js";

export function pluginsTools(service: PluginManagerService): ToolDefinition[] {
  return [
    // ── Repository Management ──────────────────────────

    defineTool({
      name: "kernel_plugins_add_repo",
      description:
        "Add a plugin repository (GitLab group, GitHub org, or single repo URL). Plugins from this repo become available for installation after syncing.",
      schema: z.object({
        name: z.string().describe("Friendly name for the repo (e.g. 'My Plugins')"),
        url: z.string().describe("Repository URL (e.g. 'https://gitlab.com/mygroup/kernel-plugins' or 'https://github.com/user')"),
        type: z.enum(["gitlab", "github", "gitea"]).optional().describe("Platform type (default: gitlab)"),
        token: z.string().optional().describe("Access token for private repos (optional)"),
      }),
      handler: async (input) => {
        const repo = service.addRepo(input);
        return textResult(
          `Repository added:\n  ID: ${repo.id}\n  Name: ${repo.name}\n  URL: ${repo.url}\n  Type: ${repo.type}\n\nUse kernel_plugins_sync to fetch available plugins.`,
        );
      },
    }),

    defineToolNoInput({
      name: "kernel_plugins_list_repos",
      description: "List all configured plugin repositories.",
      handler: async () => {
        const repos = service.listRepos();
        if (repos.length === 0) return textResult("No repositories configured. Use kernel_plugins_add_repo to add one.");

        const lines = repos.map(
          (r) => `**${r.name}** (${r.type})\n  URL: ${r.url}\n  Last synced: ${r.last_synced_at || "never"}\n  ID: ${r.id}`,
        );
        return textResult(lines.join("\n\n"));
      },
    }),

    defineTool({
      name: "kernel_plugins_remove_repo",
      description: "Remove a plugin repository and its cached index.",
      schema: z.object({
        id: z.string().describe("Repository ID"),
      }),
      handler: async ({ id }) => {
        const ok = service.removeRepo(id);
        if (!ok) return errorResult(`Repository not found: ${id}`);
        return textResult("Repository removed.");
      },
    }),

    // ── Sync & Browse ──────────────────────────────────

    defineTool({
      name: "kernel_plugins_sync",
      description:
        "Sync plugin repositories to discover available plugins. Fetches project lists from GitLab/GitHub/Gitea APIs.",
      schema: z.object({
        repo_id: z.string().optional().describe("Sync a specific repo (omit to sync all)"),
      }),
      handler: async ({ repo_id }) => {
        try {
          if (repo_id) {
            const result = await service.syncRepo(repo_id);
            return textResult(`Synced: ${result.found} plugins found.`);
          }
          const result = await service.syncAllRepos();
          return textResult(`All repos synced: ${result.total} total plugins found.`);
        } catch (err) {
          return errorResult(`Sync failed: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_plugins_browse",
      description: "Browse available plugins from synced repositories.",
      schema: z.object({
        repo_id: z.string().optional().describe("Filter by repository (omit for all)"),
      }),
      handler: async ({ repo_id }) => {
        const plugins = service.browsePlugins(repo_id);
        if (plugins.length === 0) return textResult("No plugins found. Use kernel_plugins_sync first.");

        const installed = new Set(service.listInstalled().map((p) => p.name));

        const lines = plugins.map((p) => {
          const status = installed.has(p.plugin_name) ? " [INSTALLED]" : "";
          return `**${p.plugin_name}**${status}${p.stars ? ` ⭐${p.stars}` : ""}\n  ${p.description || "(no description)"}\n  Clone: ${p.clone_url}\n  Registry ID: ${p.id}`;
        });
        return textResult(`${plugins.length} plugin(s) available:\n\n${lines.join("\n\n")}`);
      },
    }),

    // ── Install / Uninstall ────────────────────────────

    defineTool({
      name: "kernel_plugins_install",
      description:
        "Install a plugin from a repository. Provide either a registry_id (from browse) or a direct clone_url. Downloads the repo, validates plugin.json, and activates the plugin.",
      schema: z.object({
        registry_id: z.string().optional().describe("Plugin registry ID (from kernel_plugins_browse)"),
        clone_url: z.string().optional().describe("Direct git clone URL (alternative to registry_id)"),
      }),
      handler: async (input) => {
        if (!input.registry_id && !input.clone_url) {
          return errorResult("Provide either registry_id or clone_url");
        }
        try {
          const plugin = await service.install(input);
          return textResult(
            `Plugin installed successfully:\n  Name: ${plugin.name}\n  Version: ${plugin.version}\n  Author: ${plugin.author}\n  Status: ${plugin.status}\n  Path: ${plugin.install_path}\n\n⚠️ Restart Kernl to activate backend modules.`,
          );
        } catch (err) {
          return errorResult(`Install failed: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_plugins_install_file",
      description:
        "Install a plugin from a local archive file (.zip, .tar.gz, .tar). The archive must contain a plugin.json at the root (or inside a single top-level directory).",
      schema: z.object({
        file_path: z.string().describe("Absolute path to the archive file"),
      }),
      handler: async ({ file_path }) => {
        try {
          const plugin = await service.installFromFile(file_path);
          return textResult(
            `Plugin installed from archive:\n  Name: ${plugin.name}\n  Version: ${plugin.version}\n  Author: ${plugin.author}\n  Path: ${plugin.install_path}\n\n⚠️ Restart Kernl to activate backend modules.`,
          );
        } catch (err) {
          return errorResult(`Install from file failed: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_plugins_install_url",
      description:
        "Install a plugin by downloading an archive from a URL (.zip, .tar.gz). Useful for installing from GitLab/GitHub release assets or direct download links.",
      schema: z.object({
        url: z.string().describe("URL to the archive file (e.g. https://gitlab.com/user/plugin/-/archive/main/plugin-main.zip)"),
        token: z.string().optional().describe("Auth token for private downloads"),
      }),
      handler: async ({ url, token }) => {
        try {
          const plugin = await service.installFromUrl(url, token);
          return textResult(
            `Plugin installed from URL:\n  Name: ${plugin.name}\n  Version: ${plugin.version}\n  Author: ${plugin.author}\n  Path: ${plugin.install_path}\n\n⚠️ Restart Kernl to activate backend modules.`,
          );
        } catch (err) {
          return errorResult(`Install from URL failed: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_plugins_uninstall",
      description: "Uninstall a plugin by name. Removes all files and database entries.",
      schema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async ({ name }) => {
        try {
          const ok = await service.uninstall(name);
          if (!ok) return errorResult(`Plugin not found: ${name}`);
          return textResult(`Plugin "${name}" uninstalled. Restart Kernl to fully remove.`);
        } catch (err) {
          return errorResult(`Uninstall failed: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_plugins_update",
      description: "Update an installed plugin to the latest version from its repository.",
      schema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async ({ name }) => {
        try {
          const plugin = await service.update(name);
          return textResult(
            `Plugin updated:\n  Name: ${plugin.name}\n  Version: ${plugin.version}\n  Restart Kernl to apply changes.`,
          );
        } catch (err) {
          return errorResult(`Update failed: ${err}`);
        }
      },
    }),

    // ── Status Management ──────────────────────────────

    defineToolNoInput({
      name: "kernel_plugins_list",
      description: "List all installed plugins with their status.",
      handler: async () => {
        const plugins = service.listInstalled();
        if (plugins.length === 0) return textResult("No plugins installed.");

        const lines = plugins.map((p) => {
          const statusIcon = p.status === "active" ? "🟢" : p.status === "disabled" ? "🔴" : "⚠️";
          return `${statusIcon} **${p.name}** v${p.version}\n  ${p.description}\n  Author: ${p.author} | Status: ${p.status}\n  Installed: ${p.installed_at}\n  Path: ${p.install_path}`;
        });
        return textResult(`${plugins.length} plugin(s) installed:\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_plugins_enable",
      description: "Enable a disabled plugin.",
      schema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async ({ name }) => {
        const ok = service.setStatus(name, "active");
        if (!ok) return errorResult(`Plugin not found: ${name}`);
        return textResult(`Plugin "${name}" enabled. Restart Kernl to activate.`);
      },
    }),

    defineTool({
      name: "kernel_plugins_disable",
      description: "Disable an active plugin without uninstalling it.",
      schema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async ({ name }) => {
        const ok = service.setStatus(name, "disabled");
        if (!ok) return errorResult(`Plugin not found: ${name}`);
        return textResult(`Plugin "${name}" disabled.`);
      },
    }),

    // ── Plugin Info ────────────────────────────────────

    defineTool({
      name: "kernel_plugins_info",
      description: "Get detailed information about an installed plugin including its manifest.",
      schema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async ({ name }) => {
        const plugin = service.getInstalledByName(name);
        if (!plugin) return errorResult(`Plugin not found: ${name}`);

        const manifest = service.getManifest(name);
        const sections: string[] = [
          `# ${plugin.name} v${plugin.version}`,
          `**${plugin.description}**`,
          `Author: ${plugin.author}`,
          `Status: ${plugin.status}`,
          `Path: ${plugin.install_path}`,
          `Installed: ${plugin.installed_at}`,
          `Updated: ${plugin.updated_at}`,
        ];

        if (manifest) {
          if (manifest.backend) sections.push(`\nBackend: ${manifest.backend.entry}`);
          if (manifest.frontend?.nav) sections.push(`Frontend: ${manifest.frontend.nav.label} (${manifest.frontend.nav.icon})`);
          if (manifest.agents?.length) sections.push(`Agents: ${manifest.agents.join(", ")}`);
          if (manifest.skills?.length) sections.push(`Skills: ${manifest.skills.join(", ")}`);
          if (manifest.dependencies?.length) sections.push(`Dependencies: ${manifest.dependencies.join(", ")}`);
        }

        return textResult(sections.join("\n"));
      },
    }),
  ];
}
