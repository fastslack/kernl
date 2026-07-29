<script lang="ts">
  /*
    /cinema/directories — community-curated directory browser.

    Three views in this single page:
      - "yours" — local-owned directories (origin='local')
      - "following" — federated directories we've subscribed to
      - "discover" — Nostr discover (live query, NOT auto-imported)

    Directories carry an `items[]` array of archive.org identifiers.
    Click on one → modal with the items grid (each card is a poster
    that opens the player from the main /cinema page on click).
    Migrated (phase 3) from services/dashboard/src/routes/cinema/directories/
    +page.svelte into the cinema extension bundle: the host routes by first
    URL segment, so /cinema/directories mounts the same "cinema" view and
    Root.svelte switches to this component based on the pathname.
  */
  import { onMount } from 'svelte';
  import type { ExtPageContext } from './types.js';

  export let ctx: ExtPageContext;

  interface DirectoryItemPreview {
    identifier: string;
    note: string | null;
    added_at: string;
    title: { identifier: string; title: string; year: number; poster_url: string } | null;
  }

  interface Directory {
    id: string;
    owner_pubkey: string;
    title: string;
    description: string;
    category: string;
    cover_identifier: string;
    visibility: 'public' | 'unlisted' | 'private';
    items: { identifier: string; note?: string; added_at: string }[];
    item_count?: number;
    collaborators: string[];
    origin: 'local' | 'federated';
    nostr_event_id: string;
    version: number;
    created_at: string;
    updated_at: string;
    published_at: string | null;
    cover?: { identifier: string; title: string; year: number } | null;
  }

  type View = 'mine' | 'following' | 'discover';
  let view: View = 'mine';

  let mine: Directory[] = [];
  let following: Directory[] = [];
  let discovery: Array<Directory & { signer_pubkey: string; event_id: string }> = [];

  let busy = false;
  let lastError = '';

  // Active directory (when user clicks a card → opens detail modal)
  let activeDir: Directory | null = null;
  let activeItems: DirectoryItemPreview[] = [];
  let activeLoading = false;

  // Create / edit modal state
  let createOpen = false;
  let editForm = {
    id: '',                        // empty = new
    title: '',
    description: '',
    category: '',
    cover_identifier: '',
    visibility: 'public' as 'public' | 'unlisted' | 'private',
    collaborators: '',             // comma-separated pubkeys
  };

  // Discovery search
  let discoverCategory = '';
  let discoverOwner = '';

  async function loadMine(): Promise<void> {
    busy = true;
    lastError = '';
    try {
      const r = await ctx.fetchRaw('/api/cinema/directories?origin=local&limit=100');
      if (!r.ok) throw new Error(`http ${r.status}`);
      const body = await r.json();
      mine = body.directories ?? [];
    } catch (err: any) {
      lastError = err?.message ?? String(err);
    } finally { busy = false; }
  }

  async function loadFollowing(): Promise<void> {
    busy = true;
    lastError = '';
    try {
      const r = await ctx.fetchRaw('/api/cinema/directories?origin=federated&subscribed=1&limit=100');
      if (!r.ok) throw new Error(`http ${r.status}`);
      const body = await r.json();
      following = body.directories ?? [];
    } catch (err: any) {
      lastError = err?.message ?? String(err);
    } finally { busy = false; }
  }

  async function runDiscover(): Promise<void> {
    busy = true;
    lastError = '';
    try {
      const params = new URLSearchParams();
      if (discoverCategory) params.set('category', discoverCategory);
      if (discoverOwner) params.set('owner', discoverOwner);
      params.set('limit', '50');
      const r = await ctx.fetchRaw(`/api/cinema/directories/discover?${params.toString()}`);
      if (!r.ok) throw new Error(`http ${r.status}`);
      const body = await r.json();
      discovery = body.directories ?? [];
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      discovery = [];
    } finally { busy = false; }
  }

  async function openDir(dir: Directory): Promise<void> {
    activeDir = dir;
    activeItems = [];
    activeLoading = true;
    try {
      const r = await ctx.fetchRaw(`/api/cinema/directories/${encodeURIComponent(dir.id)}`);
      if (r.ok) {
        const body = await r.json();
        activeDir = body.directory;
        activeItems = body.items ?? [];
      }
    } catch { /* */ }
    finally { activeLoading = false; }
  }

  function closeDir() {
    activeDir = null;
    activeItems = [];
  }

  function startCreate() {
    editForm = {
      id: '', title: '', description: '', category: '',
      cover_identifier: '', visibility: 'public', collaborators: '',
    };
    createOpen = true;
  }

  function startEdit(dir: Directory) {
    editForm = {
      id: dir.id,
      title: dir.title,
      description: dir.description,
      category: dir.category,
      cover_identifier: dir.cover_identifier,
      visibility: dir.visibility,
      collaborators: dir.collaborators.join(', '),
    };
    createOpen = true;
  }

  async function saveForm() {
    const body = {
      title: editForm.title,
      description: editForm.description,
      category: editForm.category,
      cover_identifier: editForm.cover_identifier,
      visibility: editForm.visibility,
      collaborators: editForm.collaborators
        .split(',').map(s => s.trim()).filter(Boolean),
    };
    try {
      const url = editForm.id
        ? `/api/cinema/directories/${editForm.id}/update`
        : `/api/cinema/directories`;
      const r = await ctx.fetchRaw(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        lastError = e.error ?? `http ${r.status}`;
        return;
      }
      createOpen = false;
      await loadMine();
    } catch (err: any) {
      lastError = err?.message ?? String(err);
    }
  }

  async function publishDir(dir: Directory) {
    try {
      const r = await ctx.fetchRaw(`/api/cinema/directories/${dir.id}/publish`, { method: 'POST' });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        lastError = e.error ?? `http ${r.status}`;
        return;
      }
      const body = await r.json();
      lastError = '';
      alert(`✓ publicado a ${body.relays?.length ?? 0} relays`);
      await loadMine();
    } catch (err: any) { lastError = err?.message ?? String(err); }
  }

  async function unfollowDir(dir: Directory) {
    if (!confirm(`Dejar de seguir "${dir.title}"?`)) return;
    try {
      await ctx.fetchRaw(`/api/cinema/directories/${dir.id}/unfollow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_pubkey: dir.owner_pubkey }),
      });
      await loadFollowing();
    } catch (err: any) { lastError = err?.message ?? String(err); }
  }

  async function followDiscovery(d: Directory & { signer_pubkey?: string }): Promise<void> {
    try {
      const r = await ctx.fetchRaw(`/api/cinema/directories/${d.id}/follow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_pubkey: d.owner_pubkey }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        lastError = e.error ?? `http ${r.status}`;
        return;
      }
      // Move the user to the "following" view so they see it landed.
      view = 'following';
      await loadFollowing();
    } catch (err: any) { lastError = err?.message ?? String(err); }
  }

  async function deleteDir(dir: Directory) {
    if (!confirm(`Delete "${dir.title}"?`)) return;
    try {
      await ctx.fetchRaw(`/api/cinema/directories/${dir.id}/delete`, { method: 'POST' });
      await loadMine();
    } catch (err: any) { lastError = err?.message ?? String(err); }
  }

  async function removeItemFromDir(dir: Directory, identifier: string) {
    try {
      await ctx.fetchRaw(`/api/cinema/directories/${dir.id}/items/remove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });
      // Refresh
      if (activeDir && activeDir.id === dir.id) {
        await openDir(dir);
      }
      await loadMine();
    } catch (err: any) { lastError = err?.message ?? String(err); }
  }

  function thumbUrl(identifier: string): string {
    return `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
  }
  function shortPubkey(pk: string): string {
    if (!pk) return '—';
    return pk.slice(0, 10) + '…' + pk.slice(-4);
  }

  $: if (view === 'mine') loadMine();
  $: if (view === 'following') loadFollowing();

  onMount(() => {
    loadMine();
  });
</script>

<svelte:head><title>cinema · directorios — Kernl</title></svelte:head>

<div class="page">
  <header class="hero">
    <div class="hero-inner">
      <h1>directorios<span class="cur">█</span></h1>
      <span class="dim mini">listas comunitarias · Nostr-federated</span>
    </div>
    <nav class="chips">
      <a class="chip" href="/cinema" title="back to the catalog">← cinema</a>
      <button class="chip" class:on={view === 'mine'} on:click={() => view = 'mine'}>
        <span class="chip-icon">📁</span>yours {mine.length ? `(${mine.length})` : ''}
      </button>
      <button class="chip" class:on={view === 'following'} on:click={() => view = 'following'}>
        <span class="chip-icon">★</span>following {following.length ? `(${following.length})` : ''}
      </button>
      <button class="chip" class:on={view === 'discover'} on:click={() => { view = 'discover'; if (discovery.length === 0) runDiscover(); }}>
        <span class="chip-icon">🌐</span>discover
      </button>
      <span class="spacer-flex"></span>
      <button class="chip chip-star" on:click={startCreate}>+ new directory</button>
    </nav>
  </header>

  {#if lastError}
    <div class="err">⚠ {lastError}</div>
  {/if}

  {#if view === 'discover'}
    <section class="filters">
      <input class="search" type="text" bind:value={discoverCategory} placeholder="category (optional)" on:keydown={(e) => e.key === 'Enter' && runDiscover()} />
      <input class="search" type="text" bind:value={discoverOwner} placeholder="pubkey del autor (opcional)" on:keydown={(e) => e.key === 'Enter' && runDiscover()} />
      <button class="primary" on:click={runDiscover} disabled={busy}>{busy ? '…' : 'search Nostr'}</button>
    </section>
  {/if}

  <section class="dir-grid">
    {#each (view === 'mine' ? mine : view === 'following' ? following : discovery) as dir (dir.id)}
      <div class="dir-card" on:click={() => openDir(dir)} on:keydown={(e) => e.key === 'Enter' && openDir(dir)} role="button" tabindex="0">
        {#if dir.cover_identifier}
          <img class="dir-cover" src={thumbUrl(dir.cover_identifier)} alt="" loading="lazy" />
        {:else}
          <div class="dir-cover-placeholder">{(dir.title || '?').slice(0, 1).toUpperCase()}</div>
        {/if}
        <div class="dir-body">
          <div class="dir-title">{dir.title}</div>
          {#if dir.description}<div class="dir-desc">{dir.description.slice(0, 120)}{dir.description.length > 120 ? '…' : ''}</div>{/if}
          <div class="dir-meta dim mini">
            {#if dir.category}<span>#{dir.category}</span>{/if}
            <span>· {dir.item_count ?? dir.items?.length ?? 0} items</span>
            {#if dir.collaborators?.length > 0}<span>· {dir.collaborators.length} co</span>{/if}
            {#if view === 'mine'}
              <span class="dim">· {dir.published_at ? '✓ publicado' : 'borrador'}</span>
            {:else}
              <span class="dim">por {shortPubkey(dir.owner_pubkey)}</span>
            {/if}
          </div>
          <div class="dir-actions" on:click|stopPropagation>
            {#if view === 'mine'}
              <button class="ghost sm" on:click={() => startEdit(dir)}>edit</button>
              {#if dir.visibility !== 'private'}
                <button class="ghost sm" on:click={() => publishDir(dir)} title="republish manually — only if it drifted out of sync">↻</button>
              {/if}
              <button class="ghost sm" on:click={() => deleteDir(dir)}>×</button>
            {:else if view === 'following'}
              <button class="ghost sm" on:click={() => unfollowDir(dir)}>dejar</button>
            {:else}
              <button class="primary sm" on:click={() => followDiscovery(dir)}>+ seguir</button>
            {/if}
          </div>
        </div>
      </div>
    {:else}
      <div class="empty">
        {#if busy}loading…
        {:else if view === 'mine'}no directories — create the first one, top right.
        {:else if view === 'following'}not following any yet — find them under "discover".
        {:else}no results from Nostr — try ↻ search above.
        {/if}
      </div>
    {/each}
  </section>
</div>

<!-- ── Detail modal ───────────────────────────────────────────── -->
{#if activeDir}
  <div class="modal-backdrop" on:click={closeDir} on:keydown={(e) => e.key === 'Escape' && closeDir()} role="dialog" tabindex="-1">
    <div class="modal-card" on:click|stopPropagation>
      <div class="modal-header">
        <h2>{activeDir.title}</h2>
        <span class="dim mini">v{activeDir.version} · {activeDir.items.length} items · {activeDir.origin}</span>
        <span class="spacer-flex"></span>
        <button class="ghost sm" on:click={closeDir}>×</button>
      </div>
      {#if activeDir.description}
        <p class="modal-desc">{activeDir.description}</p>
      {/if}
      <div class="modal-meta dim mini">
        {#if activeDir.category}<span>#{activeDir.category}</span>{/if}
        <span>· por {shortPubkey(activeDir.owner_pubkey)}</span>
        {#if activeDir.collaborators.length > 0}
          <span>· co: {activeDir.collaborators.map(shortPubkey).join(', ')}</span>
        {/if}
      </div>
      {#if activeLoading}
        <div class="empty">loading items…</div>
      {:else}
        <div class="item-grid">
          {#each activeItems as it (it.identifier)}
            <a class="item-card" href={`/cinema?identifier=${encodeURIComponent(it.identifier)}`}>
              <img src={thumbUrl(it.identifier)} alt="" loading="lazy" />
              <div class="item-title">
                {it.title?.title ?? it.identifier}
                {#if it.title?.year}<span class="dim">({it.title.year})</span>{/if}
              </div>
              {#if it.note}<div class="dim mini item-note">{it.note}</div>{/if}
              {#if activeDir && activeDir.origin === 'local'}
                <button class="item-rm" on:click|preventDefault|stopPropagation={() => activeDir && removeItemFromDir(activeDir, it.identifier)} title="remove from directory">×</button>
              {/if}
            </a>
          {:else}
            <div class="empty">sin items todavía</div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- ── Create / edit modal ───────────────────────────────────── -->
{#if createOpen}
  <div class="modal-backdrop" on:click={() => createOpen = false} on:keydown={(e) => e.key === 'Escape' && (createOpen = false)} role="dialog" tabindex="-1">
    <div class="modal-card modal-form" on:click|stopPropagation>
      <div class="modal-header">
        <h2>{editForm.id ? 'edit directory' : 'new directory'}</h2>
        <span class="spacer-flex"></span>
        <button class="ghost sm" on:click={() => createOpen = false}>×</button>
      </div>
      <label>title<input type="text" bind:value={editForm.title} placeholder="Argentine cinema of the 80s" /></label>
      <label>description<textarea rows="3" bind:value={editForm.description}></textarea></label>
      <label>category<input type="text" bind:value={editForm.category} placeholder="e.g. cinema, animation, horror" /></label>
      <label>archive.org identifier para portada (opcional)<input type="text" bind:value={editForm.cover_identifier} /></label>
      <label>visibilidad
        <select bind:value={editForm.visibility}>
          <option value="public">público</option>
          <option value="unlisted">sin listar</option>
          <option value="private">privado (no se publica)</option>
        </select>
      </label>
      <label>colaboradores (npubs hex separados por coma)<input type="text" bind:value={editForm.collaborators} /></label>
      <div class="form-actions">
        <button class="ghost" on:click={() => createOpen = false}>cancelar</button>
        <button class="primary" on:click={saveForm} disabled={!editForm.title.trim()}>save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { font-family: var(--font-mono, ui-monospace), monospace; min-height: 100vh; padding-bottom: 60px; }
  .hero {
    padding: 24px 32px 12px;
    border-bottom: 1px dashed var(--line, #1d3a26);
  }
  .hero-inner { display: flex; align-items: baseline; gap: 16px; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 28px; color: var(--green, #33ff77); letter-spacing: 0.04em; }
  .cur { animation: blink 1s steps(2, end) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .dim { color: var(--dim-fg, #8aa); }
  .mini { font-size: 11px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .spacer-flex { flex: 1; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 12px;
    border: 1px solid var(--line, #1d3a26);
    background: var(--bg-2, #0b1f12);
    color: var(--text-2, #c0c0c0);
    cursor: pointer;
    font: inherit; font-size: 12px;
    border-radius: 2px;
    text-decoration: none;
  }
  .chip:hover { border-color: var(--green-dim, #4d8a5a); }
  .chip.on { border-color: var(--amber, #ffb000); color: var(--amber, #ffb000); }
  .chip-star { color: var(--amber, #ffb000); border-color: rgba(255, 176, 0, 0.4); }
  .chip-icon { font-size: 13px; }

  .filters {
    display: flex; gap: 8px; align-items: center;
    padding: 12px 32px;
    flex-wrap: wrap;
    border-bottom: 1px dashed var(--line, #1d3a26);
  }
  .filters .search, .filters .primary { height: 32px; box-sizing: border-box; padding: 0 12px; font-size: 13px; line-height: 30px; border-radius: 2px; font: inherit; }
  .filters .search { flex: 1 1 240px; background: var(--bg-2, #0b1f12); border: 1px solid var(--line, #1d3a26); color: var(--green, #33ff77); outline: none; }
  .filters .search:focus { border-color: var(--amber, #ffb000); }
  button.primary {
    background: var(--green-deep, #0d2516);
    border: 1px solid var(--green, #33ff77);
    color: var(--green, #33ff77);
    cursor: pointer;
    font: inherit;
    text-transform: lowercase;
  }
  button.primary:hover:not(:disabled) {
    background: var(--green, #33ff77);
    color: #050807;
  }
  button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary.sm, button.ghost.sm { padding: 4px 10px; font-size: 12px; height: auto; line-height: normal; }
  button.ghost {
    background: transparent;
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-2, #c0c0c0);
    cursor: pointer;
    font: inherit;
    padding: 6px 12px;
    border-radius: 2px;
    font-size: 12px;
  }
  button.ghost:hover { border-color: var(--green-dim, #4d8a5a); color: var(--green, #33ff77); }

  .err { margin: 12px 32px; padding: 8px 14px; border: 1px solid var(--red, #f55); color: var(--red, #f55); background: rgba(255, 60, 60, 0.06); }

  .dir-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
    padding: 16px 32px;
  }
  .dir-card {
    display: flex;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 2px;
    overflow: hidden;
    cursor: pointer;
    transition: border-color 120ms;
    min-height: 110px;
  }
  .dir-card:hover { border-color: var(--amber, #ffb000); }
  .dir-cover {
    width: 80px; height: 110px; object-fit: cover; flex-shrink: 0;
    background: rgba(0, 0, 0, 0.4);
  }
  .dir-cover-placeholder {
    width: 80px; height: 110px;
    display: flex; align-items: center; justify-content: center;
    font-size: 36px; color: var(--green-dim, #4d8a5a);
    background: rgba(0, 0, 0, 0.3);
    flex-shrink: 0;
  }
  .dir-body { padding: 10px 12px; flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .dir-title { font-weight: 600; color: var(--text-1, #fff); font-size: 14px; }
  .dir-desc { font-size: 12px; color: var(--text-2, #c0c0c0); line-height: 1.35; }
  .dir-meta { display: flex; flex-wrap: wrap; gap: 6px; }
  .dir-actions { display: flex; gap: 6px; margin-top: auto; }

  .empty {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--dim-fg, #8aa);
    padding: 60px 20px;
  }

  /* ── Modal ─────────────────────────────────────────────── */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 50;
    padding: 20px;
  }
  .modal-card {
    background: var(--bg-1, #0a1812);
    border: 1px solid var(--green-dim, #4d8a5a);
    border-radius: 2px;
    padding: 20px;
    max-width: 1000px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
  }
  .modal-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .modal-header h2 { margin: 0; font-size: 18px; color: var(--amber, #ffb000); }
  .modal-desc { color: var(--text-2, #c0c0c0); font-size: 13px; line-height: 1.45; margin: 0 0 8px; }
  .modal-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }

  .item-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }
  .item-card {
    position: relative;
    display: flex; flex-direction: column;
    text-decoration: none;
    color: inherit;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    overflow: hidden;
    transition: border-color 120ms;
  }
  .item-card:hover { border-color: var(--amber, #ffb000); }
  .item-card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; background: rgba(0, 0, 0, 0.4); }
  .item-title { padding: 6px 8px; font-size: 12px; line-height: 1.3; }
  .item-note { padding: 0 8px 6px; }
  .item-rm {
    position: absolute; top: 4px; right: 4px;
    background: rgba(0, 0, 0, 0.7); border: 1px solid var(--red, #f55); color: var(--red, #f55);
    width: 22px; height: 22px;
    cursor: pointer; font-size: 12px;
    border-radius: 2px;
  }

  /* ── Form ──────────────────────────────────────────────── */
  .modal-form { max-width: 540px; }
  .modal-form label {
    display: flex; flex-direction: column; gap: 4px;
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--text-2, #c0c0c0);
  }
  .modal-form input, .modal-form textarea, .modal-form select {
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    padding: 6px 10px;
    font: inherit;
    font-size: 13px;
    border-radius: 2px;
    outline: none;
  }
  .modal-form input:focus, .modal-form textarea:focus, .modal-form select:focus {
    border-color: var(--amber, #ffb000);
  }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
</style>
