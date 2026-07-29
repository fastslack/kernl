<script lang="ts">
	import { miniMd } from '$lib/mini-md.js';

	export let agentName: string = '';
	export let result: string = '';
	export let completedAt: string | null = null;
	export let status: string = '';

	$: html = result ? miniMd(result) : '';
	$: timeAgo = completedAt ? formatAgo(completedAt) : '';

	function formatAgo(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}
</script>

<div class="flow-widget" class:empty={!result}>
	<div class="fw-header">
		<span class="fw-dot" class:active={status === 'completed'}></span>
		<span class="fw-name">{agentName}</span>
		{#if timeAgo}
			<span class="fw-time">{timeAgo}</span>
		{/if}
	</div>
	{#if html}
		<div class="fw-body">{@html html}</div>
	{:else}
		<div class="fw-empty">No results yet</div>
	{/if}
</div>

<style>
	.flow-widget {
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 12px 14px;
		min-width: 260px;
		max-width: 400px;
		overflow: hidden;
		transition: transform 0.2s, box-shadow 0.2s;
		animation: widgetAppear 0.4s ease-out both;
	}
	.flow-widget:hover {
		transform: translateY(-2px);
		box-shadow: 0 4px 20px rgba(0,0,0,0.3);
	}
	.flow-widget.empty {
		opacity: 0.5;
	}

	.fw-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
	}
	.fw-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-3);
		flex-shrink: 0;
	}
	.fw-dot.active {
		background: var(--green);
		box-shadow: 0 0 6px var(--green);
	}
	.fw-name {
		font-size: 12px;
		font-weight: 700;
		color: var(--text-1);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}
	.fw-time {
		font-size: 10px;
		color: var(--text-3);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.fw-body {
		font-size: 11px;
		line-height: 1.45;
		color: var(--text-2);
		max-height: 280px;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--border) transparent;
	}

	/* Mini-markdown styles */
	.fw-body :global(h1) { font-size: 13px; font-weight: 700; color: var(--text-1); margin: 0 0 4px; }
	.fw-body :global(h2) { font-size: 12px; font-weight: 700; color: var(--text-1); margin: 8px 0 3px; }
	.fw-body :global(h3) { font-size: 11px; font-weight: 700; color: var(--text-2); margin: 6px 0 2px; }
	.fw-body :global(strong) { color: var(--text-1); font-weight: 600; }
	.fw-body :global(code) {
		background: var(--surface-2);
		padding: 1px 4px;
		border-radius: 3px;
		font-size: 10px;
	}
	.fw-body :global(hr) { border: none; border-top: 1px solid var(--border); margin: 6px 0; }
	.fw-body :global(ul) { margin: 2px 0; padding-left: 14px; }
	.fw-body :global(li) { margin: 1px 0; }
	.fw-body :global(.md-bar) {
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 10px;
		line-height: 1.6;
		white-space: pre;
		color: var(--text-2);
	}
	.fw-body :global(.md-line) { margin: 1px 0; }

	.fw-empty {
		font-size: 11px;
		color: var(--text-3);
		text-align: center;
		padding: 16px 0;
	}

	@keyframes widgetAppear {
		from { opacity: 0; transform: translateY(10px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
