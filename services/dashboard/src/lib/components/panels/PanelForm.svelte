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
  .pf {
    display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 12px;
    background: linear-gradient(160deg, color-mix(in srgb, #A78BFA 10%, var(--surface-1)), var(--surface-1) 65%);
    border: 1px solid color-mix(in srgb, #A78BFA 28%, var(--border));
  }
  .pf-f { display: flex; flex-direction: column; gap: 4px; }
  .pf-f span { font: 800 9.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .06em; color: #A78BFA; }
  .pf-f input[type=text], .pf-f input[type=number], .pf-f select, .pf-f textarea {
    padding: 8px 11px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-1);
    font: 500 12.5px 'Manrope', sans-serif; min-height: 36px; transition: border-color .2s, box-shadow .2s;
  }
  .pf-f input:focus, .pf-f select:focus, .pf-f textarea:focus { outline: none; border-color: #22D3EE; box-shadow: 0 0 0 3px color-mix(in srgb, #22D3EE 18%, transparent); }
  .pf-f input[type=checkbox] { accent-color: #22D3EE; width: 18px; height: 18px; }
  .pf-row { display: flex; gap: 8px; }
  .pf-row button {
    padding: 0 16px; border-radius: 10px; cursor: pointer; min-height: 38px; font: 800 12.5px 'Manrope', sans-serif; color: #0b1020;
    border: 0; background: linear-gradient(135deg, #22D3EE, #A78BFA); box-shadow: 0 10px 22px -12px #22D3EE;
    transition: transform .2s ease-out, box-shadow .2s, filter .2s;
  }
  .pf-row button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); box-shadow: 0 14px 26px -12px #A78BFA; }
  .pf-row button:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }
  .pf-row button:disabled { opacity: .5; cursor: wait; }
  .pf-row .pf-cancel { color: var(--text-1); background: var(--surface-2); border: 1px solid var(--border); box-shadow: none; }
  .pf-msg { margin: 0; padding: 8px 12px; border-radius: 9px; font: 600 12px 'Manrope', sans-serif; color: #ff9fb5; background: color-mix(in srgb, #F43F5E 12%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 35%, transparent); }
  .pf-msg.ok { color: #34D399; background: color-mix(in srgb, #34D399 12%, transparent); border-color: color-mix(in srgb, #34D399 35%, transparent); }
  @media (prefers-reduced-motion: reduce) { .pf-row button { transition: none; } .pf-row button:hover:not(:disabled) { transform: none; } }
</style>
