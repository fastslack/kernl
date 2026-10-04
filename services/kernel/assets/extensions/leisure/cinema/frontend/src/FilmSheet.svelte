<script lang="ts">
  /*
    The film sheet: the synopsis at a size meant for reading, with the
    metadata beside it and a way to translate it.

    Self-contained: nothing else on the page reads the open film or the
    synopsis state. The page opens it with `openInfo()` and it stays mounted,
    so the translation cache outlives each open exactly as it did when this
    lived in Page.svelte. Playing or filing the film is the page's, and goes
    back through the callbacks.
  */
  import type { JsonApi } from '$shared/api';
  import Icon from '$shared/components/Icon.svelte';
  import type { ArchiveItem } from './types.js';
  import { thumbUrl, onPosterError } from './media.js';
  import { fmtDownloads, fmtRuntime } from './format.js';

  export let api: JsonApi;
  export let openPlayer: (item: ArchiveItem) => void;
  export let openDirPicker: (item: ArchiveItem, ev: Event) => void;

  // The film whose description is open for reading.
  //
  // The hover overlay is a glance, not a read: 11.5px, clipped to the poster,
  // pointer-events off, so it cannot be scrolled or selected and a long
  // synopsis simply disappears past the bottom edge. This is the read.
  let infoItem: ArchiveItem | null = null;
  export function openInfo(item: ArchiveItem, ev: Event) {
    ev.stopPropagation();
    infoItem = item;
    descShowFull = false;
    descLang = '';
    descErr = '';
  }
  function closeInfo() { infoItem = null; }

  // ── Synopsis: translate + expand ────────────────────────────────────
  //
  // archive.org descriptions are almost always English, and long ones were
  // both cut at 1200 characters with no way to see the rest and unreadable to
  // anyone who does not read English. Both are the same problem: the text is
  // there, the UI just would not give it to you.
  //
  // Translation goes through /api/llm/chat, the kernel's one door to the model
  // chain — no bespoke endpoint, and it inherits provider fallback, the rate
  // limiter and the call log for free.
  let descLang = '';           // '' = original
  let descBusy = false;
  let descErr = '';
  let descShowFull = false;
  let descModel = '';
  /** key: `${identifier}:${lang}` — a translation costs tokens; buy it once. */
  const descCache = new Map<string, string>();

  const DESC_LANGS = [
    { code: 'es', label: 'español' },
    { code: 'en', label: 'english' },
    { code: 'pt', label: 'português' },
    { code: 'fr', label: 'français' },
    { code: 'de', label: 'deutsch' },
    { code: 'it', label: 'italiano' },
  ];
  let descTarget = 'es';

  /** What the synopsis paragraph should render right now. */
  $: descSource = infoItem?.description ?? '';
  $: descShown = descLang && infoItem
    ? (descCache.get(`${infoItem.identifier}:${descLang}`) ?? descSource)
    : descSource;
  /** Long ones stay collapsed until asked — see `.info-desc.clamped`. */
  $: descIsLong = descShown.length > 700;

  async function translateDescription(): Promise<void> {
    if (!infoItem || descBusy) return;
    const item = infoItem;
    const key = `${item.identifier}:${descTarget}`;
    if (descCache.has(key)) { descLang = descTarget; return; }
    if (!item.description) return;

    descBusy = true;
    descErr = '';
    try {
      const target = DESC_LANGS.find((l) => l.code === descTarget)?.label ?? descTarget;
      const j = await api.postJson('/api/llm/chat', {
        system:
          'You translate film synopses. Return ONLY the translated text: no preamble, ' +
          'no notes, no quotes around it, and no explanation of what you did. Preserve ' +
          'proper nouns, film titles and character names. Keep the paragraph structure.',
        user: `Translate this film synopsis into ${target}:\n\n${item.description}`,
        temperature: 0.2,
        maxTokens: Math.max(400, Math.round(item.description.length / 2)),
        caller: 'cinema:describe-translate',
      });
      const text = String(j?.text ?? '').trim();
      if (!text) throw new Error('el modelo devolvió una respuesta vacía');
      descCache.set(key, text);
      descModel = String(j?.model ?? '');
      descLang = descTarget;
      descShowFull = true;   // you asked to read it — don't make it a second click
    } catch (err) {
      descErr = err instanceof Error ? err.message : String(err);
    } finally {
      descBusy = false;
    }
  }
</script>

<!-- ── FILM SHEET ───────────────────────────────────────────
     The description at a size meant for reading, scrollable, selectable,
     with the metadata the archive actually holds beside it. From here the
     two things you might want next — watch it, file it — are one click
     away, so opening the sheet is never a dead end. -->
{#if infoItem}
  <div class="modal-back" on:click|self={closeInfo} role="presentation">
    <div class="info-dialog" role="dialog" aria-modal="true" aria-label="Ficha de la película">
      <header class="dir-dialog-head">
        <span>FICHA</span>
        <button class="ghost sm" on:click={closeInfo} aria-label="cerrar">×</button>
      </header>

      <div class="info-body">
        <img class="info-poster" src={thumbUrl(infoItem.identifier)} alt="" on:error={onPosterError} />

        <div class="info-main">
          <h2 class="info-title">{infoItem.title || infoItem.identifier}</h2>

          <div class="info-facts">
            {#if infoItem.canonical?.year || infoItem.date}
              <span>{infoItem.canonical?.year || infoItem.date?.slice(0, 4)}</span>
            {/if}
            {#if infoItem.canonical?.director}<span>{infoItem.canonical.director}</span>{/if}
            {#if infoItem.canonical?.country}<span>{infoItem.canonical.country}</span>{/if}
            {#if infoItem.media?.duration_sec}<span title="duración">{fmtRuntime(infoItem.media.duration_sec)}</span>
            {:else if infoItem.runtime_sec}<span title="duración">{fmtRuntime(infoItem.runtime_sec)}</span>{/if}
            {#if infoItem.media?.height}<span title="resolución vertical">{infoItem.media.height}p</span>{/if}
            {#if infoItem.downloads}<span title="descargas en archive.org">⇩ {fmtDownloads(infoItem.downloads)}</span>{/if}
            {#if infoItem.copies && infoItem.copies > 1}<span>⧉ {infoItem.copies} copias</span>{/if}
          </div>

          {#if infoItem.creator}
            <div class="dim mini info-creator">{infoItem.creator}</div>
          {/if}

          {#if infoItem.description}
            <!-- Synopsis toolbar: language, and the state of what you are
                 reading. Sits above the text so it is found before the wall
                 of English, not after it. -->
            <div class="desc-bar">
              <span class="desc-state" class:on={!!descLang}>
                {descLang
                  ? `traducido · ${DESC_LANGS.find((l) => l.code === descLang)?.label ?? descLang}`
                  : 'texto original'}
              </span>
              <span class="spacer" />
              {#if descLang}
                <button class="desc-btn" on:click={() => (descLang = '')}>ver original</button>
              {/if}
              <select
                class="desc-lang"
                bind:value={descTarget}
                disabled={descBusy}
                aria-label="idioma de la traducción"
              >
                {#each DESC_LANGS as l}<option value={l.code}>{l.label}</option>{/each}
              </select>
              <button
                class="desc-btn primary"
                disabled={descBusy || descLang === descTarget}
                on:click={translateDescription}
                title="traducir la sinopsis con el modelo configurado"
              >
                {#if descBusy}
                  <span class="desc-spin" aria-hidden="true"></span> traduciendo…
                {:else}
                  <Icon name="globe" size={12} /> traducir
                {/if}
              </button>
            </div>

            {#if descErr}
              <div class="desc-err" role="alert">
                ⚠ no se pudo traducir: {descErr}
                <button class="desc-err-x" on:click={() => (descErr = '')} aria-label="cerrar">×</button>
              </div>
            {/if}

            <p class="info-desc" class:clamped={descIsLong && !descShowFull}>{descShown}</p>

            {#if descIsLong}
              <button class="desc-btn desc-more" on:click={() => (descShowFull = !descShowFull)}>
                {descShowFull ? '▲ ver menos' : '▼ leer completa'}
              </button>
            {/if}

            {#if descLang && descModel}
              <p class="desc-credit dim mini">traducido por {descModel}</p>
            {/if}
          {:else}
            <p class="info-desc dim">Este ítem no trae descripción en archive.org.</p>
          {/if}

          {#if infoItem.subject?.length}
            <div class="info-tags">
              {#each infoItem.subject.slice(0, 14) as t}<span class="tag">{t}</span>{/each}
            </div>
          {/if}
        </div>
      </div>

      <footer class="info-actions">
        <button class="primary" on:click={() => { const i = infoItem; closeInfo(); if (i) openPlayer(i); }}>
          ▶ ver
        </button>
        <button class="ghost" on:click={(ev) => { const i = infoItem; closeInfo(); if (i) openDirPicker(i, ev); }}>
          📁 guardar en…
        </button>
        <span class="spacer" />
        <a class="dim mini" href={`https://archive.org/details/${encodeURIComponent(infoItem.identifier)}`}
           target="_blank" rel="noopener noreferrer">ver en archive.org →</a>
      </footer>
    </div>
  </div>
{/if}


<style>
  .spacer { flex: 1; }

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

  /* The film sheet. Wider than the directory dialog because its job is
     reading — a synopsis set in a 460px column at 11px was the complaint. */
  .info-dialog {
    width: min(760px, calc(100vw - 32px));
    max-height: min(86vh, 720px);
    display: flex;
    flex-direction: column;
    background: var(--bg-1, #0a1812);
    border: 1px solid var(--green-dim, #4d8a5a);
    border-radius: var(--radius-sm);
    padding: 14px 18px 12px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.8);
    text-align: left;
  }
  .info-body {
    display: flex;
    gap: 18px;
    padding: 14px 0 4px;
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .info-poster {
    /* 168 → 200 with a fixed 3/4 box. archive.org art arrives at wildly
       different ratios, so an unconstrained <img> made the whole left column
       jump between films; reserving the box also keeps the layout from
       shifting as the image decodes. */
    width: 200px;
    aspect-ratio: 3 / 4;
    object-fit: cover;
    flex: 0 0 auto;
    align-self: flex-start;
    background: #0b1410;
    border: 1px solid var(--line, #1d3a26);
    border-radius: 3px;
  }
  .info-main { min-width: 0; flex: 1 1 auto; }
  .info-title {
    /* 19 → 24. The title was barely larger than the synopsis under it, so the
       card had no clear entry point; hierarchy comes from size and spacing,
       not from colour. */
    margin: 0 0 10px;
    font-family: var(--font-display);
    font-size: 24px;
    line-height: 1.2;
    font-weight: 700;
    color: var(--text-1);
    text-wrap: balance;
    letter-spacing: -0.01em;
  }
  /* Facts as a separated run rather than a paragraph — they are scanned,
     not read. */
  /* Chips instead of a `·`-joined run. "2005 · 1:43:32 · 136p · ⇩354.9k" made
     the reader guess what 136p and 354.9k were; each value now sits in its own
     box with a `title`, and the figures are tabular so they line up. */
  .info-facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
  }
  .info-facts > span {
    padding: 3px 9px;
    border: 1px solid rgba(255, 176, 0, 0.28);
    border-radius: 3px;
    background: rgba(255, 176, 0, 0.07);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--amber, #ffb000);
    white-space: nowrap;
  }
  .info-creator { margin-bottom: 12px; }
  /* 14.5px and 1.65 line-height: this is body copy now, not a tooltip.
     max-width keeps the measure near 70 characters so long synopses stay
     readable instead of running the full dialog width. */
  .info-desc {
    margin: 0 0 10px;
    font-size: 14.5px;
    line-height: 1.65;
    color: #c8e8d2;
    max-width: 62ch;
    white-space: pre-wrap;
  }
  /* Long synopses open collapsed. Clamping at a line boundary beats the old
     1200-character slice, which cut mid-word and offered no way to the rest. */
  .info-desc.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 7;
    line-clamp: 7;
    overflow: hidden;
  }

  /* ── Synopsis toolbar ────────────────────────────────────────────── */
  .desc-bar {
    display: flex; align-items: center; gap: 8px;
    max-width: 62ch;
    margin: 0 0 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(77, 138, 90, 0.22);
  }
  /* Says what you are looking at. Without it a translated synopsis is
     indistinguishable from an original one written in your language. */
  .desc-state {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--green-dim, #4d8a5a);
  }
  .desc-state.on { color: var(--cyan, #4dd0e1); }
  .desc-btn {
    display: inline-flex; align-items: center; gap: 5px;
    min-height: 26px;
    padding: 0 9px;
    border: 1px solid rgba(207, 232, 208, 0.22);
    border-radius: 3px;
    background: rgba(207, 232, 208, 0.05);
    color: #cfe8d0;
    font: 500 11px 'Manrope', sans-serif;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .desc-btn:hover:not(:disabled) {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    background: rgba(255, 176, 0, 0.08);
  }
  .desc-btn:focus-visible { outline: 2px solid var(--amber, #ffb000); outline-offset: 2px; }
  /* Disabled reads as disabled: dimmed AND not-allowed, never a live-looking
     control that ignores you. */
  .desc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .desc-btn.primary {
    border-color: rgba(77, 208, 225, 0.45);
    background: rgba(77, 208, 225, 0.1);
    color: var(--cyan, #4dd0e1);
  }
  .desc-lang {
    min-height: 26px;
    padding: 0 6px;
    border: 1px solid rgba(207, 232, 208, 0.22);
    border-radius: 3px;
    background: var(--bg-1, #0a1812);
    color: #cfe8d0;
    font: 500 11px 'Manrope', sans-serif;
    cursor: pointer;
  }
  .desc-lang:focus-visible { outline: 2px solid var(--amber, #ffb000); outline-offset: 2px; }
  .desc-more { margin: 0 0 12px; }
  .desc-credit { margin: 0 0 12px; }
  /* An LLM call is seconds, not milliseconds — the button has to show it is
     working or people press it again. */
  .desc-spin {
    width: 10px; height: 10px;
    border: 1.5px solid rgba(77, 208, 225, 0.3);
    border-top-color: var(--cyan, #4dd0e1);
    border-radius: 50%;
    animation: desc-spin 0.7s linear infinite;
  }
  @keyframes desc-spin { to { transform: rotate(360deg); } }
  .desc-err {
    display: flex; align-items: center; gap: 8px;
    max-width: 62ch;
    margin: 0 0 10px;
    padding: 7px 10px;
    border: 1px solid rgba(255, 90, 90, 0.4);
    border-radius: 3px;
    background: rgba(255, 90, 90, 0.08);
    color: #ffb3b3;
    font-size: 11.5px;
  }
  .desc-err-x {
    margin-left: auto;
    border: 0; background: none;
    color: inherit; font-size: 15px; line-height: 1;
    cursor: pointer;
  }
  @media (prefers-reduced-motion: reduce) {
    .desc-btn { transition: none; }
    .desc-spin { animation-duration: 2s; }
  }
  .info-tags { display: flex; flex-wrap: wrap; gap: 5px; }
  .info-tags .tag {
    color: #cfe8d0;
    font-size: 11px;
    background: rgba(207, 232, 208, 0.07);
    border: 1px solid rgba(207, 232, 208, 0.18);
    padding: 2px 8px;
    border-radius: 999px;
  }
  .info-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 12px;
    margin-top: 4px;
    border-top: 1px dashed var(--line, #1d3a26);
    flex: 0 0 auto;
  }
  .info-actions .spacer { flex: 1 1 auto; }

  @media (max-width: 640px) {
    .info-body { flex-direction: column; }
    .info-poster { width: 128px; }
  }
  .dir-dialog-head {
    display: flex; align-items: center; justify-content: space-between;
    color: var(--amber, #ffb000);
    font-size: 12px;
    letter-spacing: 0.14em;
    padding-bottom: 10px;
    border-bottom: 1px dashed var(--line, #1d3a26);
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
