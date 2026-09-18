<script lang="ts">
	import { createEventDispatcher, onDestroy, tick } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.js';

	export let open = false;
	export let title = '';
	export let width = '560px';

	const dispatch = createEventDispatcher<{ close: void }>();
	const titleId = `k-modal-${Math.random().toString(36).slice(2, 9)}`;
	const FOCUSABLE =
		'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
	const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	const ms = (n: number) => (reduced ? 0 : n);

	let dialog: HTMLDivElement | undefined;
	let body: HTMLDivElement | undefined;
	let closeBtn: HTMLButtonElement | undefined;
	let opener: HTMLElement | null = null;
	let wasOpen = false;

	$: if (open !== wasOpen) {
		wasOpen = open;
		if (open) void focusInside();
		else restoreFocus();
	}

	async function focusInside() {
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		await tick();
		// The dialog's own field first ([autofocus], then the first focusable in the
		// body); the header close button only when the body has nothing to focus.
		const target =
			body?.querySelector<HTMLElement>('[autofocus]') ??
			body?.querySelector<HTMLElement>(FOCUSABLE) ??
			closeBtn ??
			dialog;
		target?.focus();
	}

	function restoreFocus() {
		opener?.focus?.();
		opener = null;
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			dispatch('close');
			return;
		}
		if (e.key !== 'Tab' || !dialog) return;
		const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
		if (items.length === 0) return;
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	onDestroy(() => {
		if (open) restoreFocus();
	});
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
	<div class="k-scrim" transition:fade={{ duration: ms(160) }} on:click|self={() => dispatch('close')} role="presentation">
		<div
			bind:this={dialog}
			class="k-modal"
			style="--k-modal-w:{width}"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			tabindex="-1"
			in:scale={{ duration: ms(200), start: 0.97, easing: cubicOut }}
			out:fade={{ duration: ms(120) }}
		>
			<header class="k-modal-head">
				<h2 id={titleId}>{title}</h2>
				<div class="k-modal-extra"><slot name="header" /></div>
				<button bind:this={closeBtn} class="k-icon-btn" type="button" aria-label={$t('office.common.close')} on:click={() => dispatch('close')}>
					<Icon name="x" />
				</button>
			</header>
			<div class="k-modal-body" bind:this={body}><slot /></div>
			{#if $$slots.footer}
				<footer class="k-modal-foot"><slot name="footer" /></footer>
			{/if}
		</div>
	</div>
{/if}

<style>
	.k-scrim {
		position: fixed; inset: 0; z-index: var(--z-modal);
		display: grid; place-items: center; padding: 24px;
		background: rgba(4, 5, 8, 0.62); backdrop-filter: blur(3px);
	}
	.k-modal {
		width: min(var(--k-modal-w), 100%); max-height: calc(100vh - 48px);
		display: grid; grid-template-rows: auto 1fr auto; overflow: hidden; outline: none;
		background: var(--surface-1); border: 1px solid var(--border-h); border-radius: 14px;
		box-shadow: 0 32px 80px rgba(0, 0, 0, 0.6);
	}
	.k-modal-head { display: flex; align-items: center; gap: 16px; padding: 16px 16px 16px 24px; border-bottom: 1px solid var(--border); }
	.k-modal-head h2 { margin: 0; font: 600 18px/1.2 var(--font-display); color: var(--text-1); white-space: nowrap; }
	.k-modal-extra { flex: 1; display: flex; justify-content: flex-end; min-width: 0; }
	.k-modal-body { overflow-y: auto; padding: 20px 24px; min-height: 0; }
	.k-modal-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px 12px 24px; border-top: 1px solid var(--border); }
</style>
