<script lang="ts">
	import { createEventDispatcher, tick } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import RailAgentRow from './RailAgentRow.svelte';
	import { t } from '$lib/i18n/index.js';
	import { filterRail, type RailAgent, type RailModel } from '$lib/office/rail-model.js';

	export let model: RailModel;
	export let selectedOfficeId: string | null = null;
	export let selectedAgentId: string | null = null;
	export let collapsed = false;

	const dispatch = createEventDispatcher<{
		officeselect: { id: string };
		officeedit: { id: string };
		agentselect: { id: string };
		agentmove: { agentId: string; flowId: string };
		newoffice: void;
		headquarters: void;
		togglecollapse: void;
	}>();

	const UNASSIGNED = '__unassigned__';

	let query = '';
	let searchEl: HTMLInputElement | undefined;
	let listEl: HTMLDivElement | undefined;
	let expanded = new Set<string>();
	let menuFor: string | null = null;
	let dragAgentId: string | null = null;
	let dropOfficeId: string | null = null;

	$: view = filterRail(model, query);
	$: searching = query.trim().length > 0;
	$: if (selectedOfficeId && !expanded.has(selectedOfficeId)) expanded = new Set([...expanded, selectedOfficeId]);
	$: moveTargets = model.offices.map((o) => ({ id: o.id, name: o.name, color: o.color }));

	export async function focusSearch(): Promise<void> {
		if (collapsed) dispatch('togglecollapse');
		await tick();
		searchEl?.focus();
	}

	/** Open the "Sin asignar" group (after an office is deleted its agents land there). */
	export function expandUnassigned(): void {
		if (!expanded.has(UNASSIGNED)) expanded = new Set([...expanded, UNASSIGNED]);
	}

	function toggle(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function targetsFor(officeId: string | null) {
		return moveTargets.filter((o) => o.id !== officeId);
	}

	function navigate(e: KeyboardEvent, groupId?: string) {
		if (!listEl) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const items = [...listEl.querySelectorAll<HTMLElement>('[data-rail-item]')];
			const i = items.indexOf(e.currentTarget as HTMLElement);
			const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
			next?.focus();
		} else if (groupId && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
			const open = expanded.has(groupId);
			if ((e.key === 'ArrowRight') !== open) {
				e.preventDefault();
				toggle(groupId);
			}
		}
	}

	function startDrag(e: DragEvent, agent: RailAgent) {
		dragAgentId = agent.id;
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/plain', agent.id);
			e.dataTransfer.effectAllowed = 'move';
		}
	}

	function endDrag() {
		dragAgentId = null;
		dropOfficeId = null;
	}

	function dragOver(e: DragEvent, officeId: string) {
		if (!dragAgentId) return;
		e.preventDefault();
		dropOfficeId = officeId;
	}

	function drop(e: DragEvent, officeId: string) {
		e.preventDefault();
		const agentId = dragAgentId;
		endDrag();
		if (agentId) dispatch('agentmove', { agentId, flowId: officeId });
	}

	function move(agentId: string, flowId: string) {
		menuFor = null;
		dispatch('agentmove', { agentId, flowId });
	}
</script>

<svelte:window
	on:click={() => (menuFor = null)}
	on:keydown|capture={(e) => { if (menuFor && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menuFor = null; } }}
	on:resize={() => (menuFor = null)}
/>

{#if collapsed}
	<aside class="rail rail--collapsed" aria-label={$t('office.rail.title')}>
		<button class="k-icon-btn" type="button" aria-label={$t('office.rail.expand')} on:click={() => dispatch('togglecollapse')}>
			<Icon name="panel" />
		</button>
	</aside>
{:else}
	<aside class="rail" aria-label={$t('office.rail.title')}>
		<header class="rail-head">
			<h2 class="rail-title">{$t('office.rail.title')} <span class="rail-count">{model.offices.length}</span></h2>
			<button class="k-icon-btn" type="button" aria-label={$t('office.rail.collapse')} on:click={() => dispatch('togglecollapse')}>
				<Icon name="panel" />
			</button>
		</header>

		<div class="rail-search">
			<label class="rail-search-box">
				<Icon name="search" />
				<input
					bind:this={searchEl}
					bind:value={query}
					type="search"
					placeholder={$t('office.rail.search')}
					aria-label={$t('office.rail.search')}
					autocomplete="off"
					on:keydown={(e) => {
						if (e.key === 'Escape' && query) {
							e.preventDefault();
							e.stopPropagation();
							query = '';
						}
					}}
				/>
				<kbd class="k-kbd">/</kbd>
			</label>
		</div>

		<div class="rail-list" bind:this={listEl} on:scroll={() => (menuFor = null)}>
			{#if model.offices.length === 0 && !searching}
				<p class="rail-empty">{$t('office.rail.empty')}</p>
			{/if}

			{#each view.offices as office (office.id)}
				{@const open = searching || expanded.has(office.id)}
				<div
					class="rail-office"
					class:rail-office--drop={dropOfficeId === office.id}
					role="group"
					aria-label={office.name}
					on:dragover={(e) => dragOver(e, office.id)}
					on:dragleave={() => { if (dropOfficeId === office.id) dropOfficeId = null; }}
					on:drop={(e) => drop(e, office.id)}
				>
					<div class="rail-row" class:rail-row--sel={selectedOfficeId === office.id}>
						<button
							class="rail-toggle"
							type="button"
							data-rail-item
							aria-expanded={open}
							on:click={() => { toggle(office.id); dispatch('officeselect', { id: office.id }); }}
							on:keydown={(e) => navigate(e, office.id)}
						>
							<span class="rail-chev" class:rail-chev--open={open}><Icon name="chev-r" size={14} /></span>
							<span class="rail-dot" style="background:{office.color}"></span>
							<span class="rail-name">{office.name}</span>
							<span
								class="rail-num"
								title={$t('office.rail.working_count', { w: office.working, n: office.agents.length })}
								aria-label={$t('office.rail.working_count', { w: office.working, n: office.agents.length })}
							>
								{#if office.working > 0}<span class="rail-num-working">{office.working}</span>/{/if}{office.agents.length}
							</span>
						</button>
						<button class="k-icon-btn rail-edit" type="button" aria-label={$t('office.rail.edit', { name: office.name })} on:click={() => dispatch('officeedit', { id: office.id })}>
							<Icon name="pencil" size={13} />
						</button>
					</div>
					{#if open && office.agents.length > 0}
						<ul class="rail-agents">
							{#each office.agents as agent (agent.id)}
								<li>
									<RailAgentRow
										{agent}
										selected={selectedAgentId === agent.id}
										moveTargets={targetsFor(office.id)}
										menuOpen={menuFor === agent.id}
										on:select={() => dispatch('agentselect', { id: agent.id })}
										on:menu={() => (menuFor = menuFor === agent.id ? null : agent.id)}
										on:move={(e) => move(agent.id, e.detail.flowId)}
										on:dragstart={(e) => startDrag(e.detail, agent)}
										on:dragend={endDrag}
										on:navkey={(e) => navigate(e.detail)}
									/>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}

			{#if searching && view.offices.length === 0 && !view.headquarters && view.unassigned.length === 0}
				<p class="rail-empty">{$t('office.rail.no_match', { q: query.trim() })}</p>
			{/if}

			{#if view.headquarters || view.unassigned.length > 0}
				<p class="k-section-title rail-group">{$t('office.rail.outside')}</p>
			{/if}

			{#if view.headquarters}
				<div class="rail-row">
					<button class="rail-toggle rail-toggle--special" type="button" data-rail-item on:click={() => dispatch('headquarters')} on:keydown={(e) => navigate(e)}>
						<span class="rail-chev"></span>
						<span class="rail-diamond" aria-hidden="true"></span>
						<span class="rail-name">{$t('office.rail.headquarters')}</span>
						<span class="rail-num">{view.headquarters.name}</span>
					</button>
				</div>
			{/if}

			{#if view.unassigned.length > 0}
				{@const open = searching || expanded.has(UNASSIGNED)}
				<div class="rail-row">
					<button class="rail-toggle rail-toggle--special" type="button" data-rail-item aria-expanded={open} on:click={() => toggle(UNASSIGNED)} on:keydown={(e) => navigate(e, UNASSIGNED)}>
						<span class="rail-chev" class:rail-chev--open={open}><Icon name="chev-r" size={14} /></span>
						<span class="rail-hollow" aria-hidden="true"></span>
						<span class="rail-name">{$t('office.rail.unassigned')}</span>
						<span class="rail-num">{view.unassigned.length}</span>
					</button>
				</div>
				{#if open}
					<ul class="rail-agents">
						{#each view.unassigned as agent (agent.id)}
							<li>
								<RailAgentRow
									{agent}
									selected={selectedAgentId === agent.id}
									moveTargets={targetsFor(null)}
									menuOpen={menuFor === agent.id}
									on:select={() => dispatch('agentselect', { id: agent.id })}
									on:menu={() => (menuFor = menuFor === agent.id ? null : agent.id)}
									on:move={(e) => move(agent.id, e.detail.flowId)}
									on:dragstart={(e) => startDrag(e.detail, agent)}
									on:dragend={endDrag}
									on:navkey={(e) => navigate(e.detail)}
								/>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>

		<footer class="rail-foot">
			<button class="k-btn k-btn--block" type="button" on:click={() => dispatch('newoffice')}>
				<Icon name="plus" />{$t('office.rail.new')}
			</button>
		</footer>
	</aside>
{/if}

<style>
	.rail {
		height: 100%; min-height: 0; display: grid; grid-template-rows: 52px auto 1fr auto;
		background: var(--surface-1); border-right: 1px solid var(--border); z-index: var(--z-chrome);
	}
	.rail--collapsed { grid-template-rows: 52px; width: 52px; place-items: center start; padding-left: 10px; }
	.rail-head { display: flex; align-items: center; justify-content: space-between; padding: 0 10px 0 16px; border-bottom: 1px solid var(--border); }
	.rail-title { margin: 0; font: 600 14px/1 var(--font-display); color: var(--text-1); display: flex; align-items: baseline; gap: 8px; }
	.rail-count { font: 400 12px/1 var(--font-mono); color: var(--text-3); }
	.rail-search { padding: 12px 12px 8px; }
	.rail-search-box {
		display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; color: var(--text-3);
		background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
	}
	.rail-search-box:focus-within { border-color: var(--teal); }
	.rail-search-box input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: var(--text-1); font: 400 13px/1 var(--font-body); }
	.rail-search-box input::placeholder { color: var(--text-3); }
	.rail-list { overflow-y: auto; min-height: 0; padding: 4px 8px 12px; display: grid; align-content: start; gap: 2px; }
	.rail-empty { margin: 8px; font-size: 12.5px; color: var(--text-3); }
	.rail-office { border-radius: var(--radius-sm); }
	.rail-office--drop { box-shadow: inset 0 0 0 1px var(--teal); background: color-mix(in srgb, var(--teal) 6%, transparent); }
	.rail-row { display: flex; align-items: center; gap: 2px; border-radius: var(--radius-sm); border: 1px solid transparent; }
	.rail-row--sel { background: var(--surface-3); border-color: var(--border-h); }
	.rail-toggle {
		flex: 1; min-width: 0; display: grid; grid-template-columns: 14px 10px 1fr auto; align-items: center; gap: 8px;
		padding: 7px 6px 7px 4px; border: 0; border-radius: var(--radius-sm); background: transparent;
		color: var(--text-1); font: 600 13.5px/1.3 var(--font-body); text-align: left; cursor: pointer;
	}
	.rail-toggle:hover { background: var(--surface-2); }
	.rail-toggle:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
	.rail-toggle--special { color: var(--text-2); font-weight: 500; }
	.rail-chev { color: var(--text-3); display: grid; place-items: center; transition: transform 0.15s var(--ease-out); }
	.rail-chev--open { transform: rotate(90deg); }
	.rail-dot { width: 10px; height: 10px; border-radius: 3px; }
	.rail-diamond { width: 9px; height: 9px; margin-left: 0.5px; background: var(--gold); transform: rotate(45deg); border-radius: 1px; }
	.rail-hollow { width: 10px; height: 10px; border-radius: 50%; border: 1.5px dashed var(--text-3); }
	.rail-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.rail-num { font: 400 11.5px/1 var(--font-mono); color: var(--text-3); font-variant-numeric: tabular-nums; }
	.rail-num-working { color: var(--green); }
	.rail-edit { width: 26px; height: 26px; opacity: 0; }
	.rail-row:hover .rail-edit, .rail-row--sel .rail-edit, .rail-edit:focus-visible { opacity: 1; }
	.rail-agents { list-style: none; margin: 0; padding: 2px 0 6px 28px; display: grid; gap: 1px; }
	.rail-group { padding: 12px 8px 4px; }
	.rail-foot { padding: 12px; border-top: 1px solid var(--border); }
	@media (prefers-reduced-motion: reduce) { .rail-chev { transition: none; } }
</style>
