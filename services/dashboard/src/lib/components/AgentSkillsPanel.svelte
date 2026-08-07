<!--
  AgentSkillsPanel — the per-agent slice of the skills system.

  Renders the skills attached to one agent plus the picker to attach more.
  Mounted in every surface that shows an agent in detail: the /agents list
  drawer and the 3D flow drawer. Installing skills is NOT done here — that
  lives in /extensions (Skills tab); this panel only decides which of the
  installed ones this agent carries.

  Writes go through $lib/skills.ts so the shared cache stays truthful and
  the hub reflects an attach made from a drawer (and vice versa).

  Props:
    agent   — { id, name, skills_json }; null renders nothing
    compact — denser type/tiles for the narrow 3D-flow drawer

  Events:
    change  — { skills: string[] } after a successful save, so the parent
              can patch its own copy of the agent without a refetch
-->
<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import {
		loadInstalledSkills,
		parseAttachedSkills,
		saveAgentSkills,
		estimateSkillTokens,
		skillSource,
		skillDescription,
		skillMatches,
		type SkillItem,
		type SkillAgent
	} from '$lib/skills.js';

	export let agent: SkillAgent | null = null;
	export let compact = false;

	const dispatch = createEventDispatcher<{ change: { skills: string[] } }>();

	let installed: SkillItem[] = [];
	let installedLoaded = false;
	let showPicker = false;
	let search = '';
	let saving = false;
	let error = '';

	$: attached = parseAttachedSkills(agent);

	// Slug → item, so an attached chip can show the description even when
	// the picker has never been opened for this agent.
	$: bySlug = new Map(installed.map((s) => [s.slug, s]));

	$: pickerRows = installed
		.filter((s) => skillMatches(s, search))
		.map((s) => ({ ...s, attached: attached.includes(s.slug) }));

	// A slug in skills_json with no matching installed extension: the skill
	// was uninstalled while still attached. The executor drops it silently,
	// so the UI is the only place this is visible.
	$: orphans = installedLoaded ? attached.filter((slug) => !bySlug.has(slug)) : [];

	async function ensureInstalled(): Promise<void> {
		if (installedLoaded) return;
		installed = await loadInstalledSkills();
		installedLoaded = true;
	}

	async function openPicker(): Promise<void> {
		await ensureInstalled();
		showPicker = true;
	}

	async function persist(slugs: string[]): Promise<void> {
		if (!agent) return;
		saving = true;
		error = '';
		try {
			await saveAgentSkills(agent.id, slugs);
			agent = { ...agent, skills_json: JSON.stringify(slugs) };
			dispatch('change', { skills: slugs });
		} catch (e) {
			error = (e as Error).message;
		} finally {
			saving = false;
		}
	}

	function toggle(slug: string): Promise<void> {
		const next = attached.includes(slug)
			? attached.filter((s) => s !== slug)
			: [...attached, slug];
		return persist(next);
	}

	// Slugs whose description tile is flipped open. Set + reassign so
	// Svelte's reactivity catches the mutation.
	let expanded: Set<string> = new Set();
	function toggleExpand(slug: string): void {
		const next = new Set(expanded);
		if (next.has(slug)) next.delete(slug);
		else next.add(slug);
		expanded = next;
	}

	// Total up-front cost: the picker prices each skill's full body, but an
	// attached skill only spends its one-line index entry until loaded.
	$: indexCost = attached.reduce((sum, slug) => {
		const s = bySlug.get(slug);
		return sum + Math.ceil((slug.length + (skillDescription(s ?? ({} as SkillItem)) || '').slice(0, 240).length + 8) / 4);
	}, 0);

	// Load lazily so the chips can show a description without a click, but
	// never block the drawer's first paint.
	$: if (agent && attached.length > 0 && !installedLoaded) void ensureInstalled();
</script>

{#if agent}
	<div class="skp" class:skp-compact={compact}>
		<div class="skp-head">
			<h4 class="skp-title">
				<span class="skp-glyph" aria-hidden="true">✦</span>
				Skills
				{#if attached.length}<span class="skp-count">{attached.length}</span>{/if}
			</h4>
			<button class="skp-add" on:click={openPicker} disabled={saving}>+ Attach</button>
		</div>

		{#if attached.length === 0}
			<p class="skp-empty">
				No skills attached. Skills are markdown playbooks the agent loads on demand —
				install them in <a href="/extensions?tab=skills">Extensions → Skills</a>, then attach here.
			</p>
		{:else}
			<div class="skp-chips">
				{#each attached as slug (slug)}
					{@const item = bySlug.get(slug)}
					<span class="skp-chip" class:skp-chip-orphan={installedLoaded && !item} title={item ? skillDescription(item) : 'Not installed — the executor skips this slug'}>
						<span class="skp-chip-glyph" aria-hidden="true">{installedLoaded && !item ? '⚠' : '✦'}</span>
						{slug}
						<button
							class="skp-chip-x"
							title="Detach"
							on:click={() => toggle(slug)}
							disabled={saving}>×</button>
					</span>
				{/each}
			</div>
			<p class="skp-hint">
				Each attached skill adds one line to the system_prompt (~{indexCost}t);
				the body is pulled on demand via <code>kernel_skill_load</code>.
			</p>
			{#if orphans.length}
				<p class="skp-warn">
					⚠︎ {orphans.length} attached slug{orphans.length === 1 ? '' : 's'} not installed
					({orphans.join(', ')}) — the executor skips {orphans.length === 1 ? 'it' : 'them'}.
				</p>
			{/if}
		{/if}

		{#if error}
			<p class="skp-error">Failed to save: {error}</p>
		{/if}
	</div>
{/if}

{#if showPicker && agent}
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="skp-scrim"
		role="presentation"
		on:click={() => (showPicker = false)}
		on:keydown={(e) => e.key === 'Escape' && (showPicker = false)}
	></div>
	<aside class="skp-picker" role="dialog" aria-modal="true" aria-label="Attach skills">
		<header class="skp-picker-head">
			<h3>Attach skills to {agent.name}</h3>
			<button class="skp-picker-close" on:click={() => (showPicker = false)} aria-label="Close">×</button>
		</header>

		<!-- svelte-ignore a11y-autofocus -->
		<input
			class="skp-picker-search"
			type="text"
			autofocus
			bind:value={search}
			placeholder="Search by slug or description…"
		/>

		<div class="skp-picker-list">
			{#if pickerRows.length === 0}
				<p class="skp-empty">
					{#if installed.length === 0}
						No skills installed yet. Add a repository or install one from
						<a href="/extensions?tab=skills">Extensions → Skills</a>.
					{:else}
						No matches for “{search}”.
					{/if}
				</p>
			{:else}
				<div class="skp-tiles">
					{#each pickerRows as s (s.id)}
						{@const isOpen = expanded.has(s.slug)}
						<div class="skp-tile" class:skp-tile-on={s.attached} class:skp-tile-open={isOpen}>
							{#if !isOpen}
								<button
									class="skp-tile-front"
									disabled={saving}
									on:click={() => toggle(s.slug)}
									title={s.attached ? 'Detach' : 'Attach'}
								>
									{#if s.attached}
										<span class="skp-tile-corner" aria-hidden="true">
											<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
												<polyline points="3 8.5 6.5 12 13 4.5"></polyline>
											</svg>
										</span>
									{/if}
									<span class="skp-tile-name">{s.slug}</span>
									<span class="skp-tile-foot">
										<span class="skp-tile-tok mono">{estimateSkillTokens(s)}t</span>
										{#if skillSource(s)}<span class="skp-tile-src">{skillSource(s)}</span>{/if}
									</span>
								</button>

								<button
									class="skp-tile-info"
									type="button"
									on:click|stopPropagation={() => toggleExpand(s.slug)}
									aria-label="Show description"
									title="Show description"
								>
									<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4">
										<circle cx="8" cy="8" r="6.5"></circle>
										<line x1="8" y1="7" x2="8" y2="11.5" stroke-linecap="round"></line>
										<circle cx="8" cy="4.6" r="0.9" fill="currentColor" stroke="none"></circle>
									</svg>
								</button>
							{:else}
								<div class="skp-tile-back">
									<button
										class="skp-tile-close"
										type="button"
										on:click|stopPropagation={() => toggleExpand(s.slug)}
										aria-label="Close description">×</button>
									<div class="skp-tile-back-name">{s.slug}</div>
									<div class="skp-tile-back-text">{skillDescription(s) || '(no description)'}</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<footer class="skp-picker-foot">
			<span class="mono">{attached.length} attached · {installed.length} installed</span>
			<a class="skp-picker-link" href="/extensions?tab=skills">Manage all skills →</a>
			<button class="skp-picker-done" on:click={() => (showPicker = false)}>Done</button>
		</footer>
	</aside>
{/if}

<style>
	/* Panel ──────────────────────────────────────────────────────── */
	.skp-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
	}
	.skp-title {
		display: flex;
		align-items: center;
		gap: 7px;
		margin: 0;
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-2);
	}
	.skp-glyph {
		color: var(--skill);
		font-size: 11px;
	}
	.skp-count {
		background: color-mix(in srgb, var(--skill) 18%, transparent);
		color: var(--skill);
		border: 1px solid color-mix(in srgb, var(--skill) 40%, transparent);
		border-radius: 999px;
		padding: 1px 8px;
		font-size: 11px;
		font-weight: 600;
	}
	.skp-add {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-2);
		font-family: inherit;
		font-size: 11.5px;
		padding: 4px 10px;
		cursor: pointer;
		transition: border-color 0.15s ease, color 0.15s ease;
	}
	.skp-add:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--skill) 55%, var(--border));
		color: var(--skill);
	}
	.skp-add:disabled { opacity: 0.5; cursor: not-allowed; }

	.skp-empty {
		margin: 4px 0;
		font-size: 12px;
		line-height: 1.55;
		color: var(--text-2);
	}
	.skp-empty a,
	.skp-picker-link { color: var(--gold); }

	.skp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
	.skp-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 6px 3px 10px;
		background: linear-gradient(135deg, color-mix(in srgb, var(--skill) 14%, var(--surface-2)), var(--surface-2));
		border: 1px solid color-mix(in srgb, var(--skill) 35%, var(--border));
		border-radius: 999px;
		font-size: 11.5px;
		color: var(--text-1);
	}
	.skp-chip-orphan {
		background: var(--surface-2);
		border-color: color-mix(in srgb, var(--orange) 45%, var(--border));
		color: var(--text-2);
	}
	.skp-chip-glyph { color: var(--skill); font-size: 10px; }
	.skp-chip-orphan .skp-chip-glyph { color: var(--orange); }
	.skp-chip-x {
		background: transparent;
		border: none;
		color: var(--text-3);
		font-size: 14px;
		line-height: 1;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.skp-chip-x:hover {
		background: color-mix(in srgb, var(--red) 30%, transparent);
		color: var(--text-1);
	}
	.skp-chip-x:disabled { opacity: 0.4; cursor: not-allowed; }

	.skp-hint {
		margin-top: 8px;
		font-size: 11px;
		font-style: italic;
		line-height: 1.5;
		color: var(--text-3);
	}
	.skp-hint code {
		background: var(--surface-2);
		padding: 1px 4px;
		border-radius: 3px;
		color: var(--gold);
		font-style: normal;
	}
	.skp-warn {
		margin-top: 6px;
		font-size: 11px;
		line-height: 1.5;
		color: var(--orange);
	}
	.skp-error {
		margin-top: 6px;
		font-size: 11.5px;
		color: var(--red);
	}

	.skp-compact .skp-title { font-size: 11px; }
	.skp-compact .skp-chip { font-size: 10.5px; padding: 2px 5px 2px 8px; }
	.skp-compact .skp-hint { font-size: 10px; }

	/* Picker ─────────────────────────────────────────────────────── */
	.skp-scrim {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(2px);
		z-index: 190;
	}
	.skp-picker {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(960px, 94vw);
		max-height: 82vh;
		padding: 18px 20px;
		background:
			radial-gradient(circle at top right, color-mix(in srgb, var(--skill) 8%, transparent), transparent 55%),
			var(--surface-1);
		border: 1px solid color-mix(in srgb, var(--skill) 30%, var(--border));
		border-radius: 14px;
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.7), 0 0 0 1px color-mix(in srgb, var(--skill) 10%, transparent);
		display: flex;
		flex-direction: column;
		z-index: 200;
	}
	.skp-picker-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12px;
	}
	.skp-picker-head h3 { margin: 0; font-size: 15px; color: var(--text-1); }
	.skp-picker-close {
		background: transparent;
		border: none;
		color: var(--text-2);
		font-size: 24px;
		line-height: 1;
		padding: 0 6px;
		cursor: pointer;
	}
	.skp-picker-close:hover { color: var(--gold); }
	.skp-picker-search {
		width: 100%;
		padding: 8px 12px;
		margin-bottom: 12px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text-1);
		font-family: inherit;
		font-size: 13px;
	}
	.skp-picker-search:focus { outline: none; border-color: var(--skill); }
	.skp-picker-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-right: 4px;
	}
	.skp-picker-foot {
		margin-top: 14px;
		display: flex;
		align-items: center;
		gap: 14px;
		font-size: 11px;
		color: var(--text-3);
	}
	.skp-picker-link { margin-left: auto; text-decoration: none; font-size: 11.5px; }
	.skp-picker-link:hover { text-decoration: underline; }
	.skp-picker-done {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-1);
		font-family: inherit;
		font-size: 12px;
		padding: 5px 14px;
		cursor: pointer;
	}
	.skp-picker-done:hover { border-color: var(--skill); color: var(--skill); }

	/* Tiles ──────────────────────────────────────────────────────── */
	.skp-tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(138px, 1fr));
		gap: 8px;
		padding-bottom: 4px;
	}
	.skp-tile {
		position: relative;
		height: 118px;
		border-radius: 9px;
		background:
			linear-gradient(180deg, rgba(255, 255, 255, 0.025) 0%, transparent 35%),
			var(--surface-2);
		border: 1px solid var(--border);
		overflow: hidden;
		transition:
			transform 0.18s cubic-bezier(0.2, 0.7, 0.3, 1.2),
			border-color 0.18s ease,
			box-shadow 0.2s ease,
			background 0.2s ease;
	}
	.skp-tile::before {
		/* ambient diagonal sheen — barely visible, gives the tile a panel feel */
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(135deg, transparent 0%, color-mix(in srgb, var(--skill) 8%, transparent) 50%, transparent 100%);
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.25s;
	}
	.skp-tile:hover {
		transform: translateY(-1px);
		border-color: var(--border-h);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
	}
	.skp-tile:hover::before { opacity: 1; }
	.skp-tile-on {
		background: linear-gradient(135deg, color-mix(in srgb, var(--skill) 18%, var(--surface-2)) 0%, var(--surface-2) 100%);
		border-color: color-mix(in srgb, var(--skill) 50%, var(--border));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--skill) 22%, transparent);
	}
	.skp-tile-on:hover {
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--skill) 35%, transparent),
			0 4px 18px color-mix(in srgb, var(--skill) 22%, transparent);
	}
	.skp-tile-front {
		position: absolute;
		inset: 0;
		padding: 10px 12px 9px 12px;
		background: transparent;
		border: 0;
		cursor: pointer;
		color: var(--text-1);
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-family: inherit;
	}
	.skp-tile-front:disabled { cursor: not-allowed; opacity: 0.55; }
	.skp-tile-front:focus-visible {
		outline: none;
		border-radius: 9px;
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--skill) 60%, transparent);
	}
	.skp-tile-corner {
		position: absolute;
		top: 0;
		right: 0;
		width: 24px;
		height: 24px;
		background: var(--skill);
		color: #fff;
		clip-path: polygon(100% 0, 100% 100%, 0 0);
		box-shadow: 0 0 12px color-mix(in srgb, var(--skill) 45%, transparent);
	}
	.skp-tile-corner svg { position: absolute; top: 3px; right: 3px; }
	.skp-tile-name {
		margin-top: 2px;
		padding-right: 24px; /* clear of the info icon / attached corner */
		font-size: 13px;
		font-weight: 700;
		line-height: 1.2;
		letter-spacing: -0.005em;
		color: var(--text-1);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		text-overflow: ellipsis;
		word-break: break-word;
	}
	.skp-tile-on .skp-tile-name { color: #fff; }
	.skp-tile-foot {
		margin-top: auto;
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 9px;
		line-height: 1.2;
	}
	.skp-tile-tok {
		color: var(--text-3);
		background: color-mix(in srgb, var(--bg) 65%, transparent);
		padding: 2px 6px;
		border-radius: 4px;
		font-size: 9.5px;
		letter-spacing: 0.02em;
	}
	.skp-tile-on .skp-tile-tok {
		color: color-mix(in srgb, #fff 80%, var(--skill));
		background: rgba(0, 0, 0, 0.18);
	}
	.skp-tile-src {
		font-size: 8.5px;
		color: var(--teal);
		border: 1px solid color-mix(in srgb, var(--teal) 35%, transparent);
		padding: 1px 5px;
		border-radius: 999px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.skp-tile-info {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 22px;
		height: 22px;
		border: 0;
		background: rgba(255, 255, 255, 0.04);
		border-radius: 5px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-3);
		cursor: pointer;
		transition: all 0.15s ease;
		z-index: 2;
	}
	.skp-tile-info:hover {
		background: var(--surface-3);
		color: var(--skill);
		transform: scale(1.08);
	}
	.skp-tile-info:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--skill); }
	/* Tuck the info button left when the attached corner is showing. */
	.skp-tile-on .skp-tile-info { right: 30px; }

	.skp-tile-open {
		background: linear-gradient(180deg, var(--surface-1), var(--surface-2));
		border-color: color-mix(in srgb, var(--skill) 35%, var(--border));
	}
	.skp-tile-back {
		position: absolute;
		inset: 0;
		padding: 9px 12px 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		animation: skpFlip 0.22s ease;
	}
	@keyframes skpFlip {
		from { opacity: 0; transform: translateY(2px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.skp-tile-close {
		position: absolute;
		top: 4px;
		right: 4px;
		width: 22px;
		height: 22px;
		border: 0;
		background: rgba(255, 255, 255, 0.04);
		border-radius: 5px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-2);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.skp-tile-close:hover { background: var(--surface-3); color: var(--skill); }
	.skp-tile-back-name {
		padding-right: 28px;
		font-size: 10.5px;
		font-weight: 700;
		color: var(--skill);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.skp-tile-back-text {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-right: 4px;
		font-size: 10.5px;
		line-height: 1.4;
		color: var(--text-2);
		word-break: break-word;
		scrollbar-width: thin;
		scrollbar-color: var(--surface-3) transparent;
	}
	.skp-tile-back-text::-webkit-scrollbar { width: 4px; }
	.skp-tile-back-text::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 2px; }

	.mono { font-family: var(--font-mono, monospace); }

	@media (max-width: 540px) {
		.skp-tiles { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
		.skp-tile { height: 108px; }
	}
</style>
