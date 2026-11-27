<!--
  A filter chip (the office look's `ol-chip soft`, as a button): an optional
  glowing dot (`dot`, pulsing with `live`) and a count. Dimmed while off,
  full colour with a ring of `color` when `on`.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  export let label: string;
  export let count: string | number = '';
  export let color: string = '#94A3B8';
  export let on = false;
  export let dot = false;
  export let live = false;
  export let small = false;
  const dispatch = createEventDispatcher<{ click: MouseEvent }>();
</script>

<button type="button" class="ol-chip soft ks-chip" class:on class:small style="--c: {color}" aria-pressed={on}
  on:click={(e) => dispatch('click', e)}>{#if dot}<i class:live></i>{/if}{label}{#if count !== ''}<em>{count}</em>{/if}</button>

<style>
  .ks-chip { flex: none; cursor: pointer; opacity: .62; filter: saturate(.55); transition: opacity .15s, filter .15s, box-shadow .15s; }
  .ks-chip:hover { opacity: .9; }
  .ks-chip.on { opacity: 1; filter: none; box-shadow: 0 0 0 1px var(--c) inset; }
  .ks-chip.small { height: 20px; padding: 0 8px; font-size: 10.5px; }
  .ks-chip:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
  em { font-style: normal; font-weight: 600; color: var(--text-3); }
  i.live { animation: ks-pulse 1.3s ease-in-out infinite; }
  @keyframes ks-pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .ks-chip { transition: none; } i.live { animation: none; } }
</style>
