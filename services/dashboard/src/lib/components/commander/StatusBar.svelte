<script lang="ts">
	import type { CommanderTab } from '$lib/commander-stores.js';

	export let leftTab: CommanderTab | null;
	export let rightTab: CommanderTab | null;
	export let activeSide: 'left' | 'right';

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

	function summary(tab: CommanderTab | null): {
		count: number;
		selected: number;
		size: number;
	} {
		if (!tab) return { count: 0, selected: 0, size: 0 };
		let size = 0;
		for (const e of tab.entries) if (tab.selection.has(e.name)) size += e.size;
		return { count: tab.entries.length, selected: tab.selection.size, size };
	}

	$: active = activeSide === 'left' ? leftTab : rightTab;
	$: s = summary(active);
</script>

<div class="cmd-statusbar">
	<span>
		<span class="count-hi">{s.count}</span> items
	</span>
	{#if s.selected > 0}
		<span class="sep">·</span>
		<span>
			<span class="count-hi">{s.selected}</span> selected
			<span class="sep">·</span>
			{fmtBytes(s.size)}
		</span>
	{/if}
	<span class="sep">·</span>
	<span>L: {leftTab?.path ?? '-'}</span>
	<span class="sep">·</span>
	<span>R: {rightTab?.path ?? '-'}</span>
	<span style="margin-left:auto;color:var(--text-3)">
		active: <span class="count-hi">{activeSide === 'left' ? 'L' : 'R'}</span>
	</span>
</div>
