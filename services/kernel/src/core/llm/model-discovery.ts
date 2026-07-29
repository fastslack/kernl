/**
 * Model discovery orchestrator.
 *
 * Polls every running provider's `listModels()`, reconciles the result into the
 * persistent `ModelCatalog`, then scans the kernel's configured model
 * references for any that now point at a vanished model (would 404/403 mid-run)
 * and proposes a successor.
 *
 * Driven by the `llm:model-discovery` builtin handler (zero LLM tokens) on a
 * cron. The successor is ONLY a suggestion — applying it is a gated user action
 * (`kernel_models_apply_migration`), never automatic.
 */

import type { SqliteDb } from "../db/sqlite.js";
import type { KernelConfig } from "../config.js";
import { classifyModel } from "./model-traits.js";
import type { ModelCatalog } from "./model-catalog.js";
import type { ModelBlocklist } from "./model-blocklist.js";

/** Minimal slice of LlmProviderRegistry this module needs (keeps it testable). */
export interface DiscoveryRegistry {
  getRunningSlugs(): string[];
  getProvider(slug: string): { listModels?: () => Promise<string[]> } | undefined;
}

export interface DiscoveredModel {
  slug: string;
  model: string;
}

export interface BrokenRef {
  /** Human-readable location, e.g. "agent: Job Application Drafter". */
  location: string;
  kind: "config" | "agent";
  /** env key to write for kind 'config' (e.g. AGENTS_EVAL_MODEL). */
  configKey?: string;
  /** agent id for kind 'agent'. */
  agentId?: string;
  /** normalized provider slug the broken model belongs to. */
  slug: string;
  /** the model id that's gone. */
  model: string;
  /** best-effort successor of the same family, or null when none is clear. */
  suggestion: string | null;
}

export interface DiscoveryReport {
  added: DiscoveredModel[];
  removed: DiscoveredModel[];
  brokenRefs: BrokenRef[];
}

/**
 * Map config-land provider names onto registry/catalog slugs. The chains and
 * config fields use names like `claude_code`/`anthropic`; the catalog keys on
 * registry slugs like `claude-code`/`claude`. A miss just means we won't flag
 * the ref (conservative — no false "gone" alarm).
 */
const SLUG_ALIASES: Record<string, string> = {
  claude_code: "claude-code",
  claudecode: "claude-code",
  anthropic: "claude",
  xai: "grok",
  "lm-studio": "lmstudio",
  lm_studio: "lmstudio",
};

export function normalizeSlug(slug: string): string {
  const k = (slug || "").toLowerCase().trim();
  return SLUG_ALIASES[k] ?? k;
}

/** Split a model id into a family signature (versions blanked to '#') and an
 *  ordered numeric version vector. "MiniMax-M2.7" → { sig:"minimax-m#",
 *  ver:[2,7] }; "claude-sonnet-4-5" → { sig:"claude-sonnet-#-#", ver:[4,5] }. */
function versionShape(model: string): { sig: string; ver: number[] } {
  const ver: number[] = [];
  const sig = model.toLowerCase().replace(/\d+(?:\.\d+)*/g, (tok) => {
    for (const part of tok.split(".")) ver.push(parseInt(part, 10));
    return "#";
  });
  return { sig, ver };
}

/** Element-wise numeric compare of two version vectors (missing slots = 0). */
function cmpVer(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Suggest the newest available model of the SAME family (same name shape with
 * version numbers blanked) and a strictly-higher version. Returns null when no
 * clear successor exists — the caller then tells the user to migrate by hand.
 */
export function suggestSuccessor(
  catalog: ModelCatalog,
  slug: string,
  broken: string,
): string | null {
  const target = versionShape(broken);
  let best: { model: string; ver: number[] } | null = null;
  for (const candidate of catalog.availableModels(slug)) {
    if (candidate === broken) continue;
    const shape = versionShape(candidate);
    if (shape.sig !== target.sig) continue; // different family
    if (cmpVer(shape.ver, target.ver) <= 0) continue; // not strictly newer
    if (!best || cmpVer(shape.ver, best.ver) > 0) best = { model: candidate, ver: shape.ver };
  }
  return best?.model ?? null;
}

/**
 * Scan configured model references (global config + per-agent chains) for ones
 * pointing at a model the catalog has recorded as 'gone'. Pure DB read — no
 * network. Safe to call from a read-only MCP tool.
 */
export function findBrokenRefs(deps: {
  catalog: ModelCatalog;
  config: KernelConfig;
  db: SqliteDb;
}): BrokenRef[] {
  const { catalog, config, db } = deps;
  const out: BrokenRef[] = [];
  const seen = new Set<string>();

  const consider = (ref: Omit<BrokenRef, "suggestion" | "slug"> & { slug: string }): void => {
    const slug = normalizeSlug(ref.slug);
    if (!ref.model || !slug) return;
    if (!catalog.isGone(slug, ref.model)) return;
    const key = `${ref.kind}:${ref.agentId ?? ref.configKey}:${slug}:${ref.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...ref, slug, suggestion: suggestSuccessor(catalog, slug, ref.model) });
  };

  const a = config.agents;
  const c = config.chat;

  const chain = a?.defaultModelChain ?? [];
  for (let i = 0; i < chain.length; i++) {
    consider({
      location: `config: AGENTS_DEFAULT_MODEL_CHAIN[${i}]`,
      kind: "config",
      configKey: "AGENTS_DEFAULT_MODEL_CHAIN",
      slug: chain[i].provider,
      model: chain[i].model,
    });
  }
  if (a?.defaultModel)
    consider({ location: "config: AGENTS_DEFAULT_MODEL", kind: "config", configKey: "AGENTS_DEFAULT_MODEL", slug: a.defaultProvider, model: a.defaultModel });
  if (a?.evalModel)
    consider({ location: "config: AGENTS_EVAL_MODEL", kind: "config", configKey: "AGENTS_EVAL_MODEL", slug: a.evalProvider || a.defaultProvider, model: a.evalModel });
  if (c?.defaultModel)
    consider({ location: "config: CHAT_DEFAULT_MODEL", kind: "config", configKey: "CHAT_DEFAULT_MODEL", slug: c.defaultProvider, model: c.defaultModel });
  if (c?.extractionModel)
    consider({ location: "config: CHAT_EXTRACTION_MODEL", kind: "config", configKey: "CHAT_EXTRACTION_MODEL", slug: c.defaultProvider, model: c.extractionModel });

  // Per-agent model_chain JSON.
  let rows: Array<{ id: string; name: string; model_chain: string }> = [];
  try {
    rows = db
      .prepare("SELECT id, name, model_chain FROM agents WHERE model_chain IS NOT NULL AND model_chain != ''")
      .all() as Array<{ id: string; name: string; model_chain: string }>;
  } catch {
    rows = [];
  }
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.model_chain);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed as Array<{ provider?: string; model?: string }>) {
      if (!entry?.model) continue;
      consider({
        location: `agent: ${r.name}`,
        kind: "agent",
        agentId: r.id,
        slug: entry.provider ?? "",
        model: entry.model,
      });
    }
  }

  return out;
}

/**
 * Full discovery pass: poll providers → reconcile catalog → scan broken refs.
 *
 * Per-provider failures are isolated: a `listModels()` that throws, times out,
 * or returns an empty/all-filtered list SKIPS that provider entirely — its
 * catalog rows are left untouched so a transient outage never marks live models
 * 'gone'.
 */
export async function discoverModels(deps: {
  registry: DiscoveryRegistry;
  catalog: ModelCatalog;
  blocklist: ModelBlocklist;
  config: KernelConfig;
  db: SqliteDb;
}): Promise<DiscoveryReport> {
  const { registry, catalog, blocklist, config, db } = deps;
  const added: DiscoveredModel[] = [];
  const removed: DiscoveredModel[] = [];

  for (const slug of registry.getRunningSlugs()) {
    const provider = registry.getProvider(slug);
    if (!provider?.listModels) continue;

    let models: string[] | undefined;
    try {
      models = await provider.listModels();
    } catch {
      continue; // unreachable provider — skip, don't touch its catalog
    }
    if (!models || models.length === 0) continue; // empty list — ambiguous, skip

    const chat = models.filter((m) => classifyModel(slug, m).chat);
    const usable = blocklist.filterAvailable(slug, chat);
    if (usable.length === 0) continue; // nothing usable — don't wipe the catalog

    const delta = catalog.recordDiscovery(slug, usable);
    for (const m of delta.added) added.push({ slug, model: m });
    for (const m of delta.removed) removed.push({ slug, model: m });
  }

  const brokenRefs = findBrokenRefs({ catalog, config, db });
  return { added, removed, brokenRefs };
}

/** Format a discovery report into a concise notification body. Returns null
 *  when there's nothing worth notifying about (no new models, no broken refs). */
export function formatDiscoveryNotification(report: DiscoveryReport): { title: string; body: string } | null {
  if (report.added.length === 0 && report.brokenRefs.length === 0) return null;
  const lines: string[] = [];
  if (report.added.length) {
    const list = report.added.map((m) => `${m.slug}/${m.model}`).join(", ");
    lines.push(`🆕 New models: ${list}`);
  }
  if (report.brokenRefs.length) {
    lines.push("⚠️ In use but gone upstream:");
    for (const ref of report.brokenRefs) {
      const fix = ref.suggestion ? `→ ${ref.suggestion}` : "(no clear successor — migrate manually)";
      lines.push(`  • ${ref.slug}/${ref.model} [${ref.location}] ${fix}`);
    }
    lines.push("Apply with kernel_models_apply_migration or from /providers.");
  }
  return { title: "LLM models changed", body: lines.join("\n") };
}
