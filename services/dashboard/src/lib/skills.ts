/**
 * Procedural skills — shared data layer.
 *
 * A "skill" is a markdown playbook (`SKILL.md`) installed as a row in
 * `installed_extensions` with `type='skill'`. There is no separate skills
 * registry any more: /extensions is the single install surface, and the
 * only thing that varies per agent is WHICH slugs are attached to it
 * (`agents.skills_json`).
 *
 * The executor resolves those slugs through SkillBodyResolver: each one
 * contributes a single line to the agent's system_prompt, and the model
 * pulls the full body on demand with `kernel_skill_load`. That is why the
 * UI shows a token estimate — attaching a skill costs ~1 line up front,
 * not the whole playbook.
 *
 * Both consumers (the per-agent panel in the agent drawers and the Skills
 * hub inside /extensions) read through here so a single fetch feeds them
 * all and an attach in one surface is visible in the other.
 */

import { updateAgent } from './api.js';

export interface SkillItem {
	id: string;
	slug: string;
	name: string;
	status?: string;
	manifest: {
		description?: string;
		long_description?: string;
		version?: string;
	} | null;
	install_receipt: { source?: { type?: string; url?: string } } | null;
}

/** Minimal agent shape this layer needs — both agent pages carry more. */
export interface SkillAgent {
	id: string;
	name: string;
	skills_json?: string;
	active?: number | boolean;
	builtin_handler?: string;
}

// Module-level caches. Cheap: both endpoints are small and the data only
// changes when the user acts, at which point we invalidate explicitly.
let skillsCache: SkillItem[] | null = null;
let skillsInflight: Promise<SkillItem[]> | null = null;
let agentsCache: SkillAgent[] | null = null;
let agentsInflight: Promise<SkillAgent[]> | null = null;

/** Installed, active skills. Deduped by slug, sorted alphabetically. */
export async function loadInstalledSkills(force = false): Promise<SkillItem[]> {
	if (!force && skillsCache) return skillsCache;
	if (!force && skillsInflight) return skillsInflight;
	skillsInflight = (async () => {
		try {
			const r = await fetch('/api/extensions?type=skill&status=active');
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const body = await r.json();
			const items = (body.items ?? []) as SkillItem[];
			skillsCache = items.slice().sort((a, b) => a.slug.localeCompare(b.slug));
			return skillsCache;
		} catch (e) {
			console.warn('Failed to load installed skills', e);
			return skillsCache ?? [];
		} finally {
			skillsInflight = null;
		}
	})();
	return skillsInflight;
}

/**
 * Agents that can carry procedural skills.
 *
 * `builtin_handler` agents are kernel JS scripts — they never build a
 * system_prompt, so a skill attached to one would silently do nothing.
 * They are filtered out here rather than in each caller.
 */
export async function loadSkillAgents(force = false): Promise<SkillAgent[]> {
	if (!force && agentsCache) return agentsCache;
	if (!force && agentsInflight) return agentsInflight;
	agentsInflight = (async () => {
		try {
			const r = await fetch('/api/agents');
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const body = await r.json();
			const rows = (body.agents ?? []) as SkillAgent[];
			agentsCache = rows
				.filter((a) => !a.builtin_handler)
				.sort((a, b) => a.name.localeCompare(b.name));
			return agentsCache;
		} catch (e) {
			console.warn('Failed to load agents for skills', e);
			return agentsCache ?? [];
		} finally {
			agentsInflight = null;
		}
	})();
	return agentsInflight;
}

export function invalidateSkillsCache(): void {
	skillsCache = null;
}

export function invalidateAgentsCache(): void {
	agentsCache = null;
}

/** `skills_json` is a JSON array of slugs — tolerate anything else. */
export function parseAttachedSkills(agent: { skills_json?: string } | null | undefined): string[] {
	if (!agent?.skills_json) return [];
	try {
		const p = JSON.parse(agent.skills_json);
		return Array.isArray(p) ? p.map(String) : [];
	} catch {
		return [];
	}
}

/**
 * Persist the slug list for one agent and keep the local cache in sync so
 * the other surface (hub ↔ drawer) reflects it without a refetch.
 */
export async function saveAgentSkills(agentId: string, slugs: string[]): Promise<void> {
	await updateAgent(agentId, { skills: slugs });
	if (agentsCache) {
		agentsCache = agentsCache.map((a) =>
			a.id === agentId ? { ...a, skills_json: JSON.stringify(slugs) } : a
		);
	}
}

/** Toggle one slug on one agent. Returns the resulting slug list. */
export async function toggleAgentSkill(
	agent: SkillAgent,
	slug: string
): Promise<string[]> {
	const current = parseAttachedSkills(agent);
	const next = current.includes(slug)
		? current.filter((s) => s !== slug)
		: [...current, slug];
	await saveAgentSkills(agent.id, next);
	return next;
}

/**
 * Coarse cost of a skill, matching SkillBodyResolver's own estimate
 * (chars / 4). `long_description` is what the manifest carries of the
 * SKILL.md body; when absent we can only price the one-liner.
 */
export function estimateSkillTokens(s: SkillItem): number {
	const body = s.manifest?.long_description ?? '';
	const desc = s.manifest?.description ?? '';
	return Math.ceil((body.length + desc.length) / 4);
}

/** Where the skill came from — 'git', 'bundle', 'store'… '' when unknown. */
export function skillSource(s: SkillItem): string {
	return s.install_receipt?.source?.type ?? '';
}

export function skillDescription(s: SkillItem): string {
	return s.manifest?.description ?? '';
}

/** Free-text match over slug + name + description. */
export function skillMatches(s: SkillItem, query: string): boolean {
	const q = query.toLowerCase().trim();
	if (!q) return true;
	return `${s.slug} ${s.name} ${skillDescription(s)}`.toLowerCase().includes(q);
}

/**
 * What ONE attached skill costs on EVERY run.
 *
 * Not the same number as `estimateSkillTokens()`, and the difference is the
 * whole point of showing both: the executor injects
 * `- **<slug>** — <description sliced to 240>` per attached skill into the
 * system_prompt (SkillBodyResolver.buildPromptIndex), and only pulls the body
 * when the model calls `kernel_skill_load`. So this is the fixed toll and
 * `estimateSkillTokens()` is the variable one.
 *
 * Same chars/4 approximation the resolver uses for its own estimate.
 */
export function skillIndexTokens(slug: string, description: string): number {
	// "- **" + slug + "** — " + desc + "\n"  → 10 chars of scaffolding.
	return Math.ceil((slug.length + (description ?? '').slice(0, 240).length + 10) / 4);
}

/**
 * The preamble buildPromptIndex writes once above the per-skill lines. Paid
 * on every run as soon as the agent carries at least one skill, so a header
 * that claims to show the fixed cost has to count it.
 */
export const SKILL_INDEX_PREAMBLE_TOKENS = Math.ceil(
	[
		'',
		'## Available skills',
		'These procedural skills are loaded for this agent. Each lists its',
		'trigger pattern. When a user request matches, call `kernel_skill_load`',
		'with the slug to read the full step-by-step playbook before acting.',
		'',
		'',
	].join('\n').length / 4,
);
