<script lang="ts">
  /**
   * The edition choice: personal or business. Two big cards, one click.
   * It decides which free extensions start active; it never locks anything.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { setEdition, type EditionMode } from '$lib/edition.js';

  const dispatch = createEventDispatcher<{ done: EditionMode }>();
  let saving: EditionMode | null = null;
  let error = '';

  const OPTIONS: Array<{ mode: EditionMode; icon: string }> = [
    { mode: 'personal', icon: '🏠' },
    { mode: 'business', icon: '🏢' },
  ];

  async function pick(mode: EditionMode): Promise<void> {
    if (saving) return;
    saving = mode;
    error = '';
    try {
      const summary = await setEdition(mode);
      if (summary.failed.length) console.warn('[edition] some extensions did not switch', summary.failed);
      dispatch('done', mode);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = null;
    }
  }
</script>

<h2>{$t('setup.edition_title')}</h2>
<p class="step-lede">{$t('setup.edition_lede')}</p>

<div class="edition-grid">
  {#each OPTIONS as o (o.mode)}
    <button class="edition-card" class:busy={saving === o.mode} disabled={!!saving} on:click={() => pick(o.mode)}>
      <span class="edition-icon" aria-hidden="true">{o.icon}</span>
      <span class="edition-name">{$t(`setup.edition_${o.mode}`)}</span>
      <span class="edition-tag">{$t(`setup.edition_${o.mode}_tag`)}</span>
      <span class="edition-items">{$t(`setup.edition_${o.mode}_items`)}</span>
      {#if saving === o.mode}<span class="edition-saving">{$t('setup.edition_saving')}</span>{/if}
    </button>
  {/each}
</div>
{#if error}<p class="edition-error" role="alert">{error}</p>{/if}

<style>
  /* The wizard hardcodes its palette (no CSS variables), and its scoped
     heading styles do not reach into this component, so both live here. */
  h2 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 8px; color: #fff; }
  .step-lede { max-width: 64ch; color: #b8bdd1; font-size: 14px; line-height: 1.6; margin: 0 0 28px; }
  .edition-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  @media (max-width: 640px) { .edition-grid { grid-template-columns: 1fr; } }
  .edition-card {
    display: flex; flex-direction: column; align-items: flex-start; gap: 8px; text-align: left;
    padding: 24px; border-radius: 14px; border: 1px solid #232742;
    background: rgba(99,102,241,0.04); color: inherit; cursor: pointer; font: inherit;
    transition: border-color .15s, transform .15s, background .15s;
  }
  .edition-card:hover:not(:disabled) { border-color: #6366f1; background: rgba(99,102,241,0.08); transform: translateY(-2px); }
  .edition-card:disabled { cursor: progress; opacity: .7; }
  .edition-card.busy { opacity: 1; border-color: #6366f1; }
  .edition-icon { font-size: 34px; line-height: 1; }
  .edition-name { font-size: 20px; font-weight: 700; color: #fff; }
  .edition-tag { color: #b8bdd1; }
  .edition-items { font-size: 13px; color: #8b91a8; }
  .edition-saving { font-size: 13px; color: #3dd6c8; }
  .edition-error { color: #ff8888; margin-top: 12px; }
</style>
