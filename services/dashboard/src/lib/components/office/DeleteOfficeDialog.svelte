<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { t } from '$lib/i18n/index.js';
	import { deleteOffice } from '$lib/office/office-api.js';
	import { errorMessage } from '$lib/office/office-errors.js';

	export let open = false;
	export let officeId: string;
	export let officeName: string;
	export let agentCount = 0;

	const dispatch = createEventDispatcher<{ close: void; deleted: { unassigned: number } }>();
	const inputId = `k-delete-${Math.random().toString(36).slice(2, 9)}`;

	let typed = '';
	let busy = false;
	let error = '';

	$: if (!open) {
		typed = '';
		error = '';
		busy = false;
	}
	$: matches = typed.trim() === officeName.trim();

	async function confirmDelete() {
		if (!matches || busy) return;
		busy = true;
		error = '';
		try {
			dispatch('deleted', await deleteOffice(officeId));
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}
</script>

<Modal {open} title={$t('office.panel.delete_title', { name: officeName })} width="460px" on:close>
	<div class="dd">
		<p class="dd-body">{$t('office.panel.delete_body', { n: agentCount })}</p>
		<div class="k-field">
			<label class="k-label" for={inputId}>{$t('office.panel.delete_type')}</label>
			<input
				id={inputId}
				class="k-input"
				bind:value={typed}
				autocomplete="off"
				on:keydown={(e) => { if (e.key === 'Enter') void confirmDelete(); }}
			/>
		</div>
		{#if error}<p class="k-error" role="alert">{error}</p>{/if}
	</div>
	<svelte:fragment slot="footer">
		<span class="dd-spacer"></span>
		<button class="k-btn k-btn--ghost" type="button" on:click={() => dispatch('close')}>{$t('office.common.cancel')}</button>
		<button class="k-btn k-btn--danger" type="button" disabled={!matches || busy} on:click={confirmDelete}>
			<Icon name="trash" />{$t('office.panel.delete_confirm')}
		</button>
	</svelte:fragment>
</Modal>

<style>
	.dd { display: grid; gap: 14px; }
	.dd-body { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.55; }
	.dd-spacer { flex: 1; }
</style>
