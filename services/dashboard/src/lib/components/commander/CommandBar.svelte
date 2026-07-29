<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';

	export let initial = '';

	let value = initial;
	let inputEl: HTMLInputElement;

	const dispatch = createEventDispatcher<{
		run: { cmd: string };
		cancel: undefined;
	}>();

	function onKey(ev: KeyboardEvent) {
		if (ev.key === 'Escape') {
			ev.preventDefault();
			dispatch('cancel');
		} else if (ev.key === 'Enter') {
			ev.preventDefault();
			if (value.trim()) dispatch('run', { cmd: value.trim() });
			else dispatch('cancel');
		}
	}

	onMount(() => {
		setTimeout(() => inputEl?.focus(), 10);
	});
</script>

<div class="cmd-prompt" role="dialog" aria-label="Command">
	<span class="colon">:</span>
	<input
		bind:this={inputEl}
		bind:value
		placeholder="cd /path · mkdir name · find query · goto ~/Downloads"
		on:keydown={onKey}
	/>
	<span class="hint">Esc to cancel · Enter to run</span>
</div>
