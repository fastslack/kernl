<!--
  A KPI tile of the strip (the office look's `ol-kpi`): a big glowing number
  over a short label, tinted with `color`. `clickable` makes it a button (a
  filter, usually) and `on` marks the active one; `live` adds a pulsing dot
  (something is happening now) and `alert` a gold ring (needs you).
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  export let value: string | number;
  export let label: string;
  export let color: string = '#22D3EE';
  export let clickable = false;
  export let on = false;
  export let live = false;
  export let alert = false;
  export let disabled = false;
  export let title: string = '';
  const dispatch = createEventDispatcher<{ click: MouseEvent }>();
</script>

{#if clickable}
  <button type="button" class="ol-kpi" class:on class:live class:alert style="--c: {color}" {title} {disabled}
    aria-pressed={on} on:click={(e) => dispatch('click', e)}><b>{value}</b><small>{label}</small></button>
{:else}
  <div class="ol-kpi" class:live class:alert style="--c: {color}" {title}><b>{value}</b><small>{label}</small></div>
{/if}

<style>
  b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  button:disabled { opacity: .35; cursor: default; transform: none; box-shadow: none; }
</style>
