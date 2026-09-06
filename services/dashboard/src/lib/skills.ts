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
import { agentFromResponse } from './stores/agent-detail.js';
import { normalizeRepoUrl } from './skill-repos.js';

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

/** Same list, same order? Order is part of the value: it is the column verbatim. */
export function sameSlugList(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * Persist the slug list for one agent and keep the local cache in sync so
 * the other surface (hub ↔ drawer) reflects it without a refetch.
 *
 * Throws when the write did not land — including when the call itself
 * SUCCEEDED. That is not defensive padding; it is the whole point of this
 * function now. `agents.update` accepted `{id, skills}` and answered
 * `{success: true, agent}` while quietly dropping the column, because its
 * handler built an explicit key list that `skills` was not on. Every caller
 * here read "did not throw" as "saved": the tab set `attached`, moved
 * `seenJson`, dispatched `change`, and the badge, the row and the token
 * estimate all updated for a skill the agent never got.
 *
 * So the response row is checked instead of assumed, the same way
 * `agent-detail.ts`'s `patch()` reconciles every other field the drawer
 * writes. The check lives HERE rather than in that store because the store is
 * only under one of the three surfaces that mount SkillsTab; this is the one
 * place all of them go through.
 *
 * A response with no row at all is not treated as a failure — some transports
 * answer without one, and a check that cannot run must not invent a verdict.
 * That is the only path left where success is taken on trust.
 */
export async function saveAgentSkills(agentId: string, slugs: string[]): Promise<void> {
	const res = await updateAgent(agentId, { skills: slugs });
	const saved = agentFromResponse(res);

	if (saved) {
		const landed = parseAttachedSkills(saved as { skills_json?: string });
		if (!sameSlugList(landed, slugs)) {
			// Deliberately says what came back. Against a kernel that drops the
			// column the landed list is the agent's PREVIOUS one, and seeing it
			// is what tells the user the attach did nothing rather than that it
			// half-worked.
			throw new Error(
				`Not saved: skills — the kernel answered with ${
					landed.length ? landed.join(', ') : 'an empty list'
				}. This kernel build may not accept skill changes.`
			);
		}
	}

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

// ── Catalog repos, from inside an agent ───────────────────────────────
//
// Subscribing to a git repo of skills has always been possible, but only on
// /extensions. That is the wrong place to be standing when the thought is
// "this agent should know three.js": the answer was to leave the agent, add
// the repo, and come back. These two functions put the same POST behind the
// agent's Skills tab, and let it show what the repo actually brought.

/** A catalogue row, narrowed to what the repo list renders and filters on. */
export interface CatalogSkill {
	id: string;
	slug: string;
	status?: string;
	manifest?: { name?: string; description?: string } | null;
	origin?: { provider?: string; source?: { type?: string; url?: string } };
}

export interface RepoSubscription {
	/** True when the URL was already on the list and no clone was asked for. */
	alreadySubscribed: boolean;
	/**
	 * Skills the kernel found in the repo. Zero is the "awesome list" case —
	 * a README of links whose targets live in other repositories. It clones
	 * cleanly and reports success, so this count is the only way to tell.
	 */
	itemsFound: number;
}

/**
 * Subscribe to a git repo of skills, or report that it was already there.
 *
 * The pre-check is not an optimisation: `POST /api/marketplace/repos` on a
 * known URL re-clones it, so without this the user waits through a shallow
 * clone to arrive exactly where they started.
 */
export async function subscribeRepo(url: string, ref?: string): Promise<RepoSubscription> {
	const target = normalizeRepoUrl(url);

	const listed = await fetch('/api/marketplace/repos');
	if (listed.ok) {
		const body = (await listed.json().catch(() => ({}))) as {
			repos?: { url: string; items_found?: number }[];
		};
		const existing = (body.repos ?? []).find((r) => normalizeRepoUrl(r.url) === target);
		if (existing) {
			return { alreadySubscribed: true, itemsFound: existing.items_found ?? 0 };
		}
	}

	const r = await fetch('/api/marketplace/repos', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ url: url.trim(), ...(ref?.trim() ? { ref: ref.trim() } : {}) })
	});
	const body = (await r.json().catch(() => ({}))) as {
		success?: boolean;
		error?: string;
		repo?: { items_found?: number };
	};
	if (!r.ok || !body.success) throw new Error(String(body.error ?? `HTTP ${r.status}`));

	return { alreadySubscribed: false, itemsFound: body.repo?.items_found ?? 0 };
}

/**
 * The skills one subscribed repo contributed to the catalogue.
 *
 * Filtered here rather than server-side because `CatalogFilter` has no repo
 * field — `origin.source.url` is the only thread back to the repo an item
 * came from. The whole skill shelf is a few hundred rows off a local kernel,
 * so the cost of over-fetching is smaller than the cost of a kernel change
 * that every dashboard would then have to require.
 */
export async function loadRepoSkills(url: string): Promise<CatalogSkill[]> {
	const target = normalizeRepoUrl(url);
	const r = await fetch('/api/marketplace/catalog?type=skill&limit=1000');
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const body = (await r.json()) as { items?: CatalogSkill[] };
	return (body.items ?? []).filter(
		(i) => i.origin?.source?.url && normalizeRepoUrl(i.origin.source.url) === target
	);
}
