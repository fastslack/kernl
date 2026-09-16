<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	export let open = false;
	export let width = '400px';
	/** Offset from the top of the positioned parent (the command bar height). */
	export let top = '0px';
	export let label = '';

	const dispatch = createEventDispatcher<{ close: void }>();
	const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

	function onKeydown(e: KeyboardEvent) {
		if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
		// A modal on top owns Escape.
		if (document.querySelector('.k-scrim')) return;
		dispatch('close');
	}
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
	<aside
		class="k-drawer"
		style="--k-drawer-w:{width};--k-drawer-top:{top}"
		aria-label={label || undefined}
		transition:fly={{ x: 32, duration: reduced ? 0 : 240, easing: cubicOut, opacity: 0 }}
	>
		{#if $$slots.head}<header class="k-drawer-head"><slot name="head" /></header>{/if}
		<div class="k-drawer-body"><slot /></div>
		{#if $$slots.foot}<footer class="k-drawer-foot"><slot name="foot" /></footer>{/if}
	</aside>
{/if}

<style>
	.k-drawer {
		position: absolute; top: var(--k-drawer-top); right: 0; bottom: 0; z-index: var(--z-drawer);
		width: min(var(--k-drawer-w), 100%); min-height: 0;
		display: grid; grid-template-rows: auto 1fr auto;
		background: var(--surface-1); border-left: 1px solid var(--border-h);
		box-shadow: -24px 0 48px rgba(0, 0, 0, 0.4);
	}
	.k-drawer-head { padding: 16px 16px 14px 20px; border-bottom: 1px solid var(--border); }
	.k-drawer-body { overflow-y: auto; min-height: 0; padding: 4px 20px 16px; }
	.k-drawer-foot { display: flex; justify-content: space-between; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border); }
</style>
