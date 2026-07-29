<script lang="ts">
	import { onMount } from 'svelte';
	import type { Bookmark, HistoryRow } from '$lib/fs-api.js';
	import { bookmarksList, historyList, bookmarkRemove } from '$lib/fs-api.js';
	import type { PaneId } from '$lib/commander-stores.js';

	export let pane: PaneId;
	export let onJump: (providerId: string, path: string) => void;
	export let onClose: () => void;

	type Tab = 'bookmarks' | 'history';
	let tab: Tab = 'bookmarks';
	let bookmarks: Bookmark[] = [];
	let history: HistoryRow[] = [];
	let loading = true;

	async function loadAll(): Promise<void> {
		loading = true;
		try {
			const [b, h] = await Promise.all([bookmarksList(), historyList(pane, 50)]);
			bookmarks = b;
			history = h;
		} catch {
			// ignore
		} finally {
			loading = false;
		}
	}

	async function remove(id: string): Promise<void> {
		await bookmarkRemove(id).catch(() => {});
		await loadAll();
	}

	function onKey(ev: KeyboardEvent): void {
		if (ev.key === 'Escape') onClose();
	}

	onMount(() => {
		loadAll();
	});
</script>

<svelte:window on:keydown={onKey} />

<div class="bm-overlay" on:click|self={onClose} role="dialog" aria-modal="true">
	<div class="bm-dialog">
		<div class="bm-header">
			<button class="bm-tab" class:active={tab === 'bookmarks'} on:click={() => (tab = 'bookmarks')}>
				BOOKMARKS
			</button>
			<button class="bm-tab" class:active={tab === 'history'} on:click={() => (tab = 'history')}>
				HISTORY ({pane})
			</button>
			<button class="bm-close" on:click={onClose} aria-label="Close">×</button>
		</div>

		<div class="bm-body">
			{#if loading}
				<div class="bm-muted">Loading…</div>
			{:else if tab === 'bookmarks'}
				{#if bookmarks.length === 0}
					<div class="bm-muted">No bookmarks yet. Use Ctrl+B in the pane to add one.</div>
				{:else}
					{#each bookmarks as b (b.id)}
						<div class="bm-row">
							<button
								class="bm-main"
								on:click={() => {
									onJump(b.provider_id, b.path);
									onClose();
								}}
							>
								<span class="bm-label">{b.label}</span>
								<span class="bm-sub">
									<code>{b.provider_id}</code> · {b.path}
								</span>
							</button>
							<button class="bm-del" on:click={() => remove(b.id)} title="Remove">×</button>
						</div>
					{/each}
				{/if}
			{:else if history.length === 0}
				<div class="bm-muted">No history for this pane yet.</div>
			{:else}
				{#each history as h (h.id)}
					<button
						class="bm-main"
						on:click={() => {
							onJump(h.provider_id, h.path);
							onClose();
						}}
					>
						<span class="bm-label">{h.path}</span>
						<span class="bm-sub">
							<code>{h.provider_id}</code> · {h.visited_at.slice(0, 19).replace('T', ' ')}
						</span>
					</button>
				{/each}
			{/if}
		</div>
	</div>
</div>

<style>
	.bm-overlay {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, #000 50%, transparent);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		z-index: 940;
		padding-top: 120px;
		backdrop-filter: blur(3px);
	}
	.bm-dialog {
		background: var(--surface-1);
		border: 1px solid var(--gold);
		border-radius: var(--radius);
		width: min(620px, 92vw);
		max-height: 70vh;
		overflow: hidden;
		display: grid;
		grid-template-rows: auto 1fr;
		box-shadow: 0 25px 60px color-mix(in srgb, var(--gold) 20%, #000);
		font-family: 'Fira Code', monospace;
	}
	.bm-header {
		display: flex;
		align-items: stretch;
		background: color-mix(in srgb, var(--gold) 8%, var(--surface-1));
		border-bottom: 1px solid var(--border);
	}
	.bm-tab {
		background: none;
		border: none;
		padding: 8px 16px;
		color: var(--text-2);
		font-family: inherit;
		font-size: 11px;
		letter-spacing: 0.1em;
		cursor: pointer;
		border-right: 1px solid var(--border);
	}
	.bm-tab:hover { color: var(--gold); }
	.bm-tab.active { color: var(--gold); background: var(--surface-1); }
	.bm-close {
		margin-left: auto;
		background: none;
		border: none;
		color: var(--text-3);
		font-size: 20px;
		padding: 0 12px;
		cursor: pointer;
	}
	.bm-close:hover { color: var(--red); }
	.bm-body {
		overflow: auto;
		padding: 4px 0;
	}
	.bm-muted { color: var(--text-3); padding: 16px; font-size: 12px; text-align: center; }
	.bm-row { display: flex; align-items: stretch; }
	.bm-main {
		flex: 1;
		text-align: left;
		background: transparent;
		border: none;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
		padding: 8px 16px;
		cursor: pointer;
		font-family: inherit;
		color: var(--text-1);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.bm-main:hover { background: color-mix(in srgb, var(--gold) 8%, transparent); }
	.bm-label { font-size: 13px; color: var(--text-1); }
	.bm-sub { font-size: 11px; color: var(--text-3); }
	.bm-sub code { color: var(--teal); }
	.bm-del {
		background: transparent;
		border: none;
		color: var(--text-3);
		padding: 0 12px;
		cursor: pointer;
		font-size: 16px;
	}
	.bm-del:hover { color: var(--red); }
</style>
