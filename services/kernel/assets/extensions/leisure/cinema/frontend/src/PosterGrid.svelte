<script lang="ts">
  /*
    The poster wall: one card per title, or the empty/loading line when
    there are none.

    The whole grid rather than a single card, because the cards animate with
    `animate:flip`, which only works on an element that is the direct child of
    the keyed each block — it cannot sit on a component. What the cards do is
    the page's business (open the player, the sheet, the directory dialog, the
    watchlist), so each action is a callback under its page name.
  */
  // Framework-level motion — the part of "looks expensive" that CSS alone
  // cannot do. When a filter changes the result set, the cards that survive
  // SLIDE to their new positions instead of the grid snapping to a different
  // arrangement. The each-block is already keyed by identifier, which is the
  // prerequisite that makes it possible.
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import type { ArchiveItem, CanonRail } from './types.js';
  import { thumbUrl, onPosterError } from './media.js';
  import { fmtDownloads, fmtRuntime } from './format.js';

  export let shownItems: ArchiveItem[];
  export let canonRails: CanonRail[];
  export let busy: boolean;
  export let lastError: string;
  export let viewWatchlist: boolean;
  export let isSaved: (id: string) => boolean;

  export let openPlayer: (item: ArchiveItem) => void;
  export let toggleWatch: (item: ArchiveItem) => void;
  export let openDirPicker: (item: ArchiveItem, ev: Event) => void;
  export let openInfo: (item: ArchiveItem, ev: Event) => void;

  // The card under the pointer, for its hover synopsis.
  let hoverItem: string | null = null;
</script>

<section class="grid">
  {#each shownItems as it (it.identifier)}
    <button
      class="card"
      animate:flip={{ duration: 320, easing: cubicOut }}
      on:click={() => openPlayer(it)}
      on:mouseenter={() => hoverItem = it.identifier}
      on:mouseleave={() => hoverItem === it.identifier && (hoverItem = null)}
    >
      <img class="poster" src={thumbUrl(it.identifier)} alt={it.title} loading="lazy" on:error={onPosterError} />

      <div class="overlay">
        <div class="ovl-title">{it.title || it.identifier}</div>
        <!-- Facts, on exactly one line that never wraps.
             This used to be a wrapping row of up to eight badges plus the
             creator plus the download count. Every card ended up a different
             height of metadata, so the grid had no rhythm and the badges
             read as noise rather than information. What survives is what you
             scan a poster wall for; the rest moved to the ℹ sheet, which is
             where you go when you actually want to know. -->
        <div class="ovl-meta">
          {#if it.date}<span class="fact year">{it.date.slice(0, 4)}</span>{/if}
          <!-- Prefer the probed duration: runtime_sec is 0 on a large part
               of the catalogue, and where both exist the probe read it off
               the file rather than off a metadata field someone typed. -->
          {#if it.media?.duration_sec}
            <span class="fact" title="duración real, leída de los archivos del ítem">{fmtRuntime(it.media.duration_sec)}</span>
          {:else if it.runtime_sec}
            <span class="fact" title="duración declarada">{fmtRuntime(it.runtime_sec)}</span>
          {/if}
          {#if it.media?.height}
            <span class="fact" title={`${it.media.width}×${it.media.height} · ${it.media.best_format}`}>{it.media.height}p</span>
          {/if}
          {#if it.media?.has_subtitles}<span class="fact" title="trae subtítulos">SUBS</span>{/if}
          {#if it.downloads}<span class="fact dl" title="descargas">⇩ {fmtDownloads(it.downloads)}</span>{/if}
        </div>
        <!-- Second fixed line: who made it. Always rendered, even empty, so
             every card in the grid is the same height. -->
        <div class="ovl-creator">{it.creator ?? ''}</div>
      </div>

      <!-- Quality marks, top-right and away from the title.
           These answer "is this worth your time", which is a different
           question from "what is it" — mixing them into the same row was
           what made both unreadable. At most three ever show. -->
      <div class="card-flags">
        {#if it.media && !it.media.has_video}
          <span class="flag bad" title="el ítem no contiene ningún archivo de video">SIN VIDEO</span>
        {/if}
        {#if it.canon?.length}
          {@const rail = canonRails.find((r) => r.key === it.canon?.[0])}
          <span class="flag rail" title={it.canon.map((k) => canonRails.find((r) => r.key === k)?.label ?? k).join(' · ')}>
            ★ {rail?.label ?? it.canon[0]}{#if it.canon.length > 1}&nbsp;+{it.canon.length - 1}{/if}
          </span>
        {/if}
        {#if it.canonical}
          <span class="flag canon"
                title={`identificada: ${it.canonical.label}${it.canonical.year ? ` (${it.canonical.year})` : ''}${it.canonical.director ? ` · ${it.canonical.director}` : ''}${it.canonical.country ? ` · ${it.canonical.country}` : ''}`}
          >🎬{#if it.canonical.ext_votes > 0}&nbsp;{it.canonical.ext_rating.toFixed(1)}{/if}</span>
        {/if}
        {#if it.copies && it.copies > 1}
          <span class="flag copies" title={`${it.copies} subidas de esta película — descargas y votos sumados`}>⧉ {it.copies}</span>
        {/if}
      </div>

      <!-- One toolbar instead of three absolutely-placed buttons. They were
           pinned at left 48/86/124 — gaps of 40, 38, 38, and a 48px indent
           that was the hole left by a play button whose markup is long gone
           (its CSS still is; removed below). A flex row owns the spacing, so
           the group starts flush at the left and adding or dropping a
           control cannot desync the numbers again. -->
      <div class="card-actions">
        <span
          class="card-act star-btn"
          class:saved={isSaved(it.identifier)}
          role="button"
          tabindex="0"
          title={isSaved(it.identifier) ? 'remove from watchlist' : 'save to watchlist'}
          on:click|stopPropagation={() => toggleWatch(it)}
          on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && toggleWatch(it)}
        >{isSaved(it.identifier) ? '★' : '☆'}</span>
        <span
          class="card-act dir-btn"
          role="button"
          tabindex="0"
          title="guardar en un directorio"
          on:click={(ev) => openDirPicker(it, ev)}
          on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && openDirPicker(it, e)}
        >📁</span>
      <!-- Read the description properly. The hover overlay clips it and
           cannot be scrolled, so anything past a few lines was unreachable. -->
        <span
          class="card-act info-btn"
          role="button"
          tabindex="0"
          title="ver la ficha completa"
          on:click={(ev) => openInfo(it, ev)}
          on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && openInfo(it, e)}
        >ℹ</span>
      </div>

      {#if hoverItem === it.identifier && it.description}
        <div class="hover-desc">
          <!-- Full text, clamped in CSS. Slicing at 360 characters cut
               mid-word at a count that knows nothing about the card's width
               or font size, and then `overflow: hidden` cut it AGAIN at
               whatever pixel the box ended — two truncations fighting, and
               neither landing on a line boundary. -->
          <p class="hover-text">{it.description}</p>
          {#if it.subject?.length}
            <div class="tags">
              {#each it.subject.slice(0, 4) as s}<span class="tag">#{s}</span>{/each}
            </div>
          {/if}
          <!-- A real control, not a caption. It first shipped as a plain
               <span>, and since the overlay is `pointer-events: none` the
               click fell straight through to the card and opened the video
               — a thing that looked tappable and did the wrong thing, which
               is worse than no affordance at all. `role="button"` rather
               than <button> because the card itself is a <button> and
               nesting one inside another is invalid; the star/folder/info
               controls above use the same pattern. -->
          <span
            class="hover-more"
            role="button"
            tabindex="0"
            title="ver la ficha completa"
            on:click|stopPropagation={(ev) => openInfo(it, ev)}
            on:keydown|stopPropagation={(e) => (e.key === 'Enter' || e.key === ' ') && openInfo(it, e)}
          >ℹ ficha completa</span>
        </div>
      {/if}
    </button>
  {:else}
    {#if !busy && !lastError}
      <div class="empty">{viewWatchlist ? '★ no items in your watchlist yet — click the ☆ on a card to save.' : 'no matches — try a different filter.'}</div>
    {:else if busy}
      <div class="empty loading">▮ loading from archive.org…</div>
    {/if}
  {/each}
</section>


<style>
  @keyframes blink { 50% { opacity: 0; } }

  /* ─── POSTER GRID ────────────────────────────────────────── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 10px;
    padding: 14px 24px;
  }

  .card {
    position: relative;
    aspect-ratio: 4 / 3;
    border: 1px solid var(--line, #1d3a26);
    background: #0a0a0a;
    cursor: pointer;
    overflow: hidden;
    border-radius: 3px;
    padding: 0;
    text-align: left;
    color: inherit;
    transition: transform 0.18s ease, border-color 0.18s, box-shadow 0.18s;
  }
  .card:hover {
    transform: scale(1.04) translateY(-2px);
    border-color: var(--amber, #ffb000);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.7), 0 0 18px rgba(255, 176, 0, 0.18);
    z-index: 2;
  }

  .poster {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    transition: transform 0.3s ease, opacity 0.3s;
    opacity: 1;
    background: linear-gradient(135deg, #142219, #050807);
  }
  .card:hover .poster { transform: scale(1.02); }

  /* Bottom gradient + title */
  .overlay {
    position: absolute;
    inset: auto 0 0 0;
    padding: 26px 12px 10px;
    /* The scrim starts higher and darker than before. Titles are set in amber
       over whatever the poster happens to be, and on a light frame — a snow
       scene, a title card — the old gradient left them barely legible. */
    background: linear-gradient(
      180deg,
      transparent 0%,
      rgba(0, 0, 0, 0.55) 28%,
      rgba(0, 0, 0, 0.88) 62%,
      rgba(0, 0, 0, 0.97) 100%
    );
    color: #fff;
    pointer-events: none;
  }
  .ovl-title {
    /* Display font on titles — the one place a distinct face earns its
       keep, and what the token set provides Geist for. */
    font-family: var(--font-display);
    color: var(--gold);
    font-size: 13px;
    line-height: 1.25;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
    margin-bottom: 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* One line, never wrapping. `min-width: 0` on the children is what lets the
     line clip instead of forcing the row taller — the wrapping version is
     exactly what made every card a different height. */
  .ovl-meta {
    display: flex;
    gap: 0;
    flex-wrap: nowrap;
    align-items: baseline;
    overflow: hidden;
    height: 15px;
    /* Mono here, and only here: years, durations, resolutions and counts are
       exactly the case tabular figures exist for, so columns of cards line
       their numbers up instead of drifting. */
    font-family: var(--font-mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
  }
  .ovl-meta .fact { white-space: nowrap; min-width: 0; }
  /* Interpuncts as separators rather than boxes. Six bordered pills on a
     poster is a fence; six words with dots between them is a caption. */
  .ovl-meta .fact + .fact::before {
    content: "·";
    margin: 0 6px;
    color: var(--green-dim, #4d8a5a);
  }
  .ovl-meta .fact.dl { color: #9dbfa8; }
  /* The year leads the row, so it earns a little weight — it is the fact you
     scan a poster wall by, and at --text-2 it sat level with the resolution
     and the download count. Brighter and bolder, but the same size and the
     same mono figures: the row must still read as one line, not as a badge
     with a caption trailing off it. */
  .ovl-meta .fact.year {
    color: var(--amber, #ffb000);
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  /* Always rendered, even empty, so the grid keeps a single rhythm. */
  .ovl-creator {
    height: 14px;
    margin-top: 2px;
    font-size: 10.5px;
    color: #8fae99;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Quality marks, stacked top-right, clear of the title and of the
     hover buttons on the left. */
  .card-flags {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    max-width: 70%;
    pointer-events: none;
  }
  .flag {
    font-size: 10px;
    line-height: 1;
    letter-spacing: 0.04em;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    backdrop-filter: blur(2px);
  }
  .flag.rail {
    color: #1a1206;
    background: var(--amber, #ffb000);
    font-weight: 700;
  }
  .flag.canon {
    color: #ffe9a8;
    background: rgba(20, 14, 2, 0.82);
    border: 1px solid rgba(255, 176, 0, 0.5);
  }
  .flag.copies {
    color: #cfe0ff;
    background: rgba(8, 14, 28, 0.82);
    border: 1px solid rgba(160, 190, 255, 0.45);
  }
  .flag.bad {
    color: #fff;
    background: rgba(158, 26, 26, 0.92);
    font-weight: 700;
  }

  /* ── Card action toolbar ──────────────────────────────────────────
     One row, one gap value, flush left. The `.play-btn` rules that used to
     live here had no markup left anywhere in the file — but the star was
     still positioned at `left: 48px` to clear it, so every card carried a
     48px indent for a button that no longer existed. */
  .card-actions {
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    z-index: 3;
  }
  /* Shared shell for every control in the bar: same box, same ring, same
     motion. Only the glyph and its accent differ. */
  .card-act {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    /* Opaque enough to hold contrast over a bright poster — at 0.6 the dim
       green washed out completely against a pale frame, which is why the ℹ
       read as "dark and invisible". */
    background: rgba(4, 8, 6, 0.82);
    /* One legible foreground for all three. They were split between bright
       green and a dim #4d8a5a that only cleared 4.5:1 against pure black,
       and these sit over arbitrary artwork. */
    color: #b9f2cc;
    border: 1px solid rgba(185, 242, 204, 0.5);
    /* Sizes were 16 / 14 / 15 with no reason; one token keeps the row even. */
    font-size: 15px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transform: scale(0.85);
    transition: opacity 0.15s ease, transform 0.15s ease, color 0.15s ease,
                border-color 0.15s ease, background 0.15s ease;
  }
  .card:hover .card-act,
  .card:focus-within .card-act { opacity: 1; transform: scale(1); }
  .card-act:hover,
  .card-act:focus-visible {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    background: rgba(0, 0, 0, 0.9);
    outline: none;
  }
  .card-act:focus-visible { outline: 2px solid var(--amber, #ffb000); outline-offset: 2px; }
  /* Saved is a state, so it stays lit even when the card is not hovered —
     otherwise the only way to see your watchlist marks is to sweep the grid. */
  .card-act.saved {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.4);
    opacity: 1;
    transform: scale(1);
  }
  @media (prefers-reduced-motion: reduce) {
    .card-act { transition: opacity 0.15s ease; transform: none; }
    .card:hover .card-act { transform: none; }
  }

  /* ★ watchlist toggle on each card */
  /* The three controls differ only in their accent; the shell lives in
     `.card-act` above so the row cannot drift apart again. */

  /* 📁 add-to-directory — cyan while its popover is the thing you are aiming
     at, so it reads apart from the amber "saved" state next to it. */
  .dir-btn:hover, .dir-btn:focus-visible {
    color: var(--cyan, #4dd0e1);
    border-color: var(--cyan, #4dd0e1);
  }

  .hover-desc {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(5, 8, 7, 0.92), rgba(5, 8, 7, 0.96));
    color: var(--green, #33ff77);
    /* 48px of top padding, not 14: the star/folder/info buttons sit at
       `top: 8px` and are 32px tall, so text starting at 14px ran straight
       under them and the first two lines were unreadable. Reserve the row
       instead of stacking on it. */
    padding: 48px 14px 12px;
    /* A column so the tags and the affordance can hold the bottom while the
       paragraph takes whatever is left — previously everything flowed from
       the top and the tags were sliced by the card edge. */
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
    /* Explicit, and below the action buttons' 3. It relied on source order
       before, which is why the buttons drew over the text rather than the
       text simply starting below them. */
    z-index: 1;
    /* A glance, not a read — the ℹ button opens the readable version. Still
       bumped from 11.5px, which was small enough to be decorative. */
    font-size: 12.5px;
    line-height: 1.55;
    pointer-events: none;
    animation: fade 0.18s ease-out;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .hover-desc .hover-text {
    margin: 0;
    color: #c0e8cd;
    /* Clamp at a LINE boundary with a real ellipsis, and let the box shrink:
       `min-height: 0` is what allows a flex child to give room back to the
       tags below instead of pushing them out of the card. */
    flex: 0 1 auto;
    min-height: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    overflow: hidden;
  }
  /* The tags and the hint own the bottom — pushed there, never overrun. */
  .hover-desc .tags {
    display: flex; gap: 5px; flex-wrap: wrap;
    flex: 0 0 auto;
    margin-top: auto;
    max-height: 44px;
    overflow: hidden;
  }
  .hover-desc .tag {
    color: var(--cyan, #4dd0e1);
    font-size: 10px;
    background: rgba(77, 208, 225, 0.08);
    padding: 1px 6px;
    border-radius: 999px;
    /* One tag with a long name used to wrap into a second line and shove the
       row past the card; keep each to one line. */
    max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Truncation needs a way out, not just an ellipsis. This IS the way out, so
     it has to be clickable — the overlay above sets `pointer-events: none`,
     which every child inherits, so it re-enables them for itself. */
  .hover-desc .hover-more {
    flex: 0 0 auto;
    align-self: flex-start;
    pointer-events: auto;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    /* 28px, not 44: it lives inside a hover-only overlay that no touch device
       ever sees, and a full-size button would eat the card. Generous padding
       keeps it comfortably clickable with a mouse. */
    min-height: 28px;
    padding: 2px 8px;
    border: 1px solid rgba(77, 138, 90, 0.45);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.4);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--green-dim, #4d8a5a);
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .hover-desc .hover-more:hover {
    color: var(--amber, #ffb000);
    border-color: var(--amber, #ffb000);
    background: rgba(0, 0, 0, 0.7);
  }
  .hover-desc .hover-more:focus-visible {
    outline: 2px solid var(--amber, #ffb000);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .hover-desc .hover-more { transition: none; }
  }
  /* Shorter cards can't hold six lines plus tags; drop the clamp so the
     paragraph yields first and the bottom row still fits. */
  @media (max-height: 820px) {
    .hover-desc .hover-text { -webkit-line-clamp: 4; line-clamp: 4; }
  }

  .empty {
    grid-column: 1 / -1;
    padding: 60px 20px;
    text-align: center;
    color: var(--green-dim, #4d8a5a);
    font-size: 13px;
  }
  .empty.loading { color: var(--amber, #ffb000); animation: blink 1.2s steps(2) infinite; }

  /* ─── RESPONSIVE ─────────────────────────────────────────── */
  @media (max-width: 700px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); padding: 10px; gap: 8px; }
  }
</style>
