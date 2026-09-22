/**
 * `/api/claude-config` — the Claude Code host configuration the dashboard edits:
 * user-scope MCP servers and enabled plugins.
 *
 * Split out of `api-routes.ts` unchanged. It reads and writes files under the
 * host's `~/.claude/`, which is why it needs nothing from the agents module
 * beyond the HTTP server itself.
 */

import { HttpError, type KernelHttpServer } from "../../../core/http-server.js";

export function registerClaudeConfigRoutes(server: KernelHttpServer): void {


  // ── Claude Code host config ────────────────────────────────────
  // Wraps ~/.claude.json + ~/.claude/settings.json so the dashboard can manage
  // user-scope MCPs + plugin enablement exactly as `claude mcp add` / `claude
  // plugin` would. Files are the source of truth; the CLI and the SDK read
  // from the same locations.

  server.route("GET", "/api/claude-config", async () => {
    const cfg = await import("../claude-host-config.js");
    return {
      hostHome: cfg.hostHome(),
      mcpServers: cfg.readUserScopeMcps(),
      enabledPlugins: cfg.readEnabledPlugins(),
      extraKnownMarketplaces: cfg.readClaudeSettings().extraKnownMarketplaces ?? {},
    };
  });

  server.route<{
    name: string;
    type?: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }>("POST", "/api/claude-config/mcp", async ({ body }) => {
    if (!body.name || !/^[a-z0-9][a-z0-9_-]*$/i.test(body.name)) {
      throw new HttpError(400, "Invalid name (alphanumeric, dashes, underscores)");
    }
    const type = body.type ?? (body.url ? "http" : "stdio");
    if (type === "stdio" && !body.command) throw new HttpError(400, "stdio MCP requires 'command'");
    if ((type === "http" || type === "sse") && !body.url) throw new HttpError(400, `${type} MCP requires 'url'`);

    const cfg = await import("../claude-host-config.js");
    const mcp: import("../claude-host-config.js").ClaudeMcpServer =
      type === "stdio"
        ? { type: "stdio", command: body.command!, args: body.args, env: body.env }
        : { type, url: body.url!, env: body.env };
    cfg.upsertUserScopeMcp(body.name, mcp);
    return { ok: true, name: body.name, scope: "user" };
  });

  server.route("DELETE", "/api/claude-config/mcp/:name", async ({ params: { name } }) => {
    const cfg = await import("../claude-host-config.js");
    const result = cfg.removeUserScopeMcp(name);
    if (!result.removedFromJson && !result.removedFromSettings) {
      throw new HttpError(404, `MCP "${name}" not found in user scope`);
    }
    return { ok: true, ...result };
  });

  server.route("POST", "/api/claude-config/plugin/:ref/enable", ({ params: { ref } }) => togglePlugin(ref, true));
  server.route("POST", "/api/claude-config/plugin/:ref/disable", ({ params: { ref } }) => togglePlugin(ref, false));

  async function togglePlugin(ref: string, enabled: boolean) {
    const decoded = decodeURIComponent(ref);
    const cfg = await import("../claude-host-config.js");
    cfg.setPluginEnabled(decoded, enabled);
    return { ok: true, ref: decoded, enabled };
  }
}
