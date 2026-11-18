<script lang="ts">
  /**
   * Settings → AI, on one screen: what Kernl thinks with and its backups,
   * every connection with a Test button, and the same connect dialog the setup
   * wizard uses. Reordering and the rest of the options stay out of the way.
   */
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { t, locale } from '$lib/i18n/index.js';
  import ProviderGrid from './ProviderGrid.svelte';
  import ProviderConnect from './ProviderConnect.svelte';
  import ClaudeSignIn from './ClaudeSignIn.svelte';
  import EmbeddingsNote from './EmbeddingsNote.svelte';
  import {
    addClaudeAccount, chainSummary, connectionRows, disconnectProvider, errorView, fetchCatalog, fetchClaudeAccounts,
    moveLink, removeClaudeAccount, saveChain, testProvider, timeAgo, updateClaudeAccount,
    type CatalogResponse, type ChainLink, type ClaudeLoginStatus,
  } from '$lib/llm-connect.js';
  import {
    accountIdent, accountState, isClaudeConnected, accountTitle, formatUntil, withClaudeAccounts,
    type ClaudeAccount, type ConnectionLine,
  } from '$lib/claude-accounts.js';

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

  // Claude Code accounts: extra rows of the list. `accountsSupported` stays false on a kernel without the
  // routes (404), which keeps today's single row and hides "Otra cuenta de Claude Code".
  const POLL_MS = 30_000;
  let accounts: ClaudeAccount[] = [];
  let accountsSupported = false;
  let accountsError = '';
  let now = Date.now();
  let accBusy = false;
  let menuFor = '';
  let renaming = '';
  let renameValue = '';
  let confirmAccount = '';
  /** Per-account message under its row (a refused removal, a failed rename). */
  let rowError: Record<string, string> = {};
  let signInId = '';
  let duplicate: NonNullable<ClaudeLoginStatus['duplicateOf']> | null = null;
  let addError = '';
  let timer: ReturnType<typeof setInterval> | null = null;
  // Bumped by every mutation: a poll that started before one must not overwrite the fresher list.
  let seq = 0;

  $: providers = catalog?.providers ?? [];
  $: claudeConnected = isClaudeConnected(providers);
  $: rows = withClaudeAccounts(connectionRows(providers, catalog?.chain ?? []), accounts);
  $: canAddAccount = accountsSupported && claudeConnected;
  $: signInAccount = accounts.find((a) => a.id === signInId) ?? null;
  $: summary = chainSummary(catalog?.chain ?? [], providers);
  $: dialogProvider = providers.find((p) => p.slug === dialogSlug) ?? null;

  // Reactive declarations, so the rows re-render when the language changes.
  $: accName = (a: ClaudeAccount, index: number): string => {
    const label = a.label.trim();
    return label || $t('llm.acc.unnamed', { n: index + 1 });
  };
  $: lineName = (l: ConnectionLine): string => {
    if (!l.account) return l.provider.name;
    if (!l.extra && !l.account.label.trim()) return l.provider.name;
    return $t('llm.acc.row_name', { name: accName(l.account, l.index) });
  };
  $: stateText = (a: ClaudeAccount, at: number): string => {
    const s = accountState(a, at);
    if (s.kind === 'disconnected') return $t('llm.acc.disconnected');
    if (s.kind === 'down') return $t('llm.acc.down');
    if (s.kind === 'ok') return $t('llm.acc.ok');
    const when = formatUntil(s.until, at, $locale);
    return s.model ? $t('llm.acc.limit_model', { model: s.model, when }) : $t('llm.acc.limit_all', { when });
  };
  $: signInName = signInAccount ? accName(signInAccount, accounts.indexOf(signInAccount)) : '';

  async function load(): Promise<void> {
    try {
      catalog = await fetchCatalog();
      loadError = '';
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      return;
    }
    // From the catalog just fetched: the `$:` copy only catches up on the next flush.
    await refreshAccounts(isClaudeConnected(catalog.providers));
  }

  let polling = false;
  async function refreshAccounts(connected: boolean): Promise<void> {
    if (!connected) { accounts = []; accountsSupported = false; accountsError = ''; return; }
    if (polling) return;
    polling = true;
    const mine = seq;
    try {
      const r = await fetchClaudeAccounts();
      if (mine === seq) { accounts = r.accounts; accountsSupported = r.supported; }
      accountsError = '';
    } catch (e) {
      accountsError = e instanceof Error ? e.message : String(e);
    } finally {
      polling = false;
    }
    now = Date.now();
  }

  /** Runs one account mutation; the kernel answers with the fresh list. */
  async function act(id: string, run: () => Promise<{ accounts: ClaudeAccount[] }>): Promise<boolean> {
    menuFor = '';
    rowError = { ...rowError, [id]: '' };
    accBusy = true;
    seq++;
    try {
      accounts = (await run()).accounts;
      seq++;
      now = Date.now();
      void load();
      return true;
    } catch (e) {
      rowError = { ...rowError, [id]: e instanceof Error ? e.message : String(e) };
      return false;
    } finally {
      accBusy = false;
    }
  }

  /** "Otra cuenta de Claude Code" in the connect dialog: create the account, then sign it in right there. */
  async function addAccount(): Promise<void> {
    if (accBusy) return;
    addError = '';
    accBusy = true;
    try {
      const before = new Set(accounts.map((a) => a.id));
      seq++;
      accounts = (await addClaudeAccount()).accounts;
      seq++;
      const fresh = accounts.find((a) => !before.has(a.id));
      if (fresh) await openSignIn(fresh.id);
    } catch (e) {
      addError = e instanceof Error ? e.message : String(e);
    } finally {
      accBusy = false;
    }
  }

  async function openSignIn(id: string): Promise<void> {
    menuFor = '';
    duplicate = null;
    addError = '';
    dialogSlug = '';
    signInId = id;
    await tick();
    if (!connectDialog.open) connectDialog.showModal();
  }

  async function signedIn(status?: ClaudeLoginStatus): Promise<void> {
    await load();
    if (status?.duplicateOf) {
      duplicate = status.duplicateOf;
      return;
    }
    closeConnect();
  }

  function onSelect(slug: string): void {
    if (slug === 'claude-code' && canAddAccount) void addAccount();
    else dialogSlug = slug;
  }

  function startRename(a: ClaudeAccount): void {
    menuFor = '';
    confirmAccount = '';
    renaming = a.id;
    renameValue = a.label;
  }

  async function saveRename(id: string): Promise<void> {
    const label = renameValue.trim();
    // Closed only once the kernel accepted it; a refusal keeps the typed text.
    if (await act(id, () => updateClaudeAccount(id, { label }))) renaming = '';
  }

  function toggleMenu(id: string): void {
    confirmAccount = '';
    menuFor = menuFor === id ? '' : id;
  }

  function onWindowClick(e: MouseEvent): void {
    if (menuFor && !(e.target as Element | null)?.closest?.('[data-acc-menu]')) menuFor = '';
  }

  function onWindowKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && menuFor) menuFor = '';
  }

  const focusOnMount = (node: HTMLInputElement) => { node.focus(); node.select(); };

  async function openConnect(slug = ''): Promise<void> {
    dialogSlug = slug;
    await tick();
    if (!connectDialog.open) connectDialog.showModal();
  }

  function closeConnect(): void {
    if (connectDialog.open) connectDialog.close();
    dialogSlug = '';
    signInId = '';
    duplicate = null;
    addError = '';
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
    // Before the first await, so a view destroyed meanwhile still clears it.
    timer = setInterval(() => void refreshAccounts(isClaudeConnected(catalog?.providers ?? [])), POLL_MS);
    await load();
    if (initialConnect && providers.some((p) => p.slug === initialConnect)) void openConnect(initialConnect);
  });
  onDestroy(() => { if (timer) clearInterval(timer); });
</script>

<svelte:window on:click={onWindowClick} on:keydown={onWindowKey} />

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

    <EmbeddingsNote />

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
          {#each rows as l (l.key)}
            {@const r = l.provider}
            {@const a = l.account}
            {@const last = l.extra ? null : r.lastTest}
            {@const st = a ? accountState(a, now) : null}
            {@const showState = !!a && (l.extra || (st && st.kind !== 'ok'))}
            {@const id = a?.id ?? r.slug}
            <li class="ai-item">
              <div class="ai-row">
                {#if a && showState && st}
                  <span class="ai-dot {st.kind}" aria-hidden="true"></span>
                {:else}
                  <span class="ai-dot" class:ok={last?.ok} class:err={last && !last.ok} aria-hidden="true"></span>
                {/if}
                <img src={r.logo} alt="" width="22" height="22" />

                {#if a && renaming === a.id}
                  <form class="ai-rename" on:submit|preventDefault={() => saveRename(a.id)}>
                    <input class="ai-input" bind:value={renameValue} maxlength="80" use:focusOnMount
                           aria-label={$t('llm.acc.rename_label')}
                           on:keydown={(e) => { if (e.key === 'Escape') renaming = ''; }} />
                    <button type="submit" class="ai-btn primary" disabled={accBusy}>{$t('llm.save')}</button>
                    <button type="button" class="ai-btn ghost" on:click={() => (renaming = '')}>{$t('llm.cancel')}</button>
                  </form>
                {:else}
                  <span class="ai-name" class:ai-name-acc={!!a}>
                    <span class="ai-name-row">
                      <span class="ai-name-t" title={lineName(l)}>{lineName(l)}</span>
                      {#if l.multi && !l.extra}<span class="ai-chip" title={$t('llm.acc.primary_hint')}>{$t('llm.acc.primary')}</span>{/if}
                    </span>
                    <!-- Which subscription this row is: the email is what tells two accounts apart. -->
                    {#if a}
                      {#if accountIdent(a)}<span class="ai-email" title={accountIdent(a)}>{accountIdent(a)}</span>
                      {:else}<span class="ai-email none">{$t('llm.acc.no_email')}</span>{/if}
                    {/if}
                  </span>
                  <span class="ai-modelcol">
                    {#if !l.extra}<span class="ai-model">{r.model || '—'}</span>{/if}
                  </span>
                  <span class="ai-meta" class:ai-state={showState} class:limited={st?.kind === 'limited'} class:down={st?.kind === 'down'}
                        role="status" aria-live="polite">
                    {#if showState && a}{stateText(a, now)}
                    {:else if testing[r.slug]}{$t('llm.state.testing')}
                    {:else if last}
                      {$t('llm.tested', { ago: $t(timeAgo(last.at).key, { n: timeAgo(last.at).n }) })}
                      {#if last.ok} · {last.latencyMs} ms{:else} · {$t(errorView(last.code).messageKey, { name: r.name, url: r.baseUrl })}{/if}
                    {:else}{$t('llm.never_tested')}{/if}
                  </span>
                  <span class="ai-row-actions" data-acc-menu>
                    {#if a && confirmAccount === a.id}
                      <span class="ai-confirm">{$t('llm.acc.remove_confirm', { name: accName(a, l.index) })}</span>
                      <button type="button" class="ai-btn ghost" on:click={() => (confirmAccount = '')}>{$t('llm.cancel')}</button>
                      <button type="button" class="ai-btn danger" disabled={accBusy}
                              on:click={async () => { const aid = a.id; confirmAccount = ''; await act(aid, () => removeClaudeAccount(aid)); }}>{$t('llm.remove')}</button>
                    {:else if !l.extra && confirmRemove === r.slug}
                      <span class="ai-confirm">{$t('llm.remove_confirm', { name: r.name })}</span>
                      <button type="button" class="ai-btn ghost" on:click={() => (confirmRemove = '')}>{$t('llm.cancel')}</button>
                      <button type="button" class="ai-btn danger" on:click={() => remove(r.slug)}>{$t('llm.remove')}</button>
                    {:else}
                      {#if a && !a.connected && (l.extra || l.multi)}
                        <button type="button" class="ai-btn primary" on:click={() => openSignIn(a.id)}>{$t('llm.acc.connect')}</button>
                      {/if}
                      {#if !l.extra}
                        <button type="button" class="ai-btn ghost" disabled={testing[r.slug]} on:click={() => test(r.slug)}>{$t('llm.test')}</button>
                        <button type="button" class="ai-btn ghost" on:click={() => openConnect(r.slug)}>{$t('llm.edit')}</button>
                      {/if}
                      {#if a && l.multi}
                        <button type="button" class="ai-more" aria-haspopup="menu" aria-expanded={menuFor === a.id}
                                aria-label={$t('llm.acc.menu', { name: lineName(l) })} on:click={() => toggleMenu(a.id)}>⋯</button>
                        {#if menuFor === a.id}
                          <ul class="ai-menu" role="menu">
                            <li role="none"><button type="button" role="menuitem" on:click={() => openSignIn(a.id)}>{$t('llm.acc.reconnect')}</button></li>
                            <li role="none"><button type="button" role="menuitem" on:click={() => startRename(a)}>{$t('llm.acc.rename')}</button></li>
                            <li role="none"><button type="button" role="menuitem" disabled={l.index === 0 || accBusy} on:click={() => act(a.id, () => updateClaudeAccount(a.id, { move: 'up' }))}>{$t('llm.move_up')}</button></li>
                            <li role="none"><button type="button" role="menuitem" disabled={l.index === accounts.length - 1 || accBusy} on:click={() => act(a.id, () => updateClaudeAccount(a.id, { move: 'down' }))}>{$t('llm.move_down')}</button></li>
                            {#if !l.extra}
                              <li role="none"><button type="button" role="menuitem" on:click={() => { menuFor = ''; confirmRemove = ''; confirmAccount = a.id; }}>{$t('llm.acc.remove_account')}</button></li>
                              <li role="none"><button type="button" role="menuitem" class="danger" on:click={() => { menuFor = ''; confirmAccount = ''; confirmRemove = r.slug; }}>{$t('llm.acc.remove_provider')}</button></li>
                            {/if}
                          </ul>
                        {/if}
                      {/if}
                      {#if l.extra && a}
                        <button type="button" class="ai-btn ghost" on:click={() => { menuFor = ''; confirmAccount = a.id; }}>{$t('llm.remove')}</button>
                      {:else if !l.multi}
                        <button type="button" class="ai-btn ghost" on:click={() => (confirmRemove = r.slug)}>{$t('llm.remove')}</button>
                      {/if}
                    {/if}
                  </span>
                {/if}
              </div>
              {#if rowError[id]}<p class="ai-rowerr" role="alert">{rowError[id]}</p>{/if}
              {#if accountsError && r.slug === 'claude-code' && !l.extra}<p class="ai-rowmuted">{accountsError}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<dialog class="ai-dialog" bind:this={connectDialog} aria-labelledby="ai-dialog-title" on:close={() => { dialogSlug = ''; signInId = ''; duplicate = null; addError = ''; }}>
  <header class="ai-dialog-head">
    <h2 id="ai-dialog-title">{signInId ? $t('llm.acc.signin_title', { name: signInName }) : dialogProvider ? dialogProvider.name : $t('llm.title')}</h2>
    <button type="button" class="ai-btn ghost" on:click={closeConnect}>{$t('llm.close')}</button>
  </header>
  {#if signInId}
    {#if duplicate}
      <p class="ai-notice" role="alert">{$t('llm.acc.duplicate', { label: duplicate.label, email: duplicate.email })}</p>
    {/if}
    {#key signInId}
      <ClaudeSignIn accountId={signInId} onDone={signedIn} />
    {/key}
  {:else if dialogProvider}
    {#key dialogProvider.slug}
      <ProviderConnect
        provider={dialogProvider}
        loginCommand={catalog?.claudeCodeLoginCommand ?? 'claude'}
        browserLogin={catalog?.claudeCodeBrowserLogin ?? false}
        pasteLogin={catalog?.claudeCodePasteLogin ?? false}
        on:back={() => (dialogSlug = '')}
        on:connected={onConnected}
      />
    {/key}
  {:else if catalog}
    {#if addError}<p class="ai-error" role="alert">{addError}</p>{/if}
    <ProviderGrid providers={catalog.providers} anotherClaude={canAddAccount} on:select={(e) => onSelect(e.detail)} />
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
  .ai-item { border-bottom: 1px solid var(--border); }
  .ai-item:last-child { border-bottom: 0; }
  .ai-row {
    display: grid; grid-template-columns: 10px 22px minmax(90px, 190px) minmax(120px, 1fr) minmax(140px, 1.2fr) auto;
    align-items: center; gap: 10px; min-height: 44px; padding: 4px 14px;
  }
  .ai-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ai-name-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-modelcol { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .ai-name-acc { flex-direction: column; align-items: flex-start; gap: 1px; }
  .ai-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
  .ai-email { font-size: 12px; font-weight: 500; color: #22D3EE; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-email.none { color: var(--text-3); font-style: italic; }
  .ai-chip {
    flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
    color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 65%, transparent);
    background: color-mix(in srgb, var(--gold) 10%, transparent);
  }
  .ai-meta.ai-state { font-weight: 600; color: var(--green); }
  .ai-meta.ai-state.limited { color: var(--orange); }
  .ai-meta.ai-state.down { color: var(--red); }
  .ai-rowerr { margin: 0; padding: 0 14px 6px 56px; font-size: 12px; color: var(--red); }
  .ai-rowmuted { margin: 0; padding: 0 14px 6px 56px; font-size: 12px; color: var(--text-2); }
  .ai-rename { grid-column: 3 / -1; display: flex; gap: 6px; align-items: center; }
  .ai-input {
    flex: 1; min-width: 0; min-height: 34px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-1); color: var(--text-1); font-size: 13px;
  }
  .ai-input:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .ai-more {
    width: 34px; height: 34px; border-radius: var(--radius-sm); border: 1px solid transparent; background: transparent;
    color: var(--text-1); font-size: 18px; line-height: 1; cursor: pointer; transition: border-color 150ms ease-out;
  }
  .ai-more:hover, .ai-more[aria-expanded='true'] { border-color: var(--border-h); }
  .ai-more:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .ai-menu {
    position: absolute; top: 100%; right: 0; z-index: 20; min-width: 170px; margin: 2px 0 0; padding: 4px; list-style: none;
    border: 1px solid var(--border-h); border-radius: var(--radius-sm); background: var(--surface-1); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .ai-menu button {
    display: block; width: 100%; min-height: 34px; padding: 6px 10px; border: 0; border-radius: 4px; background: transparent;
    color: var(--text-1); font-size: 13px; text-align: left; cursor: pointer;
  }
  .ai-menu button:hover:not(:disabled), .ai-menu button:focus-visible { background: var(--surface-3); outline: none; }
  .ai-menu button.danger { color: var(--red); }
  .ai-menu button:disabled { opacity: 0.4; cursor: not-allowed; }
  .ai-row img { border-radius: 5px; }
  .ai-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .ai-meta { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
  .ai-dot.ok { background: var(--green); }
  .ai-dot.err { background: var(--red); }
  .ai-dot.limited { background: var(--orange); }
  .ai-dot.down { background: var(--red); }
  .ai-dot.disconnected { background: var(--text-3); }
  .ai-row-actions { position: relative; display: flex; gap: 6px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
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
    .ai-modelcol, .ai-meta { display: none; }
    .ai-rename { grid-column: 3 / -1; }
  }
  @media (prefers-reduced-motion: reduce) { .ai-btn, .ai-more { transition: none; } }
</style>
