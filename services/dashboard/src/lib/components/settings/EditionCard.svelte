<script lang="ts">
  /** Settings: which edition this Kernl runs as, and switching it (add-only). */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { restartKernl, updating } from '$lib/update.js';
  import { fetchEdition, setEdition, type EditionMode, type EditionStatus } from '$lib/edition.js';

  let status: EditionStatus | null = null;
  let busy = false;
  let message = '';
  let needsRestart = false;
  let error = '';

  onMount(async () => {
    try { status = await fetchEdition(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  });

  async function choose(mode: EditionMode): Promise<void> {
    busy = true; error = ''; message = ''; needsRestart = false;
    try {
      const s = await setEdition(mode, { addOnly: true });
      status = { mode: s.mode, legacy: s.legacy, parked: s.parked };
      message = $t('edition.switched', { n: s.activated.length });
      needsRestart = s.activated.length > 0;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  $: other = (status?.mode === 'business' ? 'personal' : 'business') as EditionMode;
</script>

<section class="edition-card">
  <h3>{$t('edition.title')}</h3>
  {#if !status}
    {#if error}<p class="err">{error}</p>{/if}
  {:else if status.mode === null}
    <p>{$t('edition.unset')}</p>
    <div class="row">
      <button class="ed-btn" disabled={busy} on:click={() => choose('personal')}>{$t('edition.pick_personal')}</button>
      <button class="ed-btn" disabled={busy} on:click={() => choose('business')}>{$t('edition.pick_business')}</button>
    </div>
  {:else}
    <p>{$t(`edition.current_${status.mode}`)}</p>
    <div class="row">
      <button class="ed-btn" disabled={busy} on:click={() => choose(other)}>{$t(`edition.switch_to_${other}`)}</button>
      <span class="note">{$t('edition.switch_note')}</span>
    </div>
  {/if}
  {#if message}
    <p class="ok">{message}</p>
    {#if needsRestart}
      <div class="row">
        <span class="note">{$t('edition.restart_hint')}</span>
        <button class="ed-btn" disabled={$updating} on:click={restartKernl}>{$t('edition.restart_now')}</button>
      </div>
    {/if}
  {/if}
  {#if status && error}<p class="err">{error}</p>{/if}
</section>

<style>
  .edition-card { padding: 12px 0 16px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  h3 { margin: 0 0 6px; font-size: 15px; color: var(--text-1); }
  p { margin: 4px 0; color: var(--text-2); font-size: 13.5px; line-height: 1.5; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .note { font-size: 12px; color: var(--text-3); }
  .ok { color: var(--green); font-size: 13px; }
  .err { color: var(--red); font-size: 13px; }
  .ed-btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); border-radius: 6px; padding: 8px 14px; min-height: 36px; font: inherit; font-size: 13px; cursor: pointer; }
  .ed-btn:hover:not(:disabled) { background: var(--surface-3); }
  .ed-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .ed-btn:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
</style>
