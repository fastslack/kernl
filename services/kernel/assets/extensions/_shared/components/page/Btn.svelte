<!--
  A strip or card action (the office look's `ol-btn`). `variant`: "primary"
  (the page's one gold action), "ghost" or "danger". With `href` it renders
  a link.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  export let variant: 'primary' | 'ghost' | 'danger' = 'ghost';
  export let href: string = '';
  export let disabled = false;
  export let small = false;
  export let title: string = '';
  const dispatch = createEventDispatcher<{ click: MouseEvent }>();
  $: cls = variant === 'primary' ? '' : variant;
</script>

{#if href}
  <a {href} class="ol-btn ks-btn {cls}" class:small {title}><slot /></a>
{:else}
  <button type="button" class="ol-btn ks-btn {cls}" class:small {disabled} {title} on:click={(e) => dispatch('click', e)}><slot /></button>
{/if}

<style>
  .ks-btn { text-decoration: none; }
  .ks-btn.small { height: 28px; padding: 0 10px; font-size: 11.5px; }
</style>
