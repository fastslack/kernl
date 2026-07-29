<script lang="ts">
	import type { OpProgress } from '$lib/fs-api.js';
	export let op: OpProgress;
	export let onCancel: (id: string) => void;
	export let onDismiss: (id: string) => void;

	function fmtBytes(n: number): string {
		if (!n) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let v = n;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v.toFixed(1)} ${units[i]}`;
	}

	$: klass =
		op.status === 'error' || op.status === 'cancelled'
			? 'error'
			: op.status === 'done'
				? 'done'
				: '';
	$: pct = Math.round((op.progress ?? 0) * 100);
	$: canCancel = op.status === 'running' || op.status === 'pending';
	$: canDismiss = !canCancel;
</script>

<div class="cmd-toast {klass}">
	<div class="head">
		<span>{op.kind.toUpperCase()}</span>
		<span>· {op.status}</span>
		{#if canCancel}
			<button class="cancel" on:click={() => onCancel(op.id)} title="Cancel">×</button>
		{:else}
			<button class="cancel" on:click={() => onDismiss(op.id)} title="Dismiss">×</button>
		{/if}
	</div>
	{#if op.currentFile}
		<div style="color:var(--text-1);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
			{op.currentFile}
		</div>
	{/if}
	<div class="bar"><div class="fill" style="width:{pct}%"></div></div>
	<div class="meta">
		<span>{pct}%</span>
		<span>· {op.itemsDone}/{op.itemsTotal} items</span>
		<span>· {fmtBytes(op.bytes)} / {fmtBytes(op.totalBytes)}</span>
	</div>
	{#if op.errors.length > 0}
		<div style="color:var(--red);font-size:10px;margin-top:6px">
			{op.errors[op.errors.length - 1]}
		</div>
	{/if}
</div>
