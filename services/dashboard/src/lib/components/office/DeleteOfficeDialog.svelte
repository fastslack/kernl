<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import { t } from '$lib/i18n/index.js';
	import { deleteOffice } from '$lib/office/office-api.js';
	import { errorMessage } from '$lib/office/office-errors.js';

	export let open = false;
	export let officeId: string;
	export let officeName: string;
	export let agentCount = 0;

	const dispatch = createEventDispatcher<{ close: void; deleted: { unassigned: number; flowId: string } }>();
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
			dispatch('deleted', { ...(await deleteOffice(officeId)), flowId: officeId });
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}
</script>

<Modal {open} title={$t('office.panel.delete_title', { name: officeName })} width="460px" on:close>
	<div class="dd">
		<div class="dd-warn" role="note">
			<span class="dd-blast" aria-hidden="true">💥</span>
			<div>
				<strong>{$t('office.panel.delete_warn')}</strong>
				<ul>
					<li>{$t('office.panel.delete_blast')}</li>
					<li>{$t('office.panel.delete_body', { n: agentCount })}</li>
					<li>{$t('office.panel.delete_lot')}</li>
				</ul>
			</div>
		</div>
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
			<span aria-hidden="true">💥</span>{$t('office.panel.delete_confirm')}
		</button>
	</svelte:fragment>
</Modal>

<style>
	.dd { display: grid; gap: 14px; }
	.dd-warn { display: flex; gap: 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--red, #e5484d) 45%, var(--border)); background: color-mix(in srgb, var(--red, #e5484d) 10%, var(--surface-1)); }
	.dd-warn strong { display: block; color: var(--text-1); font-size: 13.5px; margin-bottom: 6px; }
	.dd-warn ul { margin: 0; padding-left: 18px; color: var(--text-2); font-size: 13px; line-height: 1.55; }
	.dd-blast { font-size: 24px; line-height: 1; }
	.dd-spacer { flex: 1; }
</style>
