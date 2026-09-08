/**
 * Grant a bridged MCP server's tools to an agent's allowed_tools whitelist.
 *
 * An agent with a non-empty `allowed_tools` sees ONLY what the list names
 * (executor.ts → resolveTools). There are no wildcards: the filter is a
 * `Set.has(tool.name)`, so "mcp_upwork_*" grants nothing. The real names only
 * exist once the bridge has connected and called listTools() against the
 * remote server — which is why this discovers them instead of hardcoding.
 *
 * `agents.update` REPLACES allowed_tools wholesale, so sending only the new
 * names would silently strip whatever the agent already had. This merges.
 *
 * Idempotent: running it twice is a no-op the second time.
 *
 * Run it from the HOST, in services/kernel — not inside the container, whose
 * image ships dist/ but not the src/ that the bridge client imports. The
 * kernel's own port is not published, so reach it through the dashboard's
 * nginx on 3086, which proxies /api:
 *
 *   T=$(docker exec kernl-public-kernel cat /app/data/.kernel-auth-token)
 *   KERNEL_URL=http://127.0.0.1:3086 KERNEL_AUTH_TOKEN="$T" \
 *   MCP_BRIDGE_SERVERS='<same JSON as kernl/.env>' \
 *     bun run scripts/grant-mcp-tools.ts --server upwork --agent Scout --dry-run
 *
 * Drop --dry-run to write.
 */

import { connectMcpServer } from "../assets/extensions/ai/mcp-bridge/_module/client.js";
import { parseMcpBridgeServers } from "../assets/extensions/ai/mcp-bridge/_module/types.js";
import { readFileSync } from "node:fs";

const KERNEL_URL = process.env.KERNEL_URL ?? "http://localhost:3087";
const TOKEN_PATH = process.env.KERNEL_AUTH_TOKEN_PATH ?? "/app/data/.kernel-auth-token";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function authToken(): string {
  const fromEnv = process.env.KERNEL_AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    throw new Error(
      `No kernel auth token: set KERNEL_AUTH_TOKEN or make ${TOKEN_PATH} readable`,
    );
  }
}

async function rpc(action: string, body: unknown): Promise<any> {
  const response = await fetch(`${KERNEL_URL}/api/rpc/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RPC ${action} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text);
  if (parsed?.error) throw new Error(`RPC ${action}: ${parsed.error}`);
  return parsed;
}

/** allowed_tools is TEXT holding JSON; older rows hold the array already. */
function asList(raw: unknown): string[] {
  if (raw == null) return [];
  const parsed =
    typeof raw === "object" ? raw : (() => {
      try { return JSON.parse(String(raw)); } catch { return null; }
    })();
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

async function main(): Promise<void> {
  const serverName = arg("server");
  const agentRef = arg("agent");
  const dryRun = process.argv.includes("--dry-run");

  if (!serverName || !agentRef) {
    console.error(
      "Usage: bun run scripts/grant-mcp-tools.ts --server <mcp-name> --agent <name|uuid> [--dry-run]",
    );
    process.exit(1);
  }

  // ── 1. Find the bridge config for that server ──────────
  const servers = parseMcpBridgeServers(process.env.MCP_BRIDGE_SERVERS ?? "");
  const config = servers.find((s) => s.name === serverName);
  if (!config) {
    const known = servers.map((s) => s.name).join(", ") || "(none)";
    throw new Error(
      `MCP_BRIDGE_SERVERS has no server named "${serverName}". Configured: ${known}`,
    );
  }

  // ── 2. Discover the real tool names ────────────────────
  console.log(`Connecting to "${serverName}"…`);
  const connection = await connectMcpServer(config);
  const discovered = connection.tools.map((t) => t.name).sort();
  await connection.disconnect();

  if (discovered.length === 0) {
    throw new Error(`"${serverName}" exposed no tools — nothing to grant`);
  }
  console.log(`Discovered ${discovered.length} tools:`);
  for (const name of discovered) console.log(`  · ${name}`);

  // ── 3. Locate the agent ────────────────────────────────
  const graph = await rpc("agents.graph", {});
  const agents: any[] = graph.agents ?? graph.nodes ?? [];
  const matches = agents.filter(
    (a) => a.id === agentRef || a.name === agentRef,
  );
  if (matches.length === 0) throw new Error(`No agent matching "${agentRef}"`);
  if (matches.length > 1) {
    console.error(`"${agentRef}" is ambiguous — pass one of these ids:`);
    for (const a of matches) console.error(`  ${a.id}  (flow ${a.flow_id})`);
    process.exit(1);
  }
  const agent = matches[0];

  // ── 4. Merge, preserving what the agent already had ────
  const current = asList(agent.allowed_tools);
  if (current.length === 0) {
    console.log(
      `\n"${agent.name}" has an empty whitelist, which already means every ` +
      `kernel tool — including ${serverName}'s. Nothing to do.`,
    );
    return;
  }

  const missing = discovered.filter((n) => !current.includes(n));
  if (missing.length === 0) {
    console.log(`\n"${agent.name}" already has all ${discovered.length} tools. No change.`);
    return;
  }

  const merged = [...current, ...missing];
  console.log(
    `\n"${agent.name}" (${agent.id}): ${current.length} tools → ${merged.length} ` +
    `(+${missing.length})`,
  );
  for (const name of missing) console.log(`  + ${name}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  await rpc("agents.update", { id: agent.id, allowed_tools: merged });
  console.log(`\nUpdated. Re-run with --dry-run to verify it is now a no-op.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
