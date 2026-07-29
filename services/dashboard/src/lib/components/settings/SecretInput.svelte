<script lang="ts">
  /**
   * Password input for secrets. `value` holds only what the user typed in this
   * session (empty = unchanged). If the secret is already configured, the
   * server-masked value ("sk-abc12***xy") is shown as placeholder.
   */
  export let value = '';
  export let masked = '';       // masked current value from the server
  export let configured = false;
  export let disabled = false;
  export let placeholder = '';
  export let id = '';
  let reveal = false;
</script>

<div class="si">
  {#if reveal}
    <input
      {id}
      type="text"
      bind:value
      {disabled}
      placeholder={configured ? masked || '••••••••' : placeholder}
      autocomplete="off"
      spellcheck="false"
    />
  {:else}
    <input
      {id}
      type="password"
      bind:value
      {disabled}
      placeholder={configured ? masked || '••••••••' : placeholder}
      autocomplete="new-password"
      spellcheck="false"
    />
  {/if}
  <button
    type="button"
    class="eye"
    tabindex="-1"
    title={reveal ? 'Hide' : 'Show'}
    on:click={() => (reveal = !reveal)}
    disabled={disabled || !value}
  >
    {#if reveal}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
    {:else}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
    {/if}
  </button>
</div>

<style>
  .si { position: relative; display: flex; align-items: center; width: 100%; }
  input {
    width: 100%; padding: 6px 30px 6px 10px; border-radius: 6px; font-size: 12px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-mono); outline: none; box-sizing: border-box;
  }
  input:focus { border-color: var(--teal); }
  input:disabled { opacity: 0.5; }
  input::placeholder { color: var(--text-3); font-family: var(--font-mono); }
  .eye {
    position: absolute; right: 4px; width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: none; color: var(--text-3); cursor: pointer;
    border-radius: 4px; padding: 0;
  }
  .eye:hover:not(:disabled) { color: var(--text-1); background: var(--surface-3); }
  .eye:disabled { opacity: 0.35; cursor: default; }
</style>
