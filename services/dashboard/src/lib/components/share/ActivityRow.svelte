<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { t, locale } from '$lib/i18n';
	import { formatBytes, downloadUrl, type TransferView } from '$lib/share-api';
	export let tr: TransferView;
	/** Bytes per second, measured by the page between polls; 0 while unknown. */
	export let speed = 0;
	const dispatch = createEventDispatcher<{ accept: { always: boolean }; reject: void; cancel: void; retry: void; resume: void }>();
	let open = false;
	let always = false;
	let menu = false;
	let copied = false;

	$: pct = tr.total_bytes ? Math.round((tr.done_bytes / tr.total_bytes) * 100) : 0;
	$: active = ['staging', 'accepted', 'sending'].includes(tr.state);
	$: incomingPending = tr.direction === 'in' && tr.state === 'pending';

	async function copy() { await navigator.clipboard.writeText(tr.text); copied = true; setTimeout(() => (copied = false), 1500); }
</script>

<article class="row" class:pending={incomingPending}>
	<button class="main" on:click={() => (open = !open)} aria-expanded={open}>
		<span class="dir" aria-hidden="true">{tr.direction === 'in' ? '↓' : '↑'}</span>
		<span class="what">
			{#if tr.files.length}
				{$t('share.wants', { name: tr.peer_name, n: tr.files.length, size: formatBytes(tr.total_bytes, $locale) })}
			{:else}
				“{tr.text.slice(0, 80)}{tr.text.length > 80 ? '…' : ''}” · {tr.peer_name}
			{/if}
		</span>
		{#if active && tr.total_bytes}
			<span class="rate">{pct}%{#if speed > 0} · {formatBytes(Math.round(speed), $locale)}/s{/if}</span>
		{/if}
		<span class="state {tr.state}">{$t(`share.state.${tr.state}`)}</span>
	</button>

	{#if active && tr.total_bytes}
		<div class="bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"><span style="width:{pct}%"></span></div>
	{/if}
	{#if tr.error}<p class="err">{tr.error}</p>{/if}

	{#if incomingPending}
		<div class="decide">
			<button class="btn" on:click={() => dispatch('accept', { always })}>{$t('share.accept')}</button>
			<button class="btn ghost" on:click={() => dispatch('reject')}>{$t('share.reject')}</button>
			<label class="always"><input type="checkbox" bind:checked={always} /> {$t('share.always')}</label>
		</div>
	{/if}

	<div class="more">
		<button class="dots" aria-label="⋯" on:click={() => (menu = !menu)}>⋯</button>
		{#if menu}
			<div class="menu" role="menu">
				{#if tr.text}<button role="menuitem" on:click={copy}>{copied ? $t('share.copied') : $t('share.act.copy')}</button>{/if}
				{#if tr.state === 'failed' && tr.direction === 'out'}<button role="menuitem" on:click={() => dispatch('retry')}>{$t('share.act.retry')}</button>{/if}
				{#if tr.state === 'staging'}<button role="menuitem" on:click={() => dispatch('resume')}>{$t('share.act.resume')}</button>{/if}
				{#if ['staging', 'pending', 'accepted', 'sending'].includes(tr.state)}<button role="menuitem" on:click={() => dispatch('cancel')}>{$t('share.act.cancel')}</button>{/if}
			</div>
		{/if}
	</div>

	{#if open}
		<div class="detail">
			{#if tr.text}<p class="text">{tr.text}</p>{/if}
			{#each tr.files as f}
				<div class="file">
					<span class="fname">{f.name}</span><span class="fsize">{formatBytes(f.size, $locale)}</span>
					{#if tr.direction === 'in' && tr.state === 'done'}<a href={downloadUrl(tr.id, f.n)} download={f.name}>{$t('share.act.download')}</a>{/if}
				</div>
			{/each}
		</div>
	{/if}
</article>

<style>
	.row { position: relative; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); padding: 8px 44px 8px 12px; margin-bottom: 5px; }
	.row.pending { border-color: var(--teal); }
	.main { width: 100%; display: flex; gap: 10px; align-items: center; background: none; border: 0; color: var(--text-1); cursor: pointer; text-align: left; padding: 0; font: inherit; }
	.dir { font-size: 14px; color: var(--text-3); width: 14px; }
	.what { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rate { font-size: 11.5px; color: var(--text-2); font-family: var(--font-mono); white-space: nowrap; }
	.state { font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
	.state.done { color: var(--green); } .state.failed, .state.rejected { color: var(--red); } .state.pending { color: var(--orange); }
	.bar { height: 4px; background: var(--surface-3); border-radius: 2px; margin-top: 6px; overflow: hidden; }
	.bar span { display: block; height: 100%; background: var(--teal); transition: width 0.3s ease; }
	.err { margin: 6px 0 0; font-size: 12px; color: var(--orange); }
	.decide { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
	.always { font-size: 12px; color: var(--text-2); display: flex; gap: 6px; align-items: center; }
	.btn { background: var(--teal); color: var(--bg); border: 0; border-radius: 6px; padding: 6px 14px; font-weight: 700; font-size: 12.5px; cursor: pointer; }
	.btn.ghost { background: none; border: 1px solid var(--border); color: var(--text-2); font-weight: 500; }
	.more { position: absolute; top: 6px; right: 6px; }
	.dots { width: 30px; height: 30px; border-radius: 6px; border: 1px solid transparent; background: none; color: var(--text-2); cursor: pointer; font-size: 16px; }
	.dots:hover { border-color: var(--border); }
	.menu { position: absolute; right: 0; top: 32px; z-index: 20; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 4px; display: flex; flex-direction: column; min-width: 160px; }
	.menu button { background: none; border: 0; color: var(--text-1); text-align: left; padding: 7px 10px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
	.menu button:hover { background: var(--surface-3); }
	.detail { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
	.text { white-space: pre-wrap; font-size: 13px; color: var(--text-1); margin: 0 0 4px; }
	.file { display: flex; gap: 10px; font-size: 12.5px; align-items: center; }
	.fname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.fsize { color: var(--text-3); font-family: var(--font-mono); font-size: 11.5px; }
	.file a { color: var(--teal); }
</style>
