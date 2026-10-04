<script lang="ts">
  /*
    The sticky header of /cinema: identity and global actions, the search box
    and filters panel, the "Showing" row of active filters, the discover rail
    and the tag band.

    Presentational. Every value it shows and every filter it edits is state
    of the page, which runs the search — edits come back up through `bind:`
    and actions through the callbacks below, under their page names.
  */
  // The filters panel opens by pushing the bands below it down rather than
  // floating over the grid. A popover would have covered the posters the
  // filters are there to change, which is the one thing you need to watch
  // while changing them.
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { Readable } from 'svelte/store';
  import type { Translate } from '$shared/i18n';
  // One icon family for the whole page. The emoji these replaced rendered
  // from a different font on every platform and carried their own colour, so
  // a "dim" chip still had a full-saturation 📁 sitting in it.
  import Icon from '$shared/components/Icon.svelte';
  import { CONTENT_LANGUAGES, languageName } from './i18n/index.js';
  import type { ArchiveItem, CanonRail, CinemaTag, ActiveChip } from './types.js';
  import { fmtDownloads } from './format.js';

  export let t: Readable<Translate>;
  export let uiLocale: Readable<string>;

  // ── Filters, search and view — edited here, owned by the page ──
  export let query: string;
  export let yearMin: number | null;
  export let yearMax: number | null;
  export let langFilter: string;
  export let kindFilter: '' | 'film' | 'series';
  export let sortMode: 'downloads' | 'year_desc' | 'year_asc' | 'added_desc' | 'rating' | 'best';
  export let minMinutes: number;
  export let collapseWorks: boolean;
  export let playableOnly: boolean;
  export let subsOnly: boolean;
  export let identifiedOnly: boolean;
  export let viewWatchlist: boolean;
  export let embedPanelOpen: boolean;
  export let tagSearchQuery: string;
  export let tagSearchOpen: boolean;

  // ── Read-only ──────────────────────────────────────────────────
  export let condensed: boolean;
  export let filtersOpen: boolean;
  export let tagPanelOpen: boolean;
  export let watchlist: unknown[];
  export let busy: boolean;
  export let items: ArchiveItem[];
  export let embedSnap: { status: string } | null;
  export let panelFilterCount: number;
  export let activeChips: ActiveChip[];
  export let activeTags: string[];
  export let tagsMatch: 'all' | 'any';
  export let semanticMode: boolean;
  export let forYouMode: boolean;
  export let forYouReason: string;
  export let forYouProfileSize: number;
  export let canonRails: CanonRail[];
  export let activeRail: string;
  export let topTags: CinemaTag[];
  export let tagSearchHits: CinemaTag[];
  export let tagSearchBusy: boolean;

  // ── Actions ────────────────────────────────────────────────────
  export let runSearch: () => void;
  export let toggleFilters: () => void;
  export let removeActive: (chip: ActiveChip) => void;
  export let toggleTagsMatch: () => void;
  export let clearAllFilters: () => void;
  export let toggleForYou: () => void;
  export let toggleRail: (key: string) => void;
  export let pickTag: (tag: string) => void;
  export let openTagPanel: () => void;
  export let closeTagPanel: () => void;
  export let onTagSearchInput: () => void;
  export let closeTagSearchSoon: () => void;
  export let pickTagFromSearch: (tag: CinemaTag) => void;
  export let refreshEmbedStatus: () => void;
</script>

<!-- ══ HEADER CHROME ═════════════════════════════════════════════
     Four bands, in the order the questions actually get asked:

       ①  what am I looking at        — identity + global actions
       ②  what am I looking for       — the search box, and the filters
       ③  what is narrowing it        — every active filter, in one line
       ④  what else could I look at   — curated rails, then tags

     What this replaces: four control systems (nav chips, a wrapping
     filter row, canon rails, thirty tag chips) rendered at the same
     visual weight, in four different chip languages, taking ~400px —
     the whole fold — before a single poster appeared. Nothing has been
     removed; it has been ordered, and the parts that are consulted
     rather than scanned now live behind one click.

     Every band is laid out on --gutter. The old tag row was not: it
     carried its own margin AND its own padding and started 12px further
     in than every band above it, which read as a rendering fault. -->
<header class="chrome" class:condensed>
  <!-- ── ① identity + global actions ──────────────────────────── -->
  <div class="band band-id">
    <h1 class="wordmark">cinema<span class="caret" aria-hidden="true">▌</span></h1>
    <p class="subtitle">
      {#if viewWatchlist}
        {$t('header.watchlist', { n: watchlist.length })}
      {:else if busy && items.length === 0}
        {$t('header.loading')}
      {:else if query.trim()}
        {$t('header.results', { n: items.length, q: query.trim() })}
      {:else}
        {$t('header.catalogue', { n: items.length })}
      {/if}
    </p>
    <nav class="quick" aria-label={$t('nav.aria')}>
      <button
        type="button"
        class="qbtn"
        class:on={viewWatchlist}
        aria-pressed={viewWatchlist}
        title={$t('nav.watchlist.hint')}
        on:click={() => (viewWatchlist = !viewWatchlist)}
      >
        <Icon name="star" size={13} />
        <span>{$t('nav.watchlist')}</span>
        {#if watchlist.length}<span class="qbadge">{watchlist.length}</span>{/if}
      </button>
      <button
        type="button"
        class="qbtn"
        class:on={embedPanelOpen}
        aria-pressed={embedPanelOpen}
        title={$t('nav.embeddings.hint')}
        on:click={() => { embedPanelOpen = !embedPanelOpen; refreshEmbedStatus(); }}
      >
        <Icon name="cpu" size={13} />
        <span>{$t('nav.embeddings')}</span>
        {#if embedSnap?.status === 'running'}
          <span class="qpulse" role="img" aria-label={$t('nav.embeddings.running')}></span>
        {/if}
      </button>
      <a class="qbtn" href="/cinema/directories" title={$t('nav.directories.hint')}>
        <Icon name="folder" size={13} />
        <span>{$t('nav.directories')}</span>
      </a>
    </nav>
  </div>

  {#if !viewWatchlist}
    <!-- ── ② command bar ──────────────────────────────────────
         The search box is the only element on this page that gets to be
         large. It was previously one control among eight on a wrapping
         row, which put a year spinner and a checkbox at the same weight
         as the thing the page exists to do. The submit button is gone:
         Enter already searched, and the button was what pushed itself
         onto a second row once the toggles stretched the first. -->
    <div class="band band-cmd">
      <div class="searchbox">
        <span class="searchbox-icon"><Icon name="search" size={16} /></span>
        <input
          type="text"
          bind:value={query}
          placeholder={$t('search.placeholder')}
          aria-label={$t('search.aria')}
          aria-describedby="cinema-search-hint"
          on:keydown={(e) => e.key === 'Enter' && runSearch()}
        />
        {#if query}
          <button
            type="button"
            class="searchbox-clear"
            title={$t('search.clear')}
            aria-label={$t('search.clear')}
            on:click={() => { query = ''; runSearch(); }}
          >
            <Icon name="x" size={13} />
          </button>
        {/if}
        <kbd class="searchbox-key" aria-hidden="true">↵</kbd>
      </div>
      <span id="cinema-search-hint" class="sr-only">{$t('search.enter.hint')}</span>
      <button
        type="button"
        class="filters-btn"
        class:on={filtersOpen}
        aria-expanded={filtersOpen}
        aria-controls="cinema-filters"
        title={filtersOpen ? $t('filters.close') : $t('filters.toggle.hint')}
        on:click={toggleFilters}
      >
        <Icon name="sliders" size={15} />
        <span>{$t('filters.toggle')}</span>
        {#if panelFilterCount > 0}
          <span class="count-badge" aria-label={$t('filters.toggle.count', { n: panelFilterCount })}>
            {panelFilterCount}
          </span>
        {/if}
        <span class="caret-icon" class:open={filtersOpen}><Icon name="chevronDown" size={13} /></span>
      </button>
    </div>

    <!-- ── filters panel ──────────────────────────────────────
         Inline, not floating: it pushes the grid down instead of
         covering it, so you can watch the result set change while you
         change it. Every control has a visible label — the row this
         replaces used placeholder text ("year ≥", "language", "+ views")
         as labels, which vanish the moment a value is entered. -->
    {#if filtersOpen}
      <div class="fpanel" id="cinema-filters" transition:slide={{ duration: 180, easing: cubicOut }}>
        <div class="fgrid">
          <div class="field" role="group" aria-labelledby="f-year-label">
            <span class="field-label" id="f-year-label">{$t('filters.year')}</span>
            <div class="field-pair">
              <input
                type="number" bind:value={yearMin} min="1888" max="2099"
                placeholder={$t('filters.year.from.ph')}
                aria-label={$t('filters.year.from')}
                on:change={runSearch}
              />
              <span class="field-dash" aria-hidden="true">–</span>
              <input
                type="number" bind:value={yearMax} min="1888" max="2099"
                placeholder={$t('filters.year.to.ph')}
                aria-label={$t('filters.year.to')}
                on:change={runSearch}
              />
            </div>
          </div>

          <label class="field">
            <span class="field-label">{$t('filters.language')}</span>
            <select bind:value={langFilter} on:change={runSearch}>
              <option value="">{$t('filters.language.any')}</option>
              {#each CONTENT_LANGUAGES as code (code)}
                <option value={code}>{languageName(code, $uiLocale)}</option>
              {/each}
            </select>
          </label>

          <label class="field">
            <span class="field-label">{$t('filters.kind')}</span>
            <select bind:value={kindFilter} on:change={runSearch}>
              <option value="">{$t('filters.kind.any')}</option>
              <option value="film">{$t('filters.kind.film')}</option>
              <option value="series">{$t('filters.kind.series')}</option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">{$t('filters.sort')}</span>
            <select bind:value={sortMode} on:change={runSearch}>
              <option value="best">{$t('filters.sort.best')}</option>
              <option value="downloads">{$t('filters.sort.downloads')}</option>
              <option value="rating">{$t('filters.sort.rating')}</option>
              <option value="year_desc">{$t('filters.sort.year_desc')}</option>
              <option value="year_asc">{$t('filters.sort.year_asc')}</option>
              <option value="added_desc">{$t('filters.sort.added_desc')}</option>
            </select>
            <span class="field-help">{$t('filters.sort.hint')}</span>
          </label>

          <label class="field">
            <span class="field-label">{$t('filters.duration')}</span>
            <select bind:value={minMinutes} on:change={runSearch}>
              <option value={0}>{$t('filters.duration.any')}</option>
              <option value={20}>{$t('filters.duration.20')}</option>
              <option value={40}>{$t('filters.duration.40')}</option>
              <option value={60}>{$t('filters.duration.60')}</option>
            </select>
            <span class="field-help">{$t('filters.duration.hint')}</span>
          </label>

          <div class="field field-wide" role="group" aria-labelledby="f-content-label">
            <span class="field-label" id="f-content-label">{$t('filters.content')}</span>
            <div class="toggles">
              <label class="toggle" title={$t('toggle.collapse.hint')}>
                <input type="checkbox" bind:checked={collapseWorks} on:change={runSearch} />
                <span class="toggle-box"><Icon name="check" size={11} /></span>
                <Icon name="layers" size={14} />
                <span>{$t('toggle.collapse')}</span>
              </label>
              <label class="toggle" title={$t('toggle.playable.hint')}>
                <input type="checkbox" bind:checked={playableOnly} on:change={runSearch} />
                <span class="toggle-box"><Icon name="check" size={11} /></span>
                <Icon name="play" size={14} />
                <span>{$t('toggle.playable')}</span>
              </label>
              <label class="toggle" title={$t('toggle.subs.hint')}>
                <input type="checkbox" bind:checked={subsOnly} on:change={runSearch} />
                <span class="toggle-box"><Icon name="check" size={11} /></span>
                <Icon name="captions" size={14} />
                <span>{$t('toggle.subs')}</span>
              </label>
              <label class="toggle" title={$t('toggle.identified.hint')}>
                <input type="checkbox" bind:checked={identifiedOnly} on:change={runSearch} />
                <span class="toggle-box"><Icon name="check" size={11} /></span>
                <Icon name="verified" size={14} />
                <span>{$t('toggle.identified')}</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── ③ what is currently narrowing the grid ─────────────
         The band this page never had. Seven controls, a rail and a set
         of tags could all be filtering at once with nothing on screen
         saying which — reading the state meant reading every control.
         Each chip removes exactly its own filter. -->
    {#if activeChips.length > 0}
      <div class="band band-active" role="group" aria-label={$t('active.aria')}>
        <span class="eyebrow">{$t('active.label')}</span>
        <div class="active-list">
          {#each activeChips as chip (chip.id)}
            <button
              type="button"
              class="chip chip-removable"
              data-tone={chip.tone}
              title={$t('active.remove', { x: chip.label })}
              aria-label={$t('active.remove', { x: chip.label })}
              on:click={() => removeActive(chip)}
            >
              <span class="chip-text">{chip.label}</span>
              <Icon name="x" size={11} />
            </button>
          {/each}
          {#if activeTags.length >= 2}
            <button
              type="button"
              class="chip chip-mode"
              title={$t('active.match.hint')}
              on:click={toggleTagsMatch}
            >
              {tagsMatch === 'all' ? $t('active.match.all') : $t('active.match.any')}
            </button>
          {/if}
        </div>
        <button type="button" class="linkbtn" on:click={clearAllFilters}>
          <Icon name="eraser" size={13} />
          <span>{$t('active.clear')}</span>
        </button>
      </div>
    {/if}

    {#if !semanticMode}
      <!-- ── ④ discover ──────────────────────────────────────
           Above the tags because it answers the stronger question: not
           "what is this about" but "who decided this mattered". The
           eyebrow makes it read as a shelf; without it the "for you"
           chip sat alone against the gutter looking like a stray
           control on catalogues holding nothing from a curated list. -->
      <div class="band band-rail band-collapsible" role="group" aria-label={$t('discover.aria')}>
        <span class="eyebrow">{$t('discover.label')}</span>
        <div class="band-scroll">
          <button
            type="button"
            class="chip chip-computed"
            class:on={forYouMode}
            aria-pressed={forYouMode}
            title={$t('discover.forYou.hint')}
            on:click={toggleForYou}
          >
            <Icon name="sparkles" size={13} />
            <span class="chip-text">{$t('discover.forYou')}</span>
          </button>
          {#if canonRails.length > 0}
            <span class="band-sep" aria-hidden="true"></span>
          {/if}
          {#each canonRails as rail (rail.key)}
            <button
              type="button"
              class="chip chip-editorial"
              class:on={activeRail === rail.key}
              aria-pressed={activeRail === rail.key}
              title={$t('discover.rail.hint', { blurb: rail.blurb, held: rail.held, members: rail.members })}
              on:click={() => toggleRail(rail.key)}
            >
              <span class="chip-text">{rail.label}</span>
              <span class="chip-count">{rail.held}</span>
            </button>
          {/each}
        </div>
      </div>

      <!-- Why the rail came back empty. The three causes need different
           things from the user, so "no results" would leave them with
           nothing to do about it. -->
      {#if forYouMode && forYouReason !== 'ok' && forYouReason !== ''}
        <p class="band band-note">
          {#if forYouReason === 'no_profile'}
            {$t('foryou.noProfile', { n: forYouProfileSize })}
          {:else if forYouReason === 'no_vectors'}
            {$t('foryou.noVectors')}
          {:else}
            {$t('foryou.noDirection')}
          {/if}
        </p>
      {/if}

      <!-- ── ⑤ tags ─────────────────────────────────────────
           Tags are a browse axis, the sibling of DISCOVER above — not a
           filter like year or language. They used to be both: this row,
           AND a duplicate cloud nested inside the filters panel, two bands
           apart, drawn from the same `topTags`. Opening one printed Drama,
           Horror, Comedy and eleven more twice on the same screen, and the
           "all tags" link sent you to a section in a different container.

           One surface now. Collapsed it is ONE row that scrolls sideways
           rather than thirty chips wrapping to four; "all tags" expands it
           in place, right where you clicked, into the search box and the
           full cloud. Any tag at all can also be typed as #tag in the
           search box, which absorbs it as a filter. -->
      {#if topTags.length > 0}
        <div
          class="band band-tags"
          class:band-collapsible={!tagPanelOpen}
          class:band-tags-open={tagPanelOpen}
          role="group"
          aria-label={$t('tags.aria')}
        >
          <span class="eyebrow">{$t('tags.label')}</span>

          {#if !tagPanelOpen}
            <div class="band-scroll band-scroll-fade">
              {#each topTags.slice(0, 14) as tg (tg.tag_norm)}
                <button
                  type="button"
                  class="chip chip-tag"
                  class:on={activeTags.includes(tg.tag_norm)}
                  aria-pressed={activeTags.includes(tg.tag_norm)}
                  title={$t('tags.hint', { n: tg.count.toLocaleString($uiLocale) })}
                  on:click={() => pickTag(tg.tag_norm)}
                >
                  <span class="chip-text">{tg.tag_display}</span>
                  <span class="chip-count">{fmtDownloads(tg.count) || tg.count}</span>
                </button>
              {/each}
            </div>
            <button
              type="button"
              class="linkbtn"
              aria-expanded="false"
              title={$t('tags.all.hint')}
              on:click={openTagPanel}
            >
              <span>{$t('tags.all')}</span>
              <Icon name="chevronRight" size={12} />
            </button>
          {:else}
            <div class="band-tags-body" transition:slide={{ duration: 150, easing: cubicOut }}>
              <div class="tag-search-wrap">
                <span class="tag-search-icon"><Icon name="search" size={14} /></span>
                <input
                  class="tag-search-input"
                  type="text"
                  bind:value={tagSearchQuery}
                  placeholder={$t('tags.search.placeholder')}
                  aria-label={$t('tags.search.placeholder')}
                  on:input={onTagSearchInput}
                  on:focus={() => { tagSearchOpen = true; if (tagSearchQuery) onTagSearchInput(); }}
                  on:blur={closeTagSearchSoon}
                />
                {#if tagSearchOpen && (tagSearchHits.length > 0 || tagSearchBusy || tagSearchQuery.trim())}
                  <div class="tag-search-popover">
                    {#if tagSearchBusy}
                      <div class="tag-search-empty">{$t('tags.search.busy')}</div>
                    {:else if tagSearchHits.length === 0}
                      <div class="tag-search-empty">{$t('tags.search.empty', { q: tagSearchQuery })}</div>
                    {:else}
                      {#each tagSearchHits as tg (tg.tag_norm)}
                        <button
                          type="button"
                          class="tag-search-row"
                          class:active={activeTags.includes(tg.tag_norm)}
                          on:mousedown|preventDefault={() => pickTagFromSearch(tg)}
                        >
                          <span class="tag-search-name">
                            {#if activeTags.includes(tg.tag_norm)}<Icon name="check" size={12} />{/if}
                            {tg.tag_display}
                          </span>
                          <span class="chip-count">{fmtDownloads(tg.count) || tg.count}</span>
                        </button>
                      {/each}
                    {/if}
                  </div>
                {/if}
              </div>
              <div class="tag-cloud">
                {#each topTags as tg (tg.tag_norm)}
                  <button
                    type="button"
                    class="chip chip-tag"
                    class:on={activeTags.includes(tg.tag_norm)}
                    aria-pressed={activeTags.includes(tg.tag_norm)}
                    title={$t('tags.hint', { n: tg.count.toLocaleString($uiLocale) })}
                    on:click={() => pickTag(tg.tag_norm)}
                  >
                    <span class="chip-text">{tg.tag_display}</span>
                    <span class="chip-count">{fmtDownloads(tg.count) || tg.count}</span>
                  </button>
                {/each}
              </div>
            </div>
            <button
              type="button"
              class="linkbtn"
              aria-expanded="true"
              title={$t('tags.less.hint')}
              on:click={closeTagPanel}
            >
              <span>{$t('tags.less')}</span>
              <Icon name="chevronDown" size={12} />
            </button>
          {/if}
        </div>
      {/if}
    {/if}
  {/if}
</header>


<style>
  /* ══ HEADER CHROME ═══════════════════════════════════════════════
     One gutter, one chip language, one motion curve.

     What this replaces: four separate chip systems (a lowercase 11.5px
     green pill, a 12px gold square-cornered tab, a 12px white pill and a
     native checkbox) rendered at the same visual weight, plus a tag row
     that carried BOTH a 32px margin and a 12px padding and therefore
     started 12px further in than every band above it. That offset is the
     thing that read as "misaligned" — it was, by exactly 12px.

     Contrast note: --text-3 (#4A4F6A) is ~2.3:1 on --bg and fails AA for
     text at any size. The old header used it (via the --green-dim alias)
     for chip labels, section labels and the "more tags" link. It survives
     here only as a border and dash colour; anything readable uses
     --text-2 (~5.6:1) or an accent. */
  .chrome {
    --gutter: 32px;
    --chip-h: 27px;
    /* One easing for the whole header. Mixed curves are why a set of
       controls can feel like it came from three different products. */
    --ease: cubic-bezier(0.2, 0.8, 0.25, 1);
    /* Fixed column so the eyebrows of bands ③④⑤ put their chips on the
       same x. Sized for the longest label across en/es; a longer word in
       a future locale overflows into the 10px gap rather than pushing the
       chips out of alignment, which is the failure worth avoiding. */
    --eyebrow-w: 84px;

    position: sticky;
    top: 0;
    z-index: 5;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--amber) 5%, transparent), transparent 70%),
      color-mix(in srgb, var(--bg) 84%, transparent);
    backdrop-filter: blur(14px) saturate(1.15);
    border-bottom: 1px solid var(--line);
  }

  .band {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 var(--gutter);
    min-height: 40px;
  }

  /* Section label. Small caps rather than a chip, so it reads as the name
     of a shelf and not as another thing to click — the previous "descubrir"
     was styled like the dim chips beside it and got clicked. */
  .eyebrow {
    flex: 0 0 var(--eyebrow-w);
    font-family: var(--font-display);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-2);
    white-space: nowrap;
    line-height: 1;
  }

  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* One focus treatment for every control in the header. The old one had
     none at all: keyboard users could not see where they were. */
  .chrome button:focus-visible,
  .chrome a:focus-visible,
  .chrome input:focus-visible,
  .chrome select:focus-visible {
    outline: 2px solid var(--amber);
    outline-offset: 2px;
  }

  /* ─── ① identity + global actions ───────────────────────────── */
  .band-id {
    align-items: baseline;
    gap: 14px;
    padding-top: 15px;
    padding-bottom: 11px;
    transition: padding 0.24s var(--ease);
  }
  .wordmark {
    margin: 0;
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.035em;
    line-height: 1;
    color: var(--amber);
    text-shadow: 0 0 20px color-mix(in srgb, var(--amber) 32%, transparent);
    transition: font-size 0.24s var(--ease);
  }
  .caret {
    font-weight: 400;
    opacity: 0.6;
    animation: blink 1.1s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  .subtitle {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font-size: 12px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .quick {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .qbtn {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 11px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.14s var(--ease), background 0.14s var(--ease), border-color 0.14s var(--ease);
  }
  /* Pointer target grown to 44px without growing the drawn control — the
     visual density this header needs and the touch minimum are not the
     same number. -2px horizontally keeps neighbours from overlapping
     inside the 2px gap. */
  .qbtn::before { content: ''; position: absolute; inset: -7px -1px; }
  .qbtn:hover {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 8%, transparent);
  }
  .qbtn.on {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 13%, transparent);
    border-color: color-mix(in srgb, var(--amber) 42%, transparent);
  }
  .qbadge {
    min-width: 17px;
    height: 17px;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--amber) 20%, transparent);
    color: var(--amber);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .qpulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--cyan);
    animation: qpulse 1.7s var(--ease) infinite;
  }
  @keyframes qpulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 color-mix(in srgb, var(--cyan) 55%, transparent); }
    70% { opacity: 0.75; box-shadow: 0 0 0 5px transparent; }
  }

  /* ─── ② command bar ─────────────────────────────────────────── */
  .band-cmd {
    align-items: stretch;
    gap: 10px;
    padding-bottom: 13px;
    min-height: 0;
  }
  .searchbox {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 42px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface-2) 80%, transparent);
    color: var(--text-2);
    transition: border-color 0.16s var(--ease), box-shadow 0.16s var(--ease),
                background 0.16s var(--ease), color 0.16s var(--ease);
  }
  .searchbox:focus-within {
    color: var(--amber);
    background: var(--surface-2);
    border-color: color-mix(in srgb, var(--amber) 65%, transparent);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--amber) 13%, transparent),
      0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .searchbox-icon { display: inline-flex; flex: 0 0 auto; }
  .searchbox input {
    flex: 1 1 auto;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    font: inherit;
    font-size: 14px;
    color: var(--text-1);
  }
  .searchbox input::placeholder { color: var(--text-2); opacity: 0.75; }
  /* The box already shows focus; a second ring inside it is noise. */
  .searchbox input:focus-visible { outline: none; }
  .searchbox-clear {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    padding: 3px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    transition: color 0.14s var(--ease), background 0.14s var(--ease);
  }
  .searchbox-clear::before { content: ''; position: absolute; inset: -9px; }
  .searchbox-clear:hover { color: var(--red); background: color-mix(in srgb, var(--red) 14%, transparent); }
  .searchbox-key {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: color-mix(in srgb, var(--surface-3) 70%, transparent);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.4;
  }

  .filters-btn {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 42px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface-2) 80%, transparent);
    color: var(--text-2);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.15s var(--ease), background 0.15s var(--ease), border-color 0.15s var(--ease);
  }
  .filters-btn:hover { color: var(--text-1); border-color: var(--border-h, #2A2E48); }
  .filters-btn.on {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 11%, transparent);
    border-color: color-mix(in srgb, var(--amber) 45%, transparent);
  }
  .caret-icon {
    display: inline-flex;
    opacity: 0.7;
    transition: transform 0.2s var(--ease);
  }
  .caret-icon.open { transform: rotate(180deg); }

  .count-badge {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: var(--amber);
    color: var(--bg);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  /* ─── filters panel ─────────────────────────────────────────── */
  .fpanel {
    padding: 0 var(--gutter) 16px;
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 70%, transparent), transparent 90%);
  }
  .fgrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 15px 18px;
    padding: 16px 0 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .field-wide { grid-column: 1 / -1; }
  /* Visible, permanent labels. The row this replaces used placeholder text
     as its labels ("year ≥", "language", "+ views"), which means the label
     disappears exactly when a value exists to explain. */
  .field-label {
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--text-2);
    line-height: 1;
  }
  .field select,
  .field-pair input {
    height: 34px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-1);
    font: inherit;
    font-size: 13px;
    outline: none;
    transition: border-color 0.14s var(--ease), box-shadow 0.14s var(--ease);
  }
  .field select { cursor: pointer; width: 100%; }
  .field select:hover,
  .field-pair input:hover { border-color: var(--border-h, #2A2E48); }
  .field-pair { display: flex; align-items: center; gap: 8px; }
  .field-pair input { width: 100%; min-width: 0; font-variant-numeric: tabular-nums; }
  .field-dash { flex: 0 0 auto; color: var(--text-3); }
  /* Persistent helper text for the two controls whose behaviour is not
     guessable from their label — what "best" weights by, and that the
     duration floor reads the item's real files. Both were tooltips, which
     is to say invisible. */
  .field-help {
    font-size: 11px;
    line-height: 1.45;
    color: var(--text-2);
    opacity: 0.85;
  }

  .toggles { display: flex; flex-wrap: wrap; gap: 8px; }
  .toggle {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 12px 0 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-2) 65%, transparent);
    color: var(--text-2);
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    transition: color 0.14s var(--ease), background 0.14s var(--ease), border-color 0.14s var(--ease);
  }
  /* The native checkbox stays in the DOM for semantics, keyboard and
     screen readers; only its painting is replaced. */
  .toggle input {
    position: absolute;
    width: 1px; height: 1px;
    opacity: 0;
    margin: 0;
  }
  .toggle-box {
    flex: 0 0 auto;
    width: 15px;
    height: 15px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--text-2) 55%, transparent);
    border-radius: 4px;
    color: transparent;
    transition: background 0.14s var(--ease), border-color 0.14s var(--ease), color 0.14s var(--ease);
  }
  .toggle:hover { color: var(--text-1); border-color: var(--border-h, #2A2E48); }
  .toggle:focus-within { outline: 2px solid var(--amber); outline-offset: 2px; }
  .toggle:has(input:checked) {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 12%, transparent);
    border-color: color-mix(in srgb, var(--amber) 45%, transparent);
  }
  .toggle:has(input:checked) .toggle-box {
    background: var(--amber);
    border-color: var(--amber);
    color: var(--bg);
  }

  /* Expanded tag band — the searchable long tail, in place. */
  .band-tags-body {
    flex: 1 1 auto;
    min-width: 0;
    padding-bottom: 4px;
  }
  .tag-cloud {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 132px;
    overflow-y: auto;
    padding: 10px 2px 2px;
  }

  .tag-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    max-width: 320px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-2);
    transition: border-color 0.14s var(--ease);
  }
  .tag-search-wrap:focus-within { border-color: color-mix(in srgb, var(--amber) 60%, transparent); color: var(--amber); }
  .tag-search-icon { display: inline-flex; flex: 0 0 auto; }
  .tag-search-input {
    flex: 1 1 auto;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    font: inherit;
    font-size: 12.5px;
    color: var(--text-1);
  }
  .tag-search-input::placeholder { color: var(--text-2); opacity: 0.75; }
  .tag-search-input:focus-visible { outline: none; }
  .tag-search-popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 30;
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--border-h, #2A2E48);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  }
  .tag-search-empty { padding: 10px 8px; font-size: 11.5px; color: var(--text-2); }
  .tag-search-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s var(--ease), color 0.1s var(--ease);
  }
  .tag-search-row:hover { background: var(--surface-3); color: var(--text-1); }
  .tag-search-row.active { color: var(--amber); }
  .tag-search-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── the one chip language ─────────────────────────────────── */
  .chip {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--chip-h);
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--text-2) 26%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-2) 55%, transparent);
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.14s var(--ease), background 0.14s var(--ease),
                border-color 0.14s var(--ease), transform 0.09s var(--ease);
  }
  .chip::before { content: ''; position: absolute; inset: -8px -2px; }
  .chip:hover {
    color: var(--text-1);
    background: color-mix(in srgb, var(--surface-2) 92%, transparent);
    border-color: color-mix(in srgb, var(--text-2) 48%, transparent);
  }
  .chip:active { transform: scale(0.97); }
  .chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 24ch;
  }
  .chip-count {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    opacity: 0.6;
  }

  /* Tags — statistical. Neutral until picked. */
  .chip-tag.on,
  .chip-tag[aria-pressed='true'] {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 18%, transparent);
    border-color: color-mix(in srgb, var(--amber) 60%, transparent);
  }

  /* Editorial — decided by people. Gold: the page's accent belongs to the
     strongest signal it has. */
  .chip-editorial {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 7%, transparent);
    border-color: color-mix(in srgb, var(--amber) 30%, transparent);
  }
  .chip-editorial:hover {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 16%, transparent);
    border-color: color-mix(in srgb, var(--amber) 52%, transparent);
  }
  .chip-editorial.on {
    background: color-mix(in srgb, var(--amber) 26%, transparent);
    border-color: var(--amber);
    font-weight: 600;
  }

  /* Computed rather than curated — a cooler tone so it does not read as
     another editorial list. */
  .chip-computed {
    color: var(--cyan);
    background: color-mix(in srgb, var(--cyan) 7%, transparent);
    border-color: color-mix(in srgb, var(--cyan) 30%, transparent);
  }
  .chip-computed:hover {
    color: var(--cyan);
    background: color-mix(in srgb, var(--cyan) 16%, transparent);
    border-color: color-mix(in srgb, var(--cyan) 52%, transparent);
  }
  .chip-computed.on {
    background: color-mix(in srgb, var(--cyan) 24%, transparent);
    border-color: var(--cyan);
    font-weight: 600;
  }

  /* Active filters. Tinted by where the filter came from, so the row is
     scannable; hovering any of them turns red, because clicking removes. */
  .chip-removable { color: var(--text-1); }
  .chip-removable[data-tone='query'] {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 10%, transparent);
    border-color: color-mix(in srgb, var(--green) 38%, transparent);
  }
  .chip-removable[data-tone='tag'],
  .chip-removable[data-tone='rail'] {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 12%, transparent);
    border-color: color-mix(in srgb, var(--amber) 40%, transparent);
  }
  .chip-removable[data-tone='filter'] {
    color: var(--text-1);
    background: color-mix(in srgb, var(--surface-3) 80%, transparent);
    border-color: color-mix(in srgb, var(--text-2) 34%, transparent);
  }
  .chip-removable:hover {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 13%, transparent);
    border-color: color-mix(in srgb, var(--red) 55%, transparent);
  }
  .chip-mode {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  /* ─── ③ active filters ──────────────────────────────────────── */
  .band-active { padding-bottom: 10px; }
  .active-list {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .linkbtn {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 2px;
    border: 0;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    transition: color 0.14s var(--ease);
  }
  .linkbtn::before { content: ''; position: absolute; inset: -13px -6px; }
  .linkbtn:hover { color: var(--amber); }

  /* ─── ④⑤ discover + tags ────────────────────────────────────── */
  /* Horizontal scroll instead of wrapping. Thirty tag chips wrapped to
     four rows and took the fold; one row that scrolls holds the same
     content and costs 34px. */
  .band-scroll {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    /* Room for the 2px focus ring + its offset, which overflow:hidden
       would otherwise clip off the top and bottom of a focused chip. */
    padding: 5px 0;
    scroll-padding-inline: 16px;
  }
  .band-scroll::-webkit-scrollbar { display: none; }
  /* Fades the right edge so a cut-off chip reads as "there is more" rather
     than as a clipping bug. Dropped while anything inside has focus, since
     the mask would also fade the focus ring. */
  .band-scroll-fade {
    /* Prefixed as well: unprefixed mask-image only landed in Chrome 120, and
       without the fallback the row hard-cuts mid-chip, which is the exact
       "is this broken?" reading the fade exists to prevent. */
    -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 40px), transparent 100%);
    mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 40px), transparent 100%);
    /* So the last chip can scroll clear of the fade instead of living inside
       it forever. */
    padding-right: 40px;
  }
  .band-scroll-fade:focus-within {
    -webkit-mask-image: none;
    mask-image: none;
  }
  .band-sep {
    flex: 0 0 auto;
    width: 1px;
    height: 16px;
    margin: 0 4px;
    background: var(--line);
  }
  .band-note {
    min-height: 0;
    max-width: 70ch;
    padding-top: 2px;
    padding-bottom: 10px;
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-2);
  }
  .band-rail { padding-bottom: 2px; }
  .band-tags { padding-bottom: 8px; }
  /* Expanded, the band stops being a 40px row: the eyebrow and the collapse
     link stay pinned to the top while the search box and the cloud take the
     height they need. `.band-collapsible` is dropped in the markup while
     this is on, so nothing clips it to 56px. */
  .band-tags-open {
    align-items: flex-start;
    padding-top: 4px;
    padding-bottom: 12px;
  }
  .band-tags-open .eyebrow,
  .band-tags-open .linkbtn { margin-top: 8px; }

  /* ─── condensed on scroll ───────────────────────────────────── */
  /* Once you are reading posters, the two discovery bands fold away and
     the command bar plus the active-filter row stay pinned. Both are one
     scroll-up away, and nothing that reports state is ever hidden. */
  .band-collapsible {
    overflow: hidden;
    max-height: 56px;
    transition: max-height 0.24s var(--ease), opacity 0.18s var(--ease);
  }
  .chrome.condensed .band-collapsible {
    min-height: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    opacity: 0;
    /* Delayed so the band is not pulled out of the tab order mid-animation,
       and so a focused chip inside it does not vanish under the user. */
    visibility: hidden;
    transition:
      max-height 0.24s var(--ease),
      opacity 0.14s var(--ease),
      visibility 0s linear 0.24s;
  }
  .chrome.condensed .band-id { padding-top: 9px; padding-bottom: 7px; }
  .chrome.condensed .wordmark { font-size: 20px; }

  /* ─── responsive ────────────────────────────────────────────── */
  @media (max-width: 860px) {
    .chrome { --gutter: 18px; }
    .band-id { flex-wrap: wrap; }
    .subtitle { order: 3; flex: 1 1 100%; }
    .band-cmd { flex-wrap: wrap; }
    .searchbox { flex: 1 1 100%; }
    .filters-btn { flex: 1 1 auto; justify-content: center; }
  }
  @media (max-width: 620px) {
    .chrome { --gutter: 14px; }
    /* The eyebrow takes its own line rather than eating half the width of
       a 360px viewport. */
    .band-rail, .band-tags, .band-active { flex-wrap: wrap; }
    .eyebrow { flex: 0 0 100%; }
    .band-collapsible { max-height: 92px; }
    .wordmark { font-size: 22px; }
  }

  /* ─── reduced motion ────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    .chrome,
    .chrome *,
    .chrome *::before {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
    }
    .caret { opacity: 0.6; }
  }
</style>
