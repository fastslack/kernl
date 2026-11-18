<script lang="ts">
  /**
   * Settings → General → Menu: show/hide and reorder the groups at the top of
   * the sidebar. Chat and System stay pinned at the bottom and are not listed.
   *
   * Tools keeps its own switch (DASHBOARD_SHOW_TOOLS_MENU, off by default), so
   * its row writes that key instead of the hidden list: one control, one key.
   *
   * The edition (Personal / Empresa) hides the other audience's menus by
   * default. A row it hides starts off and says so; switching it on stores it
   * as `shown`, so the user's choice wins over the edition's.
   */
  import { onMount, onDestroy } from 'svelte';
  import { fetchEdition, type EditionMode } from '$lib/edition.js';
  import { t } from '$lib/i18n/index.js';
  import SettingsCard from './SettingsCard.svelte';
  import Toggle from './Toggle.svelte';
  import {
    shellNavGroups, orderNavGroups, parseNavPrefs, serializeNavPrefs, isNavGroupVisible,
    NAV_LAYOUT_KEY, SHOW_TOOLS_KEY,
  } from '$lib/nav-prefs.js';

  /** Raw stored values, from the settings catalog. */
  export let layoutValue = '';
  export let showToolsValue = '';

  type Row = { id: string; label: string; icon: string; visible: boolean; byEdition: boolean };

  let editionHidden: string[] = [];
  let editionMode: EditionMode | null = null;
  async function loadEdition() {
    try {
      const s = await fetchEdition();
      editionHidden = s.hiddenGroups ?? [];
      editionMode = s.mode;
    } catch { /* older kernel: the edition hides nothing */ }
  }
  onMount(() => {
    void loadEdition();
    window.addEventListener('edition:changed', loadEdition);
  });
  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('edition:changed', loadEdition);
  });

  let rows: Row[] = [];
  let baseline = '';
  let loadedFrom = '';
  let saving = false;
  let savedMsg = '';
  let error = '';

  function build(groups: typeof $shellNavGroups, layout: string, tools: string, byEdition: string[]): Row[] {
    const prefs = parseNavPrefs(layout);
    return orderNavGroups(groups, prefs.order).map((g) => ({
      ...g,
      byEdition: byEdition.includes(g.id),
      visible: g.id === 'tools'
        ? tools === 'true' && !prefs.hidden.includes('tools')
        : isNavGroupVisible(g.id, prefs, byEdition),
    }));
  }
  const snapshot = (r: Row[]) => JSON.stringify(r.map((x) => [x.id, x.visible]));

  // Rebuild when the stored values or the shell's groups change, never over unsaved edits.
  $: source = JSON.stringify([$shellNavGroups.map((g) => g.id), layoutValue, showToolsValue, editionHidden]);
  $: if (source !== loadedFrom && (!rows.length || snapshot(rows) === baseline)) {
    rows = build($shellNavGroups, layoutValue, showToolsValue, editionHidden);
    baseline = snapshot(rows);
    loadedFrom = source;
  }
  $: dirty = rows.length > 0 && snapshot(rows) !== baseline;

  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    rows = next;
    savedMsg = '';
  }

  function reset() {
    rows = build($shellNavGroups, '', 'false', editionHidden);
    savedMsg = '';
  }

  async function save() {
    saving = true;
    error = '';
    try {
      const entries: Record<string, string> = {
        // Store only what differs from the edition's default, so switching
        // edition later still moves the menus the user never touched.
        [NAV_LAYOUT_KEY]: serializeNavPrefs({
          order: rows.map((r) => r.id),
          hidden: rows.filter((r) => r.id !== 'tools' && !r.visible && !r.byEdition).map((r) => r.id),
          shown: rows.filter((r) => r.id !== 'tools' && r.visible && r.byEdition).map((r) => r.id),
        }),
      };
      const tools = rows.find((r) => r.id === 'tools');
      if (tools) entries[SHOW_TOOLS_KEY] = tools.visible ? 'true' : 'false';
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const body = res.ok ? await res.json() : null;
      if (!res.ok || body?.errors?.length) throw new Error(body?.errors?.[0]?.error ?? `HTTP ${res.status}`);
      baseline = snapshot(rows);
      layoutValue = entries[NAV_LAYOUT_KEY];
      if (tools) showToolsValue = entries[SHOW_TOOLS_KEY];
      loadedFrom = JSON.stringify([$shellNavGroups.map((g) => g.id), layoutValue, showToolsValue, editionHidden]);
      savedMsg = $t('settings.card.saved');
      // The shell re-reads its prefs on this event and redraws the sidebar.
      window.dispatchEvent(new CustomEvent('settings:saved', { detail: { keys: Object.keys(entries) } }));
    } catch (e) {
      error = $t('settings.card.error');
      console.warn('[settings] menu save failed', e);
    } finally {
      saving = false;
    }
  }
</script>

<SettingsCard
  cardId="nav-menu"
  title={$t('settings.menu.title')}
  description={$t('settings.menu.desc')}
  {dirty}
  {saving}
  {savedMsg}
  {error}
  saveLabel={$t('settings.card.save')}
  savingLabel={$t('settings.card.saving')}
  on:save={save}
>
  {#if rows.length}
    <ol class="nm-list">
      {#each rows as row, i (row.id)}
        <li class="nm-row" class:off={!row.visible}>
          <span class="nm-icon" aria-hidden="true">{row.icon}</span>
          <span class="nm-label">
            {row.label}
            {#if row.byEdition && editionMode}
              <small class="nm-tag">{$t(`settings.menu.by_edition_${editionMode}`)}</small>
            {/if}
          </span>
          <button type="button" class="nm-move" disabled={i === 0}
            aria-label={$t('settings.menu.up', { name: row.label })} on:click={() => move(i, -1)}>↑</button>
          <button type="button" class="nm-move" disabled={i === rows.length - 1}
            aria-label={$t('settings.menu.down', { name: row.label })} on:click={() => move(i, 1)}>↓</button>
          <Toggle bind:checked={row.visible} on:click={() => (savedMsg = '')} />
        </li>
      {/each}
    </ol>
    <p class="nm-note">{$t('settings.menu.pinned')}</p>
  {:else}
    <p class="nm-note">{$t('settings.menu.loading')}</p>
  {/if}
  <button slot="footer-extra" type="button" class="nm-reset" on:click={reset}>{$t('settings.menu.reset')}</button>
</SettingsCard>

<style>
  .nm-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .nm-row {
    display: grid; grid-template-columns: 24px 1fr auto auto auto; align-items: center; gap: 8px;
    padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm, 6px);
    background: var(--surface-2);
  }
  .nm-row.off .nm-label, .nm-row.off .nm-icon { opacity: 0.45; }
  .nm-icon { text-align: center; }
  .nm-label { font-weight: 600; color: var(--text-1); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .nm-tag { font-weight: 400; font-size: 11.5px; color: var(--text-3); }
  .nm-move {
    width: 28px; height: 28px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface-3); color: var(--text-1); cursor: pointer;
  }
  .nm-move:disabled { opacity: 0.3; cursor: default; }
  .nm-move:focus-visible, .nm-reset:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .nm-note { margin: 10px 0 0; color: var(--text-2); font-size: 12px; }
  .nm-reset { border: 0; background: none; color: var(--text-2); cursor: pointer; text-decoration: underline; }
</style>
