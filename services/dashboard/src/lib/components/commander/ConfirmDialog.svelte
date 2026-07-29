<script lang="ts">
	/**
	 * Generic confirm/input dialog.
	 *
	 * Use as:
	 *   <ConfirmDialog
	 *     title="Delete selection"
	 *     message="This will remove 4 entries, including 1 directory."
	 *     confirmLabel="Delete"
	 *     variant="danger"
	 *     requireTypeYes
	 *     on:confirm={doDelete}
	 *     on:cancel={close}
	 *   />
	 *
	 * For a prompt, pass `inputLabel` + `initialValue`; the `confirm` event
	 * detail carries `{value}`.
	 */
	import { createEventDispatcher, onMount } from 'svelte';

	export let title: string;
	export let message = '';
	export let confirmLabel = 'OK';
	export let cancelLabel = 'Cancel';
	export let variant: 'primary' | 'danger' = 'primary';
	export let inputLabel: string | null = null;
	export let initialValue = '';
	export let requireTypeYes = false;

	let value = initialValue;
	let typedYes = '';
	let inputEl: HTMLInputElement | null = null;

	const dispatch = createEventDispatcher<{
		confirm: { value: string };
		cancel: undefined;
	}>();

	$: canConfirm = requireTypeYes ? typedYes.trim().toLowerCase() === 'yes' : true;

	function onKey(ev: KeyboardEvent) {
		if (ev.key === 'Escape') {
			dispatch('cancel');
		} else if (ev.key === 'Enter' && !ev.shiftKey && canConfirm) {
			ev.preventDefault();
			dispatch('confirm', { value });
		}
	}

	onMount(() => {
		setTimeout(() => inputEl?.focus(), 10);
	});
</script>

<div
	class="cmd-overlay"
	on:click|self={() => dispatch('cancel')}
	on:keydown={onKey}
	role="dialog"
	aria-modal="true"
>
	<div class="cmd-dialog">
		<div class="cmd-dialog-header">{title}</div>
		<div class="cmd-dialog-body">
			{#if message}<p style="margin:0 0 8px;color:var(--text-2);font-size:12px">{message}</p>{/if}
			{#if inputLabel !== null}
				<label style="color:var(--text-2);font-size:11px;text-transform:uppercase;letter-spacing:0.05em">{inputLabel}</label>
				<input bind:value bind:this={inputEl} on:keydown={onKey} />
			{/if}
			{#if requireTypeYes}
				<label style="color:var(--red);font-size:11px;margin-top:12px;display:block">Type <b>yes</b> to confirm</label>
				<input bind:value={typedYes} placeholder="yes" on:keydown={onKey} />
			{/if}
		</div>
		<div class="cmd-dialog-foot">
			<button on:click={() => dispatch('cancel')}>{cancelLabel}</button>
			<button
				class={variant}
				disabled={!canConfirm}
				on:click={() => dispatch('confirm', { value })}
			>
				{confirmLabel}
			</button>
		</div>
	</div>
</div>
