<!-- src/lib/components/panels/PanelDetail.svelte -->
<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { textOf } from '$lib/panels/template.js';
  import { pollSource } from '$lib/panels/client.js';
  import { jsonHtml } from '$lib/json-view.js';
  import type { PanelSpec, PanelView } from '$lib/panels/types.js';
  import PanelForm from './PanelForm.svelte';
  export let flowId: string;
  export let view: PanelView;
  export let spec: PanelSpec;
  /** The opened record, or null when this detail is a tab of its own (no back button, no key). */
  export let rowKey: string | null;
  const dispatch = createEventDispatcher<{ back: void }>();
  let row: Record<string, unknown> | null = null;
  let error = '';
  let openAction: string | null = null;
  const [source, select] = (view.data ?? '').split(/:(.*)/s);
  const stop = pollSource(flowId, source, { select, ...(rowKey ? { key: rowKey } : {}) }, (d) => { row = (d as Record<string, unknown>) ?? null; }, (m) => (error = m));
  onDestroy(stop);
  $: sections = view.sections ?? Object.keys(row ?? {});
</script>

<div class="pd">
  {#if rowKey}<button class="pd-back" on:click={() => dispatch('back')}>← {rowKey}</button>{/if}
  {#if error}<p class="pd-err" role="alert">{error}</p>{/if}
  {#if row}
    {#each sections as s (s)}
      {#if row[s] !== undefined && row[s] !== null && row[s] !== ''}
        <section class="pd-sec"><h4>{s}</h4>
          {#if typeof row[s] === 'object'}{@html jsonHtml(row[s])}{:else}<p>{String(row[s])}</p>{/if}
        </section>
      {/if}
    {/each}
  {/if}
  {#if view.actions?.length}
    <div class="pd-acts">
      {#each view.actions as a (a)}
        {#if spec.actions?.[a]}<button class:on={openAction === a} on:click={() => (openAction = openAction === a ? null : a)}>{textOf(spec.actions[a].label, $locale)}</button>{/if}
      {/each}
    </div>
    {#if openAction && spec.actions?.[openAction]}
      {#key `${rowKey}:${openAction}`}<PanelForm {flowId} actionId={openAction} action={spec.actions[openAction]} preset={rowKey ? { key: rowKey } : {}} />{/key}
    {/if}
  {/if}
</div>

<style>
  .pd { display: flex; flex-direction: column; gap: 8px; }
  .pd-back { align-self: flex-start; background: none; border: none; color: var(--teal); font: 600 12px 'Manrope', sans-serif; cursor: pointer; min-height: 30px; }
  .pd-sec h4 { margin: 0 0 4px; font: 700 10px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .05em; color: var(--text-3); }
  .pd-sec p { margin: 0; font: 500 12px/1.5 'Manrope', sans-serif; color: var(--text-1); white-space: pre-wrap; }
  .pd-err { color: #ff9fb5; font: 500 11.5px 'Manrope', sans-serif; margin: 0; }
  .pd-acts { display: flex; gap: 6px; flex-wrap: wrap; }
  .pd-acts button { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1); font: 600 11.5px 'Manrope', sans-serif; cursor: pointer; min-height: 32px; }
  .pd-acts button.on { border-color: var(--teal); }
</style>
