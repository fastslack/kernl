<script lang="ts">
  /*
    Root router for the crm view. The dashboard host routes by FIRST URL
    segment only, so both /crm and /crm/leads mount this same bundle
    (view "crm") — and same-view URL changes do NOT remount it. This wrapper
    picks the sub-page from the current pathname and re-checks on every
    `kernl:navigate` event the host route broadcasts.
  */
  import { onDestroy } from 'svelte';
  import CrmPage from './CrmPage.svelte';
  import LeadsPage from './LeadsPage.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  function subFor(path: string): 'leads' | 'main' {
    return path.startsWith(ctx.basePath + '/leads') ? 'leads' : 'main';
  }

  let sub: 'leads' | 'main' = subFor(window.location.pathname);

  const offNavigate = ctx.events.on('navigate', (detail: { path?: string }) => {
    const next = subFor(detail?.path ?? window.location.pathname);
    if (next !== sub) sub = next;
  });

  onDestroy(offNavigate);
</script>

{#if sub === 'leads'}
  <LeadsPage {ctx} />
{:else}
  <CrmPage {ctx} />
{/if}
