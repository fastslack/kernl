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

// ── Tokenisation + IDF scoring ────────────────────────────────

// Bilingual stopword list. Tuned to the kernel's voice (mix EN/ES) and to
// strip kernel-domain noise words ("agent", "tool", "kernel") that would
// otherwise match every skill.
const STOPWORDS = new Set([
  // English
  "the","a","an","and","or","but","of","to","in","on","for","is","at","by","with","as","from",
  "that","this","be","are","was","were","you","your","when","then","what","which","who","how","why",
  "not","no","do","does","done","its","it","has","have","had","into","over","under","also",
  // Spanish
  "el","la","los","las","de","del","y","o","en","con","por","para","un","una","es","son","ser",
  "como","cuando","entonces","que","cual","quien","si","se","su","sus","les","les","esa","ese",
  // Kernel-domain noise
  "use","using","used","get","got","run","runs","call","calls","tool","tools",
  "agent","agents","kernel","skill","skills","script","handler","module","modules",
  "when","also","etc","just","only","very","first","next","more","most","best",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function computeIdf(skillTokens: Map<string, Set<string>>, N: number): Map<string, number> {
  // df[token] = # of skills that contain it.
  const df = new Map<string, number>();
  for (const tokens of skillTokens.values()) {
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Smoothed IDF — log((N+1)/(df+1)) + 1, never goes negative, never zero.
  const idf = new Map<string, number>();
  for (const [t, n] of df) {
    idf.set(t, Math.log((N + 1) / (n + 1)) + 1);
  }
  return idf;
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

function skillText(s: SkillRow): string {
  let desc = ""; let longDesc = "";
  try {
    const m = JSON.parse(s.manifest_json || "{}");
    desc = typeof m.description === "string" ? m.description : "";
    longDesc = typeof m.long_description === "string" ? m.long_description : "";
  } catch { /* ignore */ }
  return `${s.slug} ${s.name} ${desc} ${longDesc}`;
}

function agentText(a: AgentRow): string {
  // Cap the system_prompt — operator prompts can be 5-10k chars; the
  // useful signal is in the first ~2k (role, domain, stack).
  const sp = (a.system_prompt || "").slice(0, 2000);
  return `${a.name} ${a.description || ""} ${sp} ${a.flow_name || ""}`;
}

interface Suggestion { slug: string; score: number; matches: string[] }
interface AgentSuggestion { agentId: string; agentName: string; suggestions: Suggestion[] }

function scoreSkill(
  agentTokens: Set<string>,
  skillTokens: Set<string>,
  idf: Map<string, number>,
  skillSlug: string,
  agentBlob: string,
): { score: number; matches: string[] } {
  const matched: string[] = [];
  let s = 0;
  for (const t of skillTokens) {
    if (agentTokens.has(t)) {
      const w = idf.get(t) ?? 1;
      s += w;
      matched.push(t);
    }
  }
  // Slug appears verbatim in the agent's prompt/description → strong signal.
  // Often happens when the user already mentions the skill but hasn't attached it.
  if (skillSlug.length >= 4 && agentBlob.toLowerCase().includes(skillSlug.toLowerCase())) {
    s += 5;
    matched.unshift(`slug:${skillSlug}`);
  }
  return { score: s, matches: matched.slice(0, 5) };
}

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

    // Tokenise each skill once per run; IDF computed against the full skill corpus.
    const skillTokens = new Map<string, Set<string>>();
    for (const s of skills) skillTokens.set(s.slug, new Set(tokenize(skillText(s))));
    const idf = computeIdf(skillTokens, skills.length);

    const results: AgentSuggestion[] = [];
    for (const a of windowAgents) {
      const blob = agentText(a);
      const aTokens = new Set(tokenize(blob));
      if (aTokens.size === 0) continue;
      const attached = getAttachedSlugs(a);

      const scored = skills
        .filter((s) => !attached.has(s.slug))
        .map((s) => {
          const tokens = skillTokens.get(s.slug);
          if (!tokens || tokens.size === 0) return { slug: s.slug, score: 0, matches: [] };
          const { score, matches } = scoreSkill(aTokens, tokens, idf, s.slug, blob);
          return { slug: s.slug, score, matches };
        })
        .filter((x) => x.score >= vars.minScore)
        .sort((x, y) => y.score - x.score)
        .slice(0, vars.topNPerAgent);

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
