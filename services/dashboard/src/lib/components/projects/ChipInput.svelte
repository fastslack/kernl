<script lang="ts">
	/*
	  A list typed as chips: Enter or comma adds one, × or Backspace on an
	  empty input removes the last. Suggestions are one-click chips.
	*/
	export let values: string[] = [];
	export let id: string;
	export let placeholder = '';
	export let suggestions: string[] = [];
	export let describedby = '';

	let draft = '';

	function add(v: string) {
		const s = v.trim().replace(/,$/, '').trim();
		if (s && !values.some((x) => x.toLowerCase() === s.toLowerCase())) values = [...values, s];
		draft = '';
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			add(draft);
		} else if (e.key === 'Backspace' && draft === '' && values.length) {
			values = values.slice(0, -1);
		}
	}

	$: open = suggestions.filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()));
</script>

<div class="chips">
	{#each values as v, i (v)}
		<span class="chip">{v}<button type="button" aria-label="Quitar {v}" on:click={() => (values = values.filter((_, j) => j !== i))}>×</button></span>
	{/each}
	<input {id} bind:value={draft} on:keydown={onKey} on:blur={() => add(draft)}
		placeholder={values.length ? '' : placeholder} aria-describedby={describedby || undefined} />
</div>
{#if open.length}
	<div class="sugg" aria-label="Sugerencias">
		{#each open as s}<button type="button" on:click={() => add(s)}>+ {s}</button>{/each}
	</div>
{/if}

<style>
	.chips {
		display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 40px;
		background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 8px;
	}
	.chips:focus-within { outline: 2px solid var(--teal); outline-offset: 1px; }
	.chip {
		display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-1);
		background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 2px 4px 2px 10px;
	}
	.chip button { background: none; border: 0; color: var(--text-3); cursor: pointer; font-size: 15px; width: 22px; height: 22px; border-radius: 50%; }
	.chip button:hover { color: var(--red); }
	input { flex: 1; min-width: 120px; background: none; border: 0; outline: none; color: var(--text-1); font: inherit; font-size: 14px; padding: 4px 2px; }
	.sugg { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
	.sugg button {
		background: none; border: 1px dashed var(--border); color: var(--text-2); border-radius: 999px;
		padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer;
	}
	.sugg button:hover { border-color: var(--teal); color: var(--teal); }
</style>
