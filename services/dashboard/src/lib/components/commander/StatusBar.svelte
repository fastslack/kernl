<script lang="ts">
	import type { CommanderTab } from '$lib/commander-stores.js';

	export let leftTab: CommanderTab | null;
	export let rightTab: CommanderTab | null;
	export let activeSide: 'left' | 'right';
	/** How many entries a copy/move would act on right now. */
	export let targetCount = 0;

	$: source = activeSide === 'left' ? leftTab : rightTab;
	$: destination = activeSide === 'left' ? rightTab : leftTab;

	/** Trim long paths from the left — the tail is the part that identifies it. */
	function ellipsize(p: string | undefined, max = 46): string {
		if (!p) return '—';
		return p.length <= max ? p : '…' + p.slice(-(max - 1));
	}
</script>

<!--
	Counts live in each pane's footer now. This bar answers the one question the
	panes cannot: where an F5/F6 would send the current selection. It is the
	direction of the operation made explicit, so a transfer is never a surprise.
-->
<div class="cmd-statusbar" aria-live="polite">
	<span class="sb-label">Transfer</span>
	{#if targetCount === 0}
		<span class="sb-idle">Select entries to copy or move</span>
	{:else}
		<span class="sb-count">{targetCount}</span>
		<span class="sb-path from" title={source?.path}>{ellipsize(source?.path)}</span>
		<span class="sb-arrow" aria-hidden="true">→</span>
		<span class="sb-path to" title={destination?.path}>{ellipsize(destination?.path)}</span>
		<span class="sb-side">({activeSide === 'left' ? 'left → right' : 'right → left'})</span>
	{/if}
	<span class="sb-spacer"></span>
	<span class="sb-active">
		Active pane
		<span class="sb-active-val">{activeSide}</span>
		<kbd>Tab</kbd> to switch
	</span>
</div>
