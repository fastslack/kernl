<script lang="ts">
  /*
    "Save to a directory": pick one of your local directories for a film, or
    create one with the film already in it.

    Self-contained: the page only ever asks it to open (`openDirPicker()`),
    and it stays mounted so the directory list it fetched is reused by the
    next open, as before.
  */
  import type { JsonApi } from '$shared/api';
  import type { ArchiveItem } from './types.js';
  import { thumbUrl, onPosterError } from './media.js';

  /** Same-origin /api fetch with the host auth token attached. */
  export let apiFetch: (input: string, init?: RequestInit) => Promise<Response>;
  export let api: JsonApi;

  // ── "+ to directory" popover ───────────────────────────────────
  // Lightweight: click the 📁 icon on a card → small floating list of
  // your local directories. Click one → POST add-item. "+ new" goes
  // to /cinema/directories where the form lives.
  interface MyDirectorySummary { id: string; title: string; item_count: number; }
  let myDirs: MyDirectorySummary[] = [];
  // The film being filed, not just its id: the dialog shows what you are
  // filing. The old popover covered the card it opened on, so the one thing
  // you needed to see — which film this is — was the thing it hid.
  let dirPickerItem: ArchiveItem | null = null;
  let dirPopoverBusy = false;
  let dirPopoverNotice = '';
  // Inline creation. The empty state used to be a link to another page,
  // which meant discovering you had no directories cost you the film you
  // were trying to file. Now the first directory is made right here.
  let dirNewTitle = '';
  let dirCreating = false;

  async function ensureMyDirsLoaded() {
    if (myDirs.length > 0) return;
    try {
      const body = await api.getJson('/api/cinema/directories?origin=local&limit=200');
      myDirs = (body.directories ?? []).map((d: any) => ({
        id: d.id, title: d.title, item_count: d.item_count ?? d.items?.length ?? 0,
      }));
    } catch { /* */ }
  }
  export async function openDirPicker(item: ArchiveItem, ev: Event) {
    ev.stopPropagation();
    dirPopoverNotice = '';
    dirNewTitle = '';
    dirPickerItem = dirPickerItem?.identifier === item.identifier ? null : item;
    if (dirPickerItem) await ensureMyDirsLoaded();
  }

  /**
   * Create a directory and drop this film into it, in one go.
   *
   * The two steps are one intention — nobody opens this dialog wanting an
   * empty directory — so splitting them across two screens was the whole
   * problem with the old flow.
   */
  async function createDirAndAdd() {
    const title = dirNewTitle.trim();
    const item = dirPickerItem;
    if (!title || !item) return;
    dirCreating = true;
    dirPopoverNotice = '';
    try {
      const r = await apiFetch('/api/cinema/directories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description: '',
          category: '',
          cover_identifier: item.identifier,
          visibility: 'private',
          collaborators: [],
        }),
      });
      const body = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        dirPopoverNotice = `✗ ${body.error ?? 'no se pudo crear'}`;
        return;
      }
      const id = body.directory?.id ?? body.id;
      if (!id) {
        dirPopoverNotice = '✗ el servidor no devolvió un id';
        return;
      }
      // Refetched rather than pushed locally, so item_count and anything
      // else the server decided stay authoritative.
      myDirs = [];
      await ensureMyDirsLoaded();
      dirNewTitle = '';
      await addToDir(id, item.identifier);
    } catch (err: any) {
      dirPopoverNotice = `✗ ${err?.message ?? String(err)}`;
    } finally {
      dirCreating = false;
    }
  }
  async function addToDir(dirId: string, identifier: string) {
    dirPopoverBusy = true;
    dirPopoverNotice = '';
    try {
      const r = await apiFetch(`/api/cinema/directories/${encodeURIComponent(dirId)}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        dirPopoverNotice = `✗ ${e.error ?? 'falló'}`;
        return;
      }
      dirPopoverNotice = '✓ agregada';
      // optimistic count bump
      myDirs = myDirs.map(d => d.id === dirId ? { ...d, item_count: d.item_count + 1 } : d);
      // Close after a beat, so the ✓ is seen. Guarded on the film still being
      // the one that was filed: without it, filing A and quickly opening B
      // would slam B's dialog shut.
      setTimeout(() => {
        if (dirPickerItem?.identifier === identifier) closeDirPopover();
      }, 700);
    } catch (err: any) {
      dirPopoverNotice = `✗ ${err?.message ?? err}`;
    } finally { dirPopoverBusy = false; }
  }
  function closeDirPopover() {
    dirPickerItem = null;
    dirPopoverNotice = '';
    dirNewTitle = '';
  }
</script>

<!-- ── SAVE TO A DIRECTORY ───────────────────────────────────
     A dialog at page level rather than a popover inside the card. The old
     one was absolutely positioned over the poster, so it covered the single
     thing you needed to see: which film you were filing. Here the film is
     the first thing in it. -->
{#if dirPickerItem}
  <div class="modal-back" on:click|self={closeDirPopover} role="presentation">
    <div class="dir-dialog" role="dialog" aria-modal="true" aria-label="Guardar en un directorio">
      <header class="dir-dialog-head">
        <span>GUARDAR EN…</span>
        <button class="ghost sm" on:click={closeDirPopover} aria-label="cerrar">×</button>
      </header>

      <div class="dir-dialog-subject">
        <img src={thumbUrl(dirPickerItem.identifier)} alt="" on:error={onPosterError} />
        <div>
          <div class="dir-dialog-title">{dirPickerItem.title || dirPickerItem.identifier}</div>
          {#if dirPickerItem.date}<div class="dim mini">{dirPickerItem.date.slice(0, 4)}</div>{/if}
        </div>
      </div>

      {#if myDirs.length > 0}
        <ul class="dir-dialog-list">
          {#each myDirs as d (d.id)}
            <li>
              <button
                on:click={() => dirPickerItem && addToDir(d.id, dirPickerItem.identifier)}
                disabled={dirPopoverBusy}
              >
                <span class="dir-name">{d.title}</span>
                <span class="dim mini">{d.item_count} títulos</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <!-- Always available, not just when the list is empty: the moment you
           most want a new directory is when none of the existing ones fit. -->
      <form class="dir-dialog-new" on:submit|preventDefault={createDirAndAdd}>
        <label class="dim mini" for="dir-new-title">
          {myDirs.length === 0
            ? 'Todavía no tenés directorios. Creá el primero y esta película entra sola:'
            : 'O creá uno nuevo con esta película adentro:'}
        </label>
        <div class="dir-dialog-new-row">
          <input
            id="dir-new-title"
            bind:value={dirNewTitle}
            placeholder="ej. Terror clase B"
            maxlength="80"
            disabled={dirCreating || dirPopoverBusy}
          />
          <button class="primary" type="submit" disabled={!dirNewTitle.trim() || dirCreating || dirPopoverBusy}>
            {dirCreating ? '…' : 'crear y guardar'}
          </button>
        </div>
      </form>

      {#if dirPopoverNotice}
        <div class="dir-dialog-notice" class:ok={dirPopoverNotice.startsWith('✓')}>
          {dirPopoverNotice}
        </div>
      {/if}

      <a class="dim mini dir-dialog-manage" href="/cinema/directories">administrar directorios →</a>
    </div>
  </div>
{/if}


<style>
  /* ─── BUTTONS ────────────────────────────────────────────── */
  /* What makes a control look built rather than declared, in four layers:
     a fill with a slight vertical gradient so it has a light source; a 1px
     inset highlight along the top edge (the inset shadow below) so it reads
     as a raised surface; a drop shadow beneath it; and a press state that
     actually moves. None of this is decoration — it is the difference
     between a rectangle with a border and something that looks pressable. */
  button.primary {
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--green) 22%, transparent),
        color-mix(in srgb, var(--green) 11%, transparent)
      );
    border: 1px solid color-mix(in srgb, var(--green) 55%, transparent);
    color: var(--green);
    padding: 0 16px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    letter-spacing: 0.01em;
    height: 32px;
    box-sizing: border-box;
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--green) 30%, transparent),
      0 1px 2px rgba(0, 0, 0, 0.5);
    transition: background 0.15s, box-shadow 0.15s, transform 0.08s, border-color 0.15s;
  }
  /* Pressing moves the control and pulls its shadow in. A button that does
     not react to being pressed feels broken even when it works. */
  button.primary:active:not(:disabled) {
    transform: translateY(1px);
    box-shadow:
      inset 0 1px 3px rgba(0, 0, 0, 0.45),
      0 0 0 rgba(0, 0, 0, 0);
  }
  button.primary:focus-visible {
    outline: 2px solid var(--gold);
    outline-offset: 2px;
  }
  button.primary:hover:not(:disabled) {
    background: var(--green);
    border-color: var(--green);
    color: var(--bg);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.25),
      0 2px 10px color-mix(in srgb, var(--green) 35%, transparent);
  }
  button.primary:disabled { opacity: 0.3; cursor: not-allowed; }
  button.ghost {
    background: transparent;
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 5px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    border-radius: var(--radius-sm);
    text-transform: lowercase;
  }
  button.ghost:hover:not(:disabled) { color: var(--green, #33ff77); border-color: var(--green-dim, #4d8a5a); }
  button.ghost.sm { padding: 3px 8px; }
  button.ghost:disabled { opacity: 0.3; cursor: not-allowed; }
  .ghost.sm {
    padding: 4px 10px;
    font-size: 12px;
  }

  /* Save-to-directory dialog.
     Amber, not the cyan the old popover used — that colour appeared nowhere
     else on the page and read as a foreign element pasted over the grid.
     Amber is already this interface's "you did something" accent (the star,
     the canon badge), which is exactly what filing a film is. */
  .dir-dialog {
    width: min(460px, calc(100vw - 32px));
    max-height: min(80vh, 620px);
    overflow-y: auto;
    background: var(--bg-1, #0a1812);
    border: 1px solid var(--amber, #ffb000);
    border-radius: var(--radius-sm);
    padding: 14px 16px 12px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.8);
    text-align: left;
  }
  .dir-dialog-head {
    display: flex; align-items: center; justify-content: space-between;
    color: var(--amber, #ffb000);
    font-size: 12px;
    letter-spacing: 0.14em;
    padding-bottom: 10px;
    border-bottom: 1px dashed var(--line, #1d3a26);
  }
  /* The film being filed, stated first. The old popover covered it. */
  .dir-dialog-subject {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 12px 0;
  }
  .dir-dialog-subject img {
    width: 48px; height: 68px;
    object-fit: cover;
    background: #0b1410;
    flex: 0 0 auto;
  }
  .dir-dialog-title {
    font-size: 13px;
    line-height: 1.3;
    color: var(--green, #33ff77);
  }

  .dir-dialog-list { list-style: none; padding: 0; margin: 0 0 12px; }
  .dir-dialog-list li button {
    width: 100%;
    display: flex; justify-content: space-between; align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-1, #e5e5e5);
    cursor: pointer;
    font: inherit; font-size: 12px;
    border-radius: var(--radius-sm);
    margin-bottom: 4px;
  }
  .dir-dialog-list li button:hover:not(:disabled) {
    background: rgba(255, 176, 0, 0.12);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
  }
  .dir-dialog-list li button:disabled { opacity: 0.5; cursor: wait; }
  .dir-name { text-align: left; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .dir-dialog-new { display: block; padding-top: 4px; }
  .dir-dialog-new label { display: block; margin-bottom: 6px; line-height: 1.4; }
  .dir-dialog-new-row { display: flex; gap: 6px; }
  .dir-dialog-new-row input {
    flex: 1 1 auto;
    min-width: 0;
    height: 32px;
    box-sizing: border-box;
    padding: 0 10px;
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    font: inherit; font-size: 13px;
    border-radius: var(--radius-sm);
    outline: none;
  }
  .dir-dialog-new-row input:focus {
    border-color: var(--amber, #ffb000);
    box-shadow: 0 0 6px rgba(255, 176, 0, 0.2);
  }
  .dir-dialog-new-row button { flex: 0 0 auto; height: 32px; white-space: nowrap; }

  .dir-dialog-notice {
    font-size: 12px;
    margin-top: 10px;
    color: #ff9a9a;
  }
  .dir-dialog-notice.ok { color: var(--green, #33ff77); }
  .dir-dialog-manage {
    display: block;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px dashed var(--line, #1d3a26);
  }

  /* ─── PLAYER MODAL ────────────────────────────────────── */
  /* ── Modal: control-room enclosure ──────────────────────────
     Sharp 90° corners, scanline overlay, corner brackets that
     hint at a CRT bezel without overwhelming the content.       */
  .modal-back {
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(0, 4, 1, 0.5) 0%, rgba(0, 0, 0, 0.92) 100%);
    backdrop-filter: blur(6px);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    animation: fade 0.18s ease-out;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

  .dim { color: var(--green-dim, #4d8a5a); }
  .mini { font-size: 11px; }
</style>
