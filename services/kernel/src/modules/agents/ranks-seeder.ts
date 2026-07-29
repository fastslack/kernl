/**
 * Seed the default hierarchy of agent ranks.
 *
 * 11 ranks, level 1 (lowest) → 11 (highest = top of the organization).
 * Editable from the API / dashboard after seeding. We only populate the table
 * when it's empty, so user edits survive boots.
 *
 * Also runs a one-time auto-assignment pass: agents with rank_id = '' get a
 * sensible default based on their role + dashboard visibility, so the 3D view
 * shows meaningful insignia on first boot without requiring manual setup.
 * Subsequent boots skip any agent that already has a rank.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { AgentService } from "./service.js";
import { log } from "../../core/logger.js";

interface DefaultRank {
  name: string;
  level: number;
  insignia: string;
  color: string;
  description: string;
}

// Level 1 = bottom, 11 = top. Editable by the user — this is only the initial
// seed.
const DEFAULT_RANKS: DefaultRank[] = [
  { level: 1,  name: "Trainee",           insignia: "●",    color: "#6b7280", description: "Entry level — newly onboarded" },
  { level: 2,  name: "Junior Associate",  insignia: "▲",    color: "#71717a", description: "Junior team member with initial responsibilities" },
  { level: 3,  name: "Associate",         insignia: "▲▲▲",  color: "#78716c", description: "Team member leading a small group" },
  { level: 4,  name: "Senior Associate",  insignia: "❖",    color: "#a16207", description: "Most senior individual-contributor level" },
  { level: 5,  name: "Specialist",        insignia: "★",    color: "#ca8a04", description: "First management-track level" },
  { level: 6,  name: "Senior Specialist", insignia: "★★",   color: "#eab308", description: "Senior specialist" },
  { level: 7,  name: "Team Lead",         insignia: "★★★",  color: "#f59e0b", description: "Leads a team" },
  { level: 8,  name: "Manager",           insignia: "✦",    color: "#ef4444", description: "Manages a group — second in command" },
  { level: 9,  name: "Senior Manager",    insignia: "✦✦",   color: "#dc2626", description: "Manages a group or department" },
  { level: 10, name: "Director",          insignia: "✪",    color: "#b91c1c", description: "Senior leadership" },
  { level: 11, name: "Chief",             insignia: "✪✪✪",  color: "#7c3aed", description: "Top of the organization" },
];

export function seedAgentRanks(db: SqliteDb, service: AgentService): void {
  // ── 1. Seed ranks if empty ─────────────────────────────
  const existing = service.listRanks();
  if (existing.length === 0) {
    for (const r of DEFAULT_RANKS) {
      service.createRank({
        name: r.name,
        level: r.level,
        insignia: r.insignia,
        color: r.color,
        description: r.description,
      });
    }
    log.info(`Ranks seeder: created ${DEFAULT_RANKS.length} default ranks`);
  }

  // ── 2. Auto-assign unranked agents by TYPE + role ─────────────
  //
  // Rank rules (type-driven, not just role):
  //   SCRIPT agent (builtin_handler != '')      → Junior Associate  (always)
  //   LLM agent, role = manager + on dashboard  → Senior Manager
  //   LLM agent, role = manager (not dashboard) → Manager
  //   LLM agent, role != manager (worker)       → Senior Specialist  (mid-level)
  //
  // Why: LLM agents are reasoning systems and map to specialist/management
  // tracks. Scripts execute deterministic code and map to the entry track.
  const ranks = service.listRanks();
  const byName = new Map(ranks.map(r => [r.name, r]));

  const managerTop = byName.get("Senior Manager") ?? findByLevel(ranks, 9);
  const managerMid = byName.get("Manager") ?? findByLevel(ranks, 8);
  const llmWorker  = byName.get("Senior Specialist") ?? findByLevel(ranks, 6);
  const scriptWorker = byName.get("Junior Associate") ?? findByLevel(ranks, 2);

  if (!managerTop || !managerMid || !llmWorker || !scriptWorker) {
    log.warn("Ranks seeder: could not resolve default ranks, skipping auto-assign");
    return;
  }

  type AgentRow = {
    id: string; role: string; show_on_dashboard: number;
    rank_id: string; builtin_handler: string;
  };
  const unranked = db
    .prepare(
      `SELECT id, role, show_on_dashboard, rank_id, builtin_handler
       FROM agents WHERE COALESCE(rank_id, '') = '' AND active = 1`,
    )
    .all() as AgentRow[];

  let assigned = 0;
  const stmt = db.prepare("UPDATE agents SET rank_id = ?, updated_at = datetime('now') WHERE id = ?");
  for (const a of unranked) {
    const isScript = a.builtin_handler !== "";
    let rankId: string;
    if (isScript) rankId = scriptWorker.id;
    else if (a.role === "manager" && a.show_on_dashboard === 1) rankId = managerTop.id;
    else if (a.role === "manager") rankId = managerMid.id;
    else rankId = llmWorker.id;
    stmt.run(rankId, a.id);
    assigned++;
  }
  if (assigned > 0) {
    log.info(`Ranks seeder: auto-assigned default ranks to ${assigned} unranked agent(s)`);
  }
}

function findByLevel(ranks: ReadonlyArray<{ id: string; level: number }>, level: number) {
  return ranks.find(r => r.level === level);
}
