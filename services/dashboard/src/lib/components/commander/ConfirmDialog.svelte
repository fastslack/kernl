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
	/**
	 * What to preselect when the input takes focus. `basename` selects the name
	 * without its extension — the rename case, where retyping ".tar.gz" every
	 * time is pure friction.
	 */
	export let selectRange: 'all' | 'basename' = 'all';
	/** Optional validator; a returned string blocks confirm and is shown inline. */
	export let validate: ((value: string) => string | null) | null = null;

	let value = initialValue;
	let typedYes = '';
	let inputEl: HTMLInputElement | null = null;

	/* Unique ids so each label actually points at its control. */
	const uid = Math.random().toString(36).slice(2, 9);
	const inputId = `cmd-dlg-input-${uid}`;
	const yesId = `cmd-dlg-yes-${uid}`;
	const errId = `cmd-dlg-err-${uid}`;

	const dispatch = createEventDispatcher<{
		confirm: { value: string };
		cancel: undefined;
	}>();

	$: validationError = validate && inputLabel !== null ? validate(value) : null;
	$: canConfirm =
		!validationError && (requireTypeYes ? typedYes.trim().toLowerCase() === 'yes' : true);

	function onKey(ev: KeyboardEvent) {
		if (ev.key === 'Escape') {
			dispatch('cancel');
		} else if (ev.key === 'Enter' && !ev.shiftKey && canConfirm) {
			ev.preventDefault();
			dispatch('confirm', { value });
		}
	}

	onMount(() => {
		setTimeout(() => {
			inputEl?.focus();
			if (!inputEl) return;
			if (selectRange === 'basename') {
				// Leading dot means a dotfile, not an extension: ".bashrc" selects whole.
				const dot = value.lastIndexOf('.');
				if (dot > 0) inputEl.setSelectionRange(0, dot);
				else inputEl.select();
			} else {
				inputEl.select();
			}
		}, 10);
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
				<label
					for={inputId}
					style="color:var(--text-2);font-size:11px;text-transform:uppercase;letter-spacing:0.05em"
					>{inputLabel}</label
				>
				<input
					id={inputId}
					bind:value
					bind:this={inputEl}
					spellcheck="false"
					autocomplete="off"
					aria-invalid={validationError ? 'true' : undefined}
					aria-describedby={validationError ? errId : undefined}
					on:keydown={onKey}
				/>
				{#if validationError}
					<p id={errId} class="cmd-dialog-err" role="alert">{validationError}</p>
				{/if}
			{/if}
			{#if requireTypeYes}
				<label for={yesId} style="color:var(--red);font-size:11px;margin-top:12px;display:block"
					>Type <b>yes</b> to confirm</label
				>
				<input id={yesId} bind:value={typedYes} placeholder="yes" on:keydown={onKey} />
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
