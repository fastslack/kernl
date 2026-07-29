import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { PluginManagerService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

export function pluginsTools(service: PluginManagerService): ToolDefinition[] {
  return [
    // ── Repository Management ──────────────────────────

    {
      name: "kernel_plugins_add_repo",
      description:
        "Add a plugin repository (GitLab group, GitHub org, or single repo URL). Plugins from this repo become available for installation after syncing.",
      inputSchema: z.object({
        name: z.string().describe("Friendly name for the repo (e.g. 'My Plugins')"),
        url: z.string().describe("Repository URL (e.g. 'https://gitlab.com/mygroup/kernel-plugins' or 'https://github.com/user')"),
        type: z.enum(["gitlab", "github", "gitea"]).optional().describe("Platform type (default: gitlab)"),
        token: z.string().optional().describe("Access token for private repos (optional)"),
      }),
      handler: async (args) => {
        const input = args as { name: string; url: string; type?: string; token?: string };
        const repo = service.addRepo(input);
        return textResult(
          `Repository added:\n  ID: ${repo.id}\n  Name: ${repo.name}\n  URL: ${repo.url}\n  Type: ${repo.type}\n\nUse kernel_plugins_sync to fetch available plugins.`,
        );
      },
    },

    {
      name: "kernel_plugins_list_repos",
      description: "List all configured plugin repositories.",
      inputSchema: z.object({}),
      handler: async () => {
        const repos = service.listRepos();
        if (repos.length === 0) return textResult("No repositories configured. Use kernel_plugins_add_repo to add one.");

        const lines = repos.map(
          (r) => `**${r.name}** (${r.type})\n  URL: ${r.url}\n  Last synced: ${r.last_synced_at || "never"}\n  ID: ${r.id}`,
        );
        return textResult(lines.join("\n\n"));
      },
    },

    {
      name: "kernel_plugins_remove_repo",
      description: "Remove a plugin repository and its cached index.",
      inputSchema: z.object({
        id: z.string().describe("Repository ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const ok = service.removeRepo(id);
        if (!ok) return errorResult(`Repository not found: ${id}`);
        return textResult("Repository removed.");
      },
    },

    // ── Sync & Browse ──────────────────────────────────

    {
      name: "kernel_plugins_sync",
      description:
        "Sync plugin repositories to discover available plugins. Fetches project lists from GitLab/GitHub/Gitea APIs.",
      inputSchema: z.object({
        repo_id: z.string().optional().describe("Sync a specific repo (omit to sync all)"),
      }),
      handler: async (args) => {
        const { repo_id } = args as { repo_id?: string };
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
    },

    {
      name: "kernel_plugins_browse",
      description: "Browse available plugins from synced repositories.",
      inputSchema: z.object({
        repo_id: z.string().optional().describe("Filter by repository (omit for all)"),
      }),
      handler: async (args) => {
        const { repo_id } = args as { repo_id?: string };
        const plugins = service.browsePlugins(repo_id);
        if (plugins.length === 0) return textResult("No plugins found. Use kernel_plugins_sync first.");

        const installed = new Set(service.listInstalled().map((p) => p.name));

        const lines = plugins.map((p) => {
          const status = installed.has(p.plugin_name) ? " [INSTALLED]" : "";
          return `**${p.plugin_name}**${status}${p.stars ? ` ⭐${p.stars}` : ""}\n  ${p.description || "(no description)"}\n  Clone: ${p.clone_url}\n  Registry ID: ${p.id}`;
        });
        return textResult(`${plugins.length} plugin(s) available:\n\n${lines.join("\n\n")}`);
      },
    },

    // ── Install / Uninstall ────────────────────────────

    {
      name: "kernel_plugins_install",
      description:
        "Install a plugin from a repository. Provide either a registry_id (from browse) or a direct clone_url. Downloads the repo, validates plugin.json, and activates the plugin.",
      inputSchema: z.object({
        registry_id: z.string().optional().describe("Plugin registry ID (from kernel_plugins_browse)"),
        clone_url: z.string().optional().describe("Direct git clone URL (alternative to registry_id)"),
      }),
      handler: async (args) => {
        const input = args as { registry_id?: string; clone_url?: string };
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
    },

    {
      name: "kernel_plugins_install_file",
      description:
        "Install a plugin from a local archive file (.zip, .tar.gz, .tar). The archive must contain a plugin.json at the root (or inside a single top-level directory).",
      inputSchema: z.object({
        file_path: z.string().describe("Absolute path to the archive file"),
      }),
      handler: async (args) => {
        const { file_path } = args as { file_path: string };
        try {
          const plugin = await service.installFromFile(file_path);
          return textResult(
            `Plugin installed from archive:\n  Name: ${plugin.name}\n  Version: ${plugin.version}\n  Author: ${plugin.author}\n  Path: ${plugin.install_path}\n\n⚠️ Restart Kernl to activate backend modules.`,
          );
        } catch (err) {
          return errorResult(`Install from file failed: ${err}`);
        }
      },
    },

    {
      name: "kernel_plugins_install_url",
      description:
        "Install a plugin by downloading an archive from a URL (.zip, .tar.gz). Useful for installing from GitLab/GitHub release assets or direct download links.",
      inputSchema: z.object({
        url: z.string().describe("URL to the archive file (e.g. https://gitlab.com/user/plugin/-/archive/main/plugin-main.zip)"),
        token: z.string().optional().describe("Auth token for private downloads"),
      }),
      handler: async (args) => {
        const { url, token } = args as { url: string; token?: string };
        try {
          const plugin = await service.installFromUrl(url, token);
          return textResult(
            `Plugin installed from URL:\n  Name: ${plugin.name}\n  Version: ${plugin.version}\n  Author: ${plugin.author}\n  Path: ${plugin.install_path}\n\n⚠️ Restart Kernl to activate backend modules.`,
          );
        } catch (err) {
          return errorResult(`Install from URL failed: ${err}`);
        }
      },
    },

    {
      name: "kernel_plugins_uninstall",
      description: "Uninstall a plugin by name. Removes all files and database entries.",
      inputSchema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async (args) => {
        const { name } = args as { name: string };
        try {
          const ok = await service.uninstall(name);
          if (!ok) return errorResult(`Plugin not found: ${name}`);
          return textResult(`Plugin "${name}" uninstalled. Restart Kernl to fully remove.`);
        } catch (err) {
          return errorResult(`Uninstall failed: ${err}`);
        }
      },
    },

    {
      name: "kernel_plugins_update",
      description: "Update an installed plugin to the latest version from its repository.",
      inputSchema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async (args) => {
        const { name } = args as { name: string };
        try {
          const plugin = await service.update(name);
          return textResult(
            `Plugin updated:\n  Name: ${plugin.name}\n  Version: ${plugin.version}\n  Restart Kernl to apply changes.`,
          );
        } catch (err) {
          return errorResult(`Update failed: ${err}`);
        }
      },
    },

    // ── Status Management ──────────────────────────────

    {
      name: "kernel_plugins_list",
      description: "List all installed plugins with their status.",
      inputSchema: z.object({}),
      handler: async () => {
        const plugins = service.listInstalled();
        if (plugins.length === 0) return textResult("No plugins installed.");

        const lines = plugins.map((p) => {
          const statusIcon = p.status === "active" ? "🟢" : p.status === "disabled" ? "🔴" : "⚠️";
          return `${statusIcon} **${p.name}** v${p.version}\n  ${p.description}\n  Author: ${p.author} | Status: ${p.status}\n  Installed: ${p.installed_at}\n  Path: ${p.install_path}`;
        });
        return textResult(`${plugins.length} plugin(s) installed:\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_plugins_enable",
      description: "Enable a disabled plugin.",
      inputSchema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async (args) => {
        const { name } = args as { name: string };
        const ok = service.setStatus(name, "active");
        if (!ok) return errorResult(`Plugin not found: ${name}`);
        return textResult(`Plugin "${name}" enabled. Restart Kernl to activate.`);
      },
    },

    {
      name: "kernel_plugins_disable",
      description: "Disable an active plugin without uninstalling it.",
      inputSchema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async (args) => {
        const { name } = args as { name: string };
        const ok = service.setStatus(name, "disabled");
        if (!ok) return errorResult(`Plugin not found: ${name}`);
        return textResult(`Plugin "${name}" disabled.`);
      },
    },

    // ── Plugin Info ────────────────────────────────────

    {
      name: "kernel_plugins_info",
      description: "Get detailed information about an installed plugin including its manifest.",
      inputSchema: z.object({
        name: z.string().describe("Plugin name"),
      }),
      handler: async (args) => {
        const { name } = args as { name: string };
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
    },
  ];
}
