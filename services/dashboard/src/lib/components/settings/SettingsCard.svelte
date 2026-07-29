<script lang="ts">
  /**
   * Card with title, optional description, content slot and a footer holding
   * the Save button + dirty/saving/saved/error state. Emits `save`.
   * Set `showFooter={false}` for cards that manage their own actions.
   */
  import { createEventDispatcher } from 'svelte';

  export let title = '';
  export let description = '';
  export let dirty = false;
  export let saving = false;
  export let savedMsg = '';
  export let error = '';
  export let saveLabel = 'Save';
  export let savingLabel = 'Saving…';
  export let showFooter = true;
  export let cardId = '';

  const dispatch = createEventDispatcher();
</script>

<section class="sc" id={cardId ? `card-${cardId}` : undefined}>
  {#if title || description || $$slots.header}
    <header>
      <div class="hd-text">
        {#if title}<h3>{title}</h3>{/if}
        {#if description}<p>{description}</p>{/if}
      </div>
      <slot name="header" />
    </header>
  {/if}

  <div class="body"><slot /></div>

  {#if showFooter}
    <footer>
      <span class="state">
        {#if error}<span class="err">{error}</span>
        {:else if savedMsg}<span class="ok">{savedMsg}</span>
        {:else if dirty}<span class="dirty">●</span>{/if}
      </span>
      <slot name="footer-extra" />
      <button class="save" disabled={!dirty || saving} on:click={() => dispatch('save')}>
        {saving ? savingLabel : saveLabel}
      </button>
    </footer>
  {/if}
</section>

<style>
  .sc {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px;
    margin-bottom: 12px; overflow: hidden;
  }
  header {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
    padding: 10px 14px 8px;
  }
  .hd-text { min-width: 0; }
  h3 {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-2); margin: 0;
  }
  p { font-size: 10px; color: var(--text-3); margin: 3px 0 0; line-height: 1.4; }
  .body { padding: 0 8px 8px; }
  footer {
    display: flex; align-items: center; justify-content: flex-end; gap: 10px;
    padding: 8px 14px; border-top: 1px solid var(--border); background: var(--surface-2);
  }
  .state { font-size: 10px; margin-right: auto; }
  .ok { color: #4ade80; }
  .err { color: #f87171; }
  .dirty { color: var(--teal); font-size: 9px; }
  .save {
    padding: 5px 16px; border-radius: 6px; font-size: 11px; font-weight: 600;
    cursor: pointer; border: 1px solid var(--teal); background: var(--teal); color: var(--bg);
    font-family: var(--font-body); transition: opacity 0.15s;
  }
  .save:hover:not(:disabled) { opacity: 0.85; }
  .save:disabled { opacity: 0.35; cursor: default; }
</style>
