<!--
  Tiny theme switcher for the global header. Lists all installed themes and
  activates one on click. Lives next to the other header buttons; the rest
  of the theme machinery (variables, fonts, customCss) is wired in
  +layout.svelte and the marketplace API.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { activeTheme, type ActiveTheme } from '$lib/stores.js';

  interface ThemeRow {
    item_id: string;
    slug: string;
    name: string;
    icon: string;
    preview_colors: string;     // JSON-encoded string[]
  }

  let themes: ThemeRow[] = [];
  let open = false;
  let busy = false;
  let err: string | null = null;
  let triggerEl: HTMLButtonElement;
  let menuStyle = '';

  function positionMenu(): void {
    if (!triggerEl) return;
    const r = triggerEl.getBoundingClientRect();
    // Fixed positioning so we escape `.app-shell` overflow:hidden clipping.
    menuStyle = `top:${Math.round(r.bottom + 6)}px;right:${Math.round(window.innerWidth - r.right)}px;`;
  }

  async function loadThemes(): Promise<void> {
    try {
      const r = await fetch('/api/marketplace/theme/list');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      themes = (data?.themes ?? []) as ThemeRow[];
    } catch (e) {
      err = String(e);
    }
  }

  async function activate(itemId: string): Promise<void> {
    if (busy) return;
    busy = true;
    err = null;
    try {
      const r = await fetch('/api/marketplace/theme/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ item_id: itemId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Refresh active theme — layout reactively re-injects vars + css.
      const ar = await fetch('/api/marketplace/theme/active');
      const ad = await ar.json();
      activeTheme.set((ad?.theme ?? null) as ActiveTheme | null);
      open = false;
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }

  function previewColorsOf(t: ThemeRow): string[] {
    try { return JSON.parse(t.preview_colors) as string[]; }
    catch { return []; }
  }

  function toggle(): void {
    open = !open;
    if (open) {
      positionMenu();
      if (themes.length === 0) loadThemes();
    }
  }

  function onDocClick(e: MouseEvent): void {
    if (!(e.target as HTMLElement).closest('.theme-switcher')) open = false;
  }

  onMount(() => {
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  });
</script>

<div class="theme-switcher">
  <button bind:this={triggerEl} class="header-btn theme-trigger" on:click|stopPropagation={toggle} title="Theme">
    {$activeTheme?.icon ?? '🎨'}
  </button>
  {#if open}
    <div class="theme-menu" role="menu" style={menuStyle}>
      <div class="theme-menu-head">Theme</div>
      {#if err}<div class="theme-err">{err}</div>{/if}
      {#each themes as t (t.item_id)}
        {@const colors = previewColorsOf(t)}
        <button
          class="theme-row"
          class:active={$activeTheme?.slug === t.slug}
          disabled={busy}
          on:click={() => activate(t.item_id)}
        >
          <span class="theme-icon">{t.icon || '🎨'}</span>
          <span class="theme-name">{t.name}</span>
          <span class="theme-swatches">
            {#each colors.slice(0, 5) as c}
              <span class="swatch" style="background:{c}" />
            {/each}
          </span>
        </button>
      {/each}
      {#if themes.length === 0 && !err}
        <div class="theme-empty">loading…</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .theme-switcher { position: relative; }
  /* Square 30px icon chip — matches the other unified header controls
     (shape/border/bg/hover come from app.css .header-control rule). */
  .theme-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    padding: 0;
    font-size: 15px;
    line-height: 1;
  }

  .theme-menu {
    /* Fixed positioning escapes the .app-shell overflow:hidden clip; the
       coordinates are computed from the trigger's bounding rect each open. */
    position: fixed;
    min-width: 240px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius, 8px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    padding: 6px;
    z-index: 1000;
  }
  .theme-menu-head {
    font-size: 11px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 4px 8px 6px;
  }
  .theme-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: 1px solid transparent;
    color: var(--text-1);
    padding: 6px 8px;
    cursor: pointer;
    border-radius: var(--radius-sm, 4px);
    text-align: left;
    font: inherit;
    font-size: 13px;
  }
  .theme-row:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border-h);
  }
  .theme-row.active {
    background: var(--surface-2);
    border-color: var(--gold, #D4A84B);
  }
  .theme-row:disabled { opacity: 0.5; cursor: wait; }
  .theme-icon { font-size: 14px; }
  .theme-name { flex: 1; }
  .theme-swatches { display: flex; gap: 2px; }
  .swatch {
    width: 8px; height: 14px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 1px;
  }
  .theme-err {
    color: var(--red, #F04770);
    font-size: 11px;
    padding: 4px 8px;
  }
  .theme-empty {
    color: var(--text-3);
    font-size: 11px;
    padding: 8px;
    text-align: center;
  }
</style>
