<script lang="ts">
  /**
   * Settings → AI, on one screen: what Kernl thinks with and its backups,
   * every connection with a Test button, and the same connect dialog the setup
   * wizard uses. Reordering and the rest of the options stay out of the way.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import ProviderGrid from './ProviderGrid.svelte';
  import ProviderConnect from './ProviderConnect.svelte';
  import {
    chainSummary, connectionRows, disconnectProvider, errorView, fetchCatalog, moveLink, saveChain,
    testProvider, timeAgo, type CatalogResponse, type ChainLink,
  } from '$lib/llm-connect.js';

  /** Slug from `?connect=` — opens the dialog on that provider. */
  export let initialConnect = '';

  const dispatch = createEventDispatcher<{ advanced: void }>();

  let catalog: CatalogResponse | null = null;
  let loadError = '';
  let testing: Record<string, boolean> = {};
  let confirmRemove = '';
  let connectDialog: HTMLDialogElement;
  let chainDialog: HTMLDialogElement;
  let dialogSlug = '';
  let draftChain: ChainLink[] = [];
  let chainSaving = false;

  $: providers = catalog?.providers ?? [];
  $: rows = connectionRows(providers, catalog?.chain ?? []);
  $: summary = chainSummary(catalog?.chain ?? [], providers);
  $: dialogProvider = providers.find((p) => p.slug === dialogSlug) ?? null;

  async function load(): Promise<void> {
    try {
      catalog = await fetchCatalog();
      loadError = '';
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  async function openConnect(slug = ''): Promise<void> {
    dialogSlug = slug;
    await tick();
    if (!connectDialog.open) connectDialog.showModal();
  }

  function closeConnect(): void {
    if (connectDialog.open) connectDialog.close();
    dialogSlug = '';
  }

  async function onConnected(): Promise<void> {
    closeConnect();
    await load();
  }

  async function test(slug: string): Promise<void> {
    testing = { ...testing, [slug]: true };
    try { await testProvider(slug); } catch { /* the row shows the stored verdict */ }
    testing = { ...testing, [slug]: false };
    await load();
  }

  async function remove(slug: string): Promise<void> {
    confirmRemove = '';
    try { await disconnectProvider(slug); } finally { await load(); }
  }

  function openChain(): void {
    draftChain = (catalog?.chain ?? []).map((l) => ({ ...l }));
    chainDialog.showModal();
  }

  async function saveDraftChain(): Promise<void> {
    chainSaving = true;
    try {
      await saveChain(draftChain);
      chainDialog.close();
      await load();
    } finally {
      chainSaving = false;
    }
  }

  const nameOf = (slug: string) => providers.find((p) => p.slug === slug)?.name ?? slug;

  onMount(async () => {
    await load();
    if (initialConnect && providers.some((p) => p.slug === initialConnect)) void openConnect(initialConnect);
  });
</script>

<div class="ai" id="card-providers">
  {#if loadError}
    <p class="ai-error" role="alert">{loadError}</p>
  {:else if !catalog}
    <p class="ai-muted">{$t('settings.loading')}</p>
  {:else}
    <section class="ai-strip" aria-label={$t('llm.thinks_with')}>
      <div class="ai-strip-main">
        <span class="ai-k">{$t('llm.thinks_with')}</span>
        {#if summary.primary}
          <strong>{summary.primary.name}</strong><span class="ai-model">{summary.primary.model}</span>
          <span class="ai-k">→ {$t('llm.fallback_to')}</span>
          {#if summary.fallbacks.length}
            {#each summary.fallbacks as f, i (f.slug + i)}<span class="ai-fb">{f.name}</span>{/each}
          {:else}<span class="ai-muted">{$t('llm.no_fallback')}</span>{/if}
        {:else}
          <span class="ai-muted">{$t('llm.none_yet')}</span>
        {/if}
      </div>
      <div class="ai-strip-actions">
        {#if (catalog.chain ?? []).length > 1}<button type="button" class="ai-btn ghost" on:click={openChain}>{$t('llm.reorder')}</button>{/if}
        <button type="button" class="ai-btn ghost" on:click={() => dispatch('advanced')}>{$t('llm.advanced')}</button>
      </div>
    </section>

    {#if catalog.claudeCodeTransition === 'legacy-token'}
      <p class="ai-notice" role="note">{$t('llm.cc_transition')}</p>
    {/if}

    <section class="ai-list" aria-labelledby="ai-conn-title">
      <header class="ai-list-head">
        <h2 id="ai-conn-title">{$t('llm.connections')}</h2>
        <button type="button" class="ai-btn primary" on:click={() => openConnect('')}>+ {$t('llm.connect_provider')}</button>
      </header>

      {#if rows.length === 0}
        <div class="ai-empty">
          <p>{$t('llm.empty_title')}</p>
          <div class="ai-row-actions">
            <button type="button" class="ai-btn primary" on:click={() => openConnect('nvidia')}>{$t('llm.empty_cta')}</button>
            <button type="button" class="ai-btn ghost" on:click={() => openConnect('')}>{$t('llm.see_all')}</button>
          </div>
        </div>
      {:else}
        <ul class="ai-rows">
          {#each rows as r (r.slug)}
            {@const last = r.lastTest}
            <li class="ai-row">
              <span class="ai-dot" class:ok={last?.ok} class:err={last && !last.ok} aria-hidden="true"></span>
              <img src={r.logo} alt="" width="22" height="22" />
              <span class="ai-name">{r.name}</span>
              <span class="ai-model">{r.model || '—'}</span>
              <span class="ai-meta" role="status" aria-live="polite">
                {#if testing[r.slug]}{$t('llm.state.testing')}
                {:else if last}
                  {$t('llm.tested', { ago: $t(timeAgo(last.at).key, { n: timeAgo(last.at).n }) })}
                  {#if last.ok} · {last.latencyMs} ms{:else} · {$t(errorView(last.code).messageKey, { name: r.name, url: r.baseUrl })}{/if}
                {:else}{$t('llm.never_tested')}{/if}
              </span>
              <span class="ai-row-actions">
                {#if confirmRemove === r.slug}
                  <span class="ai-confirm">{$t('llm.remove_confirm', { name: r.name })}</span>
                  <button type="button" class="ai-btn ghost" on:click={() => (confirmRemove = '')}>{$t('llm.cancel')}</button>
                  <button type="button" class="ai-btn danger" on:click={() => remove(r.slug)}>{$t('llm.remove')}</button>
                {:else}
                  <button type="button" class="ai-btn ghost" disabled={testing[r.slug]} on:click={() => test(r.slug)}>{$t('llm.test')}</button>
                  <button type="button" class="ai-btn ghost" on:click={() => openConnect(r.slug)}>{$t('llm.edit')}</button>
                  <button type="button" class="ai-btn ghost" on:click={() => (confirmRemove = r.slug)}>{$t('llm.remove')}</button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<dialog class="ai-dialog" bind:this={connectDialog} aria-labelledby="ai-dialog-title" on:close={() => (dialogSlug = '')}>
  <header class="ai-dialog-head">
    <h2 id="ai-dialog-title">{dialogProvider ? dialogProvider.name : $t('llm.title')}</h2>
    <button type="button" class="ai-btn ghost" on:click={closeConnect}>{$t('llm.close')}</button>
  </header>
  {#if dialogProvider}
    {#key dialogProvider.slug}
      <ProviderConnect
        provider={dialogProvider}
        loginCommand={catalog?.claudeCodeLoginCommand ?? 'claude'}
        on:back={() => (dialogSlug = '')}
        on:connected={onConnected}
      />
    {/key}
  {:else if catalog}
    <ProviderGrid providers={catalog.providers} on:select={(e) => (dialogSlug = e.detail)} />
  {/if}
</dialog>

<dialog class="ai-dialog narrow" bind:this={chainDialog} aria-labelledby="ai-chain-title">
  <header class="ai-dialog-head">
    <h2 id="ai-chain-title">{$t('llm.chain_title')}</h2>
  </header>
  <p class="ai-muted">{$t('llm.chain_hint')}</p>
  <ol class="ai-chain">
    {#each draftChain as link, i (link.provider + i)}
      <li>
        <span class="ai-n">{i + 1}</span>
        <span class="ai-name">{nameOf(link.provider)}</span>
        <span class="ai-model">{link.model}</span>
        <button type="button" class="ai-btn ghost" aria-label={$t('llm.move_up')} disabled={i === 0} on:click={() => (draftChain = moveLink(draftChain, i, -1))}>↑</button>
        <button type="button" class="ai-btn ghost" aria-label={$t('llm.move_down')} disabled={i === draftChain.length - 1} on:click={() => (draftChain = moveLink(draftChain, i, 1))}>↓</button>
      </li>
    {/each}
  </ol>
  <footer class="ai-row-actions end">
    <button type="button" class="ai-btn ghost" on:click={() => chainDialog.close()}>{$t('llm.cancel')}</button>
    <button type="button" class="ai-btn primary" disabled={chainSaving} on:click={saveDraftChain}>{$t('llm.save')}</button>
  </footer>
</dialog>

<style>
  .ai { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .ai-strip {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2);
  }
  .ai-strip-main { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; flex: 1; min-width: 0; font-size: 14px; color: var(--text-1); }
  .ai-strip-actions { display: flex; gap: 8px; }
  .ai-k { font-size: 12px; color: var(--text-2); }
  .ai-model { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-fb { padding: 2px 8px; border-radius: 999px; background: var(--surface-3); font-size: 12px; }
  .ai-muted { margin: 0; font-size: 13px; color: var(--text-2); }
  .ai-error { margin: 0; color: var(--red); }
  .ai-notice { margin: 0; padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid color-mix(in srgb, var(--orange) 40%, var(--border)); color: var(--orange); font-size: 13px; }
  .ai-list { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); min-height: 0; display: flex; flex-direction: column; }
  .ai-list-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .ai-list-head h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-1); }
  .ai-rows { list-style: none; margin: 0; padding: 0; }
  .ai-row {
    display: grid; grid-template-columns: 10px 22px minmax(90px, 150px) minmax(120px, 1fr) minmax(140px, 1.2fr) auto;
    align-items: center; gap: 10px; min-height: 44px; padding: 4px 14px; border-bottom: 1px solid var(--border);
  }
  .ai-row:last-child { border-bottom: 0; }
  .ai-row img { border-radius: 5px; }
  .ai-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .ai-meta { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
  .ai-dot.ok { background: var(--green); }
  .ai-dot.err { background: var(--red); }
  .ai-row-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
  .ai-row-actions.end { margin-top: 12px; }
  .ai-confirm { font-size: 12px; color: var(--text-1); }
  .ai-empty { padding: 20px 14px; display: grid; gap: 10px; justify-items: start; color: var(--text-1); }
  .ai-empty p { margin: 0; }
  .ai-btn {
    min-height: 34px; padding: 6px 12px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600; cursor: pointer;
    transition: border-color 150ms ease-out, background 150ms ease-out;
  }
  .ai-btn:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .ai-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .ai-btn.ghost { border: 1px solid var(--border); background: transparent; color: var(--text-1); }
  .ai-btn.ghost:hover:not(:disabled) { border-color: var(--border-h); }
  .ai-btn.primary { border: 1px solid var(--teal); background: var(--teal); color: #06201d; }
  .ai-btn.danger { border: 1px solid var(--red); background: transparent; color: var(--red); }
  .ai-dialog {
    /* A modal <dialog> centres itself through `margin: auto`, which the app's
       global reset zeroes — without this it opens pinned to the top-left. */
    margin: auto;
    width: min(980px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); padding: 16px; overflow: hidden;
    border: 1px solid var(--border-h); border-radius: var(--radius); background: var(--surface-1); color: var(--text-1);
  }
  .ai-dialog.narrow { width: min(520px, calc(100vw - 32px)); }
  .ai-dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
  .ai-dialog-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .ai-dialog-head h2 { margin: 0; font-size: 16px; }
  .ai-chain { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
  .ai-chain li { display: grid; grid-template-columns: 22px 1fr minmax(0, 1fr) auto auto; gap: 8px; align-items: center; }
  .ai-n { font-size: 12px; color: var(--teal); font-weight: 700; }
  @media (max-width: 900px) {
    .ai-row { grid-template-columns: 10px 22px 1fr auto; }
    .ai-model, .ai-meta { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .ai-btn { transition: none; } }
</style>
