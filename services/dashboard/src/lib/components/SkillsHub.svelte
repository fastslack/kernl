<!--
  SkillsHub — the single place where procedural skills are managed.

  Replaces the legacy /skills page. It lives inside /extensions because a
  skill IS an extension (`installed_extensions.type = 'skill'`); what the
  generic extension grid cannot express is the part that actually matters:
  a skill does nothing until an agent carries it.

  So the hub is built around the assignment, not the inventory. Two reads
  of the same matrix:

    By skill  — one row per skill, with the agents carrying it. Answers
                "who uses this?" and surfaces skills nobody uses.
    By agent  — pick an agent, tick its skills. Answers "what does this
                agent know?" — the same job as the drawer panel, but for
                bulk setup across the fleet.

  Install paths stay where they already work: the ＋ menu of /extensions
  (bundle / repository) and the Discover tab filtered to skills. This
  component dispatches to the parent for those rather than duplicating
  the install machinery.

  Events:
    discover — switch the page to Discover, filtered to type=skill
    addrepo  — open the "Add catalog repository" modal
    open     — { slug }: open the standard extension drawer for that skill
-->
<script lang="ts">
	import { onMount, createEventDispatcher } from 'svelte';
	import {
		loadInstalledSkills,
		loadSkillAgents,
		parseAttachedSkills,
		saveAgentSkills,
		estimateSkillTokens,
		skillSource,
		skillDescription,
		skillMatches,
		type SkillItem,
		type SkillAgent
	} from '$lib/skills.js';

	/**
	 * When the host page already owns a search field (as /extensions does),
	 * it passes the term down and hides the local one — two search boxes on
	 * one screen is the tell that a page was bolted on rather than merged.
	 */
	export let query = '';
	export let showSearch = true;

	const dispatch = createEventDispatcher<{
		discover: void;
		addrepo: void;
		open: { slug: string };
	}>();

	let skills: SkillItem[] = [];
	let agents: SkillAgent[] = [];
	let loading = true;
	let saving = '';
	let error = '';

	let view: 'skill' | 'agent' = 'skill';
	let localSearch = '';
	$: search = showSearch ? localSearch : query;
	let onlyUnused = false;
	let selectedAgentId = '';
	/** Slug whose "assign to agent" popover is open. */
	let assignFor = '';

	onMount(async () => {
		await refresh();
	});

	async function refresh(): Promise<void> {
		loading = true;
		[skills, agents] = await Promise.all([loadInstalledSkills(true), loadSkillAgents(true)]);
		if (!selectedAgentId && agents.length > 0) selectedAgentId = agents[0].id;
		loading = false;
	}

	// slug → agents carrying it. Rebuilt whenever an assignment changes,
	// which is what makes both views update from one write.
	$: usage = (() => {
		const m = new Map<string, SkillAgent[]>();
		for (const a of agents) {
			for (const slug of parseAttachedSkills(a)) {
				const list = m.get(slug);
				if (list) list.push(a);
				else m.set(slug, [a]);
			}
		}
		return m;
	})();

	$: assignedCount = skills.filter((s) => (usage.get(s.slug) ?? []).length > 0).length;
	$: unusedCount = skills.length - assignedCount;

	$: visibleSkills = skills
		.filter((s) => skillMatches(s, search))
		.filter((s) => !onlyUnused || (usage.get(s.slug) ?? []).length === 0);

	$: selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
	$: selectedAttached = parseAttachedSkills(selectedAgent);

	async function setAgentSkills(agent: SkillAgent, slugs: string[]): Promise<void> {
		saving = agent.id;
		error = '';
		try {
			await saveAgentSkills(agent.id, slugs);
			// Local patch instead of a refetch: the popover stays open and
			// the row re-renders from `usage` on the next tick.
			agents = agents.map((a) =>
				a.id === agent.id ? { ...a, skills_json: JSON.stringify(slugs) } : a
			);
		} catch (e) {
			error = `${agent.name}: ${(e as Error).message}`;
		} finally {
			saving = '';
		}
	}

	function toggle(agent: SkillAgent, slug: string): Promise<void> {
		const current = parseAttachedSkills(agent);
		return setAgentSkills(
			agent,
			current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug]
		);
	}

	function agentCount(a: SkillAgent): number {
		return parseAttachedSkills(a).length;
	}

	/** Up-front prompt cost for an agent: one index line per attached skill. */
	function indexCost(a: SkillAgent): number {
		const bySlug = new Map(skills.map((s) => [s.slug, s]));
		return parseAttachedSkills(a).reduce((sum, slug) => {
			const desc = skillDescription(bySlug.get(slug) ?? ({} as SkillItem)).slice(0, 240);
			return sum + Math.ceil((slug.length + desc.length + 8) / 4);
		}, 0);
	}
</script>

<section class="hub">
	<header class="hub-head">
		<div class="hub-intro">
			<h2 class="hub-title"><span class="hub-mark" aria-hidden="true">✦</span> Skills</h2>
			<p class="hub-sub">
				Markdown playbooks agents load on demand. Installing one only puts it on the shelf —
				it runs when an agent carries it.
			</p>
		</div>

		<div class="hub-stats">
			<div class="stat">
				<span class="stat-n">{skills.length}</span>
				<span class="stat-l">installed</span>
			</div>
			<div class="stat stat-on">
				<span class="stat-n">{assignedCount}</span>
				<span class="stat-l">in use</span>
			</div>
			<button
				class="stat stat-btn"
				class:stat-warn={unusedCount > 0}
				class:stat-active={onlyUnused}
				on:click={() => (onlyUnused = !onlyUnused)}
				title="Installed but attached to no agent — dead weight until assigned"
			>
				<span class="stat-n">{unusedCount}</span>
				<span class="stat-l">unused</span>
			</button>
		</div>
	</header>

	<div class="hub-bar">
		<div class="seg" role="group" aria-label="View">
			<button class:seg-on={view === 'skill'} on:click={() => (view = 'skill')}>By skill</button>
			<button class:seg-on={view === 'agent'} on:click={() => (view = 'agent')}>By agent</button>
		</div>

		{#if showSearch}
			<div class="hub-search">
				<span class="hub-search-icon" aria-hidden="true">⌕</span>
				<input type="text" bind:value={localSearch} placeholder="Search skills…" aria-label="Search skills" />
				{#if localSearch}
					<button class="hub-search-clear" on:click={() => (localSearch = '')} aria-label="Clear">×</button>
				{/if}
			</div>
		{:else}
			<div class="hub-spacer"></div>
		{/if}

		<button class="hub-act" on:click={() => dispatch('discover')}>⌕ Browse catalog</button>
		<button class="hub-act hub-act-primary" on:click={() => dispatch('addrepo')}>⎇ Add repository</button>
	</div>

	{#if error}
		<p class="hub-error">⚠︎ Failed to save — {error}</p>
	{/if}

	{#if loading}
		<div class="hub-loading">Loading skills…</div>
	{:else if skills.length === 0}
		<div class="hub-blank">
			<div class="hub-blank-mark" aria-hidden="true">✦</div>
			<h3>No skills installed</h3>
			<p>
				A skill is a <code>SKILL.md</code> playbook: a trigger and the steps to follow. Point the
				kernel at a Git repository of them, or pick one from the catalog.
			</p>
			<div class="hub-blank-acts">
				<button class="hub-act hub-act-primary" on:click={() => dispatch('addrepo')}>⎇ Add repository</button>
				<button class="hub-act" on:click={() => dispatch('discover')}>⌕ Browse catalog</button>
			</div>
		</div>
	{:else if view === 'skill'}
		{#if visibleSkills.length === 0}
			<div class="hub-blank hub-blank-sm">
				<p>{onlyUnused ? 'Every installed skill is attached to at least one agent.' : `No skills match “${search}”.`}</p>
			</div>
		{:else}
			<div class="rows">
				{#each visibleSkills as s (s.id)}
					{@const holders = usage.get(s.slug) ?? []}
					<article class="row" class:row-unused={holders.length === 0}>
						<button class="row-main" on:click={() => dispatch('open', { slug: s.slug })} title="Open extension details">
							<span class="row-glyph" aria-hidden="true">✦</span>
							<span class="row-text">
								<span class="row-name">
									{s.slug}
									{#if s.manifest?.version}<span class="row-ver mono">v{s.manifest.version}</span>{/if}
								</span>
								<span class="row-desc">{skillDescription(s) || 'No description in the manifest.'}</span>
							</span>
						</button>

						<div class="row-meta">
							<span class="row-tok mono">{estimateSkillTokens(s)}t</span>
							{#if skillSource(s)}<span class="row-src">{skillSource(s)}</span>{/if}
						</div>

						<div class="row-assign">
							{#each holders as a (a.id)}
								<button
									class="agent-chip"
									on:click={() => toggle(a, s.slug)}
									disabled={saving === a.id}
									title="Detach from {a.name}"
								>
									{a.name}<span class="agent-chip-x">×</span>
								</button>
							{/each}

							<div class="assign-wrap">
								<button
									class="assign-btn"
									aria-haspopup="menu"
									aria-expanded={assignFor === s.slug}
									on:click={() => (assignFor = assignFor === s.slug ? '' : s.slug)}
								>+ Agent</button>

								{#if assignFor === s.slug}
									<!-- svelte-ignore a11y-no-static-element-interactions -->
									<div class="assign-scrim" role="presentation" on:click={() => (assignFor = '')}></div>
									<div class="assign-menu" role="menu">
										{#if agents.length === 0}
											<p class="assign-empty">No LLM agents yet — create one in <a href="/agents">Agents</a>.</p>
										{:else}
											{#each agents as a (a.id)}
												{@const on = parseAttachedSkills(a).includes(s.slug)}
												<button role="menuitemcheckbox" aria-checked={on} class:assign-on={on} on:click={() => toggle(a, s.slug)} disabled={saving === a.id}>
													<span class="assign-tick">{on ? '✓' : ''}</span>
													<span class="assign-name">{a.name}</span>
													<span class="assign-n mono">{agentCount(a)}</span>
												</button>
											{/each}
										{/if}
									</div>
								{/if}
							</div>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	{:else}
		<!-- By agent: pick one on the left, tick its skills on the right. -->
		<div class="matrix">
			<aside class="matrix-agents">
				{#if agents.length === 0}
					<p class="assign-empty">No LLM agents. <a href="/agents">Create one →</a></p>
				{:else}
					{#each agents as a (a.id)}
						<button
							class="matrix-agent"
							class:matrix-agent-on={a.id === selectedAgentId}
							on:click={() => (selectedAgentId = a.id)}
						>
							<span class="matrix-agent-name">{a.name}</span>
							<span class="matrix-agent-n" class:matrix-agent-n-zero={agentCount(a) === 0}>{agentCount(a)}</span>
						</button>
					{/each}
				{/if}
			</aside>

			<div class="matrix-skills">
				{#if !selectedAgent}
					<p class="assign-empty">Pick an agent to edit its skills.</p>
				{:else}
					<div class="matrix-head">
						<strong>{selectedAgent.name}</strong>
						<span class="matrix-cost mono">
							{selectedAttached.length} attached · ~{indexCost(selectedAgent)}t of system_prompt
						</span>
					</div>
					{#each visibleSkills as s (s.id)}
						{@const on = selectedAttached.includes(s.slug)}
						<button
							class="check"
							class:check-on={on}
							disabled={saving === selectedAgent.id}
							on:click={() => selectedAgent && toggle(selectedAgent, s.slug)}
						>
							<span class="check-box">{on ? '✓' : ''}</span>
							<span class="check-text">
								<span class="check-name">{s.slug}</span>
								<span class="check-desc">{skillDescription(s) || '—'}</span>
							</span>
							<span class="check-tok mono">{estimateSkillTokens(s)}t</span>
						</button>
					{/each}
					{#if visibleSkills.length === 0}
						<p class="assign-empty">No skills match “{search}”.</p>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</section>

<style>
	.hub {
		--pad: 18px;
		margin-top: 14px;
		animation: hubIn 0.25s ease both;
	}
	@keyframes hubIn {
		from { opacity: 0; transform: translateY(4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* Head ───────────────────────────────────────────────────────── */
	.hub-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px;
		flex-wrap: wrap;
		padding: var(--pad);
		background:
			radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--skill) 9%, transparent) 0%, transparent 60%),
			var(--surface-1);
		border: 1px solid color-mix(in srgb, var(--skill) 22%, var(--border));
		border-radius: 12px;
	}
	.hub-title {
		display: flex;
		align-items: center;
		gap: 9px;
		margin: 0 0 4px;
		font-family: var(--font-display, inherit);
		font-size: 19px;
		font-weight: 700;
		letter-spacing: -0.015em;
		color: var(--text-1);
	}
	.hub-mark {
		color: var(--skill);
		font-size: 15px;
		text-shadow: 0 0 14px color-mix(in srgb, var(--skill) 55%, transparent);
	}
	.hub-sub {
		max-width: 62ch;
		margin: 0;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-2);
	}

	.hub-stats { display: flex; gap: 8px; }
	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
		min-width: 68px;
		padding: 7px 12px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 9px;
	}
	.stat-n {
		font-family: var(--font-mono, monospace);
		font-size: 17px;
		font-weight: 700;
		line-height: 1.1;
		color: var(--text-1);
	}
	.stat-l {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-3);
	}
	.stat-on { border-color: color-mix(in srgb, var(--skill) 40%, var(--border)); }
	.stat-on .stat-n { color: var(--skill); }
	.stat-btn { cursor: pointer; font-family: inherit; transition: border-color 0.15s ease; }
	.stat-warn .stat-n { color: var(--orange); }
	.stat-btn:hover { border-color: var(--border-h); }
	.stat-active {
		border-color: var(--orange);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--orange) 30%, transparent);
	}

	/* Toolbar ────────────────────────────────────────────────────── */
	.hub-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin: 12px 0;
	}
	.seg {
		display: flex;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}
	.seg button {
		background: transparent;
		border: 0;
		color: var(--text-2);
		font-family: inherit;
		font-size: 12px;
		padding: 6px 13px;
		cursor: pointer;
	}
	.seg button:hover { color: var(--text-1); }
	.seg-on {
		background: color-mix(in srgb, var(--skill) 16%, transparent);
		color: var(--skill) !important;
	}

	.hub-spacer { flex: 1; }
	.hub-search {
		position: relative;
		flex: 1;
		min-width: 200px;
		display: flex;
		align-items: center;
	}
	.hub-search-icon {
		position: absolute;
		left: 10px;
		color: var(--text-3);
		font-size: 13px;
		pointer-events: none;
	}
	.hub-search input {
		width: 100%;
		padding: 7px 30px 7px 28px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text-1);
		font-family: inherit;
		font-size: 12.5px;
	}
	.hub-search input:focus { outline: none; border-color: color-mix(in srgb, var(--skill) 55%, var(--border)); }
	.hub-search-clear {
		position: absolute;
		right: 8px;
		background: transparent;
		border: 0;
		color: var(--text-3);
		font-size: 15px;
		line-height: 1;
		cursor: pointer;
	}
	.hub-search-clear:hover { color: var(--text-1); }

	.hub-act {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text-2);
		font-family: inherit;
		font-size: 12px;
		padding: 7px 13px;
		cursor: pointer;
		white-space: nowrap;
		transition: border-color 0.15s ease, color 0.15s ease;
	}
	.hub-act:hover { border-color: var(--border-h); color: var(--text-1); }
	.hub-act-primary {
		border-color: color-mix(in srgb, var(--skill) 40%, var(--border));
		color: var(--skill);
	}
	.hub-act-primary:hover {
		border-color: var(--skill);
		color: var(--skill);
		background: color-mix(in srgb, var(--skill) 10%, var(--surface-2));
	}

	.hub-error { margin: 0 0 10px; font-size: 12px; color: var(--red); }
	.hub-loading { padding: 34px; text-align: center; font-size: 13px; color: var(--text-3); }

	/* Blank slate ────────────────────────────────────────────────── */
	.hub-blank {
		padding: 44px 24px;
		text-align: center;
		background: var(--surface-1);
		border: 1px dashed color-mix(in srgb, var(--skill) 25%, var(--border));
		border-radius: 12px;
	}
	.hub-blank-sm { padding: 26px; }
	.hub-blank-mark {
		font-size: 30px;
		color: var(--skill);
		opacity: 0.55;
		text-shadow: 0 0 24px color-mix(in srgb, var(--skill) 45%, transparent);
	}
	.hub-blank h3 { margin: 10px 0 6px; font-size: 15px; color: var(--text-1); }
	.hub-blank p {
		max-width: 54ch;
		margin: 0 auto;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-2);
	}
	.hub-blank code {
		background: var(--surface-2);
		padding: 1px 5px;
		border-radius: 4px;
		color: var(--skill);
		font-size: 11.5px;
	}
	.hub-blank-acts { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }

	/* By-skill rows ──────────────────────────────────────────────── */
	.rows { display: flex; flex-direction: column; gap: 6px; }
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 42%);
		align-items: center;
		gap: 14px;
		padding: 10px 14px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-left: 2px solid color-mix(in srgb, var(--skill) 45%, var(--border));
		border-radius: 9px;
		transition: border-color 0.15s ease, background 0.15s ease;
	}
	.row:hover { background: var(--surface-2); border-color: var(--border-h); border-left-color: var(--skill); }
	.row-unused { border-left-color: color-mix(in srgb, var(--orange) 50%, var(--border)); }
	.row-unused:hover { border-left-color: var(--orange); }

	.row-main {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		min-width: 0;
		padding: 0;
		background: transparent;
		border: 0;
		color: inherit;
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}
	.row-glyph { margin-top: 1px; color: var(--skill); font-size: 12px; }
	.row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.row-name {
		display: flex;
		align-items: baseline;
		gap: 7px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text-1);
	}
	.row-main:hover .row-name { color: var(--skill); }
	.row-ver { font-size: 10px; color: var(--text-3); }
	.row-desc {
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.row-meta { display: flex; align-items: center; gap: 6px; }
	.row-tok {
		padding: 2px 7px;
		background: var(--surface-2);
		border-radius: 4px;
		font-size: 10px;
		color: var(--text-3);
	}
	.row-src {
		padding: 1px 6px;
		border: 1px solid color-mix(in srgb, var(--teal) 32%, transparent);
		border-radius: 999px;
		font-size: 8.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--teal);
	}

	.row-assign {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 5px;
	}
	.agent-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 6px 3px 9px;
		background: color-mix(in srgb, var(--skill) 12%, var(--surface-2));
		border: 1px solid color-mix(in srgb, var(--skill) 34%, var(--border));
		border-radius: 999px;
		color: var(--text-1);
		font-family: inherit;
		font-size: 11px;
		cursor: pointer;
		max-width: 160px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.agent-chip:hover { border-color: var(--red); }
	.agent-chip:hover .agent-chip-x { color: var(--red); }
	.agent-chip:disabled { opacity: 0.5; cursor: not-allowed; }
	.agent-chip-x { color: var(--text-3); font-size: 13px; line-height: 1; }

	.assign-wrap { position: relative; }
	.assign-btn {
		padding: 3px 9px;
		background: transparent;
		border: 1px dashed var(--border-h);
		border-radius: 999px;
		color: var(--text-3);
		font-family: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.assign-btn:hover { border-color: var(--skill); color: var(--skill); }
	.assign-scrim { position: fixed; inset: 0; z-index: 40; }
	.assign-menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 50;
		min-width: 216px;
		max-height: 280px;
		overflow-y: auto;
		padding: 5px;
		background: var(--surface-2);
		border: 1px solid var(--border-h);
		border-radius: 9px;
		box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
	}
	.assign-menu button {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		background: transparent;
		border: 0;
		border-radius: 6px;
		color: var(--text-2);
		font-family: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.assign-menu button:hover { background: var(--surface-3); color: var(--text-1); }
	.assign-on { color: var(--skill) !important; }
	.assign-tick { width: 12px; color: var(--skill); font-size: 11px; }
	.assign-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.assign-n { font-size: 10px; color: var(--text-3); }
	.assign-empty { margin: 0; padding: 10px; font-size: 12px; color: var(--text-3); }
	.assign-empty a { color: var(--gold); }

	/* By-agent matrix ────────────────────────────────────────────── */
	.matrix {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		gap: 10px;
		align-items: start;
	}
	.matrix-agents {
		display: flex;
		flex-direction: column;
		gap: 3px;
		max-height: 62vh;
		overflow-y: auto;
		padding: 6px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 10px;
	}
	.matrix-agent {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 9px;
		background: transparent;
		border: 0;
		border-radius: 7px;
		color: var(--text-2);
		font-family: inherit;
		font-size: 12.5px;
		text-align: left;
		cursor: pointer;
	}
	.matrix-agent:hover { background: var(--surface-2); color: var(--text-1); }
	.matrix-agent-on {
		background: color-mix(in srgb, var(--skill) 14%, var(--surface-2));
		color: var(--text-1);
		box-shadow: inset 2px 0 0 var(--skill);
	}
	.matrix-agent-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.matrix-agent-n {
		min-width: 20px;
		padding: 1px 6px;
		background: color-mix(in srgb, var(--skill) 18%, transparent);
		border-radius: 999px;
		color: var(--skill);
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		text-align: center;
	}
	.matrix-agent-n-zero { background: var(--surface-3); color: var(--text-3); }

	.matrix-skills {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 62vh;
		overflow-y: auto;
		padding: 10px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 10px;
	}
	.matrix-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		padding-bottom: 8px;
		margin-bottom: 4px;
		border-bottom: 1px solid var(--border);
		font-size: 13px;
		color: var(--text-1);
	}
	.matrix-cost { font-size: 10.5px; color: var(--text-3); }

	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		background: var(--surface-2);
		border: 1px solid transparent;
		border-radius: 8px;
		color: inherit;
		font-family: inherit;
		text-align: left;
		cursor: pointer;
		transition: border-color 0.14s ease, background 0.14s ease;
	}
	.check:hover { border-color: var(--border-h); }
	.check:disabled { opacity: 0.55; cursor: not-allowed; }
	.check-on {
		background: color-mix(in srgb, var(--skill) 11%, var(--surface-2));
		border-color: color-mix(in srgb, var(--skill) 40%, transparent);
	}
	.check-box {
		flex: none;
		width: 17px;
		height: 17px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg);
		border: 1px solid var(--border-h);
		border-radius: 5px;
		color: var(--bg);
		font-size: 11px;
		font-weight: 700;
	}
	.check-on .check-box { background: var(--skill); border-color: var(--skill); }
	.check-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
	.check-name { font-size: 12.5px; font-weight: 600; color: var(--text-1); }
	.check-desc {
		font-size: 11px;
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.check-tok { flex: none; font-size: 10px; color: var(--text-3); }

	.mono { font-family: var(--font-mono, monospace); }

	@media (max-width: 900px) {
		.row { grid-template-columns: minmax(0, 1fr) auto; }
		.row-assign { grid-column: 1 / -1; justify-content: flex-start; }
		.matrix { grid-template-columns: 1fr; }
		.matrix-agents { flex-direction: row; flex-wrap: wrap; max-height: none; }
	}
</style>
