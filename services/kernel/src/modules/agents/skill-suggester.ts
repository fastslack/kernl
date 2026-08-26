/**
 * Skill Suggester — scans active agents and proposes installed skills that
 * would match their purpose. Deterministic. No LLM, no tokens.
 *
 * ## Why script, not LLM
 *
 * `feedback_llm_curator_hallucinates` (memory) documents the exact same
 * shape: LLM matching against a large inventory burned ~500k tokens and
 * fabricated content. Same trap here — 100+ agents × 100+ skills = a
 * matrix the LLM will summarise wrong. Keyword overlap + IDF gives the
 * same end result with zero token spend and zero hallucination.
 *
 * ## Where the suggestions land
 *
 * One note per run, tagged `#skill-suggestion #top-agent-inbox
 * #pending-review`. The top agent reads its inbox by tag and
 * decides which suggestions to apply via `kernel_agents_update`. The
 * suggester does NOT mutate agents — it proposes; the commander acts.
 *
 * ## Rotation
 *
 * Scanning all agents on every run would either flood the inbox (if N is
 * high) or starve recent additions (if N is low and we always start at
 * the beginning). A `__cursor` field in the suggester's own `variables`
 * advances by `agents_per_run` each tick, wrapping at the end of the
 * agent list. Daily cron + N=20 sweeps 140 agents/week — enough.
 */

import type { BuiltinHandler, BuiltinHandlerContext } from "./builtin-handlers.js";
import { log } from "../../core/logger.js";
import { safeQuery, safeQueryOne } from "../../core/db/query-helpers.js";
import {
  tokenize,
  rankSkillsForAgent,
  skillRowText,
  agentRowText,
} from "./skill-scoring.js";

const HANDLER_KEY = "script:agents:skill-suggest";

// ── Tunables (operator-editable via agents.variables) ─────────

interface SuggesterVars {
  topNPerAgent: number;
  agentsPerRun: number;
  minScore: number;
  excludeHandlerPrefixes: string[];
}

function parseCsv(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function readVars(ctx: BuiltinHandlerContext): SuggesterVars {
  const row = safeQueryOne<{ variables: string }>(
    ctx.db,
    "SELECT variables FROM agents WHERE builtin_handler = ? LIMIT 1",
    HANDLER_KEY,
  );
  let raw: Record<string, unknown> = {};
  try { raw = row ? JSON.parse(row.variables || "{}") : {}; } catch { /* defaults */ }
  return {
    topNPerAgent: typeof raw.top_n_per_agent === "number" ? raw.top_n_per_agent : 3,
    agentsPerRun: typeof raw.agents_per_run === "number" ? raw.agents_per_run : 20,
    minScore: typeof raw.min_score === "number" ? raw.min_score : 1,
    excludeHandlerPrefixes: parseCsv(raw.exclude_handlers),
  };
}

// ── Cursor (per-run rotation pointer) ─────────────────────────

function readCursor(ctx: BuiltinHandlerContext): number {
  const row = safeQueryOne<{ variables: string }>(
    ctx.db,
    "SELECT variables FROM agents WHERE builtin_handler = ? LIMIT 1",
    HANDLER_KEY,
  );
  if (!row) return 0;
  try {
    const v = JSON.parse(row.variables || "{}");
    return typeof v.__cursor === "number" ? v.__cursor : 0;
  } catch { return 0; }
}

function saveCursor(ctx: BuiltinHandlerContext, cursor: number): void {
  const row = safeQueryOne<{ id: string; variables: string }>(
    ctx.db,
    "SELECT id, variables FROM agents WHERE builtin_handler = ? LIMIT 1",
    HANDLER_KEY,
  );
  if (!row) return;
  let v: Record<string, unknown> = {};
  try { v = JSON.parse(row.variables || "{}"); } catch { /* ignore */ }
  v.__cursor = cursor;
  ctx.db.prepare("UPDATE agents SET variables = ? WHERE id = ?")
    .run(JSON.stringify(v), row.id);
}

function rotateWindow<T>(arr: T[], cursor: number, size: number): T[] {
  if (arr.length === 0) return [];
  if (size >= arr.length) return arr;
  const c = ((cursor % arr.length) + arr.length) % arr.length;
  const end = Math.min(c + size, arr.length);
  const head = arr.slice(c, end);
  if (head.length < size) {
    // Wrap to top — happens once per full sweep.
    return [...head, ...arr.slice(0, size - head.length)];
  }
  return head;
}

// ── DB row shapes ─────────────────────────────────────────────

interface AgentRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  builtin_handler: string;
  skills_json: string;
  flow_name: string | null;
}

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  manifest_json: string;
}

function loadAgents(ctx: BuiltinHandlerContext, vars: SuggesterVars): AgentRow[] {
  const all = safeQuery<AgentRow>(
    ctx.db,
    `SELECT a.id, a.name, a.description, a.system_prompt, a.builtin_handler, a.skills_json,
            f.name AS flow_name
       FROM agents a
       LEFT JOIN agent_flows f ON f.id = a.flow_id
      WHERE a.active = 1
        AND COALESCE(a.under_revision, 0) = 0
        AND a.builtin_handler != ?
   ORDER BY a.created_at ASC`,
    HANDLER_KEY,
  );
  if (vars.excludeHandlerPrefixes.length === 0) return all;
  return all.filter((a) => {
    if (!a.builtin_handler) return true;
    return !vars.excludeHandlerPrefixes.some((p) => a.builtin_handler.startsWith(p));
  });
}

function loadSkills(ctx: BuiltinHandlerContext): SkillRow[] {
  return safeQuery<SkillRow>(
    ctx.db,
    `SELECT id, slug, name, manifest_json
       FROM installed_extensions
      WHERE type = 'skill' AND status = 'active'`,
  );
}

function getAttachedSlugs(agent: AgentRow): Set<string> {
  if (!agent.skills_json) return new Set();
  try {
    const parsed = JSON.parse(agent.skills_json);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch { return new Set(); }
}

interface Suggestion { slug: string; score: number; matches: string[] }
interface AgentSuggestion { agentId: string; agentName: string; suggestions: Suggestion[] }

function writeSupervisorNote(
  ctx: BuiltinHandlerContext,
  results: AgentSuggestion[],
  scanned: number,
  total: number,
): void {
  const lines: string[] = [
    `Skill suggestions for ${results.length} agent${results.length === 1 ? "" : "s"} (scanned ${scanned}/${total} this run).`,
    ``,
  ];
  for (const r of results) {
    lines.push(`## ${r.agentName}`);
    lines.push(`agent-id: ${r.agentId}`);
    for (const s of r.suggestions) {
      lines.push(`  • **${s.slug}** — score ${s.score.toFixed(1)} — matched: ${s.matches.join(", ")}`);
    }
    lines.push(``);
  }
  lines.push(`---`);
  lines.push(`To attach: kernel_agents_update({ id: "<agent-id>", skills: [...current, "<slug>"] }).`);
  lines.push(`To dismiss this batch: retag this note with #skill-suggestion-reviewed.`);

  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO notes (id, title, body, tags, pinned, contact_id, task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    `[skill-suggest] ${results.length} agent-matches for top-agent review`.slice(0, 200),
    lines.join("\n"),
    `#skill-suggestion #top-agent-inbox #pending-review`,
    now, now,
  );
}

// ── Handler ───────────────────────────────────────────────────

export function skillSuggesterHandler(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const vars = readVars(ctx);
    const agents = loadAgents(ctx, vars);
    const skills = loadSkills(ctx);
    if (agents.length === 0) return "skill-suggest: no agents to scan.";
    if (skills.length === 0) {
      log.info("skill-suggest: no installed skills (subscribe to a skill repo in /extensions first).");
      return "skill-suggest: no installed skills.";
    }

    // Rotate through the agent list across runs.
    const cursor = readCursor(ctx);
    const windowAgents = rotateWindow(agents, cursor, vars.agentsPerRun);
    saveCursor(ctx, (cursor + windowAgents.length) % agents.length);

    const scorableSkills = skills.map((s) => ({ slug: s.slug, text: skillRowText(s) }));

    const results: AgentSuggestion[] = [];
    for (const a of windowAgents) {
      const blob = agentRowText(a);
      if (tokenize(blob).length === 0) continue;

      const scored = rankSkillsForAgent(
        { text: blob, attached: getAttachedSlugs(a) },
        scorableSkills,
        { minScore: vars.minScore, topN: vars.topNPerAgent },
      );

      if (scored.length > 0) {
        results.push({ agentId: a.id, agentName: a.name, suggestions: scored });
      }
    }

    if (results.length === 0) {
      return `skill-suggest: scanned ${windowAgents.length}/${agents.length} agents, no matches above min_score=${vars.minScore}.`;
    }

    writeSupervisorNote(ctx, results, windowAgents.length, agents.length);

    const totalSuggestions = results.reduce((acc, r) => acc + r.suggestions.length, 0);
    return `skill-suggest: scanned ${windowAgents.length}/${agents.length} agents → ${results.length} with matches, ${totalSuggestions} skill suggestions queued for top-agent review.`;
  };
}

// ── Registration metadata ─────────────────────────────────────

export const SKILL_SUGGESTER_DEF = {
  handler: HANDLER_KEY,
  name: "Skill Suggester",
  description:
    "Scans active agents and suggests installed skills that would match their purpose. " +
    "Writes a single note tagged #skill-suggestion #top-agent-inbox per run for the " +
    "commander to review. Deterministic keyword + IDF scoring — no LLM, no tokens.",
  cron: "0 5 * * *", // 05:00 daily — skill catalogues change slowly.
};

export function registerSkillSuggester(
  map: Map<string, BuiltinHandler>,
  ctx: BuiltinHandlerContext,
): void {
  map.set(SKILL_SUGGESTER_DEF.handler, skillSuggesterHandler(ctx));
}
