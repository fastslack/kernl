/**
 * Office Kit — one declarative manifest, one engine, many consumers.
 *
 * An "office" in the 3D agents-flow world is just an `agent_flows` row plus a
 * set of `agents` pointing at it (optionally chains, a cron on the manager and
 * a home repo). The 3D renderer derives the whole building automatically, so
 * creating an office needs zero 3D work — only these DB rows.
 *
 * This module is the single source of truth for materializing an
 * `OfficeDefinition` into those rows. Every creation surface is a thin wrapper:
 *   • CLI:        scripts/seed-office.ts <name>  (loads scripts/offices/<name>.office.ts)
 *   • MCP tool:   kernel_office_create           (src/modules/agents/tools.ts)
 *   • Dashboard:  offices.create RPC + POST /api/offices/create (NewOfficeModal wizard)
 *
 * Idempotent by design: flows match on active name, agents on slug. Re-running
 * refreshes editable fields but never un-pauses an operator-paused agent and
 * never clobbers operator-added `variables` keys.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { assetsDir } from "../../core/assets-root.js";
import type { AgentService } from "./service.js";
import type { ModelChainEntry } from "./types.js";
import { isoNow, slugify } from "../../core/helpers.js";

// Canonical slugify now lives in core/helpers. Re-export it here so existing
// importers of `office-kit`'s slugify (tests, agents tools/rpc/store) keep
// resolving it from this module.
export { slugify };

// ── Manifest types ──────────────────────────────────────────────

export interface OfficeAgentSpec {
  /** Stable unique id, e.g. "prode-techlead". Idempotency key for the agent. */
  slug: string;
  /** Display name shown in the dashboard / 3D office. */
  name: string;
  /** Managers can dispatch to / manage other agents. Default "worker". */
  role?: "manager" | "worker";
  description?: string;
  /** System prompt. The office `discipline` preamble is auto-prepended. */
  prompt: string;
  /** goal_template — supports {{event.message}} interpolation. */
  goal?: string;
  /** allowed_tools. Empty/omitted = all tools allowed. */
  tools?: string[];
  deniedTools?: string[];
  /** AUTO: "claude_code" when office.repo is set, else "native". */
  executor?: "native" | "claude_code";
  maxIterations?: number;
  timeoutMs?: number;
  /** Default true. */
  showOnDashboard?: boolean;
  /** Claude Code plugins → variables.__plugins__ */
  plugins?: string[];
  /** Merged LAST over engine defaults — the escape hatch. */
  variables?: Record<string, unknown>;
  /** Slugs this agent dispatches to → source→target chains. */
  chainTo?: string[];
}

export interface OfficeCronSpec {
  /** Slug (or exact name) of the agent to schedule — usually the manager. */
  agent: string;
  /** "45m", "6h", "90s" or a raw ms number. Clamped to the scheduler floor. */
  every: string | number;
  /** goal_override for scheduled runs. Default "resume". */
  goal?: string;
}

export interface OfficeDefinition {
  /** Flow name — the office. Idempotency key (matches active flow by name). */
  name: string;
  description?: string;
  /** Hex color of the 3D room. Default: deterministic pick from a palette. */
  color?: string;
  /** Host path of the repo this office works on ("~" expands). Implies
   *  claude_code executors with native FS tools jailed to that cwd. */
  repo?: string;
  /** → variables.__preview_url__ (clickable link in the Workspace tab). */
  previewUrl?: string;
  /** Shared preamble prepended to every agent prompt. false = none.
   *  Default: a generic office-discipline preamble (repo-aware). */
  discipline?: string | false;
  /** Default model chain. AUTO: claude_code→grok fallback when repo is set,
   *  empty (= inherit kernel default provider) otherwise. */
  modelChain?: ModelChainEntry[];
  /** Office-wide agent defaults, overridable per agent. */
  defaults?: Partial<Omit<OfficeAgentSpec, "slug" | "name" | "prompt">>;
  agents: OfficeAgentSpec[];
  cron?: OfficeCronSpec;
}

export interface MaterializeOpts {
  /** Structural repos-extension surface. Registration is best-effort. */
  repoService?: RepoServiceLike | null;
  /** Re-activate paused agents. Default false — operator pauses win. */
  reactivate?: boolean;
  /** Scheduler floor in seconds (from `config.agents.minScheduleSeconds`).
   *  Omitted → env fallback inside `scheduleFloorMs`. */
  minScheduleSeconds?: number;
}

export interface RepoServiceLike {
  getByPath(path: string): unknown | undefined;
  create(input: { name: string; path: string; description?: string; tags?: string; shared?: boolean }):
    { ok: true; repo: { id: string; name: string; path: string } } | { ok: false; error: string };
}

export interface OfficeReport {
  flowId: string;
  flowName: string;
  created: string[];
  updated: string[];
  chained: Array<[string, string]>;
  scheduled?: { agent: string; intervalMs: number };
  repo?: { registered: boolean; path: string };
  warnings: string[];
}

// ── Helpers ─────────────────────────────────────────────────────

/** Room-color palette used when the manifest doesn't pick one. Deterministic
 *  on the office name so re-runs and previews agree. */
const OFFICE_PALETTE = [
  "#16a34a", "#e11d48", "#2563eb", "#d97706", "#7c3aed",
  "#0d9488", "#db2777", "#65a30d", "#dc2626", "#0891b2",
];

export function defaultOfficeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return OFFICE_PALETTE[h % OFFICE_PALETTE.length];
}

/** "45m" | "6h" | "90s" | "1200000" | 1200000 → milliseconds. */
export function parseEvery(every: string | number): number {
  if (typeof every === "number") {
    if (!Number.isFinite(every) || every <= 0) throw new Error(`Invalid cron interval: ${every}`);
    return Math.round(every);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(every);
  if (!m) throw new Error(`Invalid cron interval "${every}" — use e.g. "45m", "6h", "90s"`);
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = Math.round(n * mult);
  if (ms <= 0) throw new Error(`Invalid cron interval "${every}"`);
  return ms;
}

/** Scheduler floor (mirrors AgentService.addSchedule). We clamp instead of
 *  throwing so "5m" in a manifest quietly becomes the safe minimum.
 *
 *  `minScheduleSeconds` is injectable (from `config.agents.minScheduleSeconds`).
 *  When omitted it falls back to the same env read as before, so config-less
 *  callers (the seed-office CLI, the office-creation RPC/tool/HTTP paths that
 *  don't carry KernelConfig) keep working unchanged. */
export function scheduleFloorMs(minScheduleSeconds?: number): number {
  const minSeconds = minScheduleSeconds ?? Math.max(1, Number(process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS ?? 300));
  return minSeconds * 1000;
}

function expandHome(p: string): string {
  // os.homedir(): Windows has no HOME, and a literal "~" folder was created.
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Generic office-discipline preamble used when the manifest doesn't bring
 *  its own. Mirrors the hand-written preambles of the legacy seeds. */
export function defaultDiscipline(def: OfficeDefinition): string {
  const lines = [
    `## Office discipline (every agent in the ${def.name} office)`,
  ];
  if (def.repo) {
    lines.push(
      `  • You work ONLY inside this repo: ${def.repo}. It is your cwd. Never touch files outside it.`,
      "  • Use your NATIVE tools (Write / Read / Edit / Bash). Everything happens on real files on disk.",
      "  • READ before you write. Make the smallest change that satisfies the task. Don't refactor unrelated code.",
      "  • NEVER run: `git commit`, `git push`, `git reset --hard`, `git clean -f`, `rm -rf`, package uninstalls, or anything piping curl/wget into a shell. The operator commits and deploys.",
    );
  } else {
    lines.push(
      "  • Stay inside your office's mandate. Do exactly the task you're handed — no scope creep.",
      "  • Never invent done work. If something is ambiguous, pick the simplest reasonable interpretation and say so.",
    );
  }
  lines.push("  • Output is terse. The operator reads on a phone: a status line + a 1-2 line summary.");
  return lines.join("\n");
}

// ── Validation ──────────────────────────────────────────────────

/** Identity + validation helper for manifest authors. Throws early on the
 *  mistakes that would otherwise surface as weird DB states. */
export function defineOffice(def: OfficeDefinition): OfficeDefinition {
  if (!def.name?.trim()) throw new Error("defineOffice: name is required");
  if (!Array.isArray(def.agents) || def.agents.length === 0) {
    throw new Error("defineOffice: at least one agent is required");
  }
  const slugs = new Set<string>();
  for (const a of def.agents) {
    if (!a.slug?.trim()) throw new Error(`defineOffice: agent "${a.name}" needs a slug`);
    if (!a.name?.trim()) throw new Error(`defineOffice: agent "${a.slug}" needs a name`);
    if (typeof a.prompt !== "string" || !a.prompt.trim()) {
      throw new Error(`defineOffice: agent "${a.slug}" needs a prompt`);
    }
    if (slugs.has(a.slug)) throw new Error(`defineOffice: duplicate agent slug "${a.slug}"`);
    slugs.add(a.slug);
  }
  for (const a of def.agents) {
    for (const target of a.chainTo ?? []) {
      if (!slugs.has(target)) {
        throw new Error(`defineOffice: agent "${a.slug}" chains to unknown slug "${target}"`);
      }
    }
  }
  if (def.cron) {
    const byName = new Set(def.agents.map((a) => a.name));
    if (!slugs.has(def.cron.agent) && !byName.has(def.cron.agent)) {
      throw new Error(`defineOffice: cron.agent "${def.cron.agent}" is not one of the office agents`);
    }
    parseEvery(def.cron.every); // throws on malformed intervals
  }
  return def;
}

/** JSON-friendly input (RPC / MCP tool / wizard POST) → validated definition.
 *  Unknown keys are dropped; types are coerced conservatively. */
export function officeDefinitionFromJson(raw: unknown): OfficeDefinition {
  if (!raw || typeof raw !== "object") throw new Error("office definition must be an object");
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const agentsRaw = Array.isArray(o.agents) ? o.agents : [];
  const agents: OfficeAgentSpec[] = agentsRaw.map((a0) => {
    const a = (a0 ?? {}) as Record<string, unknown>;
    const name = str(a.name) ?? "";
    return {
      slug: str(a.slug) ?? slugify(`${str(o.name) ?? "office"}-${name}`),
      name,
      role: a.role === "manager" ? "manager" : "worker",
      description: str(a.description),
      prompt: typeof a.prompt === "string" ? a.prompt : "",
      goal: str(a.goal),
      tools: Array.isArray(a.tools) ? (a.tools.filter((t) => typeof t === "string") as string[]) : undefined,
      deniedTools: Array.isArray(a.deniedTools) ? (a.deniedTools.filter((t) => typeof t === "string") as string[]) : undefined,
      executor: a.executor === "claude_code" ? "claude_code" : a.executor === "native" ? "native" : undefined,
      maxIterations: typeof a.maxIterations === "number" ? a.maxIterations : undefined,
      timeoutMs: typeof a.timeoutMs === "number" ? a.timeoutMs : undefined,
      showOnDashboard: typeof a.showOnDashboard === "boolean" ? a.showOnDashboard : undefined,
      plugins: Array.isArray(a.plugins) ? (a.plugins.filter((t) => typeof t === "string") as string[]) : undefined,
      variables: a.variables && typeof a.variables === "object" ? (a.variables as Record<string, unknown>) : undefined,
      chainTo: Array.isArray(a.chainTo) ? (a.chainTo.filter((t) => typeof t === "string") as string[]) : undefined,
    };
  });
  const cronRaw = o.cron && typeof o.cron === "object" ? (o.cron as Record<string, unknown>) : undefined;
  const def: OfficeDefinition = {
    name: str(o.name) ?? "",
    description: str(o.description),
    color: str(o.color),
    repo: str(o.repo),
    previewUrl: str(o.previewUrl),
    discipline: o.discipline === false ? false : str(o.discipline),
    modelChain: Array.isArray(o.modelChain) ? (o.modelChain as ModelChainEntry[]) : undefined,
    agents,
    cron: cronRaw && str(cronRaw.agent) && (typeof cronRaw.every === "string" || typeof cronRaw.every === "number")
      ? { agent: str(cronRaw.agent)!, every: cronRaw.every as string | number, goal: str(cronRaw.goal) }
      : undefined,
  };
  return defineOffice(def);
}

// ── Engine ──────────────────────────────────────────────────────

const REPO_MODEL_CHAIN: ModelChainEntry[] = [
  { provider: "claude_code", model: "claude-sonnet-4-5" },
  { provider: "grok", model: "grok-4-fast-reasoning" },
];

interface ResolvedAgent {
  spec: OfficeAgentSpec;
  systemPrompt: string;
  goal: string;
  tools: string[];
  deniedTools: string[];
  executor: "native" | "claude_code";
  maxIterations: number;
  timeoutMs: number;
  showOnDashboard: boolean;
  role: "manager" | "worker";
  variables: Record<string, unknown>;
  modelChainJson: string;
}

function resolveAgent(def: OfficeDefinition, spec: OfficeAgentSpec, repoPath: string | undefined): ResolvedAgent {
  const d = def.defaults ?? {};
  const merged: OfficeAgentSpec = { ...d, ...spec };

  const discipline = def.discipline === false ? "" : (def.discipline ?? defaultDiscipline(def));
  const systemPrompt = discipline ? `${spec.prompt.trim()}\n\n${discipline}` : spec.prompt.trim();

  const executor = merged.executor ?? (repoPath ? "claude_code" : "native");

  const variables: Record<string, unknown> = {};
  if (repoPath) {
    // The documented working posture for filesystem-bound claude_code agents
    // in the containerised kernel: native FS tools jailed to the repo cwd.
    variables.__cwd_path__ = repoPath;
    variables.__sandbox__ = false;
    variables.__permission_mode__ = "bypassPermissions";
  }
  if (def.previewUrl) variables.__preview_url__ = def.previewUrl;
  if (merged.plugins?.length) variables.__plugins__ = merged.plugins;
  Object.assign(variables, d.variables ?? {}, spec.variables ?? {}); // author overrides win

  const chain = def.modelChain ?? (repoPath ? REPO_MODEL_CHAIN : []);

  return {
    spec,
    systemPrompt,
    goal: merged.goal ?? "",
    tools: merged.tools ?? [],
    deniedTools: merged.deniedTools ?? [],
    executor,
    maxIterations: merged.maxIterations ?? (executor === "claude_code" ? 30 : 15),
    timeoutMs: merged.timeoutMs ?? (executor === "claude_code" ? 900_000 : 300_000),
    showOnDashboard: merged.showOnDashboard ?? true,
    role: merged.role === "manager" ? "manager" : "worker",
    variables,
    modelChainJson: chain.length ? JSON.stringify(chain) : "",
  };
}

/**
 * Materialize an office definition into the DB. Pure w.r.t. process lifecycle —
 * only touches the db/services it is handed, so it works identically from the
 * one-shot CLI and from inside the running kernel.
 */
export function materializeOffice(
  db: SqliteDb,
  service: AgentService,
  input: OfficeDefinition,
  opts: MaterializeOpts = {},
): OfficeReport {
  const def = defineOffice(input);
  const repoPath = def.repo ? expandHome(def.repo) : undefined;
  const report: OfficeReport = {
    flowId: "",
    flowName: def.name,
    created: [],
    updated: [],
    chained: [],
    warnings: [],
  };

  // 1) Flow upsert ─────────────────────────────────────────────
  let flow = db
    .prepare("SELECT id FROM agent_flows WHERE name = ? AND active = 1")
    .get(def.name) as { id: string } | undefined;
  if (!flow) {
    const created = service.createFlow({
      name: def.name,
      description: def.description,
      color: def.color ?? defaultOfficeColor(def.name),
    });
    flow = { id: created.id };
  } else if (def.color || def.description) {
    db.prepare("UPDATE agent_flows SET description = COALESCE(?, description), color = COALESCE(?, color), updated_at = ? WHERE id = ?")
      .run(def.description ?? null, def.color ?? null, isoNow(), flow.id);
  }
  report.flowId = flow.id;

  // 2) Agents upsert ───────────────────────────────────────────
  const idBySlug = new Map<string, string>();
  for (const spec of def.agents) {
    const r = resolveAgent(def, spec, repoPath);
    const existing = service.getAgentBySlug(spec.slug);
    if (existing) {
      // Operator-added variables survive; manifest keys win only where set.
      let exVars: Record<string, unknown> = {};
      try { exVars = JSON.parse((existing as unknown as { variables?: string }).variables || "{}"); } catch { /* defaults */ }
      const mergedVars = { ...exVars, ...r.variables };
      db.prepare(
        `UPDATE agents SET
           name = ?, description = ?, system_prompt = ?, goal_template = ?,
           flow_id = ?, allowed_tools = ?, denied_tools = ?, model_chain = ?,
           max_iterations = ?, timeout_ms = ?, show_on_dashboard = ?, role = ?,
           variables = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        spec.name, spec.description ?? "", r.systemPrompt, r.goal,
        flow.id, JSON.stringify(r.tools), JSON.stringify(r.deniedTools), r.modelChainJson,
        r.maxIterations, r.timeoutMs, r.showOnDashboard ? 1 : 0, r.role,
        JSON.stringify(mergedVars), isoNow(),
        existing.id,
      );
      if (opts.reactivate) {
        db.prepare("UPDATE agents SET active = 1, updated_at = ? WHERE id = ?").run(isoNow(), existing.id);
      }
      service.setExecutorType(existing.id, r.executor);
      idBySlug.set(spec.slug, existing.id);
      report.updated.push(spec.slug);
    } else {
      const created = service.createAgent({
        name: spec.name,
        description: spec.description,
        system_prompt: r.systemPrompt,
        goal_template: r.goal,
        flow_id: flow.id,
        allowed_tools: r.tools,
        denied_tools: r.deniedTools,
        model_chain: r.modelChainJson ? (JSON.parse(r.modelChainJson) as ModelChainEntry[]) : undefined,
        max_iterations: r.maxIterations,
        timeout_ms: r.timeoutMs,
        show_on_dashboard: r.showOnDashboard,
        role: r.role,
      });
      db.prepare("UPDATE agents SET slug = ?, variables = ?, updated_at = ? WHERE id = ?")
        .run(spec.slug, JSON.stringify(r.variables), isoNow(), created.id);
      service.setExecutorType(created.id, r.executor);
      idBySlug.set(spec.slug, created.id);
      report.created.push(spec.slug);
    }
  }

  // 3) Chains ──────────────────────────────────────────────────
  const existingChains = new Set(
    service.listChains().map((c) => `${c.source_agent_id}→${c.target_agent_id}`),
  );
  for (const spec of def.agents) {
    const sourceId = idBySlug.get(spec.slug)!;
    for (const targetSlug of spec.chainTo ?? []) {
      const targetId = idBySlug.get(targetSlug)!;
      if (existingChains.has(`${sourceId}→${targetId}`)) continue;
      service.addChain({ source_agent_id: sourceId, target_agent_id: targetId, label: `${spec.slug} → ${targetSlug}` });
      existingChains.add(`${sourceId}→${targetId}`);
      report.chained.push([spec.slug, targetSlug]);
    }
  }

  // 4) Cron ────────────────────────────────────────────────────
  if (def.cron) {
    const bySlugOrName =
      idBySlug.get(def.cron.agent) ??
      idBySlug.get(def.agents.find((a) => a.name === def.cron!.agent)?.slug ?? "");
    if (bySlugOrName) {
      const hasActive = service.listSchedules(bySlugOrName).some((s) => s.active === 1);
      if (hasActive) {
        report.warnings.push(`cron: "${def.cron.agent}" already has an active schedule — left as-is`);
      } else {
        const intervalMs = Math.max(parseEvery(def.cron.every), scheduleFloorMs(opts.minScheduleSeconds));
        service.addSchedule({
          agent_id: bySlugOrName,
          interval_ms: intervalMs,
          goal_override: def.cron.goal ?? "resume",
        });
        report.scheduled = { agent: def.cron.agent, intervalMs };
      }
    }
  }

  // 5) Repo registration (best-effort) ─────────────────────────
  if (repoPath) {
    report.repo = { registered: false, path: repoPath };
    if (opts.repoService) {
      try {
        if (opts.repoService.getByPath(repoPath)) {
          report.repo.registered = true;
        } else {
          const res = opts.repoService.create({
            name: slugify(def.name) || def.name,
            path: repoPath,
            description: `Home repo of the ${def.name} office.`,
            tags: "office",
            shared: true,
          });
          if (res.ok) report.repo.registered = true;
          else report.warnings.push(`repo: could not register ${repoPath}: ${res.error}`);
        }
      } catch (err) {
        report.warnings.push(`repo: registration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      report.warnings.push(`repo: no repos service available — register ${repoPath} later via kernel_repos_register`);
    }
  }

  return report;
}

/**
 * Best-effort loader for the repos extension's RepoService, for the live
 * (in-kernel) creation surfaces. Uses a variable-path dynamic import so the
 * core build never hard-depends on extension sources; any failure (extension
 * absent, table missing, different layout) degrades to "repo not registered"
 * which materializeOffice reports as a warning.
 */
export async function loadRepoServiceBestEffort(db: SqliteDb): Promise<RepoServiceLike | null> {
  try {
    // From the bundled assets tree, not relative to this module: in a built
    // package this code lives inside mcp-server.js, and "../../../assets"
    // climbed out of the install directory.
    const modPath = pathToFileURL(
      join(assetsDir("extensions"), "productivity", "repos", "_module", "service.js"),
    ).href;
    const mod = (await import(modPath)) as {
      RepoService?: new (db: SqliteDb) => RepoServiceLike;
    };
    return mod.RepoService ? new mod.RepoService(db) : null;
  } catch {
    return null;
  }
}
