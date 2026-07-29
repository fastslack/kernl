/**
 * SkillBodyResolver — for procedural skills attached to an agent.
 *
 * Given a skill slug, looks it up in `installed_extensions` (must be
 * type='skill'), reads the SKILL.md body from disk, and returns
 * `{slug, description, body, tokens_estimate}`.
 *
 * Caches results by `(slug, install_path, manifest_version)` so a single
 * agent run doesn't re-read disk per iteration. Cache invalidates when
 * the manifest version changes (cheap snapshot, not a watcher).
 *
 * Why a separate file: the executor pulls in many things; isolating skill
 * resolution keeps the inject-point inside executor.ts to ~5 lines and
 * makes it easy to swap the cache (LRU? Redis?) later.
 */

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";

export interface ResolvedSkill {
  /** Slug as stored in the agent's skills_json. */
  slug: string;
  /** Description from the SKILL.md frontmatter (one-liner used in the system_prompt index). */
  description: string;
  /** Full markdown body of SKILL.md (post-frontmatter). Loaded on demand via kernel_skill_load. */
  body: string;
  /** Coarse token-count estimate (chars / 4). Used by the UI to show cost. */
  tokens_estimate: number;
}

interface CacheEntry {
  resolved: ResolvedSkill;
  install_path: string;
  version: string;
}

export class SkillBodyResolver {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly db: SqliteDb) {}

  /**
   * Resolve a list of slugs into descriptions + bodies. Unknown / inactive
   * slugs are silently dropped (the executor logs them) so a single dead
   * skill doesn't break a run.
   */
  resolveMany(slugs: string[]): ResolvedSkill[] {
    const out: ResolvedSkill[] = [];
    for (const slug of slugs) {
      const r = this.resolve(slug);
      if (r) out.push(r);
    }
    return out;
  }

  /** Resolve a single slug. Returns null when not installed or body missing. */
  resolve(slug: string): ResolvedSkill | null {
    const row = this.db
      .prepare(
        `SELECT install_path, manifest_json
           FROM installed_extensions
          WHERE slug = ? AND type = 'skill' AND status IN ('active','installed')`,
      )
      .get(slug) as { install_path: string; manifest_json: string } | undefined;
    if (!row) {
      log.debug(`SkillBodyResolver: slug not installed: ${slug}`);
      return null;
    }

    const manifest = safeJson(row.manifest_json);
    const version = String(manifest?.version ?? "");

    const cached = this.cache.get(slug);
    if (cached && cached.install_path === row.install_path && cached.version === version) {
      return cached.resolved;
    }

    const body = this.loadBody(row.install_path);
    if (body === null) {
      log.warn(`SkillBodyResolver: body not found for ${slug} at ${row.install_path}`);
      return null;
    }
    const description = String(manifest?.description ?? "");
    const resolved: ResolvedSkill = {
      slug,
      description,
      body,
      tokens_estimate: Math.ceil((body.length + description.length) / 4),
    };
    this.cache.set(slug, { resolved, install_path: row.install_path, version });
    return resolved;
  }

  /**
   * Build the index block we inject into an agent's system_prompt. Compact
   * one-liner per skill so the model sees what's available without paying
   * the full-body token cost upfront.
   */
  buildPromptIndex(slugs: string[]): string {
    const resolved = this.resolveMany(slugs);
    if (resolved.length === 0) return "";
    const lines = resolved.map((s) => `- **${s.slug}** — ${s.description.slice(0, 240)}`);
    return [
      "",
      "## Available skills",
      "These procedural skills are loaded for this agent. Each lists its",
      "trigger pattern. When a user request matches, call `kernel_skill_load`",
      "with the slug to read the full step-by-step playbook before acting.",
      "",
      ...lines,
      "",
    ].join("\n");
  }

  /** Drop the cache (called when an agent's skills_json changes). */
  invalidate(slug?: string): void {
    if (slug) this.cache.delete(slug);
    else this.cache.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private loadBody(installPath: string): string | null {
    // Priority: SKILL.md (Anthropic convention), then SKILL.json long_description.
    const skillMd = join(installPath, "SKILL.md");
    if (existsSync(skillMd)) {
      try {
        const raw = readFileSync(skillMd, "utf-8");
        // Strip YAML frontmatter if present.
        if (raw.startsWith("---")) {
          const end = raw.indexOf("\n---", 3);
          if (end !== -1) return raw.slice(end + 4).replace(/^\s*\n/, "");
        }
        return raw;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function safeJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
