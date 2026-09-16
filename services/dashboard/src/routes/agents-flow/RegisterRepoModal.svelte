<script lang="ts">
	/**
	 * Register-repo modal — track an existing local checkout. Opened through
	 * `open()` by the world (a FREE rack in the Repos office) and by the
	 * command bar's View menu. `onRegistered` is awaited before the modal
	 * closes, so the rack flips from FREE to OCCUPIED while the form is up.
	 */
	import Modal from '$lib/components/ui/Modal.svelte';
	import Toast from '$lib/components/ui/Toast.svelte';
	import RepoPicker from '$lib/components/office/RepoPicker.svelte';
	import { rpcPost } from '$lib/api.js';
	import { isAbsoluteHostPath } from '$lib/host-path.js';
	import { t } from '$lib/i18n/index.js';

	/** Run after `repos.register` succeeds and before the modal closes. */
	export let onRegistered: (name: string) => void | Promise<void> = () => {};

	const uid = `k-repo-reg-${Math.random().toString(36).slice(2, 9)}`;
	let isOpen = false;
	let name = '';
	let path = '';
	let description = '';
	let tags = '';
	let shared = true;
	let agentIds: string[] = [];
	let roots: string[] = [];
	let busy = false;
	let error = '';
	/** Which field the error belongs to, so it sits under that field. */
	let errorField: 'name' | 'path' | '' = '';
	let done = '';

	/** The only way in. The picker scans candidates when the modal mounts it. */
	export function open(): void {
		name = '';
		path = '';
		description = '';
		tags = '';
		shared = true;
		agentIds = [];
		error = '';
		errorField = '';
		busy = false;
		isOpen = true;
	}

	function close(): void {
		if (busy) return;
		isOpen = false;
	}

	async function submit(): Promise<void> {
		const cleanName = name.trim();
		const cleanPath = path.trim();
		if (!cleanName) { error = $t('office.repo.name_required'); errorField = 'name'; return; }
		if (!isAbsoluteHostPath(cleanPath)) { error = $t('office.repo.path_required'); errorField = 'path'; return; }
		busy = true;
		error = '';
		errorField = '';
		try {
			const args: Record<string, unknown> = { name: cleanName, path: cleanPath, shared };
			if (description.trim()) args.description = description.trim();
			if (tags.trim()) args.tags = tags.trim();
			if (!shared) args.agents = agentIds;
			await rpcPost('repos.register', args);
			await onRegistered(cleanName);
			busy = false;
			isOpen = false;
			done = $t('office.repo.registered_toast', { name: cleanName });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			error = msg;
			// The server answers in prose; park the message under the field it is about.
			errorField = /name/i.test(msg) && !/path/i.test(msg) ? 'name' : 'path';
		} finally {
			busy = false;
		}
	}

	function onAgentsInput(e: Event): void {
		agentIds = (e.currentTarget as HTMLInputElement).value.split(',').map((v) => v.trim()).filter(Boolean);
	}

	function clearError(): void {
		error = '';
		errorField = '';
	}
</script>

<Modal open={isOpen} title={$t('office.repo.register_title')} width="520px" on:close={close}>
	<form class="rr" id={uid} on:submit|preventDefault={submit}>
		<p class="k-help">{$t('office.repo.register_sub')}</p>

		<div class="k-field">
			<label class="k-label" for="{uid}-name">{$t('office.repo.name')}<span class="rr-req" aria-hidden="true">*</span></label>
			<input id="{uid}-name" class="k-input" bind:value={name} placeholder={$t('office.repo.name_ph')} required disabled={busy}
				aria-invalid={errorField === 'name'} aria-describedby={errorField === 'name' ? `${uid}-err` : undefined} />
			{#if errorField === 'name'}<p class="k-error" id="{uid}-err" role="alert">{error}</p>{/if}
		</div>

		<RepoPicker bind:value={path} bind:name bind:roots label={$t('office.repo.path')} required disabled={busy}
			invalid={errorField === 'path'} on:change={clearError} />
		{#if errorField === 'path'}<p class="k-error" role="alert">{error}</p>{/if}

		<div class="k-field">
			<span class="k-label" id="{uid}-scope">{$t('office.repo.scope')}</span>
			<div class="rr-scope" role="radiogroup" aria-labelledby="{uid}-scope">
				<button type="button" class="rr-scope-opt" role="radio" aria-checked={shared} disabled={busy} on:click={() => (shared = true)}>
					<span class="rr-scope-t">{$t('office.repo.scope_any')}</span>
					<span class="rr-scope-s">{$t('office.repo.scope_any_help')}</span>
				</button>
				<button type="button" class="rr-scope-opt" role="radio" aria-checked={!shared} disabled={busy} on:click={() => (shared = false)}>
					<span class="rr-scope-t">{$t('office.repo.scope_some')}</span>
					<span class="rr-scope-s">{$t('office.repo.scope_some_help')}</span>
				</button>
			</div>
		</div>

		{#if !shared}
			<div class="k-field">
				<label class="k-label" for="{uid}-agents">{$t('office.repo.agents')} <span class="rr-hint">({$t('office.repo.agents_hint')})</span></label>
				<input id="{uid}-agents" class="k-input" placeholder={$t('office.repo.agents_ph')} value={agentIds.join(', ')} on:input={onAgentsInput} disabled={busy} />
				{#if agentIds.length === 0}<p class="k-help rr-warn">{$t('office.repo.agents_none')}</p>{/if}
			</div>
		{/if}

		<div class="k-field">
			<label class="k-label" for="{uid}-desc">{$t('office.repo.description')} <span class="rr-hint">({$t('office.repo.optional')})</span></label>
			<input id="{uid}-desc" class="k-input" bind:value={description} disabled={busy} />
		</div>

		<div class="k-field">
			<label class="k-label" for="{uid}-tags">{$t('office.repo.tags')} <span class="rr-hint">({$t('office.repo.tags_hint')})</span></label>
			<input id="{uid}-tags" class="k-input" placeholder={$t('office.repo.tags_ph')} bind:value={tags} disabled={busy} />
		</div>

		{#if error && !errorField}<p class="k-error" role="alert">{error}</p>{/if}
	</form>

	<svelte:fragment slot="footer">
		<span class="rr-spacer"></span>
		<button class="k-btn k-btn--ghost" type="button" disabled={busy} on:click={close}>{$t('office.common.cancel')}</button>
		<button class="k-btn k-btn--primary" type="submit" form={uid} disabled={busy || !name.trim() || !path.trim()}>
			{busy ? $t('office.repo.registering') : $t('office.repo.register')}
		</button>
	</svelte:fragment>
</Modal>

<Toast message={done} kind="success" on:dismiss={() => (done = '')} />

<style>
	.rr { display: grid; gap: 14px; }
	.rr-req { color: var(--red); }
	.rr-hint { font-weight: 400; color: var(--text-3); }
	.rr-warn { color: var(--orange); }
	.rr-scope { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
	.rr-scope-opt {
		display: grid; gap: 2px; padding: 8px 10px; text-align: left; cursor: pointer;
		border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-1);
	}
	.rr-scope-opt:hover:not(:disabled) { border-color: var(--border-h); }
	.rr-scope-opt[aria-checked='true'] { border-color: var(--teal); background: color-mix(in srgb, var(--teal) 10%, var(--surface-2)); }
	.rr-scope-opt:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
	.rr-scope-t { font: 600 12.5px/1.3 var(--font-body); }
	.rr-scope-s { font: 400 11.5px/1.4 var(--font-body); color: var(--text-2); }
	.rr-spacer { flex: 1; }
</style>
