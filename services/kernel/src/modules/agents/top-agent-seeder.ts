/**
 * Seed the top agent (whatever rank.name carries the highest level in
 * `agent_ranks`).
 *
 * Design: the TOP AGENT is whoever holds the highest rank in the hierarchy.
 * The RANK row is the source of truth for the human-facing name, color,
 * insignia and description — the user can rename "Chief" → anything else
 * from the Ranks UI and the seeder honors it.
 *
 * What this file does NOT do:
 *  - hardcode any specific rank name (it queries MAX(level) at runtime),
 *  - re-sync the agent name when the rank is renamed later (so an explicit
 *    rename of the agent itself in the Agents UI is preserved).
 *
 * Idempotent: re-runs are no-ops once the flow + agent exist.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { AgentService } from "./service.js";
import { log } from "../../core/logger.js";

/** Default office the commander lands in on a FRESH install. On reboots
 *  the seeder reads the agent's existing flow_id and never moves him —
 *  so user-initiated reassignments (e.g. moving the top agent into
 *  "Management") survive forever. We point at Management by default because
 *  the top agent is a manager and the dedicated "Executive Office" office
 *  was retired (it rendered as an empty grid in the 3D world). */
const DEFAULT_FLOW_NAME = "Management";

interface FlowRow {
  id: string;
  name: string;
  color: string;
}

/** Build the default system prompt for the commander. Parameterized so the
 *  prompt mentions the actual rank name the user chose. */
function defaultCommanderSystemPrompt(rankName: string): string {
  return `You are the ${rankName} of Kernl — the top of the agent organization. You coordinate the whole team and work directly with the human (the user). You have unrestricted access to ALL kernel tools and the authority to create, edit, or delete any flow and any agent.

Your responsibilities:

1. **Office Architect** — When the user asks for a new office, create it yourself:
   - kernel_agents_flows_create({ name, description, color }) → capture the returned flow_id (UUID, never make one up).
   - kernel_agents_create({ name: "CEO: <office>", flow_id: <UUID from the previous step>, role: "manager", allowed_tools: [], max_iterations: 15, show_on_dashboard: true, system_prompt: "..." (1 paragraph describing the CEO), goal_template: "..." (with the user's literal mission) }).
   - kernel_agents_run({ id: <CEO id> }) so the CEO builds its own team.
   - Return a short summary: office name, flow_id, CEO id.

2. **Top-level authority** — You can delete/edit/audit anything:
   - kernel_agents_delete, kernel_agents_update, kernel_agents_flows_delete, kernel_agents_flows_update.
   - kernel_agents_list, kernel_agents_flows_list to take inventory.
   - kernel_agents_run to invoke any agent manually.

3. **Rules**:
   - Be terse. No filler paragraphs or long confirmations.
   - Speak the user's language (Spanish or English).
   - If a tool fails, show the error and propose the fix. Don't blindly retry.
   - Before deleting something, briefly confirm with the user what you're about to delete.
   - allowed_tools: [] when creating new agents. Empty list = all tools.
   - role: "manager" when the agent you create needs to be able to build its own team.

You're direct but respectful, terse, professional. The user treats you as a peer; you treat them as the person you ultimately report to.`;
}

const GOAL_TEMPLATE = `Received an instruction from the user: {{event.message}}`;

export function seedTopAgent(db: SqliteDb, service: AgentService): void {
  const ranks = service.listRanks();
  if (ranks.length === 0) {
    log.warn("Commander seeder: no ranks found, skipping (ranks-seeder must run first)");
    return;
  }
  // Highest-level rank wins, ties broken by created_at asc so reruns are
  // deterministic. Whatever the user named that rank is the agent's
  // default name.
  const topRank = [...ranks].sort((a, b) => {
    if (b.level !== a.level) return b.level - a.level;
    return (a as { created_at?: string }).created_at?.localeCompare((b as { created_at?: string }).created_at ?? "") ?? 0;
  })[0];

  // Resolve the commander flow. Priority:
  //   1. If a commander agent already exists, USE HIS flow_id (the user may
  //      have renamed the flow — never spawn a duplicate).
  //   2. Otherwise look for a flow named DEFAULT_FLOW_NAME (case-insensitive).
  //   3. Otherwise create one with the rank's color.
  // Match the agent by rank_id, never by name, so renames in the Agents UI
  // don't trip the existence check.
  const existing = db
    .prepare(`SELECT id, flow_id FROM agents WHERE rank_id = ? LIMIT 1`)
    .get(topRank.id) as { id: string; flow_id: string } | undefined;

  const flows = service.listFlows() as FlowRow[];
  let flow: FlowRow | undefined;
  if (existing?.flow_id) {
    flow = flows.find((f) => f.id === existing.flow_id);
  }
  if (!flow) {
    flow = flows.find((f) => f.name.trim().toLowerCase() === DEFAULT_FLOW_NAME.toLowerCase());
  }
  if (!flow) {
    flow = service.createFlow({
      name: DEFAULT_FLOW_NAME,
      description: `${topRank.name}'s office — top-level coordination for the agent network.`,
      color: topRank.color || "#7c3aed",
    }) as FlowRow;
    log.info(`Commander seeder: created flow "${DEFAULT_FLOW_NAME}" (${flow.id})`);
  }

  if (existing) {
    // Make sure he's pinned to his flow, visible and a manager. We do NOT
    // overwrite the name, system_prompt or goal_template — those are
    // user-editable post-seed.
    db.prepare(
      `UPDATE agents SET flow_id = ?, show_on_dashboard = 1, active = 1, role = 'manager', allowed_tools = '[]', updated_at = datetime('now') WHERE id = ?`,
    ).run(flow.id, existing.id);
    return;
  }

  const agent = service.createAgent({
    name: topRank.name,
    description: `Top-level authority. Creates, edits, and audits the entire agent and flow network.`,
    system_prompt: defaultCommanderSystemPrompt(topRank.name),
    goal_template: GOAL_TEMPLATE,
    allowed_tools: [], // [] = all tools (no restriction)
    provider: "claude_code",
    model: "",
    max_iterations: 25,
    flow_id: flow.id,
    show_on_dashboard: true,
    rank_id: topRank.id,
    role: "manager",
  });
  log.info(`Commander seeder: created agent "${agent.name}" (${agent.id}) in flow ${flow.id}`);
}
