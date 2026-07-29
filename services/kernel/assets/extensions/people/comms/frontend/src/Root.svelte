<script lang="ts">
  /*
    Root router for the comms view. The dashboard host routes by FIRST URL
    segment only, so /comms, /comms/compose, /comms/campaign/<id>,
    /comms/edit/<id> and /comms/thread/<id> all mount this same bundle
    (view "comms") — and same-view URL changes do NOT remount it. This
    wrapper picks the sub-page (+ id param) from the current pathname and
    re-checks on every `kernl:navigate` event the host route broadcasts.
  */
  import { onDestroy } from 'svelte';
  import CommsPage from './CommsPage.svelte';
  import ComposePage from './ComposePage.svelte';
  import CampaignPage from './CampaignPage.svelte';
  import EditPage from './EditPage.svelte';
  import ThreadPage from './ThreadPage.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  type Sub = { name: 'main' | 'compose' | 'campaign' | 'edit' | 'thread'; id: string };

  function subFor(path: string): Sub {
    const rest = path.startsWith(ctx.basePath) ? path.slice(ctx.basePath.length) : '';
    const segs = rest.split('/').filter(Boolean);
    if (segs[0] === 'compose') return { name: 'compose', id: '' };
    if (segs[0] === 'campaign' && segs[1]) return { name: 'campaign', id: decodeURIComponent(segs[1]) };
    if (segs[0] === 'edit' && segs[1]) return { name: 'edit', id: decodeURIComponent(segs[1]) };
    if (segs[0] === 'thread' && segs[1]) return { name: 'thread', id: decodeURIComponent(segs[1]) };
    return { name: 'main', id: '' };
  }

  let sub: Sub = subFor(window.location.pathname);

  const offNavigate = ctx.events.on('navigate', (detail: { path?: string }) => {
    const next = subFor(detail?.path ?? window.location.pathname);
    if (next.name !== sub.name || next.id !== sub.id) sub = next;
  });

  onDestroy(offNavigate);
</script>

{#if sub.name === 'compose'}
  <ComposePage {ctx} />
{:else if sub.name === 'campaign'}
  <CampaignPage {ctx} id={sub.id} />
{:else if sub.name === 'edit'}
  <EditPage {ctx} id={sub.id} />
{:else if sub.name === 'thread'}
  <ThreadPage {ctx} id={sub.id} />
{:else}
  <CommsPage {ctx} />
{/if}
