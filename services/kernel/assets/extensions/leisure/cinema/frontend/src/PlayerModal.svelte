<script lang="ts">
  /*
    The player modal: header, the shared KernlPlayer with cinema's preloader,
    codec banner and community-subtitles menu section, the file list, the
    description and the "more like this" strip.

    Presentational and always mounted — the modal itself is the `{#if}`
    inside — so the <video> binding reaches the page the same way it did when
    this markup lived there. The player state is the page's (it is driven by
    handlers on the <video>); the subtitle state comes from the pipeline's
    stores.
  */
  import type { Readable } from 'svelte/store';
  import type { Translate } from '$shared/i18n';
  import KernlPlayer from '$shared/media/KernlPlayer.svelte';
  import type { ArchiveItem, PlayFile } from './types.js';
  import { thumbUrl, posterUrl, onPosterError } from './media.js';
  import { fmtBytes, fmtRuntime } from './format.js';
  import { shortPubkey, fmtBytesShort, type SubsPipeline } from './subs-pipeline.js';

  export let t: Readable<Translate>;

  export let playOpen: boolean;
  export let playItem: ArchiveItem | null;
  export let playFiles: PlayFile[];
  export let playActiveIdx: number;
  export let playLoading: boolean;
  export let playError: string;
  export let playSrc: string;
  export let playNeedsTranscode: boolean;
  // Toggled from in here, owned by the page (closePlayer resets them).
  export let descOpen: boolean;
  export let filesOpen: boolean;
  export let controlsVisible: boolean;
  /** The <video> KernlPlayer renders — the page wires its media events. */
  export let videoEl: HTMLVideoElement | null;

  export let isFullscreen: boolean;
  export let playerIsPlaying: boolean;
  export let trackUrl: string;

  // Startup preloader and conversion fallback.
  export let startupBusy: boolean;
  export let startupPhase: string;
  export let startupIndeterminate: boolean;
  export let startupBufferedFrac: number;
  export let startupElapsedMs: number;
  export let convertBusy: boolean;
  export let convertLabel: string;
  export let convertFrac: number;
  export let convertError: string;
  export let codecFallbackHint: string;
  export let codecFallbackExpected: boolean;

  export let similarItems: ArchiveItem[];
  export let similarOpen: boolean;

  export let subs: SubsPipeline;

  export let closePlayer: () => void;
  export let selectPlayFile: (idx: number) => void;
  export let showControls: () => void;
  export let toggleSimilar: () => void;
  export let openPlayer: (item: ArchiveItem) => void;

  const {
    subsCtl, subsTick, translateBusy, transcribeBusy, translateError, translateMode,
    transcribeJustDone, transcribeCueCount,
    federatedSubs, federatedRefreshing, federatedTrustOnly, federatedError,
    publishersMap, downloadingRowIds,
  } = subs;

  // Group federated rows for the UI: expose computed lists rather than
  // recomputing inline in the markup. Reactivity drives them.
  $: federatedShown = $federatedTrustOnly
    ? $federatedSubs.filter(r => ($publishersMap[r.signerPubkey]?.trust ?? 'unknown') === 'trusted'
                              || ($publishersMap[r.signerPubkey]?.trust ?? 'unknown') === 'mine')
    : $federatedSubs;
</script>

{#if playOpen && playItem}
  <div class="modal-back" on:click|self={closePlayer} role="presentation">
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-head">
        <span class="modal-title">{playItem.title || playItem.identifier}</span>
        {#if playItem.date}<span class="badge">{playItem.date.slice(0, 4)}</span>{/if}
        {#if playItem.creator}<span class="dim mini">{playItem.creator}</span>{/if}
        <span class="spacer" />
        {#if playItem.description}
          <button
            class="ghost sm"
            class:on={descOpen}
            on:click={() => descOpen = !descOpen}
            title={descOpen ? 'hide description' : 'show description'}
          >
            ⓘ {descOpen ? 'hide' : 'info'}
          </button>
        {/if}
        {#if playFiles.length > 1}
          <button
            class="ghost sm"
            class:on={filesOpen}
            on:click={() => filesOpen = !filesOpen}
            title={filesOpen ? 'hide file list' : 'show file list'}
          >
            ▤ {filesOpen ? 'hide' : `files (${playFiles.length})`}
          </button>
        {/if}
        <a class="ghost sm" href="https://archive.org/details/{playItem.identifier}" target="_blank" rel="noopener">archive.org ↗</a>
        <button class="ghost sm" on:click={closePlayer}>× close</button>
      </header>

      <div class="modal-body">
        <div class="player">
          {#if playLoading}
            <div class="player-msg loading">▮ loading file list…</div>
          {:else if playError}
            <div class="player-msg err">⚠ {playError}</div>
          {:else if playSrc}
            {@const active = playFiles[playActiveIdx]}
            {#if active?.kind === 'video'}
              <div
                class="video-stack"
                class:fullscreen={isFullscreen}
                class:controls-hidden={!controlsVisible}
                data-debug-tracksrc={trackUrl ?? ''}
                on:mousemove={showControls}
                on:mouseleave={() => { if (playerIsPlaying) controlsVisible = false; }}
                role="presentation"
              >
                <!-- The <video> stays mounted across track changes (the <track>
                     is keyed on its own URL further down). Native controls are
                     OFF — we draw our own bar so caption font/size/colour and
                     translation engine all live in one settings popover. -->
                <!-- No <track> child — we inject cues via
                     videoEl.addTextTrack() in loadTranscriptManual().
                     Doing it programmatically sidesteps Svelte/browser
                     quirks where {#if}/{#key} comment markers as direct
                     children of <video> stop the browser from parsing
                     the inner <track> element. -->
                <!-- One player for cinema, TV and torrents. On demand:
                     full transport, scrubbing and speed. Captions, their
                     styling and the translation menu all live in its bar,
                     driven by the shared controller. -->
                <!-- `poster` shows the item's own artwork until the first
                     frame decodes. The player has supported it all along;
                     cinema simply never passed one, which is why starting a
                     video was a black rectangle for several seconds. -->
                <KernlPlayer
                  bind:video={videoEl}
                  src={playSrc}
                  poster={playItem ? posterUrl(playItem.identifier) : ''}
                  live={false}
                  autoplay={true}
                  crossorigin="anonymous"
                  ctl={$subsCtl}
                  tick={$subsTick}
                  ready={!startupBusy}
                >
                  <!-- No gear. Subtitles are managed in the player's own
                       caption menu, which is the only place they live now. -->

                  <svelte:fragment slot="overlay">

                <!-- ── Startup preloader ──────────────────────────────
                     The gap between "modal opened" and "first frame" is
                     seconds long on a cold archive.org fetch and longer
                     behind the transcoder. It used to be a black rectangle
                     with a dead play glyph, which reads as broken.

                     Reports the real thing: phase, elapsed, and the actual
                     buffered fraction when the browser knows one. Hidden
                     under the subtitle modals so two cards never stack. -->
                {#if startupBusy && !$translateBusy && !$transcribeBusy}
                  <div class="vboot" role="status" aria-live="polite">
                    <div class="vboot-card">
                      <!-- Film leader: four sprocket bars chasing each other.
                           Pure decoration, and the only part that is. -->
                      <div class="vboot-reel" aria-hidden="true">
                        <span></span><span></span><span></span><span></span>
                      </div>

                      <div class="vboot-label">
                        {#if convertBusy}
                          <!-- Two phases with very different rates, so name
                               the one that is actually running and show its
                               real fraction. The old bar claimed to be
                               converting while it was still downloading. -->
                          {convertLabel}{#if convertFrac > 0}&nbsp;· {Math.round(convertFrac * 100)}%{/if}
                        {:else if convertError}
                          {convertError}
                        {:else if playNeedsTranscode}
                          {$t('boot.transcoding')}
                        {:else if startupPhase === 'connecting'}
                          {$t('boot.connecting')}
                        {:else}
                          {$t('boot.buffering')}
                        {/if}
                      </div>

                      <!-- Determinate whenever `video.buffered` gives us a
                           real fraction; a sweeping phosphor line otherwise,
                           so it never pretends to know a percentage. -->
                      <div
                        class="vboot-bar"
                        class:indeterminate={startupIndeterminate}
                        role="progressbar"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={startupIndeterminate ? undefined : Math.round(startupBufferedFrac * 100)}
                      >
                        <div
                          class="vboot-fill"
                          style={startupIndeterminate ? '' : `width:${(startupBufferedFrac * 100).toFixed(1)}%`}
                        ></div>
                      </div>

                      <div class="vboot-meta">
                        <span class="vboot-elapsed">{(startupElapsedMs / 1000).toFixed(1)}s</span>
                        {#if !startupIndeterminate}
                          <span class="vboot-sep">·</span>
                          <span>{Math.round(startupBufferedFrac * 100)}% {$t('boot.buffered')}</span>
                        {/if}
                        {#if playNeedsTranscode}
                          <span class="vboot-sep">·</span>
                          <span class="vboot-note">{$t('boot.noSeek')}</span>
                        {/if}
                      </div>
                    </div>
                  </div>
                {/if}

                <!-- Suppressed while a subtitle modal owns the screen: the
                     banner is `position:absolute; left/right:12px` and was
                     drawing a full-width amber bar straight through the
                     centred card. -->
                {#if codecFallbackHint && !$translateBusy && !$transcribeBusy}
                  <div
                    class="codec-fallback-banner"
                    class:cfb-expected={codecFallbackExpected}
                    role="status"
                  >
                    <span class="cfb-spinner"></span>
                    {codecFallbackHint}
                  </div>
                {/if}

                <!-- Settings popover (over the video, top-right). Three tabs:
                     subs, style, speed. Closes when the user clicks outside
                     (handled by the .video-stack mousedown). -->
                  </svelte:fragment>

                  <!-- ── COMMUNITY SUBTITLES ────────────────────────
                       The one thing the shared player cannot know about:
                       subtitles other people published over Nostr and
                       archive.org. This used to be a whole second panel
                       behind a gear icon, which meant choosing a track was
                       in one place and finding a track was in another.
                       Now it is the last section of the same menu. -->
                  <svelte:fragment slot="cc-extra">
                    {#if playItem}
                      <div class="cc-fed">
                        <div class="cc-fed-head">
                          <span>De la comunidad</span>
                          <button
                            class="cc-fed-refresh"
                            disabled={$federatedRefreshing}
                            on:click={() => subs.loadFederatedSubs(true)}
                            title="Buscar en Nostr y archive.org"
                            aria-label="Buscar en la red"
                          >{$federatedRefreshing ? '…' : '↻'}</button>
                        </div>

                        {#if $federatedError}
                          <p class="cc-fed-err">{$federatedError}</p>
                        {/if}

                        {#if federatedShown.length === 0}
                          <p class="cc-fed-empty">
                            {$federatedSubs.length === 0
                              ? 'Nadie compartió subtítulos de esta película todavía.'
                              : 'Ningún publicador confiable ofrece subtítulos.'}
                          </p>
                        {:else}
                          {#each federatedShown as row (row.rowId)}
                            {@const pub = $publishersMap[row.signerPubkey]}
                            {@const trust = pub?.trust ?? 'unknown'}
                            <!-- One row, one line: language and who made it
                                 are what you choose by; provider and size
                                 are detail and live in the tooltip. -->
                            <div class="cc-fed-row" class:got={row.downloadedSubId}>
                              <span class="cc-fed-lang">{row.tgtLang || '??'}</span>
                              <span
                                class="cc-fed-who"
                                title={`${row.providerId} · ${row.engine || 'humano'} · ${fmtBytesShort(row.sizeBytes)}`}
                              >
                                {row.engine || 'humano'}
                                {#if row.signerPubkey}· {pub?.alias || shortPubkey(row.signerPubkey)}{/if}
                              </span>
                              {#if trust === 'trusted'}
                                <span class="cc-fed-trust" title="Publicador confiable">★</span>
                              {/if}
                              {#if row.downloadedSubId}
                                <span class="cc-fed-got" title="Ya lo tenés">✓</span>
                              {:else}
                                <button
                                  class="cc-fed-get"
                                  disabled={$downloadingRowIds.has(row.rowId) || !row.webseedUrl}
                                  on:click={() => subs.downloadFederated(row)}
                                  title={row.webseedUrl || 'Sin webseed disponible'}
                                >{$downloadingRowIds.has(row.rowId) ? '…' : 'Usar'}</button>
                              {/if}
                            </div>
                          {/each}
                        {/if}

                        <label class="cc-fed-trustonly">
                          <input type="checkbox" bind:checked={$federatedTrustOnly} />
                          Sólo publicadores confiables
                        </label>
                      </div>
                    {/if}
                  </svelte:fragment>
                </KernlPlayer>

                <!-- Progress for a running subtitle job is NOT drawn here.
                     It belongs to the player: the chip in its bar is the
                     glanceable summary and the block in its caption menu the
                     detail, both read from the one `ctl.job` this page now
                     feeds over `subscribeProgress`. A big centered modal used
                     to sit on top of those two, built from separate local
                     state — so one screen reported the same translation three
                     times, and the two the modal covered said 0% because
                     nothing was feeding them. What stays here is what the
                     player has no way to know: the finished/failed toasts. -->
                {#if $transcribeJustDone}
                  <div class="transcribe-toast" role="status">
                    <span class="check">✓</span>
                    subtitles ready{$transcribeCueCount ? ` · ${$transcribeCueCount} cues` : ''}
                  </div>
                {:else if $translateError}
                  <div class="translate-error" role="alert">
                    <span class="t-err-icon">⚠</span>
                    <div class="t-err-body">
                      <!-- `translateError` carries whatever step of the
                           subtitle chain gave up, so the heading follows
                           `translateMode` rather than always claiming a
                           translation. It read "Translation failed" over a
                           passthrough of a shipped subtitle file, which is
                           the one thing that was definitely not happening. -->
                      <strong>{$translateMode === 'transcribe' ? 'No se pudieron obtener subtítulos' : 'Falló la traducción'}</strong>
                      <div class="dim mini">{$translateError}</div>
                    </div>
                    <button class="t-err-dismiss" on:click={() => $translateError = ''} title="dismiss">×</button>
                  </div>
                {/if}
              </div>
            {:else if active?.kind === 'audio'}
              <audio src={playSrc} controls autoplay></audio>
            {:else if active?.kind === 'image'}
              <img src={playSrc} alt={active.name} />
            {/if}
            <!-- Only once playback is under way. While the preloader is up it
                 already says both of these — and better: it shows the real
                 elapsed time, where this line promised "1-3s startup" over a
                 card reading 19.7s. Two notices, one of them wrong. What
                 survives here is the part the preloader stops saying when it
                 disappears: why the scrubber won't move. -->
            {#if playNeedsTranscode && !startupBusy}
              <div class="transcode-note dim mini">
                ⚙ {$t('transcode.note', { fmt: active?.name.split('.').pop()?.toUpperCase() ?? '' })}
              </div>
            {/if}
            <!-- subs / engine / language / font / size all moved into the
                 custom player's settings popover (gear icon over video). -->
          {/if}
        </div>

        {#if playFiles.length > 1 && filesOpen}
          <div class="filelist filelist-bottom">
            <div class="filelist-head-row">
              <span class="dim mini filelist-head">{playFiles.length} files · click to switch</span>
              <button class="filelist-close" on:click={() => filesOpen = false} title="hide">×</button>
            </div>
            <div class="filelist-row">
              {#each playFiles as f, idx}
                <button class="file-row" class:on={idx === playActiveIdx} on:click={() => selectPlayFile(idx)}>
                  <span class="kind kind-{f.kind}">{f.kind[0].toUpperCase()}</span>
                  <span class="fname">{f.name}</span>
                  <span class="dim mini">{fmtBytes(f.size)}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      {#if playItem.description && descOpen}
        <div class="modal-desc" role="region" aria-label="Item description">
          <div class="modal-desc-head">
            <span class="modal-desc-label">▸ DESCRIPTION</span>
            <span class="spacer" />
            <button class="modal-desc-close" on:click={() => descOpen = false} title="close">×</button>
          </div>
          <div class="modal-desc-body">
            {playItem.description.length > 1200 ? playItem.description.slice(0, 1200) + '…' : playItem.description}
          </div>
        </div>
      {/if}

      <!-- ── MORE LIKE THIS ────────────────────────────────────
           The route from a film you liked to the next one, which is the
           thing a catalogue of this size most lacks. Cosine over the
           stored vectors, so it works on the cartoons and industrial
           shorts that no identification-based signal can see.
           Rendered only when there is something to show: an empty row
           under every film would just be noise. -->
      {#if similarItems.length > 0}
        <div class="similar-row" class:folded={!similarOpen} role="region" aria-label="Similar titles">
          <!-- The whole header line is the toggle: a 4px chevron is a poor
               target, and there is nothing else on this line to click. -->
          <button
            class="similar-head"
            on:click={toggleSimilar}
            aria-expanded={similarOpen}
            title={similarOpen ? 'ocultar — le devuelve el alto al video' : 'ver títulos parecidos'}
          >
            <span class="similar-label">MÁS COMO ESTO</span>
            <span class="similar-count">{similarItems.length}</span>
            <span class="spacer" />
            {#if !similarOpen}<span class="similar-hint mini">oculto</span>{/if}
            <span class="similar-chev" aria-hidden="true">{similarOpen ? '⌄' : '⌃'}</span>
          </button>
          {#if similarOpen}
            <div class="similar-strip">
              {#each similarItems as s, i (s.identifier)}
                {@const dur = s.media?.duration_sec ?? s.runtime_sec}
                <button
                  class="similar-card"
                  style="--i:{i}"
                  on:click={() => openPlayer(s)}
                  title={s.title || s.identifier}
                >
                  <span class="similar-thumb">
                    <img src={thumbUrl(s.identifier)} alt="" loading="lazy" on:error={onPosterError} />
                    <!-- Rank is real information here: the endpoint returns
                         cosine order, so 01 is the closest match. -->
                    <span class="similar-rank">{String(i + 1).padStart(2, '0')}</span>
                    {#if dur}<span class="similar-dur">{fmtRuntime(dur)}</span>{/if}
                    <span class="similar-play" aria-hidden="true">▶</span>
                  </span>
                  <span class="similar-title">{s.title || s.identifier}</span>
                  <span class="similar-meta">
                    {#if s.date}<span class="sim-year">{s.date.slice(0, 4)}</span>{/if}
                    {#if s.creator}<span class="sim-by">{s.creator}</span>{/if}
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}


<style>
  @keyframes blink { 50% { opacity: 0; } }

  .spacer { flex: 1; }
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

  .err {
    margin: 12px 32px;
    padding: 8px 14px;
    border: 1px solid var(--red, #f55);
    color: var(--red, #f55);
    background: rgba(255, 60, 60, 0.06);
    border-radius: var(--radius-sm);
  }
  .ghost.sm {
    padding: 4px 10px;
    font-size: 12px;
  }
  .result {
    margin: 12px 32px;
    padding: 8px 14px;
    border: 1px dashed var(--green-dim, #4d8a5a);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    font-size: 12.5px;
  }

  /* ── Community subtitles, inside the player's caption menu ────────
     Styled to belong to that menu rather than to this page: the menu sits
     over video on a dark translucent panel, so these rows borrow its
     restraint — no borders per row, one line each, the action on the right.
     Global because the markup is passed through a slot into KernlPlayer,
     which puts it outside this component's style scope. */
  /* A panel of its own, not a section that leans on a divider.
     The border-top alone was enough while something sat above it, but when
     the film has no tracks yet this is the only content in the menu and it
     read as a fragment floating over the video. Its own surface, border and
     radius mean it looks deliberate whether it is first or last. */
  :global(.cc-fed) {
    margin-top: 10px;
    padding: 10px 10px 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    font-family: var(--font-body);
  }
  :global(.cc-fed-head) {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.45);
    margin-bottom: 6px;
  }
  :global(.cc-fed-refresh) {
    margin-left: auto;
    width: 20px; height: 20px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
  }
  :global(.cc-fed-refresh:hover:not(:disabled)) { color: #F0B429; border-color: #F0B429; }
  :global(.cc-fed-refresh:disabled) { opacity: 0.4; cursor: wait; }

  /* One row per shared track. Language leads because that is what you pick
     by; who made it follows; provider and size are detail and live in the
     tooltip rather than crowding the line. */
  :global(.cc-fed-row) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
    border-radius: 5px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.85);
  }
  :global(.cc-fed-row:hover) { background: rgba(255, 255, 255, 0.06); }
  :global(.cc-fed-row.got) { color: rgba(255, 255, 255, 0.5); }
  :global(.cc-fed-lang) {
    font-family: var(--font-mono);
    text-transform: uppercase;
    font-weight: 700;
    font-size: 11px;
    min-width: 22px;
  }
  :global(.cc-fed-who) {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
  }
  :global(.cc-fed-trust) { color: #F0B429; font-size: 11px; }
  :global(.cc-fed-got) { color: #6ee7a0; font-size: 12px; }
  :global(.cc-fed-get) {
    padding: 3px 9px;
    border-radius: 4px;
    border: 1px solid rgba(240, 180, 41, 0.5);
    background: rgba(240, 180, 41, 0.12);
    color: #F0B429;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  :global(.cc-fed-get:hover:not(:disabled)) { background: #F0B429; color: #10131a; }
  :global(.cc-fed-get:disabled) { opacity: 0.35; cursor: not-allowed; }

  :global(.cc-fed-err) { color: #ff9a9a; font-size: 11px; margin: 4px 0; }
  :global(.cc-fed-empty) {
    color: rgba(255, 255, 255, 0.45);
    font-size: 11px;
    line-height: 1.5;
    margin: 4px 0;
  }
  :global(.cc-fed-trustonly) {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
  }
  :global(.cc-fed-trustonly input) { accent-color: #F0B429; cursor: pointer; }

  /* ── MORE LIKE THIS ─────────────────────────────────────────────
     Same panel grammar as the description drawer below the player — ruled
     top edge, a labelled header line, its own padding — but keyed amber
     instead of cyan so the two drawers read as siblings, not twins. It used
     to sit flush against the modal frame with no gutter at all, posters
     bleeding into the bezel. */
  .similar-row {
    position: relative;
    flex-shrink: 0;
    border-top: 1px solid rgba(255, 176, 0, 0.28);
    background:
      linear-gradient(180deg, rgba(255, 176, 0, 0.05), rgba(0, 0, 0, 0.55));
  }
  /* The whole header line toggles the strip. Folded, the row is 30px of
     header and the player takes the ~210px back. */
  .similar-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 18px;
    background: rgba(255, 176, 0, 0.04);
    border: 0;
    border-bottom: 1px dashed rgba(255, 176, 0, 0.22);
    border-radius: 0;
    cursor: pointer;
    text-align: left;
    transition: background 120ms;
  }
  .similar-head:hover { background: rgba(255, 176, 0, 0.09); }
  .similar-head:focus-visible {
    outline: 1px solid var(--amber, #ffb000);
    outline-offset: -1px;
  }
  .similar-row.folded .similar-head { border-bottom-color: transparent; }
  .similar-label {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.45);
  }
  /* How many there are, before you scroll to find out. */
  .similar-count {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    line-height: 1;
    padding: 3px 5px;
    color: #d8b675;
    border: 1px solid rgba(255, 176, 0, 0.3);
    font-variant-numeric: tabular-nums;
  }
  .similar-head .spacer { flex: 1; }
  .similar-hint {
    color: var(--green-dim, #4d8a5a);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .similar-chev {
    font-size: 13px;
    line-height: 1;
    color: var(--amber, #ffb000);
    width: 18px;
    text-align: center;
    transition: transform 160ms ease;
  }
  .similar-head:hover .similar-chev { transform: translateY(1px); }
  .similar-row.folded .similar-head:hover .similar-chev { transform: translateY(-1px); }

  /* Horizontal strip: this sits inside a modal whose height is already
     spoken for by the player, so it scrolls sideways rather than pushing
     the video off screen. */
  .similar-strip {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 11px 18px 12px;
    /* No scroll-snap. With `scroll-snap-align: start` on the cards Chrome
       performs an initial snap that parks scrollLeft at 18 — exactly the
       left padding — so the gutter this whole pass is about was eaten
       before anyone touched the wheel. */
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 176, 0, 0.35) transparent;
  }
  .similar-strip::-webkit-scrollbar { height: 6px; }
  .similar-strip::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.04); }
  .similar-strip::-webkit-scrollbar-thumb {
    background: rgba(255, 176, 0, 0.35);
    border-radius: 0;
  }
  .similar-strip::-webkit-scrollbar-thumb:hover { background: rgba(255, 176, 0, 0.6); }
  /* Right-edge fade: the only honest signal that the strip keeps going,
     since the scrollbar is 6px of near-black. Done as a mask on the strip
     itself — an absolutely-positioned overlay would have to guess the
     header's height to know where to start. */
  .similar-strip {
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 52px), transparent);
    mask-image: linear-gradient(90deg, #000 calc(100% - 52px), transparent);
  }

  .similar-card {
    flex: 0 0 112px;
    /* A flex item's default `min-width: auto` is its min-content width, and
       the creator line is `nowrap` — so "Castle Productions Corporation"
       stretched its card to 180px and the strip came out ragged. */
    min-width: 0;
    max-width: 112px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 0;
    background: none;
    border: 0;
    cursor: pointer;
    text-align: left;
    color: var(--green, #33ff77);
    animation: sim-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: calc(var(--i) * 28ms);
  }
  @keyframes sim-in {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: none; }
  }
  /* The frame lives on the poster, not on the card: a border around card +
     caption boxed the text too and made every hover look like a form field. */
  .similar-thumb {
    position: relative;
    display: block;
    width: 112px;
    height: 148px;
    overflow: hidden;
    border: 1px solid var(--line, #1d3a26);
    border-radius: 3px;
    background: linear-gradient(135deg, #142219, #050807);
    transition: border-color 160ms, box-shadow 160ms, transform 160ms ease;
  }
  .similar-card img {
    width: 100%;
    height: 100%;
    /* `contain`, like the grid poster: these thumbnails are whatever frame
       archive.org grabbed, often a 4:3 title card. Cropped to a portrait
       box the title itself was the part that got cut. */
    object-fit: contain;
    display: block;
    transition: transform 320ms ease, opacity 200ms;
  }
  .similar-card:hover .similar-thumb,
  .similar-card:focus-visible .similar-thumb {
    transform: translateY(-3px);
    border-color: var(--amber, #ffb000);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.75), 0 0 16px rgba(255, 176, 0, 0.22);
  }
  .similar-card:hover img { transform: scale(1.06); opacity: 0.75; }
  .similar-card:focus-visible { outline: none; }

  /* Cosine rank — 01 is the closest match, which is worth saying out loud. */
  .similar-rank {
    position: absolute;
    top: 0;
    left: 0;
    padding: 2px 5px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--amber, #ffb000);
    background: rgba(0, 0, 0, 0.78);
    border-right: 1px solid rgba(255, 176, 0, 0.35);
    border-bottom: 1px solid rgba(255, 176, 0, 0.35);
    font-variant-numeric: tabular-nums;
  }
  .similar-dur {
    position: absolute;
    right: 4px;
    bottom: 4px;
    padding: 2px 4px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    color: #e8e8e8;
    background: rgba(0, 0, 0, 0.8);
    font-variant-numeric: tabular-nums;
    transition: opacity 140ms;
  }
  /* The disc is painted as a radial gradient rather than a pseudo-element:
     a ::before behind the glyph needs a negative z-index, and that drops it
     behind the poster instead of behind the triangle. */
  .similar-play {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 14px;
    padding-left: 2px;          /* optical centring of the ▶ */
    color: #050807;
    background: radial-gradient(
      circle at center,
      var(--amber, #ffb000) 0 17px,
      rgba(255, 176, 0, 0) 18px
    );
    filter: drop-shadow(0 0 10px rgba(255, 176, 0, 0.45));
    opacity: 0;
    transition: opacity 160ms;
  }
  .similar-card:hover .similar-play,
  .similar-card:focus-visible .similar-play { opacity: 1; }
  .similar-card:hover .similar-dur { opacity: 0; }

  /* Both caption lines are fixed-height so the row keeps one baseline —
     a two-line title used to shove its year a row down, which is what made
     the strip look ragged. */
  .similar-title {
    font-family: var(--font-display, inherit);
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.25;
    height: 29px;
    color: var(--gold, #d8b675);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .similar-card:hover .similar-title { color: var(--amber, #ffb000); }
  .similar-meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
    height: 13px;
    /* Explicit, not stretched: the card is a <button>, and Chrome lays its
       children out inside an anonymous box that a nowrap line can widen —
       measured 180px against a 112px card, so every creator name bled into
       the next poster. */
    width: 112px;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .sim-year { color: var(--green-dim, #4d8a5a); flex: 0 0 auto; }
  .sim-by {
    color: #6f8c79;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .similar-card { animation: none; }
    .similar-card:hover .similar-thumb { transform: none; }
    .similar-card:hover img { transform: none; }
  }

  .check {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--amber, #ffb000);
    color: #050807;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.6);
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
  .modal {
    position: relative;
    background: #050807;
    border: 1px solid var(--amber, #ffb000);
    box-shadow:
      0 0 80px rgba(255, 176, 0, 0.18),
      0 0 1px rgba(255, 176, 0, 0.6),
      inset 0 0 80px rgba(0, 0, 0, 0.7);
    width: min(1100px, 100%);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    border-radius: 0;          /* hard CRT bezel — no soft corners */
    overflow: hidden;
  }
  /* Static scanlines on top of the entire modal — half-pixel rows so the
     pattern stays crisp on retina without moiré. Pointer-events off so it
     never hijacks clicks; mix-blend-mode keeps the underlying colours. */
  .modal::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 50;
    background: repeating-linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0) 0,
      rgba(255, 255, 255, 0) 2px,
      rgba(0, 0, 0, 0.18) 2px,
      rgba(0, 0, 0, 0.18) 3px
    );
    mix-blend-mode: multiply;
    opacity: 0.55;
  }
  /* Corner brackets — purely decorative, mark the modal as a "framed" panel.
     Drawn with two box-shadows per corner via the four ::after segments
     would be heavy; instead we use a single ::after with linear-gradient
     to paint L-shaped marks at the four corners of the modal. */
  .modal::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 51;
    background:
      /* top-left  */
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 14px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 1px 14px no-repeat,
      /* top-right */
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 14px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 1px 14px no-repeat,
      /* bottom-left  */
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 14px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 1px 14px no-repeat,
      /* bottom-right */
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 14px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 1px 14px no-repeat;
    opacity: 0.85;
    filter: drop-shadow(0 0 3px rgba(255, 176, 0, 0.6));
  }

  /* ── Modal header: channel ID strip ─────────────────────────
     Monospaced title with phosphor glow, year/creator pinned as
     mono-tabular pieces, action buttons in lower-case "command"
     style (`[archive.org ↗]` `[× close]`).                      */
  .modal-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 22px 12px;
    border-bottom: 1px solid var(--line, #1d3a26);
    background:
      linear-gradient(180deg, rgba(255, 176, 0, 0.07), transparent 70%),
      linear-gradient(90deg, transparent, rgba(255, 176, 0, 0.04), transparent);
    flex-wrap: wrap;
    z-index: 1;
  }
  /* The little ▮ glyph + "CH:" prefix sells the broadcast metaphor. */
  .modal-head::before {
    content: "▮ CH";
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    color: var(--amber, #ffb000);
    letter-spacing: 0.18em;
    opacity: 0.7;
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.5);
    align-self: center;
    padding: 1px 6px;
    border: 1px solid rgba(255, 176, 0, 0.35);
    border-radius: 0;
  }
  .modal-title {
    color: var(--amber, #ffb000);
    font-family: var(--font-display, var(--font-mono, monospace));
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-shadow: 0 0 8px rgba(255, 176, 0, 0.45), 0 0 1px rgba(255, 176, 0, 0.9);
    flex: 1 1 280px;
    line-height: 1.25;
    word-break: break-word;
    text-transform: uppercase;
  }
  .modal-head .badge {
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid var(--green-dim, #4d8a5a);
    color: var(--amber, #ffb000);
    padding: 2px 7px;
    border-radius: 0;
    font-size: 10px;
    font-family: var(--font-mono, ui-monospace), monospace;
    letter-spacing: 0.1em;
    font-variant-numeric: tabular-nums;
  }
  .modal-head .dim.mini {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }
  .modal-head a.ghost, .modal-head button.ghost {
    text-decoration: none;
    background: transparent;
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 4px 11px;
    cursor: pointer;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.08em;
    border-radius: 0;
    text-transform: uppercase;
    transition: color 100ms, border-color 100ms, box-shadow 120ms;
  }
  .modal-head a.ghost:hover, .modal-head button.ghost:hover {
    color: var(--green, #33ff77);
    border-color: var(--green, #33ff77);
    box-shadow: 0 0 6px rgba(51, 255, 119, 0.35), inset 0 0 6px rgba(51, 255, 119, 0.1);
  }

  .modal-body {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-height: 0;
    background: #000;
    overflow: hidden;
  }
  .player {
    width: 100%;
    /* Player gets a guaranteed min-height so the video isn't tiny, but
       it CAN shrink/grow as needed (flex:1 1 auto) so the file list
       claims its share when open. The video element inside is bound
       to 100% of the player — never to viewport — so it cannot push
       siblings off-screen. */
    min-height: 320px;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    background: #000;
    position: relative;
    overflow: hidden;
  }
  .player audio, .player img {
    width: 100%;
    /* Bound to the player's height (NOT viewport). Was 80vh which
       overflowed the modal when the player got small — pushing the
       file list off-screen on portrait/short windows. */
    max-height: 100%;
    min-height: 0;
    background: #000;
    display: block;
    object-fit: contain;
  }
  .player audio { padding: 30px; max-height: none; min-height: 0; }
  .player img { max-height: 80vh; min-height: 0; }
  .player-msg {
    padding: 60px 40px;
    text-align: center;
    color: var(--green-dim, #4d8a5a);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .player-msg.loading {
    color: var(--amber, #ffb000);
    animation: blink 1.2s steps(2) infinite;
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.5);
  }
  .player-msg.err {
    color: var(--red, #f55);
    text-shadow: 0 0 6px rgba(255, 80, 80, 0.5);
  }
  .transcode-note {
    padding: 6px 12px;
    border-top: 1px solid var(--line, #1d3a26);
    color: var(--amber, #ffb000) !important;
    background: rgba(255, 176, 0, 0.04);
  }
  .sub-btn {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 3px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    border-radius: 999px;
    text-transform: lowercase;
  }
  .sub-btn:hover { color: var(--green, #33ff77); border-color: var(--green-dim, #4d8a5a); }
  .sub-btn.on {
    background: rgba(255, 176, 0, 0.12);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
  }
  .sub-btn-gen {
    background: rgba(77, 208, 225, 0.08);
    border-color: var(--cyan, #4dd0e1);
    color: var(--cyan, #4dd0e1);
  }
  .sub-btn-gen:hover { background: rgba(77, 208, 225, 0.18); }
  .sub-btn-gen:disabled { opacity: 0.5; cursor: not-allowed; }
  .lang-select {
    background: var(--bg-2, #0b1f12);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green, #33ff77);
    padding: 3px 6px;
    font: inherit;
    font-size: 11px;
    border-radius: var(--radius-sm);
    outline: none;
  }

  /* Stack the <video> + transcribe overlay + custom controls + settings
     so they all sit on top without pushing the video out of layout. */
  .video-stack {
    position: relative;
    line-height: 0;
    background: #000;
  }
  .video-stack.fullscreen { width: 100vw; height: 100vh; }
  .video-stack.controls-hidden { cursor: none; }

  /* ── Codec-fallback banner: SYSTEM message bar ─────────────
     Looks like a kernel notice — amber-on-black with a `> SYS:`
     prefix. The "spinner" is a horizontal sweep bar (sonar-style)
     instead of a generic round one.                              */
  /* ── Startup preloader ───────────────────────────────────────────
     Same phosphor vocabulary as .cfb-spinner, scaled up: amber on black,
     square corners, monospace. Sits over the whole video area because at
     this point there is nothing underneath it worth seeing. */
  .vboot {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 7;                 /* under the codec banner (8), over the video */
    background:
      radial-gradient(ellipse at center, rgba(255, 176, 0, 0.05), transparent 62%),
      rgba(0, 0, 0, 0.55);
    pointer-events: none;       /* never eat a click meant for the player */
    animation: vboot-in 260ms ease-out;
  }
  @keyframes vboot-in { from { opacity: 0; } to { opacity: 1; } }

  .vboot-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    min-width: 236px;
    padding: 22px 28px;
    background: rgba(8, 5, 0, 0.86);
    border: 1px solid rgba(255, 176, 0, 0.34);
    box-shadow: 0 0 34px rgba(255, 176, 0, 0.13), inset 0 0 40px rgba(255, 176, 0, 0.04);
    font-family: var(--font-mono, ui-monospace), monospace;
  }

  /* Four sprocket bars, chasing. Reads as film running through a gate. */
  .vboot-reel {
    display: flex;
    align-items: flex-end;
    gap: 5px;
    height: 26px;
  }
  .vboot-reel span {
    width: 6px;
    height: 100%;
    background: var(--amber, #ffb000);
    transform-origin: bottom;
    animation: vboot-reel 1.05s ease-in-out infinite;
    box-shadow: 0 0 8px rgba(255, 176, 0, 0.55);
  }
  .vboot-reel span:nth-child(2) { animation-delay: 0.13s; }
  .vboot-reel span:nth-child(3) { animation-delay: 0.26s; }
  .vboot-reel span:nth-child(4) { animation-delay: 0.39s; }
  @keyframes vboot-reel {
    0%, 100% { transform: scaleY(0.28); opacity: 0.45; }
    50%      { transform: scaleY(1);    opacity: 1; }
  }

  .vboot-label {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.45);
  }

  .vboot-bar {
    position: relative;
    width: 100%;
    height: 4px;
    background: rgba(255, 176, 0, 0.13);
    overflow: hidden;
  }
  .vboot-fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 0;
    background: var(--amber, #ffb000);
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.6);
    transition: width 240ms linear;
  }
  /* No real percentage to show — sweep instead of inventing one. */
  .vboot-bar.indeterminate .vboot-fill {
    width: 34%;
    transition: none;
    animation: vboot-sweep 1.25s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }
  @keyframes vboot-sweep {
    0%   { left: -34%; }
    100% { left: 100%; }
  }

  .vboot-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: rgba(255, 176, 0, 0.62);
  }
  .vboot-elapsed { font-variant-numeric: tabular-nums; }
  .vboot-sep { opacity: 0.4; }
  .vboot-note { opacity: 0.75; }

  /* Motion is the whole point here, so reduced-motion gets a static, still
     legible card rather than nothing to look at. */
  @media (prefers-reduced-motion: reduce) {
    .vboot { animation: none; }
    .vboot-reel span { animation: none; transform: scaleY(0.7); opacity: 0.8; }
    .vboot-bar.indeterminate .vboot-fill { animation: none; width: 100%; opacity: 0.45; }
  }

  .codec-fallback-banner {
    position: absolute;
    top: 12px;
    left: 12px;
    right: 12px;
    background: #1a0e00;
    color: var(--amber, #ffb000);
    padding: 9px 14px;
    border-radius: 0;
    border: 1px solid var(--amber, #ffb000);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.05em;
    z-index: 8;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 0 18px rgba(255, 176, 0, 0.35), inset 0 0 30px rgba(255, 176, 0, 0.05);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.5);
    animation: cfb-fade 220ms ease-out;
  }
  .codec-fallback-banner::before {
    content: "> SYS:";
    color: var(--amber, #ffb000);
    font-weight: 700;
    letter-spacing: 0.12em;
    opacity: 0.7;
  }
  /* Probe knew up front — routine routing, not a fault. Same slot, no siren:
     dimmer, no glow, and it says what is happening rather than what broke. */
  .cfb-expected {
    background: rgba(0, 0, 0, 0.72);
    border-color: rgba(255, 176, 0, 0.28);
    color: rgba(255, 176, 0, 0.78);
    box-shadow: none;
    text-shadow: none;
  }
  .cfb-expected::before { content: "> "; opacity: 0.5; }
  @keyframes cfb-fade { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  /* Sonar sweep bar — replaces the round spinner. A single phosphor line
     scans left-to-right inside a thin frame.                           */
  .cfb-spinner {
    flex: 0 0 28px;
    width: 28px;
    height: 10px;
    position: relative;
    overflow: hidden;
    border: 1px solid rgba(255, 176, 0, 0.4);
    background: rgba(0, 0, 0, 0.5);
    border-radius: 0;
    animation: none;
  }
  .cfb-spinner::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 3px;
    background: var(--amber, #ffb000);
    box-shadow: 0 0 6px var(--amber, #ffb000);
    animation: sonar-sweep 1.1s linear infinite;
  }
  @keyframes sonar-sweep {
    0%   { transform: translateX(0); opacity: 0.4; }
    50%  { opacity: 1; }
    100% { transform: translateX(28px); opacity: 0.4; }
  }

  /* ── Captions overlay (we render cues ourselves) ─────────────── */
  .captions-overlay {
    position: absolute;
    left: 0; right: 0;
    display: flex;
    justify-content: center;
    align-items: flex-end;
    padding: 0 8%;
    pointer-events: none;
    z-index: 4;
  }
  /* `bottom: 12%` collided with the controls bar on shorter players.
     14% lifts captions a hair above the gradient so the eye reads them
     clean even when controls are visible.                             */
  .captions-overlay.pos-bottom { bottom: 14%; }
  .captions-overlay.pos-top { top: 6%; align-items: flex-start; }
  .captions-text {
    display: inline-block;
    line-height: 1.25;
    padding: 0.15em 0.65em;
    border-radius: 0;          /* CRT consistency — sharp edges */
    text-align: center;
    font-weight: 500;
    max-width: 100%;
    /* Phosphor-glow default. Inline styles override font/size/colour/bg
       per the user's settings; text-shadow inline also wins.            */
    text-shadow:
      0 0 8px rgba(255, 255, 255, 0.45),
      0 1px 0 rgba(0, 0, 0, 0.95),
      0 -1px 0 rgba(0, 0, 0, 0.95),
      1px 0 0 rgba(0, 0, 0, 0.95),
      -1px 0 0 rgba(0, 0, 0, 0.95);
  }
  .caption-line { white-space: pre-wrap; }

  /* ── Custom controls bar ──────────────────────────────────────── */
  .player-controls {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    background:
      linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.65) 55%, transparent 100%);
    padding: 22px 20px 14px;
    z-index: 6;
    opacity: 0;
    transition: opacity 200ms ease-out;
    pointer-events: none;
    /* Faint phosphor underline so the controls feel attached to the bezel */
    border-top: 1px solid transparent;
  }
  .player-controls.visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* Scrub bar — a phosphor track with a tall vertical bar (CRT cursor)
     in place of the round thumb. The track has a subtle inner shadow so
     it reads as a recessed groove on the panel.                       */
  .scrub-row { padding: 0 6px 12px; }
  .scrub {
    width: 100%;
    appearance: none;
    -webkit-appearance: none;
    height: 5px;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.4));
    border: 1px solid rgba(255, 176, 0, 0.18);
    border-radius: 0;
    outline: none;
    cursor: pointer;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.8);
  }
  .scrub::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 4px; height: 16px;
    border-radius: 0;
    background: var(--amber, #ffb000);
    border: none;
    cursor: pointer;
    margin-top: -6px;          /* center on a 5px track */
    box-shadow:
      0 0 6px rgba(255, 176, 0, 0.85),
      0 0 12px rgba(255, 176, 0, 0.45);
  }
  .scrub::-moz-range-thumb {
    width: 4px; height: 16px;
    border-radius: 0;
    background: var(--amber, #ffb000);
    border: none;
    cursor: pointer;
    box-shadow:
      0 0 6px rgba(255, 176, 0, 0.85),
      0 0 12px rgba(255, 176, 0, 0.45);
  }
  .scrub:hover::-webkit-slider-thumb { height: 20px; margin-top: -8px; }
  .scrub:hover::-moz-range-thumb { height: 20px; }
  .scrub:disabled { opacity: 0.35; cursor: not-allowed; }

  .ctrl-row {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-1, #e5e5e5);
    line-height: 1;
  }
  /* Generic player button — sharp corners, uppercase mono captions for
     text variants, phosphor border-glow on hover, amber active state.   */
  .pc-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-2, #aaa);
    font-size: 13px;
    width: 32px; height: 32px;
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer;
    border-radius: 0;
    transition: background 120ms ease-out, color 120ms ease-out, border-color 120ms, box-shadow 120ms;
    line-height: 1;
  }
  .pc-btn:hover {
    background: rgba(255, 176, 0, 0.06);
    border-color: rgba(255, 176, 0, 0.45);
    color: var(--amber, #ffb000);
    box-shadow: 0 0 8px rgba(255, 176, 0, 0.35), inset 0 0 6px rgba(255, 176, 0, 0.06);
  }
  .pc-btn.on {
    color: var(--amber, #ffb000);
    border-color: rgba(255, 176, 0, 0.55);
    background: rgba(255, 176, 0, 0.08);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.6);
  }
  .pc-btn.pc-play { font-size: 15px; }
  .pc-btn.rate-btn,
  .pc-btn.cc-btn {
    width: auto;
    padding: 0 10px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.1em;
    font-weight: 600;
    text-transform: uppercase;
    height: 24px;
    align-self: center;
  }
  /* Count pill next to "CC" — green when subs are available so the user
     sees there's something to pick without opening Settings. */
  .pc-btn.cc-btn { display: inline-flex; align-items: center; gap: 5px; position: relative; }
  .cc-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 4px;
    border-radius: 7px;
    background: rgba(95, 219, 160, 0.18);
    color: #5fdba0;
    border: 1px solid rgba(95, 219, 160, 0.45);
    font: 700 9px/1 'JetBrains Mono', monospace;
    letter-spacing: 0;
    text-transform: none;
    text-shadow: 0 0 4px rgba(95, 219, 160, 0.55);
  }
  .pc-btn.settings-btn,
  .pc-btn.fs-btn,
  .pc-btn.pc-mute,
  .pc-btn.pc-play {
    height: 30px;
    width: 30px;
  }
  /* Settings gear: extra glow when open so the user sees their anchor */
  .pc-btn.settings-btn.on { box-shadow: 0 0 10px rgba(255, 176, 0, 0.55); }

  /* Volume — same recessed-groove style as the scrub track. Hover
     brightens the LED dot so it's easier to grab.                     */
  .volume {
    appearance: none;
    -webkit-appearance: none;
    width: 84px;
    height: 4px;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.4));
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0;
    outline: none;
    cursor: pointer;
    margin-left: 4px;
  }
  .volume::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 4px; height: 12px;
    border-radius: 0;
    background: var(--text-1, #e5e5e5);
    border: none;
    margin-top: -4px;
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.4);
    transition: background 120ms;
  }
  .volume::-moz-range-thumb {
    width: 4px; height: 12px;
    border-radius: 0;
    background: var(--text-1, #e5e5e5);
    border: none;
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.4);
  }
  .volume:hover::-webkit-slider-thumb {
    background: var(--amber, #ffb000);
    box-shadow: 0 0 8px var(--amber, #ffb000);
  }
  .volume:hover::-moz-range-thumb {
    background: var(--amber, #ffb000);
    box-shadow: 0 0 8px var(--amber, #ffb000);
  }

  /* ── Settings popover: side panel with corner brackets ──────
     Sharp 90° corners, recessed body, monospaced tab strip with
     `[ ]` brackets on the active tab. Width nudged up so longer
     translation/engine labels don't wrap awkwardly.              */
  .settings-popover {
    position: absolute;
    /* Bottom-anchored, content-sized. Popover grows UPWARD to fit
       its content, capped by max-height so it never extends past the
       top edge of the video stack. Letting it size to content (instead
       of filling the whole height with top+bottom) means no giant
       empty void below the wizard. */
    right: 18px;
    bottom: 80px;
    width: min(520px, calc(100% - 36px));
    max-height: calc(100% - 120px);
    display: flex;
    flex-direction: column;
    background:
      linear-gradient(180deg, rgba(13, 26, 18, 0.97), rgba(7, 18, 10, 0.97));
    border: 1px solid var(--amber, #ffb000);
    border-radius: 0;
    box-shadow:
      0 10px 36px rgba(0, 0, 0, 0.7),
      0 0 18px rgba(255, 176, 0, 0.22),
      inset 0 0 60px rgba(0, 0, 0, 0.25);
    z-index: 7;
    color: var(--text-1, #e5e5e5);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    animation: settings-in 220ms cubic-bezier(0.16, 1, 0.3, 1);
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  @keyframes settings-in {
    from { transform: translateY(10px) scale(0.98); opacity: 0; }
    to   { transform: translateY(0) scale(1);       opacity: 1; }
  }

  .section-head {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--amber, #ffb000);
    padding-bottom: 6px;
    margin: 10px 0 12px;
    font-weight: 700;
    /* ASCII tick-rule underline: solid line with little caps at each end.
       Pure CSS via gradient stripes — no extra DOM.                      */
    background-image:
      linear-gradient(to right, var(--amber, #ffb000) 0, var(--amber, #ffb000) 1px, transparent 1px, transparent calc(100% - 1px), var(--amber, #ffb000) calc(100% - 1px), var(--amber, #ffb000) 100%),
      linear-gradient(to right, rgba(255, 176, 0, 0.4), rgba(255, 176, 0, 0.05));
    background-repeat: no-repeat;
    background-position: bottom, bottom;
    background-size: 100% 6px, 100% 1px;
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.5);
  }

  /* ──────────────────────────────────────────────────────────────────
     SUBTITLE PANEL — single-config flat layout.

     Replaced the 2-step wizard with one stack of labeled config blocks
     and ONE big CTA at the bottom. User picks everything up front,
     clicks once, kernel runs the whole pipeline. Cleaner than wizards
     for a flow that's small but has multiple options.
     ────────────────────────────────────────────────────────────────── */
  .subs-panel { padding: 4px 2px; display: flex; flex-direction: column; gap: 22px; }

  /* Big secondary CTA — "+ Generate new subtitle" — visually clearer
     than a dotted toggle. Lives in SELECT mode to invite the user to
     create more languages. */
  .cta-btn.cta-generate-new {
    margin-top: 4px;
    background: rgba(51, 255, 119, 0.06);
    color: var(--green, #33ff77);
    border: 1px dashed var(--green-dim, #4d8a5a);
    padding: 14px 16px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 0;
    transition: border-color 120ms, background 120ms, color 120ms, box-shadow 120ms;
  }
  .cta-btn.cta-generate-new:hover {
    border-color: var(--green, #33ff77);
    border-style: solid;
    background: rgba(51, 255, 119, 0.12);
    box-shadow: 0 0 14px rgba(51, 255, 119, 0.2);
  }

  /* Back link in GENERATE mode — small, top-anchored. */
  .back-link {
    align-self: flex-start;
    background: transparent;
    border: 0;
    color: var(--green-dim, #4d8a5a);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 4px 0;
    cursor: pointer;
    transition: color 120ms;
  }
  .back-link:hover { color: var(--green, #33ff77); }

  /* Larger select for the primary "Generate in LANG" picker. */
  .cfg-select.cfg-select-lg {
    width: 100%;
    padding: 12px 14px;
    font-size: 13px;
    background: rgba(0, 0, 0, 0.7);
    border-color: rgba(255, 176, 0, 0.4);
  }
  .cfg-select.cfg-select-lg:hover { border-color: var(--amber, #ffb000); }
  /* Each section gets a clear horizontal divider above its label so the
     SELECT row, the GENERATE collapsible, and the PLAYBACK footer feel
     like distinct zones — not one wall of stacked controls. */
  .cfg-block {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  /* Stack source pills as full-width rows for the SELECT list — each
     option is a clear, tappable row instead of a cramped horizontal
     line of capsules. The Target Language picker overrides this back
     to flex-row via .cfg-row.target-row. */
  .cfg-row.source-row {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  /* Compact pills used in horizontal rows (target language) — keep them
     inline-sized, not full-width. */

  /* Generic config select inside a cfg-row */
  .cfg-select {
    flex: 1;
    min-width: 140px;
    background: rgba(0, 0, 0, 0.65);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-1, #e5e5e5);
    padding: 7px 10px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    border-radius: 0;
    outline: none;
    cursor: pointer;
    transition: border-color 120ms, box-shadow 120ms;
  }
  .cfg-select:hover { border-color: var(--green-dim, #4d8a5a); }
  .cfg-select:focus { border-color: var(--amber, #ffb000); box-shadow: 0 0 6px rgba(255, 176, 0, 0.3); }
  .cfg-select:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Advanced collapsible — hides engine-config noise by default. */
  /* Advanced/Engine-settings toggle — borderless inline link, NOT a
     button-rectangle. Just a chevron + label + hint. Looks like a
     section header you can collapse. */
  .adv-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    align-self: flex-start;
    padding: 4px 0;
    background: transparent;
    border: 0;
    color: var(--green-dim, #4d8a5a);
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 0;
    transition: color 120ms;
  }
  .adv-toggle:hover { color: var(--amber, #ffb000); }
  .adv-toggle.open { color: var(--amber, #ffb000); }
  .adv-caret {
    color: var(--amber, #ffb000);
    font-size: 10px;
    width: 10px;
    text-align: center;
  }
  .adv-label { font-weight: 700; }
  .adv-hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0.02em;
    font-size: 9.5px;
    color: var(--text-2, #888);
    opacity: 0.85;
  }
  .adv-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    /* No box — just indented contents under the toggle. Less visual
       noise; the toggle's own border already marks the section. */
    padding: 8px 0 0 14px;
    border-left: 1px dashed rgba(255, 176, 0, 0.22);
    margin-left: 6px;
    animation: adv-slide 180ms ease-out;
  }
  @keyframes adv-slide {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* GENERATE toggle / body — visually demoted vs the SELECT row above
     so the user understands SELECT is the primary action. */
  .gen-toggle {
    margin-top: 4px;
    border-color: var(--green-dim, #4d8a5a);
    color: var(--green-dim, #4d8a5a);
  }
  .gen-toggle:hover {
    color: var(--green, #33ff77);
    border-color: var(--green, #33ff77);
    background: rgba(51, 255, 119, 0.04);
  }
  .gen-toggle.open {
    color: var(--green, #33ff77);
    border-color: var(--green, #33ff77);
    background: rgba(51, 255, 119, 0.05);
  }
  .gen-body {
    border-color: rgba(51, 255, 119, 0.22);
    background: linear-gradient(180deg, rgba(51, 255, 119, 0.03), rgba(0, 0, 0, 0.2));
  }

  /* Empty-state hint shown in the SELECT row when nothing's available. */
  .empty-hint {
    padding: 8px 4px;
    font-size: 10px;
    letter-spacing: 0.04em;
    font-style: italic;
  }

  /* Translation engine grid — strict 2 columns, even in narrow popovers */
  .engine-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .engine-tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px 10px 14px;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-2, #aaa);
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    border-radius: 0;
    position: relative;
    transition: border-color 120ms, color 120ms, background 120ms, box-shadow 120ms, transform 120ms;
    /* CRITICAL: grid items default to min-width:auto which means their
       content's intrinsic width pushes the column wider than 1fr — long
       model names like "grok-4-fast-non-reasoning" overflow into the
       neighbour tile and the whole grid looks "encimado". min-width:0
       + overflow:hidden contains the content; the inner spans truncate
       with ellipsis. */
    min-width: 0;
    overflow: hidden;
  }
  /* Truncate long model labels — keep et-name untouched so the [auto]
     badge can still flex inline with the brand name. */
  .et-meta, .et-time {
    display: block;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .et-name {
    max-width: 100%;
    overflow: hidden;
  }
  .engine-tile:hover {
    color: var(--text-1, #e5e5e5);
    border-color: var(--green-dim, #4d8a5a);
    background: rgba(51, 255, 119, 0.04);
    transform: translateY(-1px);
  }
  .engine-tile.on {
    border-color: var(--amber, #ffb000);
    /* Keep the background dark — the amber-on-amber-tint version made
       the brand name and model meta nearly invisible at this size.
       Use a left rail + glow + bright text for the selected state. */
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    box-shadow: inset 5px 0 0 var(--amber, #ffb000), 0 0 14px rgba(255, 176, 0, 0.3);
  }
  .engine-tile.on::after {
    content: "●";
    position: absolute;
    top: 8px;
    right: 10px;
    font-size: 10px;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px var(--amber, #ffb000);
  }
  .et-name {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .et-meta {
    font-size: 10px;
    color: var(--green, #33ff77);   /* bumped from green-dim — was illegible */
    letter-spacing: 0.02em;
    opacity: 0.8;
  }
  /* (overridden above for higher contrast) */
  .et-time {
    font-size: 9px;
    color: var(--text-2, #888);
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  /* (overridden above for higher contrast) */
  .et-badge {
    font-size: 7px;
    padding: 1px 4px;
    background: rgba(51, 255, 119, 0.15);
    color: var(--green, #33ff77);
    border: 1px solid rgba(51, 255, 119, 0.5);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    text-shadow: 0 0 3px rgba(51, 255, 119, 0.5);
    font-weight: 700;
  }

  /* Pipeline preview — borderless inline summary. Just the prefix
     glyph + the line. Looks like terminal output, not a card. */
  .pipeline-preview {
    padding: 6px 0 6px 0;
    background: transparent;
    border: 0;
  }
  .pp-label {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--amber, #ffb000);
    margin-bottom: 5px;
    opacity: 0.75;
  }
  .pp-line {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10.5px;
    color: var(--green, #33ff77);
    line-height: 1.6;
    letter-spacing: 0.02em;
    word-break: break-word;
  }
  .pp-step::before { content: "$ "; opacity: 0.5; }
  .pp-arrow {
    color: var(--cyan, #4dd0e1);
    margin: 0 6px;
    font-weight: 700;
    text-shadow: 0 0 3px rgba(77, 208, 225, 0.5);
  }

  /* Apply CTA — primary button, big, amber when ready */
  .cta-btn.cta-apply {
    margin-top: 4px;
    background: linear-gradient(135deg, rgba(255, 176, 0, 0.16), rgba(255, 176, 0, 0.06));
    color: var(--amber, #ffb000);
    border: 1px solid var(--amber, #ffb000);
    padding: 13px 16px;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    text-shadow: 0 0 5px rgba(255, 176, 0, 0.5);
    box-shadow: 0 0 16px rgba(255, 176, 0, 0.18);
  }
  .cta-btn.cta-apply:hover:not(:disabled) {
    background: var(--amber, #ffb000);
    color: #1a0e00;
    box-shadow: 0 0 22px rgba(255, 176, 0, 0.55), inset 0 0 14px rgba(255, 255, 255, 0.18);
    text-shadow: none;
  }
  .cta-btn.cta-apply.applied {
    background: linear-gradient(135deg, rgba(51, 255, 119, 0.12), rgba(51, 255, 119, 0.04));
    color: var(--green, #33ff77);
    border-color: var(--green, #33ff77);
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.5);
    box-shadow: 0 0 10px rgba(51, 255, 119, 0.18);
  }
  .cta-btn.cta-apply:disabled {
    background: rgba(255, 176, 0, 0.04);
    color: rgba(255, 176, 0, 0.4);
    border-color: rgba(255, 176, 0, 0.3);
    cursor: not-allowed;
    text-shadow: none;
    box-shadow: none;
  }

  /* ──────────────────────────────────────────────────────────────────
     Legacy wizard (kept as no-op for the now-unused .subs-wizard class).
     ────────────────────────────────────────────────────────────────── */
  /* ──────────────────────────────────────────────────────────────────
     SUBTITLE WIZARD — patch-panel architecture.

     Each section is a self-contained framed module, not items in a list.
     The visual separation comes from CONTAINMENT (boxed panels) rather
     than dividers between siblings. The result reads like rack-mounted
     gear: SOURCE module on top, override toggle as a discrete utility
     strip, DESTINATION (translation) module below.
     ────────────────────────────────────────────────────────────────── */
  .subs-wizard { padding: 0; }

  /* Step panel — recessed dark surface with a thin amber edge. The
     LEFT edge is fatter (gutter for the binder-tab number) and gets
     a subtle vertical glow on the .done state.                      */
  .step {
    position: relative;
    background:
      linear-gradient(180deg, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.35)),
      radial-gradient(ellipse at top left, rgba(255, 176, 0, 0.04), transparent 60%);
    border: 1px solid rgba(255, 176, 0, 0.18);
    padding: 18px 20px 18px 24px;
    margin-bottom: 18px;
    transition: border-color 180ms, box-shadow 180ms;
  }
  .step:last-child { margin-bottom: 0; }
  /* Faint vertical accent on the left gutter — anchors the step-num cell
     visually so it reads as a binder tab attached to the panel.        */
  .step::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 12px;
    bottom: 12px;
    width: 2px;
    background: rgba(77, 138, 90, 0.3);
    transition: background 180ms, box-shadow 180ms;
  }
  .step.done {
    border-color: rgba(255, 176, 0, 0.42);
    box-shadow: 0 0 14px rgba(255, 176, 0, 0.08);
  }
  .step.done::before {
    background: var(--amber, #ffb000);
    box-shadow: 0 0 6px var(--amber, #ffb000);
  }
  .step.disabled {
    opacity: 0.42;
    filter: grayscale(0.5);
    border-style: dashed;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.35));
  }
  .step.disabled::before { background: rgba(77, 138, 90, 0.18); box-shadow: none; }

  /* Step head — number cell on the left, title block on the right. The
     head gets a separator line at its bottom so the body reads as a
     distinct sub-zone within the panel.                                */
  .step-head {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px dashed rgba(77, 138, 90, 0.22);
  }

  /* Step number — bigger boxed cell that sits visually on top of the
     panel. Uppercase mono numeral with a phosphor glow when active.   */
  .step-num {
    flex: 0 0 32px;
    width: 32px;
    height: 32px;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid var(--green-dim, #4d8a5a);
    color: var(--green-dim, #4d8a5a);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0;
    transition: all 180ms;
    position: relative;
  }
  /* Two corner ticks make it read as a "framed display" instead of
     just a square button. */
  .step-num::before,
  .step-num::after {
    content: "";
    position: absolute;
    width: 4px;
    height: 4px;
    border: 1px solid currentColor;
    opacity: 0.7;
  }
  .step-num::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
  .step-num::after  { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
  .step-num.done {
    background: rgba(255, 176, 0, 0.18);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    box-shadow:
      0 0 12px rgba(255, 176, 0, 0.5),
      inset 0 0 12px rgba(255, 176, 0, 0.1);
    text-shadow: 0 0 6px rgba(255, 176, 0, 0.8);
  }
  .step-title-block { flex: 1; min-width: 0; padding-top: 4px; }
  .step-title {
    color: var(--text-1, #e5e5e5);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    line-height: 1.2;
  }
  .step-tag {
    display: inline-block;
    margin-left: 10px;
    font-size: 9px;
    padding: 2px 7px;
    border-radius: 0;
    background: rgba(77, 208, 225, 0.08);
    color: var(--cyan, #4dd0e1);
    border: 1px solid rgba(77, 208, 225, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    vertical-align: 2px;
    font-weight: 700;
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  .step-sub {
    font-size: 10px;
    line-height: 1.5;
    font-family: var(--font-mono, ui-monospace), monospace;
    letter-spacing: 0.04em;
    color: var(--green-dim, #4d8a5a);
  }
  .step-sub::before { content: "// "; opacity: 0.55; }

  /* Step body — choice cards stack inside, no left indent or conduit
     line (the panel boundary already groups them). Comfortable gap. */
  .step-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    position: relative;
  }
  .step-body::before { content: none; }     /* override old conduit */
  .disabled-hint {
    padding: 8px 12px;
    font-style: italic;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--green-dim, #4d8a5a);
    background: rgba(77, 138, 90, 0.06);
    border-left: 2px solid rgba(77, 138, 90, 0.3);
  }
  .disabled-hint::before { content: "▴ "; opacity: 0.7; }

  /* Choice card — patch-bay style. Sharp left rail (4px) on the active
     state for unmissable confirmation. Hover slides a > cursor in
     and lifts the card slightly. Sharp 90° corners, mono throughout. */
  .choice {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 13px 14px 13px 24px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--line, #1d3a26);
    border-radius: 0;
    color: var(--text-2, #aaa);
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    width: 100%;
    position: relative;
    transition: border-color 120ms, background 120ms, color 120ms, transform 120ms, box-shadow 120ms;
  }
  .choice::before {
    content: ">";
    position: absolute;
    left: 9px;
    top: 13px;
    color: var(--green, #33ff77);
    opacity: 0;
    transform: translateX(-4px);
    transition: opacity 120ms, transform 120ms, color 120ms;
    font-weight: 700;
    line-height: 1;
  }
  .choice:hover {
    border-color: var(--green-dim, #4d8a5a);
    color: var(--text-1, #e5e5e5);
    background: rgba(51, 255, 119, 0.05);
  }
  .choice:hover::before { opacity: 0.7; transform: translateX(0); }
  /* Active state — STRONG visual confirmation: 4px amber left rail,
     warm gradient bg, halo glow, and a filled `▸` cursor that matches
     the rail. Impossible to mistake for "not picked".                 */
  .choice.on {
    border-color: var(--amber, #ffb000);
    background:
      linear-gradient(90deg, rgba(255, 176, 0, 0.18) 0%, rgba(255, 176, 0, 0.05) 60%, transparent 100%);
    color: var(--amber, #ffb000);
    box-shadow:
      inset 4px 0 0 var(--amber, #ffb000),
      0 0 14px rgba(255, 176, 0, 0.22),
      inset 0 0 18px rgba(255, 176, 0, 0.06);
  }
  .choice.on::before {
    content: "▸";
    opacity: 1;
    transform: translateX(0);
    color: var(--amber, #ffb000);
    text-shadow: 0 0 6px var(--amber, #ffb000);
    font-size: 13px;
  }
  /* The generate work-card looks distinct (dashed) so it doesn't read
     as "another pick". It's a station you operate, not select.         */
  .choice.generate-card {
    cursor: default;
    border-style: dashed;
    border-color: rgba(77, 208, 225, 0.3);
    padding: 16px 16px 16px 18px;
    background:
      linear-gradient(180deg, rgba(77, 208, 225, 0.04), rgba(0, 0, 0, 0.45));
  }
  .choice.generate-card:hover {
    background: linear-gradient(180deg, rgba(77, 208, 225, 0.04), rgba(0, 0, 0, 0.45));
    color: var(--text-1, #e5e5e5);
    border-color: rgba(77, 208, 225, 0.5);
  }
  .choice.generate-card::before { content: none; }

  .choice-icon {
    flex: 0 0 26px;
    font-size: 18px;
    line-height: 1;
    padding-top: 1px;
    text-align: center;
    filter: drop-shadow(0 0 3px rgba(255, 176, 0, 0.15));
    transition: filter 180ms, transform 180ms;
  }
  .choice-text { flex: 1; min-width: 0; }
  .choice-title {
    font-size: 12px;
    font-weight: 700;
    line-height: 1.4;
    margin-bottom: 5px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .choice-sub {
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--green-dim, #4d8a5a);
    letter-spacing: 0.02em;
    text-transform: none;
  }
  /* Badges (READY, AUTO, .srt language label) — uniform mono pills
     that align to the title baseline.                              */
  .badge.ready {
    background: rgba(51, 255, 119, 0.12);
    color: var(--green, #33ff77);
    border-color: rgba(51, 255, 119, 0.5);
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.5);
  }
  .badge.ready::before { content: "✓ "; opacity: 0.85; }
  .badge.cached {
    background: rgba(77, 208, 225, 0.08);
    color: var(--cyan, #4dd0e1);
    border-color: rgba(77, 208, 225, 0.5);
  }

  /* Generate controls — engine/model selectors inside the work-card.
     Two-column flex with mono micro-labels using ASCII tree glyphs.   */
  .generate-controls {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px dashed rgba(77, 208, 225, 0.25);
  }
  .ctl {
    display: flex;
    flex-direction: column;
    gap: 5px;
    flex: 1;
    min-width: 140px;
  }
  .ctl-lbl {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--green-dim, #4d8a5a);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-weight: 700;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .ctl-lbl::before { content: "├ "; opacity: 0.55; }

  /* ── ENGINE PICK — the dramatic moment ─────────────────────
     When `.engine-pending` is present (engineConfirmed=false), the
     engine row promotes itself: bigger cards, pulsing border, a
     LOUD banner above announcing "AWAITING SELECTION". After pick,
     the row contracts back to a compact "currently using X" state. */
  .ctl.engine-row {
    width: 100%;
    flex: 0 0 100%;
    margin-top: 6px;
    transition: padding 200ms, background 200ms;
  }
  /* Pending state — uses :has() to detect the pending hint inside
     the same row. Promotes the whole row into the focal point.     */
  .ctl.engine-row:has(.engine-pending) {
    padding: 14px;
    background:
      linear-gradient(180deg, rgba(77, 208, 225, 0.08), rgba(77, 208, 225, 0.02));
    border: 1px solid rgba(77, 208, 225, 0.4);
    box-shadow: inset 0 0 20px rgba(77, 208, 225, 0.04);
  }

  /* Pending-state label transforms into a banner: full-width, sweep
     animation, attention-grabbing.                                  */
  /* Sweep light across the banner */
  @keyframes engine-sweep {
    from { left: -30%; }
    to   { left: 100%; }
  }

  .engine-pending {
    color: var(--cyan, #4dd0e1);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-left: 0;
    display: block;
    margin-top: 3px;
    opacity: 0.85;
  }
  .engine-pending::before { content: "└ "; opacity: 0.5; }

  .engine-opts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 10px;
  }

  /* Engine card — larger, with grid layout for consistent height
     across cards no matter how long their meta text is.            */
  .engine-btn {
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-2, #aaa);
    padding: 13px 14px 13px 18px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    border-radius: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
    position: relative;
    transition: border-color 140ms, color 140ms, background 140ms, transform 140ms, box-shadow 140ms;
    min-height: 64px;
  }
  /* When in pending mode, every engine card pulses subtly so the user
     knows interaction is required HERE.                              */
  @keyframes engine-pulse {
    0%, 100% { box-shadow: 0 0 0 rgba(77, 208, 225, 0); }
    50%      { box-shadow: 0 0 14px rgba(77, 208, 225, 0.18); }
  }
  .engine-btn:hover {
    color: var(--text-1, #e5e5e5);
    border-color: var(--cyan, #4dd0e1);
    background: rgba(77, 208, 225, 0.06);
    transform: translateY(-1px);
    box-shadow: 0 4px 14px rgba(77, 208, 225, 0.18), 0 0 0 1px rgba(77, 208, 225, 0.3);
    animation: none;
  }
  .engine-btn.on {
    border-color: var(--amber, #ffb000);
    background:
      linear-gradient(135deg, rgba(255, 176, 0, 0.18), rgba(255, 176, 0, 0.04));
    color: var(--amber, #ffb000);
    box-shadow:
      inset 4px 0 0 var(--amber, #ffb000),
      0 0 12px rgba(255, 176, 0, 0.25);
    animation: none;
  }
  /* Selected indicator: a glowing dot that anchors top-right          */
  .engine-btn.on::after {
    content: "●";
    position: absolute;
    top: 11px;
    right: 12px;
    font-size: 11px;
    color: var(--amber, #ffb000);
    text-shadow: 0 0 8px var(--amber, #ffb000);
  }
  .eng-name {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 0;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    line-height: 1.2;
  }
  .eng-badge {
    font-size: 8px;
    padding: 2px 6px;
    background: rgba(51, 255, 119, 0.15);
    color: var(--green, #33ff77);
    border: 1px solid rgba(51, 255, 119, 0.5);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.5);
    font-weight: 700;
  }
  .eng-meta {
    font-size: 10px;
    color: var(--green-dim, #4d8a5a);
    letter-spacing: 0.04em;
    line-height: 1.45;
    text-transform: none;
  }

  /* CTA button — primary action ("▶ Start Whisper"). Mono uppercase
     with ASCII brackets via ::before/::after. Cyan command palette. */
  .cta-btn {
    margin-top: 14px;
    background: rgba(77, 208, 225, 0.1);
    color: var(--cyan, #4dd0e1);
    border: 1px solid var(--cyan, #4dd0e1);
    padding: 11px 16px;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    border-radius: 0;
    cursor: pointer;
    width: 100%;
    transition: background 120ms, color 120ms, box-shadow 140ms;
    text-shadow: 0 0 4px rgba(77, 208, 225, 0.5);
    box-shadow: 0 0 0 rgba(77, 208, 225, 0);
  }
  .cta-btn:hover {
    background: var(--cyan, #4dd0e1);
    color: #001b24;
    box-shadow: 0 0 16px rgba(77, 208, 225, 0.6), inset 0 0 12px rgba(255, 255, 255, 0.2);
    text-shadow: none;
  }
  .cta-btn:disabled {
    background: rgba(77, 208, 225, 0.05);
    color: rgba(77, 208, 225, 0.5);
    border-color: rgba(77, 208, 225, 0.3);
    cursor: not-allowed;
    text-shadow: none;
    box-shadow: none;
  }

  /* ── Playback override: utility strip ──────────────────────
     Sits BETWEEN the two wizard steps but visually subordinate —
     a slim cyan-bordered strip with a left rail tag, distinctly
     NOT a wizard step. Reads as "system tweak available" not
     "another decision in the flow".                              */
  /* Force-transcode footer — same hairline-divider language as the
     other section labels. No floating chip, no rectangle, just a
     dim section header above the toggle. */
  .force-transcode-row {
    margin: 14px 0 0 0;
    padding: 14px 0 0 0;
    border-top: 1px dashed rgba(77, 208, 225, 0.25);
    background: transparent;
    position: relative;
  }
  .force-transcode-row::after {
    content: none;
  }
  .force-transcode-row::before {
    content: "▸ PLAYBACK · OVERRIDE";
    display: block;
    margin-bottom: 8px;
    padding: 0;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.2em;
    color: var(--cyan, #4dd0e1);
    background: transparent;
    text-shadow: 0 0 4px rgba(77, 208, 225, 0.45);
  }
  .force-transcode-toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    user-select: none;
  }
  /* The knob track: `[OFF | ON]` slot with a single phosphor bar that
     slides between the two slots. No round shapes — this is a console. */
  .ftt-knob {
    flex: 0 0 56px;
    width: 56px;
    height: 22px;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid var(--line, #1d3a26);
    border-radius: 0;
    position: relative;
    transition: border-color 120ms;
    overflow: hidden;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    letter-spacing: 0.1em;
    font-weight: 700;
    color: var(--text-2, #888);
  }
  /* OFF / ON labels baked into the track so they're always visible */
  .ftt-knob::before {
    content: "OFF";
    position: absolute;
    left: 6px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    transition: color 120ms;
  }
  .ftt-knob::after {
    content: "ON";
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    transition: color 120ms;
  }
  /* The travelling phosphor bar — separate element via the input wrapper */       /* in case anyone added one */
  /* OFF state highlight */
  /* ON state — cyan to harmonize with the utility-strip family.
     Override is always opt-in, so ON should feel "I picked this on
     purpose" not "system-recommended" (that's the amber treatment).  */

  .ftt-text { flex: 1; min-width: 0; line-height: 1.45; }
  .ftt-title {
    display: block;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-1, #e5e5e5);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .ftt-sub {
    display: block;
    font-size: 10px;
    margin-top: 3px;
    line-height: 1.45;
    color: var(--green-dim, #4d8a5a);
  }

  /* Inline error — terminal-style with `! ERR:` prefix */
  .inline-err {
    margin-top: 10px;
    padding: 7px 10px;
    border-radius: 0;
    background: rgba(255, 80, 80, 0.08);
    border: 1px solid var(--red, #f55);
    color: #fcc;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }
  .inline-err::before {
    content: "! ERR ";
    color: var(--red, #f55);
    font-weight: 700;
    margin-right: 4px;
    text-shadow: 0 0 4px rgba(255, 80, 80, 0.5);
  }
  .inline-err.global {
    margin: 14px 0 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .dismiss-mini {
    background: transparent;
    border: 0;
    color: #fcc;
    font-size: 16px;
    cursor: pointer;
    margin-left: auto;
    padding: 0 4px;
    line-height: 1;
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  .dismiss-mini:hover { color: var(--red, #f55); }
  .section-head:first-child { margin-top: 0; }
  .row.indent { margin-left: 16px; padding-left: 8px; border-left: 1px solid rgba(77, 138, 90, 0.18); }
  .lbl {
    flex: 0 0 110px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--green-dim, #4d8a5a);
  }
  .val {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    color: var(--green, #33ff77);
    min-width: 48px;
    text-align: right;
  }
  .opts {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    flex: 1;
  }
  .opts.speed-opts { gap: 6px; }
  /* `.opt` pills (used in Style and Speed tabs). Sharp corners,
     mono uppercase, hover phosphor.                              */
  .opt {
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 5px 12px;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 0;
    cursor: pointer;
    transition: color 100ms, border-color 100ms, background 100ms, box-shadow 120ms;
  }
  .opt:hover {
    color: var(--green, #33ff77);
    border-color: var(--green-dim, #4d8a5a);
    background: rgba(51, 255, 119, 0.05);
  }
  .opt.on {
    background: rgba(255, 176, 0, 0.15);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    box-shadow: 0 0 6px rgba(255, 176, 0, 0.3), inset 0 0 6px rgba(255, 176, 0, 0.05);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.5);
  }
  .opt.gen {
    background: rgba(77, 208, 225, 0.08);
    border-color: var(--cyan, #4dd0e1);
    color: var(--cyan, #4dd0e1);
  }
  .opt:disabled { opacity: 0.4; cursor: not-allowed; }

  .caption-preview {
    display: inline-block;
    line-height: 1.25;
    padding: 0.15em 0.6em;
    border-radius: 4px;
    text-align: center;
    align-self: center;
  }

  /* ── Translate progress card: sonar transmission ─────────
     Corner-pinned panel with a sweep-bar that scans across the
     translate-bar — no round spinners. The vibe is "data is
     flowing, watch the line move".                               */
  .translate-card {
    position: absolute;
    bottom: 84px;
    left: 14px;
    width: 340px;
    max-width: calc(100% - 28px);
    background:
      linear-gradient(180deg, rgba(7, 30, 26, 0.97), rgba(4, 18, 16, 0.97));
    border: 1px solid var(--cyan, #4dd0e1);
    border-radius: 0;
    box-shadow:
      0 8px 28px rgba(0, 0, 0, 0.6),
      0 0 18px rgba(77, 208, 225, 0.25),
      inset 0 0 30px rgba(77, 208, 225, 0.04);
    padding: 13px 15px 12px;
    z-index: 6;
    color: var(--text-1, #e5e5e5);
    display: flex;
    align-items: flex-start;
    gap: 12px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    animation: translate-in 240ms cubic-bezier(0.16, 1, 0.3, 1);
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
  }
  /* Title-bar accent — corner brackets like the popover */
  .translate-card::before {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    pointer-events: none;
    background:
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 0 0 / 6px 1px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 0 0 / 1px 6px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 100% 0 / 6px 1px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 100% 0 / 1px 6px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 0 100% / 6px 1px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 0 100% / 1px 6px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 100% 100% / 6px 1px no-repeat,
      linear-gradient(var(--cyan, #4dd0e1), var(--cyan, #4dd0e1)) 100% 100% / 1px 6px no-repeat;
    filter: drop-shadow(0 0 2px rgba(77, 208, 225, 0.6));
  }
  @keyframes translate-in {
    from { transform: translateY(10px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
  /* Sweeping vertical bar inside a thin frame — replaces the round
     CSS spinner. Reads as "scanning…" rather than "loading…".       */
  .translate-spinner {
    width: 22px;
    height: 32px;
    flex: 0 0 22px;
    border-radius: 0;
    border: 1px solid rgba(77, 208, 225, 0.4);
    background: rgba(0, 0, 0, 0.55);
    position: relative;
    overflow: hidden;
    animation: none;
    margin-top: 2px;
  }
  .translate-spinner::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 3px;
    top: -3px;
    background: var(--cyan, #4dd0e1);
    box-shadow: 0 0 8px var(--cyan, #4dd0e1), 0 0 16px var(--cyan, #4dd0e1);
    animation: sonar-vsweep 1.4s ease-in-out infinite;
  }
  /* Phosphor afterglow trail */
  .translate-spinner::after {
    content: "";
    position: absolute;
    left: 0; right: 0; top: 0; bottom: 0;
    background: linear-gradient(180deg, transparent, rgba(77, 208, 225, 0.08), transparent);
    pointer-events: none;
  }
  @keyframes sonar-vsweep {
    0%   { transform: translateY(0); opacity: 0.6; }
    50%  { opacity: 1; }
    100% { transform: translateY(35px); opacity: 0.4; }
  }
  .translate-body { flex: 1; min-width: 0; }
  .translate-title {
    color: var(--cyan, #4dd0e1);
    font-weight: 700;
    margin-bottom: 6px;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-shadow: 0 0 5px rgba(77, 208, 225, 0.5);
  }
  .translate-title::before {
    content: "▸ ";
    opacity: 0.7;
  }
  .translate-meta {
    color: var(--green-dim, #4d8a5a);
    font-size: 10px;
    margin-bottom: 9px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    letter-spacing: 0.04em;
  }
  .translate-bar {
    position: relative;
    height: 5px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(77, 208, 225, 0.2);
    border-radius: 0;
    overflow: hidden;
  }
  .translate-bar-fill {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(77, 208, 225, 0.85), var(--cyan, #4dd0e1));
    transition: width 280ms ease-out;
    box-shadow: 0 0 6px rgba(77, 208, 225, 0.7);
  }
  .translate-bar-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 0%, rgba(255,255,255,0.22) 50%, transparent 100%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
    pointer-events: none;
  }

  /* ── Translate error banner ───────────────────────────────
     Same corner-pinned slot as the progress card, but red-on-
     black with `! ERR:` prefix. Mono so it reads as "console
     output", not a generic alert.                              */
  .translate-error {
    position: absolute;
    bottom: 84px;
    left: 14px;
    width: 380px;
    max-width: calc(100% - 28px);
    background: linear-gradient(180deg, rgba(40, 14, 14, 0.97), rgba(28, 8, 8, 0.97));
    border: 1px solid var(--red, #f55);
    border-radius: 0;
    padding: 11px 14px;
    z-index: 6;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    color: #fcc;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    line-height: 1.45;
    letter-spacing: 0.02em;
    animation: translate-in 220ms ease-out;
    box-shadow: 0 6px 24px rgba(0,0,0,0.6), 0 0 14px rgba(255, 80, 80, 0.25);
  }
  .t-err-icon {
    color: var(--red, #f55);
    font-size: 16px;
    line-height: 1;
    text-shadow: 0 0 6px rgba(255, 80, 80, 0.7);
    margin-top: 1px;
  }
  .t-err-body { flex: 1; min-width: 0; }
  .t-err-body strong {
    color: var(--red, #f55);
    display: block;
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 10px;
    font-weight: 700;
    text-shadow: 0 0 4px rgba(255, 80, 80, 0.5);
  }
  .t-err-body strong::before { content: "! "; opacity: 0.8; }
  .t-err-dismiss {
    background: transparent;
    border: 0;
    color: #fcc;
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  .t-err-dismiss:hover { color: var(--red, #f55); text-shadow: 0 0 4px var(--red, #f55); }

  .cache-hint {
    color: var(--cyan, #4dd0e1);
    font-size: 10px;
    padding: 2px 7px;
    border: 1px dashed rgba(77, 208, 225, 0.45);
    border-radius: 0;
    cursor: help;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* ── Transcribe overlay: big center work-card ──────────────
     Whisper takes minutes; this is the dominant on-screen UI
     while it runs. Dramatic vignette + corner-bracketed work-
     card + multi-bar phosphor scanner so the wait feels
     intentional rather than abandoned.                          */
  .transcribe-overlay {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(0, 4, 1, 0.65) 0%, rgba(0, 0, 0, 0.92) 100%);
    backdrop-filter: blur(5px);
    -webkit-backdrop-filter: blur(5px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5;
    pointer-events: auto;
    animation: overlay-fade-in 240ms ease-out;
  }
  @keyframes overlay-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .transcribe-card {
    position: relative;
    background:
      linear-gradient(180deg, rgba(13, 26, 18, 0.96), rgba(7, 18, 10, 0.96));
    border: 1px solid var(--amber, #ffb000);
    border-radius: 0;
    box-shadow:
      0 0 40px rgba(255, 176, 0, 0.22),
      0 0 1px rgba(255, 176, 0, 0.5),
      inset 0 0 60px rgba(0, 0, 0, 0.4);
    padding: 28px 36px 22px;
    min-width: 360px;
    max-width: 80%;
    text-align: center;
    color: var(--text-1, #e5e5e5);
    font-family: var(--font-mono, ui-monospace), monospace;
    line-height: 1.5;
    transition: border-color 320ms, box-shadow 320ms, background 320ms;
  }
  /* Visual differentiation when modal swaps to translate phase: shift
     border + glow from amber to cyan so the user notices the change. */
  .transcribe-card.translating {
    border-color: var(--cyan, #4dd0e1);
    box-shadow:
      0 0 40px rgba(77, 208, 225, 0.22),
      0 0 1px rgba(77, 208, 225, 0.5),
      inset 0 0 60px rgba(0, 0, 0, 0.4);
  }
  /* Same corner-bracket pattern as other framed instruments */
  .transcribe-card::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 12px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 0 / 1px 12px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 12px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 0 / 1px 12px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 12px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 0 100% / 1px 12px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 12px 1px no-repeat,
      linear-gradient(var(--amber, #ffb000), var(--amber, #ffb000)) 100% 100% / 1px 12px no-repeat;
    filter: drop-shadow(0 0 3px rgba(255, 176, 0, 0.6));
  }
  /* The 4 bouncing bars — keep the original spinner shape but
     tighter, and add an extra tall central bar so it reads as
     "spectrum analyzer" instead of "loading dots".              */
  .transcribe-spinner {
    display: inline-flex;
    gap: 5px;
    margin-bottom: 18px;
    align-items: flex-end;
    height: 22px;
  }
  @keyframes spinner-bar {
    0%, 100% { transform: scaleY(0.3); opacity: 0.55; }
    50%      { transform: scaleY(1.0); opacity: 1; }
  }

  .transcribe-title {
    color: var(--amber, #ffb000);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-bottom: 10px;
    text-shadow: 0 0 8px rgba(255, 176, 0, 0.6);
  }
  .transcribe-title::before { content: "▸ "; opacity: 0.7; }
  .transcribe-meta {
    font-size: 11px;
    margin-bottom: 16px;
    color: var(--green-dim, #4d8a5a);
    letter-spacing: 0.04em;
  }

  .transcribe-bar {
    position: relative;
    height: 7px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 176, 0, 0.25);
    border-radius: 0;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .transcribe-bar-fill {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(255, 176, 0, 0.85), #ffd76b);
    transition: width 280ms ease-out;
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.65);
  }
  .transcribe-bar-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 0%,
      rgba(255, 255, 255, 0.22) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
    pointer-events: none;
  }
  @keyframes shimmer {
    from { background-position: -100% 0; }
    to   { background-position:  100% 0; }
  }
  /* Indeterminate mode — a thin glow scrubs left↔right inside an otherwise
     empty bar. Used while we haven't received the first real progress tick
     so the user sees the system is alive instead of a stuck-at-100% bar. */
  .transcribe-bar.indeterminate {
    background: rgba(0, 0, 0, 0.6);
  }
  .transcribe-bar.indeterminate::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 32%;
    background: linear-gradient(90deg, transparent, rgba(255, 176, 0, 0.85) 50%, transparent);
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.55);
    animation: transcribe-indet 1.4s ease-in-out infinite;
  }
  @keyframes transcribe-indet {
    0%   { left: -32%; }
    100% { left: 100%; }
  }

  .transcribe-time {
    font-size: 11px;
    color: var(--green-dim, #4d8a5a);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
  }
  /* Percent badge inside .transcribe-meta — sits next to engine/model so
     the user gets a top-of-bar progress reading without scanning down. */
  .meta-pct {
    color: var(--amber, #ffb000);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  /* Stats grid — two labelled chips. AUDIO (what whisper sees) and CLOCK
     (what the user waits). Distinct icons and colour so they can never be
     read as the same value. */
  .transcribe-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-bottom: 10px;
    font-variant-numeric: tabular-nums;
  }
  .ts-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid rgba(255, 176, 0, 0.18);
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.45);
    font: 600 11px 'JetBrains Mono', monospace;
    letter-spacing: 0.02em;
  }
  .ts-ico { font-size: 12px; opacity: 0.85; }
  .ts-lbl {
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.6px;
    color: var(--green-dim, #4d8a5a);
    font-weight: 600;
  }
  /* AUDIO chip — green family (what whisper sees) */
  .ts-audio {
    border-color: rgba(95, 219, 160, 0.30);
    background: rgba(95, 219, 160, 0.06);
  }
  /* CLOCK chip — amber family (what the user waits) */
  .ts-clock {
    border-color: rgba(255, 176, 0, 0.30);
    background: rgba(255, 176, 0, 0.06);
  }
  /* CUES chip (translate phase) */
  .ts-cues {
    border-color: rgba(106, 160, 255, 0.30);
    background: rgba(106, 160, 255, 0.06);
  }
  /* DOWNLOAD chip (model-fetch phase) */
  .ts-download {
    border-color: rgba(167, 139, 250, 0.30);
    background: rgba(167, 139, 250, 0.06);
  }
  .transcribe-hint {
    margin-top: 6px;
    margin-bottom: 14px;
    font-size: 10px;
    letter-spacing: 0.02em;
    color: var(--green-dim, #4d8a5a);
    font-style: italic;
  }
  .transcribe-cancel {
    margin-top: 4px;
    background: transparent;
    border: 1px solid var(--red, #f55);
    color: var(--red, #f55);
    padding: 7px 18px;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    border-radius: 0;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-weight: 700;
    transition: background 120ms, color 120ms, box-shadow 140ms;
  }
  .transcribe-cancel:hover {
    background: var(--red, #f55);
    color: #1a0000;
    box-shadow: 0 0 14px rgba(255, 80, 80, 0.6);
  }

  /* Success toast — `[OK] subtitles ready · 568 cues` mono pill */
  .transcribe-toast {
    position: absolute;
    top: 14px;
    right: 14px;
    background: rgba(7, 30, 14, 0.96);
    border: 1px solid var(--green, #33ff77);
    color: var(--green, #33ff77);
    padding: 7px 12px;
    border-radius: 0;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    z-index: 5;
    box-shadow: 0 0 18px rgba(51, 255, 119, 0.35), inset 0 0 12px rgba(51, 255, 119, 0.05);
    text-shadow: 0 0 4px rgba(51, 255, 119, 0.6);
    animation: toast-in 0.35s ease-out, toast-out 0.5s ease-in 4s forwards;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .transcribe-toast .check {
    background: var(--green, #33ff77);
    color: #001a08;
    width: 16px;
    height: 16px;
    border-radius: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 11px;
    box-shadow: 0 0 6px rgba(51, 255, 119, 0.5);
  }
  @keyframes toast-in {
    from { transform: translateY(-12px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
  @keyframes toast-out {
    to { transform: translateY(-12px); opacity: 0; }
  }

  /* ── File list: directory listing aesthetic ────────────────
     Mono everything, fixed columns, ASCII tree-like header,
     hover slides a `▸` cursor in from the left rail.            */
  .filelist-bottom {
    border-top: 1px solid var(--amber, #ffb000);
    background:
      linear-gradient(180deg, rgba(255, 176, 0, 0.04), transparent 30%),
      #060e09;
    padding: 16px 20px 18px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 280px;            /* enough to show 6-8 file rows */
    max-height: 60vh;             /* up from 220px — give it real room */
    font-family: var(--font-mono, ui-monospace), monospace;
  }
  .filelist-head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 8px;
    flex-shrink: 0;
  }
  .filelist-head {
    color: var(--amber, #ffb000);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 700;
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.4);
  }
  .filelist-head::before { content: "▸ /"; opacity: 0.7; }
  .filelist-close {
    background: transparent;
    border: 0;
    color: var(--text-2, #888);
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    cursor: pointer;
    transition: color 120ms;
  }
  .filelist-close:hover { color: var(--red, #f55); }
  .filelist-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 176, 0, 0.4) transparent;
  }
  .filelist-row::-webkit-scrollbar { width: 6px; }
  .filelist-row::-webkit-scrollbar-thumb { background: rgba(255, 176, 0, 0.4); border-radius: 0; }
  .filelist-row::-webkit-scrollbar-track { background: transparent; }
  .file-row {
    display: grid;
    grid-template-columns: 12px 26px 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 9px 14px 9px 8px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--green-dim, #4d8a5a);
    cursor: pointer;
    font: inherit;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 11px;
    letter-spacing: 0.02em;
    text-align: left;
    border-radius: 0;
    width: 100%;
    position: relative;
    transition: background 90ms, color 90ms, border-color 90ms;
  }
  /* The cursor character before each row — invisible by default,
     slides in on hover/active so the list reads like a directory
     navigation tree.                                              */
  .file-row::before {
    content: "·";
    color: rgba(77, 138, 90, 0.4);
    font-weight: 700;
    transition: color 90ms, content 0ms;
    grid-column: 1;
  }
  .file-row:hover {
    color: var(--green, #33ff77);
    background: rgba(51, 255, 119, 0.05);
    border-color: rgba(51, 255, 119, 0.2);
  }
  .file-row:hover::before { content: "▸"; color: var(--green, #33ff77); }
  .file-row.on {
    background: linear-gradient(90deg, rgba(255, 176, 0, 0.18), rgba(255, 176, 0, 0.04));
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    box-shadow: inset 3px 0 0 var(--amber, #ffb000), 0 0 8px rgba(255, 176, 0, 0.2);
    text-shadow: 0 0 4px rgba(255, 176, 0, 0.4);
  }
  .file-row.on::before {
    content: "▶";
    color: var(--amber, #ffb000);
    text-shadow: 0 0 5px rgba(255, 176, 0, 0.7);
  }
  .file-row .kind {
    width: 26px;
    height: 18px;
    line-height: 16px;
    text-align: center;
    border: 1px solid var(--line, #1d3a26);
    background: rgba(0, 0, 0, 0.45);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--green-dim, #4d8a5a);
    text-transform: uppercase;
  }
  .file-row .kind-video { color: var(--amber, #ffb000); border-color: rgba(255, 176, 0, 0.5); }
  .file-row .kind-audio { color: var(--cyan, #4dd0e1); border-color: rgba(77, 208, 225, 0.5); }
  .file-row .kind-image { color: #b4ec51; border-color: rgba(180, 236, 81, 0.5); }
  .file-row .fname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    font-size: 11px;
    letter-spacing: 0.02em;
  }
  .file-row .dim.mini {
    color: var(--green-dim, #4d8a5a);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    letter-spacing: 0.04em;
  }
  .file-row.on .dim.mini { color: var(--amber, #ffb000); opacity: 0.7; }

  /* Description panel — opt-in, slides up from the bottom of the modal
     when the user clicks ⓘ INFO in the header. NOT visible by default
     (was sitting below the player as permanent visual noise).         */
  .modal-desc {
    border-top: 1px solid rgba(77, 208, 225, 0.4);
    background:
      linear-gradient(180deg, rgba(77, 208, 225, 0.06), rgba(0, 0, 0, 0.5));
    color: var(--text-1, #e5e5e5);
    font-family: var(--font-mono, ui-monospace), monospace;
    animation: desc-slide-up 240ms cubic-bezier(0.16, 1, 0.3, 1);
    flex-shrink: 0;
  }
  @keyframes desc-slide-up {
    from { transform: translateY(8px); opacity: 0; max-height: 0; }
    to   { transform: translateY(0);   opacity: 1; max-height: 240px; }
  }
  .modal-desc-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 18px;
    border-bottom: 1px dashed rgba(77, 208, 225, 0.25);
    background: rgba(77, 208, 225, 0.04);
  }
  .modal-desc-label {
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--cyan, #4dd0e1);
    text-shadow: 0 0 4px rgba(77, 208, 225, 0.45);
  }
  .modal-desc-head .spacer { flex: 1; }
  .modal-desc-close {
    background: transparent;
    border: 1px solid var(--line, #1d3a26);
    color: var(--text-2, #aaa);
    width: 24px; height: 22px;
    line-height: 1;
    cursor: pointer;
    font-family: var(--font-mono, ui-monospace), monospace;
    font-size: 14px;
    border-radius: 0;
    transition: color 100ms, border-color 100ms;
  }
  .modal-desc-close:hover {
    color: var(--red, #f55);
    border-color: var(--red, #f55);
    text-shadow: 0 0 4px rgba(255, 80, 80, 0.5);
  }
  .modal-desc-body {
    padding: 14px 18px 16px;
    color: var(--text-2, #c0c8c4);
    font-size: 12px;
    line-height: 1.6;
    max-height: 200px;
    overflow-y: auto;
    letter-spacing: 0.01em;
    scrollbar-width: thin;
    scrollbar-color: rgba(77, 208, 225, 0.4) transparent;
  }
  .modal-desc-body::-webkit-scrollbar { width: 5px; }
  .modal-desc-body::-webkit-scrollbar-thumb { background: rgba(77, 208, 225, 0.4); border-radius: 0; }

  /* Info button in the header — gets a cyan tint when open */
  .modal-head button.ghost.on {
    color: var(--cyan, #4dd0e1);
    border-color: var(--cyan, #4dd0e1);
    background: rgba(77, 208, 225, 0.08);
    box-shadow: 0 0 6px rgba(77, 208, 225, 0.3), inset 0 0 6px rgba(77, 208, 225, 0.06);
    text-shadow: 0 0 4px rgba(77, 208, 225, 0.5);
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

  .dim { color: var(--green-dim, #4d8a5a); }
  .mini { font-size: 11px; }
</style>
