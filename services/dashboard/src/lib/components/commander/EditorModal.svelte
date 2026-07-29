<script lang="ts">
	/**
	 * Minimal text editor for the Commander.
	 *
	 * Reads text via /api/fs/read?text=1, writes back via /api/fs/write with
	 * expected_mtime for optimistic concurrency. Monospace textarea with
	 * line numbers; syntax highlighting is deferred (CodeMirror upgrade).
	 */
	import { onMount } from 'svelte';
	import { createEventDispatcher } from 'svelte';

	export let providerId: string;
	export let path: string;
	export let onClose: () => void;

	const dispatch = createEventDispatcher<{ saved: { size: number } }>();

	let content = '';
	let original = '';
	let mtime = '';
	let mime = '';
	let size = 0;
	let loading = true;
	let saving = false;
	let error: string | null = null;
	let conflict: string | null = null;
	let taEl: HTMLTextAreaElement;

	function authHeaders(): Record<string, string> {
		const h: Record<string, string> = {};
		if (typeof localStorage !== 'undefined') {
			const t = localStorage.getItem('kernel_auth_token');
			if (t) h['Authorization'] = `Bearer ${t}`;
		}
		return h;
	}

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			const r = await fetch(
				`/api/fs/read?provider=${encodeURIComponent(providerId)}&path=${encodeURIComponent(path)}&text=1`,
				{ headers: authHeaders() }
			);
			if (r.status === 413) {
				error = 'File too large to edit.';
				loading = false;
				return;
			}
			if (!r.ok) throw new Error(await r.text());
			const data = (await r.json()) as {
				content: string;
				mime: string;
				size: number;
				mtime: string;
			};
			content = data.content;
			original = data.content;
			mime = data.mime;
			size = data.size;
			mtime = data.mtime;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
			setTimeout(() => taEl?.focus(), 30);
		}
	}

	async function save(force = false): Promise<void> {
		if (saving) return;
		saving = true;
		conflict = null;
		error = null;
		try {
			const r = await fetch('/api/fs/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...authHeaders() },
				body: JSON.stringify({
					provider: providerId,
					path,
					content,
					encoding: 'utf-8',
					overwrite: true,
					expected_mtime: force ? undefined : mtime
				})
			});
			if (r.status === 409) {
				const body = (await r.json()) as { current_mtime?: string };
				conflict = body.current_mtime ?? 'unknown';
				return;
			}
			if (!r.ok) throw new Error(await r.text());
			const after = (await r.json()) as { size: number; mtime: string };
			original = content;
			mtime = after.mtime;
			size = after.size;
			dispatch('saved', { size: after.size });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	function onKey(ev: KeyboardEvent): void {
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
			ev.preventDefault();
			save();
		} else if (ev.key === 'Escape') {
			if (content !== original) {
				if (!confirm('Discard unsaved changes?')) return;
			}
			onClose();
		}
	}

	$: dirty = content !== original;
	$: lineCount = content.split('\n').length;

	function fmtBytes(n: number): string {
		if (!n) return '0 B';
		const u = ['B', 'KB', 'MB', 'GB', 'TB'];
		let v = n;
		let i = 0;
		while (v >= 1024 && i < u.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v.toFixed(1)} ${u[i]}`;
	}

	onMount(() => {
		load();
	});
</script>

<svelte:window on:keydown={onKey} />

<div class="ed-overlay" on:click|self={onClose} role="dialog" aria-modal="true">
	<div class="ed-dialog">
		<div class="ed-header">
			<span class="ed-title">{path.split('/').pop()}</span>
			<span class="ed-meta">
				{mime} · {fmtBytes(size)} · {lineCount} lines
				{#if dirty}<span class="ed-dirty">● unsaved</span>{/if}
			</span>
			<div class="ed-actions">
				<button on:click={() => save(false)} disabled={!dirty || saving}>
					{saving ? 'Saving…' : 'Save (Ctrl+S)'}
				</button>
				<button class="close" on:click={onClose} aria-label="Close">×</button>
			</div>
		</div>

		<div class="ed-body">
			{#if loading}
				<div class="ed-loading">Loading…</div>
			{:else if error}
				<div class="ed-error">⚠︎ {error}</div>
			{:else}
				<textarea
					bind:this={taEl}
					bind:value={content}
					spellcheck="false"
					autocapitalize="off"
					autocorrect="off"
					data-gramm="false"
				></textarea>
			{/if}
		</div>

		{#if conflict}
			<div class="ed-conflict">
				⚠︎ File changed on disk (mtime now: {conflict}).
				<button on:click={() => save(true)}>Overwrite anyway</button>
				<button on:click={() => load()}>Reload from disk</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.ed-overlay {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, #000 72%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 960;
		backdrop-filter: blur(6px);
	}
	.ed-dialog {
		background: var(--surface-1);
		border: 1px solid var(--gold);
		border-radius: var(--radius);
		width: min(96vw, 1280px);
		height: min(92vh, 900px);
		display: grid;
		grid-template-rows: auto 1fr auto;
		overflow: hidden;
		box-shadow: 0 30px 80px color-mix(in srgb, var(--gold) 20%, #000);
		font-family: 'Fira Code', monospace;
	}
	.ed-header {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 8px 14px;
		background: color-mix(in srgb, var(--gold) 8%, var(--surface-1));
		border-bottom: 1px solid var(--border);
		font-size: 12px;
	}
	.ed-title {
		color: var(--gold);
		font-weight: 700;
		letter-spacing: 0.03em;
	}
	.ed-meta {
		color: var(--text-3);
		font-size: 11px;
	}
	.ed-dirty {
		color: var(--orange);
		margin-left: 6px;
	}
	.ed-actions {
		margin-left: auto;
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.ed-actions button {
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-1);
		font-family: 'Fira Code', monospace;
		font-size: 11px;
		padding: 4px 10px;
		border-radius: 3px;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.ed-actions button:not(:disabled):hover {
		border-color: var(--gold);
		color: var(--gold);
	}
	.ed-actions button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.ed-actions button.close {
		background: none;
		border: none;
		font-size: 20px;
		padding: 0 6px;
		color: var(--text-3);
	}
	.ed-actions button.close:hover {
		color: var(--red);
	}
	.ed-body {
		min-height: 0;
		background: var(--bg);
		display: grid;
	}
	.ed-body textarea {
		resize: none;
		border: none;
		outline: none;
		background: var(--bg);
		color: var(--text-1);
		padding: 14px 18px;
		font-family: 'Fira Code', monospace;
		font-size: 13px;
		line-height: 1.55;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		white-space: pre;
		overflow: auto;
		tab-size: 2;
	}
	.ed-body textarea::selection {
		background: color-mix(in srgb, var(--gold) 30%, transparent);
	}
	.ed-loading {
		padding: 40px;
		color: var(--text-3);
		text-align: center;
	}
	.ed-error {
		padding: 24px;
		color: var(--red);
	}
	.ed-conflict {
		padding: 10px 16px;
		background: color-mix(in srgb, var(--red) 12%, var(--surface-1));
		border-top: 1px solid color-mix(in srgb, var(--red) 30%, transparent);
		color: var(--text-1);
		font-size: 12px;
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.ed-conflict button {
		background: var(--surface-2);
		border: 1px solid var(--red);
		color: var(--text-1);
		font-family: 'Fira Code', monospace;
		font-size: 11px;
		padding: 3px 10px;
		border-radius: 3px;
		cursor: pointer;
	}
</style>
