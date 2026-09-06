/**
 * MCP Bridge RPC — the surface the dashboard page calls.
 *
 * Every response is built from `McpServerRow`, which structurally cannot hold
 * a secret, so no action here can leak a token by accident.
 *
 * `mcp.grant` is the one that earns its keep: assigning a server's tools to an
 * agent used to mean copying exact tool names into `allowed_tools` by hand,
 * because that whitelist is a `Set.has` with no wildcards.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import { discoverHttpServer } from "./discovery.js";
import { buildAuthorizationUrl } from "./oauth-routes.js";
import type { McpStore, McpServerRow } from "./store.js";
import type { McpRegistry } from "./registry.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const arr = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.map(String) : null;

/** What the list view renders: the row plus its cached tool count. */
function view(store: McpStore, row: McpServerRow) {
  return { ...row, tool_count: store.countTools(row.id) };
}

export function mcpRpcActions(
  db: SqliteDb,
  deps: { store: McpStore; registry: McpRegistry },
): RpcAction[] {
  const { store, registry } = deps;

  return [
    {
      name: "mcp.list",
      handler: async () => ({ servers: store.list().map((s) => view(store, s)) }),
    },

    {
      name: "mcp.get",
      handler: async (a) => {
        const row = store.get(str(a.server_id));
        if (!row) throw new Error("Server not found");
        return { server: view(store, row), tools: store.listTools(row.id) };
      },
    },

    // Probe a URL and report what it would take to connect. Read-only: nothing
    // is written until the operator confirms with mcp.add.
    {
      name: "mcp.discover",
      handler: async (a) => discoverHttpServer(str(a.url)),
    },

    {
      name: "mcp.add",
      handler: async (a) => {
        const name = str(a.name).trim();
        if (!name) throw new Error("A name is required — it becomes the mcp_<name>_<tool> prefix");
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
          throw new Error("Name must be alphanumeric, dash or underscore — it is used as a tool prefix");
        }
        if (store.getByName(name)) throw new Error(`A server named "${name}" already exists`);

        const transport = str(a.transport) === "stdio" ? "stdio" : "http";
        const row = store.create({
          name,
          transport,
          url: strOrNull(a.url),
          command: strOrNull(a.command),
          args: arr(a.args),
          env: (a.env as Record<string, string>) ?? null,
          auth_mode:
            str(a.auth_mode) === "authorization_code" ||
            str(a.auth_mode) === "client_credentials" ||
            str(a.auth_mode) === "token"
              ? (str(a.auth_mode) as "authorization_code" | "client_credentials" | "token")
              : "none",
          headers: (a.headers as Record<string, string>) ?? null,
          allow_tools: arr(a.allow_tools),
          deny_tools: arr(a.deny_tools),
        });

        // Endpoints from discovery, plus any manually supplied client details.
        if (a.token_url || a.authorize_url || a.client_id || a.client_secret || a.token || a.scope) {
          store.saveCredentials(row.id, {
            token_url: strOrNull(a.token_url),
            authorize_url: strOrNull(a.authorize_url),
            client_id: strOrNull(a.client_id),
            client_secret: strOrNull(a.client_secret),
            access_token: strOrNull(a.token),
            scope: strOrNull(a.scope),
          });
        }

        // A server that needs a login should say so rather than sit at
        // "disabled" while the operator waits for something to happen.
        if (row.auth_mode === "none" || row.auth_mode === "token" || row.transport === "stdio") {
          await registry.connect(row.id);
        } else {
          store.setStatus(row.id, "needs_auth", "Sign in to connect.");
        }

        return { server: view(store, store.get(row.id)!) };
      },
    },

    {
      name: "mcp.update",
      handler: async (a) => {
        const id = str(a.server_id);
        if (!store.get(id)) throw new Error("Server not found");
        store.update(id, {
          url: a.url === undefined ? undefined : strOrNull(a.url),
          allow_tools: a.allow_tools === undefined ? undefined : arr(a.allow_tools),
          deny_tools: a.deny_tools === undefined ? undefined : arr(a.deny_tools),
          headers: a.headers === undefined ? undefined : ((a.headers as Record<string, string>) ?? null),
        });
        return { server: view(store, store.get(id)!) };
      },
    },

    {
      name: "mcp.connect",
      handler: async (a) => {
        const row = await registry.connect(str(a.server_id));
        if (!row) throw new Error("Server not found");
        return { server: view(store, row) };
      },
    },

    {
      name: "mcp.disconnect",
      handler: async (a) => {
        await registry.disable(str(a.server_id));
        const row = store.get(str(a.server_id));
        return { server: row ? view(store, row) : null };
      },
    },

    {
      name: "mcp.remove",
      handler: async (a) => ({ removed: await registry.remove(str(a.server_id)) }),
    },

    {
      name: "mcp.tools",
      handler: async (a) => ({ tools: store.listTools(str(a.server_id)) }),
    },

    /**
     * Builds the authorization URL. The redirect target comes from the browser
     * rather than server config, because the dashboard already knows the origin
     * it is being served from and any value we guessed here would be wrong the
     * moment someone reverse-proxies the kernel.
     *
     * It is constrained to loopback: this is a single-operator, locally-bound
     * dashboard, and an arbitrary redirect would turn a stored authorization
     * code into someone else's.
     */
    {
      name: "mcp.auth.start",
      handler: async (a) => {
        const srv = store.get(str(a.server_id));
        if (!srv) throw new Error("Server not found");

        const origin = str(a.origin).replace(/\/$/, "");
        let host = "";
        try {
          host = new URL(origin).hostname;
        } catch {
          throw new Error("A valid origin is required");
        }
        if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
          throw new Error(`Refusing a non-loopback redirect target: ${host}`);
        }

        const creds = store.getCredentials(srv.id);
        if (!creds?.authorize_url || !creds.client_id) {
          throw new Error(
            "This server has no authorization endpoint or client id yet. Re-run discovery, or fill them in manually.",
          );
        }

        const redirect_uri = `${origin}/auth/mcp/callback`;
        const { url, state, verifier } = buildAuthorizationUrl({
          authorizeUrl: creds.authorize_url,
          clientId: creds.client_id,
          redirectUri: redirect_uri,
          scope: creds.scope,
        });
        store.saveOAuthState({ state, server_id: srv.id, code_verifier: verifier, redirect_uri });
        return { authorization_url: url, redirect_uri };
      },
    },

    /**
     * Grant a server's tools to an agent, merging rather than replacing:
     * `agents.update` overwrites `allowed_tools` wholesale, so sending only the
     * new names would silently strip whatever the agent already had.
     *
     * An agent with an empty whitelist already sees every kernel tool, so
     * granting is a no-op there and says so instead of pretending to act.
     */
    {
      name: "mcp.grant",
      handler: async (a) => {
        const agentId = str(a.agent_id);
        const toolNames = arr(a.tools) ?? [];
        if (!agentId) throw new Error("agent_id required");
        if (toolNames.length === 0) throw new Error("No tools given");

        const agent = db
          .prepare("SELECT id, name, allowed_tools FROM agents WHERE id = ?")
          .get(agentId) as { id: string; name: string; allowed_tools: string } | undefined;
        if (!agent) throw new Error("Agent not found");

        let current: string[] = [];
        try {
          const parsed = JSON.parse(agent.allowed_tools || "[]");
          current = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          current = [];
        }

        if (current.length === 0) {
          return {
            agent: agent.name,
            changed: false,
            reason: "This agent has an empty whitelist, which already means every kernel tool.",
          };
        }

        const missing = toolNames.filter((t) => !current.includes(t));
        if (missing.length === 0) {
          return { agent: agent.name, changed: false, reason: "Already granted." };
        }

        const merged = [...current, ...missing];
        db.prepare("UPDATE agents SET allowed_tools = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(merged),
          isoNow(),
          agentId,
        );
        return { agent: agent.name, changed: true, added: missing, total: merged.length };
      },
    },

    /** Agents the page offers in the assignment dropdown. */
    {
      name: "mcp.agents",
      handler: async () => {
        const rows = db
          .prepare("SELECT id, name, allowed_tools FROM agents ORDER BY name")
          .all() as Array<{ id: string; name: string; allowed_tools: string }>;
        return {
          agents: rows.map((r) => {
            let count = 0;
            try {
              const parsed = JSON.parse(r.allowed_tools || "[]");
              count = Array.isArray(parsed) ? parsed.length : 0;
            } catch {
              count = 0;
            }
            // unrestricted agents need no grant, and the UI should say why.
            return { id: r.id, name: r.name, tool_count: count, unrestricted: count === 0 };
          }),
        };
      },
    },
  ];
}
