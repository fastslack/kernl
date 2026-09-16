<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { t } from '$lib/i18n/index.js';
	import { placeMenu, type MenuPlacement } from '$lib/office/menu-placement.js';
	import type { RailAgent } from '$lib/office/rail-model.js';

	export let agent: RailAgent;
	export let selected = false;
	export let moveTargets: Array<{ id: string; name: string; color: string }> = [];
	export let menuOpen = false;

	const dispatch = createEventDispatcher<{
		select: void;
		menu: void;
		move: { flowId: string };
		dragstart: DragEvent;
		dragend: void;
		navkey: KeyboardEvent;
	}>();

	const MENU_WIDTH = 200;
	let moreBtn: HTMLButtonElement | undefined;
	let menuPos: MenuPlacement = { top: 0, left: 0, flipped: false };

	// Fixed position so `.rail-list`'s overflow cannot clip it; flips up near the bottom.
	$: menuHeight = Math.min(320, 40 + moveTargets.length * 32);
	$: if (menuOpen && moreBtn) {
		menuPos = placeMenu(moreBtn.getBoundingClientRect(), { width: MENU_WIDTH, height: menuHeight }, { width: window.innerWidth, height: window.innerHeight });
	}
</script>

<div class="ra" class:ra--sel={selected}>
	<button
		class="ra-main"
		type="button"
		data-rail-item
		draggable="true"
		aria-current={selected ? 'true' : undefined}
		on:click={() => dispatch('select')}
		on:keydown={(e) => dispatch('navkey', e)}
		on:dragstart={(e) => dispatch('dragstart', e)}
		on:dragend={() => dispatch('dragend')}
	>
		<span class="ra-rank">
			{#if agent.lead}<Icon name="star" size={12} filled label={$t('office.rail.lead')} />{/if}
		</span>
		<span class="ra-name">{agent.name}</span>
		{#if agent.state !== 'idle'}
			<span class="k-state k-state--{agent.state}">
				<span class="k-led k-led--{agent.state}" aria-hidden="true"></span>{$t(`office.state.${agent.state}`)}
			</span>
		{/if}
	</button>
	{#if moveTargets.length > 0}
		<button
			bind:this={moreBtn}
			class="k-icon-btn ra-more"
			type="button"
			aria-haspopup="menu"
			aria-expanded={menuOpen}
			aria-label={$t('office.rail.move_agent', { name: agent.name })}
			on:click|stopPropagation={() => dispatch('menu')}
		>
			<Icon name="more" size={14} />
		</button>
	{/if}
	{#if menuOpen}
		<div class="ra-menu" class:ra-menu--up={menuPos.flipped} role="menu" style="top:{menuPos.top}px;left:{menuPos.left}px;max-height:{menuHeight}px">
			<p class="k-section-title ra-menu-title">{$t('office.rail.move_to')}</p>
			{#each moveTargets as office (office.id)}
				<button class="ra-menu-item" type="button" role="menuitem" on:click|stopPropagation={() => dispatch('move', { flowId: office.id })}>
					<span class="ra-dot" style="background:{office.color}"></span>{office.name}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.ra { position: relative; display: flex; align-items: center; gap: 2px; }
	.ra-main {
		flex: 1; min-width: 0; display: grid; grid-template-columns: 14px 1fr auto; align-items: center; gap: 8px;
		padding: 5px 8px; border: 0; border-radius: var(--radius-sm); background: transparent;
		color: var(--text-2); font: 500 13px/1.3 var(--font-body); text-align: left; cursor: pointer;
	}
	.ra-main:hover { background: var(--surface-2); color: var(--text-1); }
	.ra-main:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
	.ra--sel .ra-main { background: var(--surface-3); color: var(--text-1); }
	.ra-rank { color: var(--gold); display: grid; place-items: center; }
	.ra-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.ra-more { width: 26px; height: 26px; opacity: 0; }
	.ra:hover .ra-more, .ra-more:focus-visible, .ra-more[aria-expanded='true'] { opacity: 1; }
	.ra-menu {
		position: fixed; z-index: var(--z-modal); width: 200px; padding: 6px; overflow-y: auto;
		display: grid; align-content: start; gap: 2px; background: var(--surface-2); border: 1px solid var(--border-h); border-radius: var(--radius);
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
	}
	.ra-menu--up { box-shadow: 0 -12px 30px rgba(0, 0, 0, 0.45); }
	.ra-menu-title { padding: 4px 6px 6px; }
	.ra-menu-item {
		display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 0; border-radius: 4px;
		background: transparent; color: var(--text-1); font: 500 13px/1.2 var(--font-body); text-align: left; cursor: pointer;
	}
	.ra-menu-item:hover, .ra-menu-item:focus-visible { background: var(--surface-3); outline: none; }
	.ra-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
</style>
