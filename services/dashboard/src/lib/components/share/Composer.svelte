<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { t, locale } from '$lib/i18n';
	import { formatBytes } from '$lib/share-api';
	export let friendName = '';
	export let offline = false;
	export let busy = false;
	export let progress = 0;
	let text = '';
	let files: File[] = [];
	let dragging = false;
	let input: HTMLInputElement;
	const dispatch = createEventDispatcher<{ send: { text: string; files: File[] } }>();

	$: total = files.reduce((a, f) => a + f.size, 0);
	$: canSend = !busy && (text.trim().length > 0 || files.length > 0);

	function add(list: FileList | null) { if (list) files = [...files, ...Array.from(list)]; }
	function onDrop(e: DragEvent) { dragging = false; add(e.dataTransfer?.files ?? null); }
	function remove(i: number) { files = files.filter((_, j) => j !== i); }
	function send() { if (!canSend) return; dispatch('send', { text: text.trim(), files }); }
	export function reset() { text = ''; files = []; }
</script>

<section class="composer">
	<div class="head">{$t('share.send_to', { name: friendName })}</div>
	<textarea bind:value={text} placeholder={$t('share.text_placeholder')} rows="2" disabled={busy}></textarea>
	<div
		class="drop" class:dragging role="button" tabindex="0"
		on:dragover|preventDefault={() => (dragging = true)} on:dragleave={() => (dragging = false)}
		on:drop|preventDefault={onDrop} on:click={() => input.click()} on:keydown={(e) => e.key === 'Enter' && input.click()}
	>
		{$t('share.drop')}
		<input bind:this={input} type="file" multiple hidden on:change={(e) => { add(e.currentTarget.files); e.currentTarget.value = ''; }} />
	</div>
	{#if files.length}
		<ul class="files">
			{#each files as f, i}
				<li><span class="fname">{f.name}</span><span class="fsize">{formatBytes(f.size, $locale)}</span>
					<button class="x" aria-label="✕" on:click={() => remove(i)} disabled={busy}>✕</button></li>
			{/each}
		</ul>
	{/if}
	<div class="foot">
		<span class="sum">
			{#if files.length}{$t('share.summary', { n: files.length, size: formatBytes(total, $locale) })}{/if}
			{#if offline}<span class="note">{$t('share.offline_note')}</span>{/if}
		</span>
		<button class="btn" disabled={!canSend} on:click={send}>
			{busy ? $t('share.sending', { pct: Math.round(progress * 100) }) : $t('share.send')}
		</button>
	</div>
</section>

<style>
	.composer { border-bottom: 1px solid var(--border); padding: 14px 18px;
		background: radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, var(--gold) 8%, transparent), transparent 60%); display: flex; flex-direction: column; gap: 8px; }
	.head { font: 700 15px/1.3 var(--font-display, inherit); color: var(--text-1); }
	textarea { resize: none; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; color: var(--text-1); padding: 9px 12px; font: inherit; font-size: 13px; }
	textarea:focus { outline: none; border-color: var(--gold); }
	.drop { border: 1.5px dashed color-mix(in srgb, var(--gold) 35%, var(--border-h)); border-radius: 10px; padding: 14px; text-align: center; font-size: 13px; color: var(--text-2); cursor: pointer; }
	.drop.dragging, .drop:hover { border-color: var(--gold); color: var(--gold); background: color-mix(in srgb, var(--gold) 6%, transparent); }
	.drop:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
	.files { list-style: none; margin: 0; padding: 0; max-height: 96px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
	.files li { display: flex; gap: 10px; align-items: center; font-size: 12.5px; }
	.fname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.fsize { color: var(--text-3); font-family: var(--font-mono); font-size: 11.5px; }
	.x { background: none; border: 0; color: var(--text-3); cursor: pointer; font-size: 12px; width: 26px; height: 26px; }
	.foot { display: flex; align-items: center; gap: 12px; }
	.sum { flex: 1; font-size: 12.5px; color: var(--text-2); display: flex; gap: 12px; }
	.note { color: var(--orange); }
	.btn { background: linear-gradient(135deg, #FBBF24, #F59E0B); color: #1a1205; border: 0; border-radius: 10px; padding: 8px 18px; font-weight: 700; font-size: 13px; cursor: pointer; }
	.btn:disabled { opacity: 0.45; cursor: default; }
</style>
