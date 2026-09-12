/**
 * `/api/claude-config` — the Claude Code host configuration the dashboard edits:
 * user-scope MCP servers and enabled plugins.
 *
 * Split out of `api-routes.ts` unchanged. It reads and writes files under the
 * host's `~/.claude/`, which is why it needs nothing from the agents module
 * beyond the HTTP server itself.
 */

import type { KernelHttpServer } from "../../../core/http-server.js";

export function registerClaudeConfigRoutes(server: KernelHttpServer): void {


  // ── Claude Code host config ────────────────────────────────────
  // Wraps ~/.claude.json + ~/.claude/settings.json so the dashboard can manage
  // user-scope MCPs + plugin enablement exactly as `claude mcp add` / `claude
  // plugin` would. Files are the source of truth; the CLI and the SDK read
  // from the same locations.

  server.get("/api/claude-config", async (_req, res) => {
    try {
      const cfg = await import("../claude-host-config.js");
      server.json(res, 200, {
        hostHome: cfg.hostHome(),
        mcpServers: cfg.readUserScopeMcps(),
        enabledPlugins: cfg.readEnabledPlugins(),
        extraKnownMarketplaces: cfg.readClaudeSettings().extraKnownMarketplaces ?? {},
      });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/claude-config/mcp", async (req, res) => {
    try {
      const body = await server.parseBody<{
        name: string;
        type?: "stdio" | "http" | "sse";
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
      }>(req);
      if (!body.name || !/^[a-z0-9][a-z0-9_-]*$/i.test(body.name)) {
        server.json(res, 400, { error: "Invalid name (alphanumeric, dashes, underscores)" });
        return;
      }
      const type = body.type ?? (body.url ? "http" : "stdio");
      if (type === "stdio" && !body.command) { server.json(res, 400, { error: "stdio MCP requires 'command'" }); return; }
      if ((type === "http" || type === "sse") && !body.url) { server.json(res, 400, { error: `${type} MCP requires 'url'` }); return; }

      const cfg = await import("../claude-host-config.js");
      const mcp: import("../claude-host-config.js").ClaudeMcpServer =
        type === "stdio"
          ? { type: "stdio", command: body.command!, args: body.args, env: body.env }
          : { type, url: body.url!, env: body.env };
      cfg.upsertUserScopeMcp(body.name, mcp);
      server.json(res, 200, { ok: true, name: body.name, scope: "user" });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.delete("/api/claude-config/mcp/:name", async (req, res) => {
    try {
      const name = (req as unknown as { params: Record<string, string> }).params?.name;
      if (!name) { server.json(res, 400, { error: "name required" }); return; }
      const cfg = await import("../claude-host-config.js");
      const result = cfg.removeUserScopeMcp(name);
      if (!result.removedFromJson && !result.removedFromSettings) {
        server.json(res, 404, { error: `MCP "${name}" not found in user scope` });
        return;
      }
      server.json(res, 200, { ok: true, ...result });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/claude-config/plugin/:ref/enable", async (req, res) => {
    await togglePluginEndpoint(req, res, true);
  });
  server.post("/api/claude-config/plugin/:ref/disable", async (req, res) => {
    await togglePluginEndpoint(req, res, false);
  });

  async function togglePluginEndpoint(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    enabled: boolean,
  ): Promise<void> {
    try {
      const ref = (req as unknown as { params: Record<string, string> }).params?.ref;
      if (!ref) { server.json(res, 400, { error: "plugin ref required" }); return; }
      const decoded = decodeURIComponent(ref);
      const cfg = await import("../claude-host-config.js");
      cfg.setPluginEnabled(decoded, enabled);
      server.json(res, 200, { ok: true, ref: decoded, enabled });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
