<!-- src/lib/components/panels/PanelForm.svelte -->
<script lang="ts">
  import { locale } from '$lib/i18n/index.js';
  import { textOf } from '$lib/panels/template.js';
  import { formFields, isVisible } from '$lib/panels/form-model.js';
  import { runAction } from '$lib/panels/client.js';
  import type { PanelAction } from '$lib/panels/types.js';
  export let flowId: string;
  export let actionId: string;
  export let action: PanelAction;
  export let preset: Record<string, unknown> = {};
  let values: Record<string, unknown> = { ...preset };
  let busy = false;
  let message = '';
  let ok = false;
  let confirming = false;
  $: fields = formFields(action.input, $locale);

  async function submit() {
    if (action.confirm && !confirming) { confirming = true; return; }
    confirming = false;
    busy = true; message = '';
    try { const r = await runAction(flowId, actionId, values); ok = true; message = r.result; }
    catch (e) { ok = false; message = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
</script>

<form class="pf" on:submit|preventDefault={submit}>
  {#each fields as f (f.key)}
    {#if isVisible(f, values)}
      <label class="pf-f">
        <span>{f.label}{f.required ? ' *' : ''}</span>
        {#if f.kind === 'select'}
          <select bind:value={values[f.key]} required={f.required}>
            <option value={undefined} disabled>—</option>
            {#each f.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}
          </select>
        {:else if f.kind === 'checkbox'}
          <input type="checkbox" checked={values[f.key] === true} on:change={(e) => (values[f.key] = e.currentTarget.checked)} />
        {:else if f.kind === 'number'}
          <input type="number" value={values[f.key] ?? ''} on:input={(e) => (values[f.key] = e.currentTarget.value)} required={f.required} />
        {:else if f.kind === 'textarea'}
          <textarea rows="3" bind:value={values[f.key]} required={f.required}></textarea>
        {:else}
          <input type="text" bind:value={values[f.key]} required={f.required} pattern={f.pattern} />
        {/if}
      </label>
    {/if}
  {/each}
  <div class="pf-row">
    <button type="submit" disabled={busy}>
      {busy ? '…' : confirming ? textOf(action.confirm, $locale) : textOf(action.label, $locale)}
    </button>
    {#if confirming}<button type="button" class="pf-cancel" on:click={() => (confirming = false)}>{$locale.startsWith('en') ? 'Cancel' : 'Cancelar'}</button>{/if}
  </div>
  {#if message}<p class="pf-msg" class:ok role="status">{message}</p>{/if}
</form>

<style>
  .pf { display: flex; flex-direction: column; gap: 8px; }
  .pf-f { display: flex; flex-direction: column; gap: 3px; }
  .pf-f span { font: 600 11px 'Manrope', sans-serif; color: var(--text-2); }
  .pf-f input[type=text], .pf-f input[type=number], .pf-f select, .pf-f textarea { padding: 7px 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-1); font: 500 12px 'Manrope', sans-serif; min-height: 34px; }
  .pf-row { display: flex; gap: 6px; }
  .pf-row button { padding: 7px 12px; border-radius: 6px; border: 1px solid var(--teal); background: rgba(61, 214, 200, .12); color: var(--text-1); font: 700 12px 'Manrope', sans-serif; cursor: pointer; min-height: 34px; }
  .pf-row button:disabled { opacity: .5; cursor: wait; }
  .pf-row .pf-cancel { border-color: var(--border); background: none; }
  .pf-msg { margin: 0; font: 500 11.5px 'Manrope', sans-serif; color: #ff9fb5; }
  .pf-msg.ok { color: var(--green); }
</style>
