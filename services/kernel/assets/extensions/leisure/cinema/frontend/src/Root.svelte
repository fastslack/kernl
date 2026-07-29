<script lang="ts">
  /*
    Root router for the cinema view. The dashboard host routes by FIRST URL
    segment only, so both /cinema and /cinema/directories mount this same
    bundle (view "cinema") — and same-view URL changes do NOT remount it.
    This wrapper picks the sub-page from the current pathname and re-checks
    on every `kernl:navigate` event the host route broadcasts (SvelteKit
    goto/back/forward both update $page, so both paths are covered).
  */
  import { onDestroy } from 'svelte';
  import Page from './Page.svelte';
  import Directories from './Directories.svelte';
  import type { ExtPageContext } from './types.js';

  export let ctx: ExtPageContext;

  function subFor(path: string): 'directories' | 'main' {
    return path.startsWith(ctx.basePath + '/directories') ? 'directories' : 'main';
  }

  let sub: 'directories' | 'main' = subFor(window.location.pathname);

  const offNavigate = ctx.events.on('navigate', (detail: { path?: string }) => {
    const next = subFor(detail?.path ?? window.location.pathname);
    if (next !== sub) sub = next;
  });

  onDestroy(offNavigate);
</script>

{#if sub === 'directories'}
  <Directories {ctx} />
{:else}
  <Page {ctx} />
{/if}
