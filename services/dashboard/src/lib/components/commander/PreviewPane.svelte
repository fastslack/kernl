<script lang="ts">
	import { onMount } from 'svelte';

	export let providerId: string;
	export let path: string;
	export let onClose: () => void;

	interface PreviewResult {
		kind: 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'hex' | 'too-large' | 'unsupported';
		mime: string;
		size: number;
		name: string;
		content?: string;
		truncated?: boolean;
		hex?: Array<{ offset: string; hex: string; ascii: string }>;
		streamable?: boolean;
	}

	let loading = true;
	let error: string | null = null;
	let result: PreviewResult | null = null;

	function authHeaders(): Record<string, string> {
		const h: Record<string, string> = {};
		if (typeof localStorage !== 'undefined') {
			const token = localStorage.getItem('kernel_auth_token');
			if (token) h['Authorization'] = `Bearer ${token}`;
		}
		return h;
	}

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			const r = await fetch(
				`/api/fs/preview?provider=${encodeURIComponent(providerId)}&path=${encodeURIComponent(path)}`,
				{ headers: authHeaders() }
			);
			if (!r.ok) throw new Error(await r.text());
			result = (await r.json()) as PreviewResult;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

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

	$: rawUrl = `/api/fs/preview?provider=${encodeURIComponent(providerId)}&path=${encodeURIComponent(path)}&raw=1`;

	function onKey(ev: KeyboardEvent): void {
		if (ev.key === 'Escape') {
			ev.stopPropagation();
			onClose();
		}
	}

	onMount(() => {
		load();
	});
</script>

<svelte:window on:keydown={onKey} />

<div class="pv-overlay" on:click|self={onClose} role="dialog" aria-modal="true">
	<div class="pv-dialog">
		<div class="pv-header">
			<span class="pv-title">{result?.name ?? path.split('/').pop()}</span>
			<span class="pv-meta">
				{#if result}{result.mime} · {fmtBytes(result.size)}{/if}
			</span>
			<button class="pv-close" on:click={onClose} aria-label="Close">×</button>
		</div>

		<div class="pv-body">
			{#if loading}
				<div class="pv-loading">Loading preview…</div>
			{:else if error}
				<div class="pv-error">⚠︎ {error}</div>
			{:else if !result}
				<!-- empty -->
			{:else if result.kind === 'image'}
				<img src={rawUrl} alt={result.name} />
			{:else if result.kind === 'video'}
				<video src={rawUrl} controls>
					<track kind="captions" />
				</video>
			{:else if result.kind === 'audio'}
				<audio src={rawUrl} controls></audio>
			{:else if result.kind === 'pdf'}
				<iframe src={rawUrl} title={result.name}></iframe>
			{:else if result.kind === 'text'}
				<pre class="pv-text">{result.content ?? ''}</pre>
				{#if result.truncated}
					<div class="pv-note">Truncated — {fmtBytes(result.size)} total</div>
				{/if}
			{:else if result.kind === 'hex' && result.hex}
				<pre class="pv-hex">{#each result.hex as line (line.offset)}
<span class="off">{line.offset}</span>  <span class="hx">{line.hex}</span>  <span class="asc">{line.ascii}</span>
{/each}</pre>
			{:else if result.kind === 'too-large'}
				<div class="pv-note">File too large for inline preview ({fmtBytes(result.size)}).</div>
			{:else}
				<div class="pv-note">No preview available for this file type.</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.pv-overlay {
		position: fixed;
		inset: 0;
		background: color-mix(in srgb, #000 72%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 950;
		backdrop-filter: blur(6px);
	}
	.pv-dialog {
		background: var(--surface-1);
		border: 1px solid var(--gold);
		border-radius: var(--radius);
		width: min(90vw, 1100px);
		height: min(88vh, 840px);
		display: grid;
		grid-template-rows: auto 1fr;
		overflow: hidden;
		box-shadow: 0 30px 80px color-mix(in srgb, var(--gold) 20%, #000);
		font-family: 'Fira Code', monospace;
	}
	.pv-header {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 8px 14px;
		background: color-mix(in srgb, var(--gold) 8%, var(--surface-1));
		border-bottom: 1px solid var(--border);
		font-size: 12px;
	}
	.pv-title {
		color: var(--gold);
		font-weight: 700;
		letter-spacing: 0.03em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pv-meta {
		color: var(--text-3);
		font-size: 11px;
	}
	.pv-close {
		margin-left: auto;
		background: none;
		border: none;
		color: var(--text-3);
		font-size: 20px;
		cursor: pointer;
	}
	.pv-close:hover {
		color: var(--red);
	}
	.pv-body {
		min-height: 0;
		overflow: auto;
		padding: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.pv-body :global(img),
	.pv-body :global(video) {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	.pv-body :global(iframe) {
		width: 100%;
		height: 100%;
		border: none;
	}
	.pv-text {
		width: 100%;
		max-height: 100%;
		overflow: auto;
		color: var(--text-1);
		font-size: 12px;
		padding: 12px;
		margin: 0;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.pv-hex {
		width: 100%;
		max-height: 100%;
		overflow: auto;
		color: var(--text-2);
		font-size: 11px;
		padding: 12px;
		margin: 0;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		line-height: 1.5;
	}
	.pv-hex .off {
		color: var(--gold);
	}
	.pv-hex .hx {
		color: var(--text-1);
	}
	.pv-hex .asc {
		color: var(--teal);
	}
	.pv-note {
		color: var(--text-2);
		padding: 24px;
		text-align: center;
		font-size: 13px;
	}
	.pv-loading {
		color: var(--text-3);
		padding: 24px;
	}
	.pv-error {
		color: var(--red);
		padding: 24px;
	}
</style>
