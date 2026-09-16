<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { rpcPost } from '$lib/api.js';
	import { joinHostPath } from '$lib/host-path.js';
	import { t } from '$lib/i18n/index.js';

	const dispatch = createEventDispatcher<{ change: void }>();

	/** Picked or typed path, as the kernel sees it. */
	export let value = '';
	/** Prefilled from a pick while untouched. */
	export let name = '';
	/** Directories the kernel can reach, filled by the scan. */
	export let roots: string[] = [];
	export let label = '';
	export let required = false;
	export let disabled = false;
	export let invalid = false;
	/** The wizard may point an office at a repo that is already tracked. */
	export let allowRegistered = false;

	const labelId = `k-repo-${Math.random().toString(36).slice(2, 9)}`;
	let candidates: Array<{ path: string; name: string; registered: boolean }> = [];
	let loading = false;
	let manual = false;

	export async function reload(): Promise<void> {
		manual = false;
		candidates = [];
		loading = true;
		try {
			const res = (await rpcPost('repos.candidates', {})) as { candidates?: typeof candidates; roots?: string[] };
			candidates = res?.candidates ?? [];
			roots = res?.roots ?? [];
			// Nothing pickable: typing is the honest option.
			if (candidates.filter((c) => allowRegistered || !c.registered).length === 0) manual = true;
		} catch {
			manual = true;
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void reload();
	});

	function pick(c: { path: string; name: string }) {
		value = c.path;
		if (!name.trim() || candidates.some((x) => x.name === name)) name = c.name;
		dispatch('change');
	}

	function toggleManual() {
		manual = !manual;
		dispatch('change');
	}

	$: placeholder = roots.length ? joinHostPath(roots[0], 'my-repo') : '/absolute/path/to/repo or C:\\code\\repo';
</script>

<div class="rp">
	<div class="k-label rp-head" id={labelId}>
		<span>{label}{#if required}<span class="rp-req" aria-hidden="true"> *</span>{/if}</span>
		<button type="button" class="rp-toggle" {disabled} on:click={toggleManual}>
			{manual ? $t('office.repo.pick') : $t('office.repo.type')}
		</button>
	</div>

	{#if loading && !manual}
		<p class="k-help">{$t('office.repo.scanning')}</p>
	{:else if manual || candidates.length === 0}
		<input class="k-input rp-mono" type="text" aria-labelledby={labelId} aria-invalid={invalid} {placeholder} bind:value {disabled} spellcheck="false" />
		<p class="k-help">
			{#if roots.length}{$t('office.repo.reach', { roots: roots.join(', ') })}{:else}{$t(manual ? 'office.repo.absolute' : 'office.repo.none')}{/if}
		</p>
	{:else}
		<div class="rp-list" role="radiogroup" aria-labelledby={labelId} aria-invalid={invalid}>
			{#each candidates as c (c.path)}
				<button
					type="button"
					class="rp-cand"
					class:rp-cand--on={value === c.path}
					role="radio"
					aria-checked={value === c.path}
					disabled={disabled || (c.registered && !allowRegistered)}
					title={c.registered ? $t('office.repo.registered') : c.path}
					on:click={() => pick(c)}
				>
					<span class="rp-name">{c.name}</span>
					<span class="rp-path">{c.path}</span>
					{#if c.registered}<span class="rp-tag">{$t('office.repo.registered')}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.rp { display: grid; gap: 6px; }
	.rp-head { justify-content: space-between; }
	.rp-req { color: var(--red); }
	.rp-toggle { background: none; border: 0; padding: 0; color: var(--teal); font: 600 12px/1 var(--font-body); cursor: pointer; }
	.rp-toggle:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
	.rp-mono { font-family: var(--font-mono); font-size: 12.5px; }
	.rp-list { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; }
	.rp-cand {
		display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; padding: 7px 9px; cursor: pointer;
		border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-1);
	}
	.rp-cand:hover:not(:disabled) { border-color: var(--border-h); background: var(--surface-3); }
	.rp-cand--on { border-color: var(--teal); background: color-mix(in srgb, var(--teal) 10%, var(--surface-2)); }
	.rp-cand:disabled { opacity: 0.45; cursor: not-allowed; }
	.rp-cand:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
	.rp-name { font: 600 12px/1.2 var(--font-body); flex: none; }
	.rp-path { font: 400 10.5px/1.3 var(--font-mono); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
	.rp-tag { font: 600 9px/1 var(--font-body); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); flex: none; }
</style>
