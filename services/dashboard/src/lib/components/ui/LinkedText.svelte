<script lang="ts">
  /** Plain text with its http(s) URLs as links that open in a new tab (an error that names the page where it is fixed). */
  import { textLinks } from '$lib/text-links.js';
  export let text = '';
  $: parts = textLinks(text);
</script>

{#each parts as p}{#if p.href}<a class="lt-link" href={p.href} target="_blank" rel="noopener noreferrer">{p.text}</a>{:else}{p.text}{/if}{/each}

<style>
  .lt-link { color: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
  .lt-link:hover { text-decoration-thickness: 2px; }
</style>
