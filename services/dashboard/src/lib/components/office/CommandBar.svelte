<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { t } from '$lib/i18n/index.js';

	export let agents = 0;
	export let working = 0;
	export let runsToday = 0;
	export let inbox = 0;
	/** View-menu entries offered by world plugins (extension buildings), e.g. hide a roof. */
	export let extraItems: Array<{ id: string; label: string }> = [];
	/** Whether the Message Stream bar at the bottom is shown (toggled from the View menu). */
	export let streamVisible = true;

	const dispatch = createEventDispatcher<{
		newoffice: void;
		meeting: void;
		activity: void;
		fit: void;
		turntable: void;
		perf: void;
		stream: void;
		extra: { id: string };
		inbox: void;
		registerrepo: void;
	}>();

	let openMenu: 'view' | null = null;

	function toggleMenu(menu: 'view') {
		openMenu = openMenu === menu ? null : menu;
	}

	function pick(action: () => void) {
		openMenu = null;
		action();
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (openMenu && e.key === 'Escape') {
			e.preventDefault();
			openMenu = null;
		}
	}
</script>

<svelte:window on:click={() => (openMenu = null)} on:keydown={onWindowKeydown} />

<header class="bar" class:bar--menu-open={openMenu !== null}>
	<h1 class="bar-title">{$t('office.bar.title')}</h1>
	<p class="bar-stats">
		<span><b>{agents}</b> {$t(agents === 1 ? 'office.bar.agent' : 'office.bar.agents')}</span>
		<span class="bar-working"><b>{working}</b> {$t('office.bar.working')}</span>
		<span><b>{runsToday}</b> {$t('office.bar.runs_today')}</span>
	</p>

	<div class="bar-actions">
		<button class="k-icon-btn bar-inbox" type="button" aria-label={$t('office.bar.inbox', { n: inbox })} on:click={() => dispatch('inbox')}>
			<Icon name="inbox" />
			{#if inbox > 0}<span class="bar-badge" aria-hidden="true">{inbox}</span>{/if}
		</button>
		<span class="bar-sep" aria-hidden="true"></span>

		<button class="k-btn k-btn--ghost" type="button" on:click={() => dispatch('meeting')}>
			<Icon name="users" />{$t('office.bar.meeting')}<kbd class="k-kbd">R</kbd>
		</button>

		<button class="k-btn k-btn--ghost" type="button" on:click={() => dispatch('activity')}>
			<Icon name="activity" />{$t('office.bar.activity')}
		</button>

		<div class="bar-menu">
			<button class="k-btn k-btn--ghost" type="button" aria-haspopup="menu" aria-expanded={openMenu === 'view'} on:click|stopPropagation={() => toggleMenu('view')}>
				<Icon name="eye" />{$t('office.bar.view')}<Icon name="chev-d" size={14} />
			</button>
			{#if openMenu === 'view'}
				<div class="bar-pop bar-pop--right" role="menu">
					<button class="bar-pop-item bar-pop-item--row" type="button" role="menuitem" on:click|stopPropagation={() => pick(() => dispatch('fit'))}>
						<Icon name="fit" /><span>{$t('office.bar.view_fit')}</span><kbd class="k-kbd">F</kbd>
					</button>
					<button class="bar-pop-item bar-pop-item--row" type="button" role="menuitem" on:click|stopPropagation={() => pick(() => dispatch('turntable'))}>
						<Icon name="move" /><span>{$t('office.bar.view_turntable')}</span>
					</button>
					<button class="bar-pop-item bar-pop-item--row" type="button" role="menuitem" on:click|stopPropagation={() => pick(() => dispatch('perf'))}>
						<Icon name="activity" /><span>{$t('office.bar.view_perf')}</span><kbd class="k-kbd">⇧P</kbd>
					</button>
					<button class="bar-pop-item bar-pop-item--row" type="button" role="menuitemcheckbox" aria-checked={streamVisible} on:click|stopPropagation={() => pick(() => dispatch('stream'))}>
						<Icon name="eye" /><span>{$t('office.bar.view_stream')}</span><span class="bar-check" aria-hidden="true">{streamVisible ? '✓' : ''}</span>
					</button>
					{#each extraItems as item (item.id)}
						<button class="bar-pop-item bar-pop-item--row" type="button" role="menuitem" on:click|stopPropagation={() => pick(() => dispatch('extra', { id: item.id }))}>
							<Icon name="eye" /><span>{item.label}</span>
						</button>
					{/each}
					<button class="bar-pop-item bar-pop-item--row" type="button" role="menuitem" on:click|stopPropagation={() => pick(() => dispatch('registerrepo'))}>
						<Icon name="plus" /><span>{$t('office.bar.register_repo')}</span>
					</button>
					<a class="bar-pop-item bar-pop-item--row" href="/repos" role="menuitem" on:click={() => (openMenu = null)}>
						<Icon name="branch" /><span>{$t('office.bar.repos')}</span>
					</a>
				</div>
			{/if}
		</div>

		<span class="bar-sep" aria-hidden="true"></span>
		<button class="k-btn bar-new" type="button" on:click={() => dispatch('newoffice')}>
			<Icon name="plus" />{$t('office.bar.new_office')}<kbd class="k-kbd bar-new-kbd">N</kbd>
		</button>
	</div>
</header>

<style>
	.bar {
		min-height: 64px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 20px; z-index: var(--z-chrome);
		background: color-mix(in srgb, var(--surface-1) 92%, transparent); border-bottom: 1px solid var(--border);
	}
	/* The bar is its own stacking context; lift it while a menu is open so the menu paints above the drawer. */
	.bar--menu-open { z-index: var(--z-modal); }
	.bar-title { margin: 0; font: 600 18px/1.2 var(--font-display); color: var(--text-1); }
	.bar-stats { margin: 0; display: flex; gap: 12px; font: 400 12px/1.4 var(--font-body); color: var(--text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
	.bar-stats b { color: var(--text-1); font-weight: 500; }
	.bar-working b { color: var(--green); }
	.bar-actions { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
	.bar-inbox { position: relative; }
	.bar-badge {
		position: absolute; top: 2px; right: 1px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
		display: grid; place-items: center; background: var(--text-2); color: var(--bg); font: 500 10px/1 var(--font-mono);
	}
	.bar-sep { width: 1px; height: 20px; margin: 0 6px; background: var(--border-h); }
	.bar-menu { position: relative; }
	.bar-pop {
		position: absolute; top: calc(100% + 6px); left: 0; z-index: var(--z-drawer); min-width: 240px; padding: 6px;
		display: grid; gap: 2px; background: var(--surface-2); border: 1px solid var(--border-h); border-radius: var(--radius);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
	}
	.bar-pop--right { left: auto; right: 0; }
	.bar-pop-item {
		display: grid; gap: 2px; padding: 8px 10px; border: 0; border-radius: 6px; background: transparent;
		color: var(--text-1); font: 600 13px/1.3 var(--font-body); text-align: left; cursor: pointer;
	}
	a.bar-pop-item { text-decoration: none; }
	.bar-pop-item--row { grid-template-columns: 16px 1fr auto; align-items: center; gap: 10px; font-weight: 500; }
	.bar-pop-item:hover, .bar-pop-item:focus-visible { background: var(--surface-3); outline: none; }
	.bar-new {
		color: var(--bg); border: 1px solid var(--gold); background: var(--gold);
		font-weight: 700; box-shadow: 0 2px 6px rgb(0 0 0 / 15%);
		transition: filter .15s;
	}
	.bar-new:hover { background: var(--gold); border-color: var(--gold); filter: brightness(1.08); }
	.bar-new-kbd { color: inherit; background: transparent; border-color: currentColor; opacity: .65; }
	@media (max-width: 700px) {
		.bar { padding: 12px; gap: 10px; }
		.bar-actions { width: 100%; margin-left: 0; }
		.bar-actions :global(.k-btn), .bar-actions :global(.k-icon-btn) { min-height: 40px; }
		.bar-sep, .bar-actions :global(kbd) { display: none; }
		.bar-pop { min-width: 210px; }
	}
	@media (prefers-reduced-motion: reduce) { .bar-new { transition: none; } }
	@media (max-width: 1100px) { .bar-stats { display: none; } }
	.bar-check { margin-left: auto; min-width: 1em; color: var(--teal); font-weight: 700; text-align: right; }
</style>
