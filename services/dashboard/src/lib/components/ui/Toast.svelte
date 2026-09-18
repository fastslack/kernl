<script lang="ts">
	import { createEventDispatcher, onDestroy } from 'svelte';
	import { fly } from 'svelte/transition';
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.js';

	export let message = '';
	export let kind: 'success' | 'error' | 'info' = 'success';
	export let actionLabel = '';
	/** Milliseconds before it dismisses itself; 0 keeps it until dismissed. */
	export let duration = 5000;

	const dispatch = createEventDispatcher<{ action: void; dismiss: void }>();
	const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	let timer: ReturnType<typeof setTimeout> | null = null;

	$: schedule(message, duration);

	function schedule(msg: string, ms: number) {
		if (timer) clearTimeout(timer);
		timer = null;
		if (msg && ms > 0) timer = setTimeout(() => dispatch('dismiss'), ms);
	}

	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});
</script>

{#if message}
	<div
		class="k-toast k-toast--{kind}"
		role={kind === 'error' ? 'alert' : 'status'}
		aria-live={kind === 'error' ? 'assertive' : 'polite'}
		transition:fly={{ y: -8, duration: reduced ? 0 : 180 }}
	>
		<Icon name={kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info'} />
		<span class="k-toast-msg">{message}</span>
		{#if actionLabel}
			<button class="k-btn" type="button" on:click={() => dispatch('action')}>{actionLabel}</button>
		{/if}
		<button class="k-icon-btn" type="button" aria-label={$t('office.common.close')} on:click={() => dispatch('dismiss')}>
			<Icon name="x" size={14} />
		</button>
	</div>
{/if}

<style>
	.k-toast {
		position: absolute; top: 68px; left: 50%; transform: translateX(-50%); z-index: var(--z-toast);
		display: flex; align-items: center; gap: 10px; max-width: min(560px, calc(100% - 32px));
		padding: 6px 6px 6px 14px; border-radius: var(--radius);
		background: var(--surface-3); border: 1px solid var(--border-h); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
		font-size: 13px; color: var(--text-1);
	}
	.k-toast--success :global(.k-svg-icon:first-child) { color: var(--green); }
	.k-toast--error :global(.k-svg-icon:first-child) { color: var(--red); }
	.k-toast--info :global(.k-svg-icon:first-child) { color: var(--teal); }
	.k-toast-msg { flex: 1; min-width: 0; }
</style>
