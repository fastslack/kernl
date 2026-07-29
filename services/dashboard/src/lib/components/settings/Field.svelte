<script lang="ts">
  /**
   * Generic catalog field: label + description + control chosen by `type`
   * (secret → SecretInput, boolean → Toggle, number → number input,
   * json → mono textarea, string → text input).
   *
   * `value` is always a string (the settings API is string-based).
   * For secrets, `value` holds only newly-typed text; the masked current
   * value goes in `masked`.
   */
  import SecretInput from './SecretInput.svelte';
  import Toggle from './Toggle.svelte';

  export let fieldKey = '';
  export let label = '';
  export let description = '';
  export let type = 'string'; // string | number | boolean | secret | json
  export let value = '';
  export let masked = '';
  export let configured = false;
  export let readonly = false;
  export let error = '';
  export let highlight = false;
  export let placeholder = '';

  const truthy = (v: string) => v === 'true' || v === '1' || v === 'yes' || v === 'on';

  function setBool(next: boolean) {
    value = next ? 'true' : 'false';
  }
</script>

<div class="fld" class:highlight id={fieldKey ? `field-${fieldKey}` : undefined}>
  <div class="meta">
    <div class="lbl-row">
      <label class="lbl" for={`in-${fieldKey}`}>{label}</label>
      {#if readonly}<span class="ro">read-only</span>{/if}
    </div>
    {#if description}<span class="desc">{description}</span>{/if}
    <span class="key">{fieldKey}</span>
  </div>

  <div class="ctrl">
    {#if type === 'secret'}
      <SecretInput id={`in-${fieldKey}`} bind:value {masked} {configured} disabled={readonly} {placeholder} />
    {:else if type === 'boolean'}
      <Toggle id={`in-${fieldKey}`} checked={truthy(value)} disabled={readonly}
        on:click={() => { if (!readonly) setBool(!truthy(value)); }} />
    {:else if type === 'number'}
      <input
        id={`in-${fieldKey}`}
        class="in num"
        type="number"
        value={value}
        disabled={readonly}
        {placeholder}
        on:input={(e) => (value = e.currentTarget.value)}
      />
    {:else if type === 'json'}
      <textarea
        id={`in-${fieldKey}`}
        class="in json"
        rows="3"
        spellcheck="false"
        disabled={readonly}
        {placeholder}
        bind:value
      />
    {:else}
      <input
        id={`in-${fieldKey}`}
        class="in"
        type="text"
        disabled={readonly}
        {placeholder}
        bind:value
        spellcheck="false"
      />
    {/if}
    {#if error}<span class="err">{error}</span>{/if}
  </div>
</div>

<style>
  .fld {
    display: grid; grid-template-columns: minmax(180px, 1fr) minmax(200px, 1.2fr);
    gap: 4px 16px; align-items: start;
    padding: 8px 6px; border-radius: 6px;
    border-bottom: 1px solid var(--border);
    transition: background 0.4s, box-shadow 0.4s;
  }
  .fld:last-child { border-bottom: none; }
  .fld.highlight { background: rgba(61, 214, 200, 0.08); box-shadow: inset 0 0 0 1px var(--teal); }

  .meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .lbl-row { display: flex; align-items: center; gap: 6px; }
  .lbl { font-size: 12px; font-weight: 600; color: var(--text-1); cursor: pointer; }
  .ro {
    font: 600 8px var(--font-mono); text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-3); border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px;
  }
  .desc { font-size: 10px; color: var(--text-2); line-height: 1.4; }
  .key { font: 400 9px var(--font-mono); color: var(--text-3); word-break: break-all; }

  .ctrl { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .in {
    width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); outline: none; box-sizing: border-box;
  }
  .in:focus { border-color: var(--teal); }
  .in:disabled { opacity: 0.5; }
  .in.num { max-width: 140px; font-family: var(--font-mono); }
  .in.json { font-family: var(--font-mono); font-size: 11px; resize: vertical; min-height: 54px; }
  .err { font-size: 10px; color: #f87171; }

  @media (max-width: 640px) {
    .fld { grid-template-columns: 1fr; }
  }
</style>
