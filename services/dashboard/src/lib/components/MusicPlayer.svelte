<script lang="ts">
  /**
   * Persistent music player. Mounted ONCE in the root layout so the audio
   * element survives route changes — letting users keep listening while
   * they roam the rest of the kernel.
   *
   * Three visual modes (driven by the `displayMode` store):
   *   - hidden       → DOM is empty (audio + state still alive though,
   *                    in case anyone re-mounts).
   *   - mini         → only the topnav indicator is visible (the
   *                    indicator lives in MusicNavIndicator.svelte; this
   *                    component renders nothing in this mode).
   *   - drawer       → bottom-anchored compact bar, music + controls.
   *   - fullscreen   → immersive "now playing" with spinning vinyl and
   *                    spectrum analyser.
   *
   * Aesthetic: dim, warm vinyl-listening-room. Brass / amber on deep
   * coffee. Display type is Fraunces — variable serif with personality
   * that suits jazz album sleeves and shellac labels.
   */

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { fade, fly, scale } from 'svelte/transition';
  import { cubicOut, expoOut } from 'svelte/easing';
  import {
    album, queue, currentIndex, currentTrack,
    playing, currentTime, duration, buffered,
    volume, muted, shuffleOn, repeatMode, playbackRate,
    displayMode, errorMsg, spectrum, sleepTimerAt,
    bindAudio, unbindAudio,
    play, pause, toggle, next, prev, jumpTo, seek,
    setVolume, toggleMute, toggleShuffle, cycleRepeat, setSpeed,
    setDisplayMode, closePlayer, setSleepTimer, reportPlay,
  } from '$lib/music-player.js';

  let audioEl: HTMLAudioElement;
  let canvasEl: HTMLCanvasElement | null = null;
  let canvasCtx: CanvasRenderingContext2D | null = null;
  let canvasRaf: number | null = null;
  let seekHover: number | null = null;     // 0..1 normalized hover position
  let speedOpen = false;
  let sleepOpen = false;

  // ── Audio element wiring ─────────────────────────────────────────
  onMount(() => {
    bindAudio(audioEl);
    return () => unbindAudio();
  });

  function onTimeUpdate(): void {
    currentTime.set(audioEl.currentTime);
    if (audioEl.buffered.length > 0) {
      buffered.set(audioEl.buffered.end(audioEl.buffered.length - 1));
    }
    // Throttled heartbeat — store handles the 30s gate.
    reportPlay();
  }
  function onLoadedMetadata(): void { duration.set(audioEl.duration || 0); }
  function onPlay(): void { playing.set(true); }
  function onPause(): void { playing.set(false); }
  function onEnded(): void { reportPlay({ force: true }); next(); }
  function onError(): void {
    errorMsg.set('Stream failed to load. Try a different format or skip.');
    playing.set(false);
  }

  // ── Spectrum canvas ──────────────────────────────────────────────
  // Subscribe to the spectrum store and repaint into the canvas. We don't
  // run our own RAF — the player module already does. We just react to
  // store updates.
  let spectrumBuf: Uint8Array = new Uint8Array(0);
  spectrum.subscribe((b) => { spectrumBuf = b; if (canvasCtx) drawSpectrum(); });

  function drawSpectrum(): void {
    if (!canvasCtx || !canvasEl) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    canvasCtx.clearRect(0, 0, w, h);
    if (spectrumBuf.length === 0) return;
    const bins = Math.min(48, spectrumBuf.length);
    const gap = 4;
    const barW = (w - (bins - 1) * gap) / bins;
    for (let i = 0; i < bins; i++) {
      const v = spectrumBuf[Math.floor((i / bins) * spectrumBuf.length)] / 255;
      // Easing curve gives the bottom of the spectrum more punch than raw.
      const eased = Math.pow(v, 0.7);
      const barH = Math.max(2, eased * h);
      const x = i * (barW + gap);
      const y = h - barH;
      const grad = canvasCtx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, '#f5e6cc');
      grad.addColorStop(0.45, '#d4a056');
      grad.addColorStop(1, '#7a4318');
      canvasCtx.fillStyle = grad;
      canvasCtx.fillRect(x, y, barW, barH);
    }
  }

  function setupCanvas(node: HTMLCanvasElement): { destroy(): void } {
    canvasEl = node;
    const dpr = window.devicePixelRatio ?? 1;
    const resize = (): void => {
      const r = node.getBoundingClientRect();
      node.width = Math.max(1, Math.floor(r.width * dpr));
      node.height = Math.max(1, Math.floor(r.height * dpr));
      canvasCtx = node.getContext('2d');
      if (canvasCtx) canvasCtx.scale(dpr, dpr);
      // Re-derive bar widths against logical px — easier reasoning.
      node.style.width = '100%';
      node.style.height = '100%';
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(node);
    return {
      destroy(): void {
        ro.disconnect();
        if (canvasRaf != null) cancelAnimationFrame(canvasRaf);
        canvasEl = null;
        canvasCtx = null;
      },
    };
  }

  // ── Seek bar interaction ─────────────────────────────────────────
  function onSeekClick(e: MouseEvent): void {
    const t = e.currentTarget as HTMLElement;
    const r = t.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    seek(($duration || 0) * Math.max(0, Math.min(1, x)));
  }
  function onSeekMove(e: MouseEvent): void {
    const t = e.currentTarget as HTMLElement;
    const r = t.getBoundingClientRect();
    seekHover = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  function onSeekLeave(): void { seekHover = null; }

  // ── Helpers ──────────────────────────────────────────────────────
  function fmtTime(s: number | null | undefined): string {
    if (s == null || !Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }
  function fmtBytes(n: number): string {
    if (!n) return '';
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  function kindLabel(k: string): string {
    const m: Record<string, string> = {
      vinyl_78: 'Vinyl 78', vinyl_lp: 'Vinyl LP', netlabel: 'Netlabel',
      live: 'Live', radio: 'Radio', audiobook: 'Audiobook', audio: 'Audio',
    };
    return m[k] ?? 'Audio';
  }

  function onCoverError(e: Event): void {
    const img = e.target as HTMLImageElement | null;
    if (img) img.style.opacity = '0.18';
  }

  /**
   * Click handler for the artist/uploader name shown in the player.
   * Navigates to the music browser pre-filtered to this creator's
   * uploads. Playback survives because the player is mounted in the
   * root layout.
   *
   * Collapses fullscreen back to drawer first so the user lands on
   * /music actually seeing the filtered grid instead of opening it
   * behind the immersive overlay.
   */
  function goToCreator(name: string): void {
    const c = name?.trim();
    if (!c) return;
    if ($displayMode === 'fullscreen') setDisplayMode('drawer');
    void goto(`/music?creator=${encodeURIComponent(c)}`);
  }

  /**
   * archive.org descriptions ship with raw HTML inside JSON strings
   * (`<span style="...">`, `<a href="...">`, `<br>`, &amp; entities).
   * We don't want to render that as markup (XSS risk + design clash),
   * so strip tags + decode the handful of entities that actually
   * appear in real descriptions.
   */
  function stripHtml(s: string): string {
    if (!s) return '';
    return s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&hellip;/g, '…')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Sleep timer countdown — re-renders every second when active.
  let nowTick = Date.now();
  let nowInterval: ReturnType<typeof setInterval>;
  onMount(() => { nowInterval = setInterval(() => { nowTick = Date.now(); }, 1000); });
  onDestroy(() => clearInterval(nowInterval));
  $: sleepRemaining = $sleepTimerAt ? Math.max(0, Math.ceil(($sleepTimerAt - nowTick) / 60_000)) : 0;

  // ── Reactive: on track change, swap the audio src. ───────────────
  // Using bind:src would trigger reload on EVERY store update; this
  // imperative path only fires when the URL actually changes.
  $: trackUrl = $currentTrack?.url ?? '';
  let lastUrl = '';
  $: if (audioEl && trackUrl && trackUrl !== lastUrl) {
    lastUrl = trackUrl;
    audioEl.src = trackUrl;
    audioEl.load();
  }

  // Volume → audio sync (in case it gets changed from outside the store actions).
  $: if (audioEl) audioEl.volume = $muted ? 0 : $volume;
  $: if (audioEl) audioEl.muted = $muted;
  $: if (audioEl) audioEl.playbackRate = $playbackRate;

  // Close ephemeral popovers when display mode changes.
  $: if ($displayMode !== 'fullscreen') { speedOpen = false; sleepOpen = false; }

  // Slider value lifted to a derived expression — Svelte's parser balks at
  // ternaries inside attribute interpolations on certain compiler versions.
  $: effectiveVolume = $muted ? 0 : $volume;
  function onVolumeInput(e: Event): void {
    const v = parseFloat((e.target as HTMLInputElement).value);
    setVolume(v);
  }
  $: volumeIcon = ($muted || $volume === 0) ? '🔇'
                : $volume < 0.4              ? '🔈'
                : $volume < 0.75             ? '🔉'
                : '🔊';

  // ── Repeat icon label ────────────────────────────────────────────
  function repeatGlyph(m: string): string {
    return m === 'one' ? '↻¹' : '↻';
  }

  /**
   * The unicode shuffle glyph (⤭ / 🔀) renders inconsistently across
   * fonts — Fraunces especially shows a tofu box. Inline SVGs render
   * crisply at any size and pick up `currentColor`, so the on/off
   * state still works via `class:on` toggling the parent's color.
   */
  const SHUFFLE_PATH = '<path d="M16 3h5v5"/><path d="M4 20l16-16"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>';
  const REPEAT_PATH  = '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
  function shuffleSvg(size = 14): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHUFFLE_PATH}</svg>`;
  }
  function repeatSvg(mode: string, size = 14): string {
    const inner = mode === 'one'
      ? `${REPEAT_PATH}<text x="12" y="14.4" font-size="6.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="monospace" font-weight="700">1</text>`
      : REPEAT_PATH;
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }
</script>

<!--
  ALWAYS-MOUNTED audio element. crossorigin lets the WebAudio analyser tap
  the stream. preload=metadata so we get duration without slurping bytes.
-->
<audio
  bind:this={audioEl}
  crossorigin="anonymous"
  preload="metadata"
  on:timeupdate={onTimeUpdate}
  on:loadedmetadata={onLoadedMetadata}
  on:play={onPlay}
  on:pause={onPause}
  on:ended={onEnded}
  on:error={onError}
></audio>

{#if $album && $displayMode === 'drawer'}
  <!-- ── DRAWER (compact bottom bar) ──────────────────────────── -->
  <div class="drawer" transition:fly={{ y: 80, duration: 280, easing: expoOut }}>
    <div class="drawer-grid">
      <button class="drawer-cover" on:click={() => setDisplayMode('fullscreen')} title="Open full player">
        <img src={$album.cover_url} alt={$album.title} on:error={onCoverError} />
        <span class="cover-pulse" class:on={$playing}></span>
      </button>

      <div class="drawer-meta">
        <div class="meta-track" title={$currentTrack?.title ?? ''}>{$currentTrack?.title ?? '—'}</div>
        <div class="meta-album" title={`${$album.title} · ${$album.creator}`}>
          <span class="meta-album-name">{$album.title}</span>
          {#if $album.creator}
            <span class="meta-sep">·</span>
            <button type="button" class="meta-album-artist creator-link" title="See all uploads by {$album.creator}" on:click|stopPropagation={() => goToCreator($album.creator)}>{$album.creator}</button>
          {/if}
        </div>
      </div>

      <div class="drawer-controls">
        <button class="ctrl-icon" on:click={prev} title="Previous (←)">⏮</button>
        <button class="ctrl-play" on:click={toggle} title={$playing ? 'Pause (Space)' : 'Play (Space)'}>
          {#if $playing}❚❚{:else}▶{/if}
        </button>
        <button class="ctrl-icon" on:click={next} title="Next (→)">⏭</button>
      </div>

      <div class="drawer-progress">
        <span class="t-cur">{fmtTime($currentTime)}</span>
        <div
          class="seek-rail"
          on:click={onSeekClick}
          on:mousemove={onSeekMove}
          on:mouseleave={onSeekLeave}
          role="slider"
          aria-valuemin="0"
          aria-valuemax={$duration}
          aria-valuenow={$currentTime}
          tabindex="0"
        >
          <span class="seek-buf"  style="width:{$duration ? ($buffered / $duration) * 100 : 0}%"></span>
          <span class="seek-fill" style="width:{$duration ? ($currentTime / $duration) * 100 : 0}%"></span>
          {#if seekHover != null}
            <span class="seek-hover" style="left:{seekHover * 100}%"></span>
            <span class="seek-tooltip" style="left:{seekHover * 100}%">{fmtTime(seekHover * ($duration || 0))}</span>
          {/if}
          <span class="seek-thumb" style="left:{$duration ? ($currentTime / $duration) * 100 : 0}%"></span>
        </div>
        <span class="t-dur">{fmtTime($duration)}</span>
      </div>

      <div class="drawer-aux">
        <button class="ctrl-aux icon-btn" class:on={$shuffleOn} on:click={toggleShuffle} title="Shuffle (S)">{@html shuffleSvg(14)}</button>
        <button class="ctrl-aux icon-btn" class:on={$repeatMode !== 'off'} on:click={cycleRepeat} title="Repeat ({$repeatMode})">{@html repeatSvg($repeatMode, 14)}</button>
        <div class="vol-wrap" title="Volume">
          <button class="ctrl-aux" on:click={() => toggleMute()}>{volumeIcon}</button>
          <input type="range" min="0" max="1" step="0.01" value={effectiveVolume} on:input={onVolumeInput} />
        </div>
        <button class="ctrl-aux" on:click={() => setDisplayMode('fullscreen')} title="Expand (F)">⛶</button>
        <button class="ctrl-aux" on:click={() => setDisplayMode('mini')} title="Minimize to topnav (M)">↓</button>
        <button class="ctrl-aux danger" on:click={closePlayer} title="Close player">✕</button>
      </div>
    </div>

    {#if $errorMsg}
      <div class="drawer-err" on:click={() => errorMsg.set(null)}>⚠ {$errorMsg} <span class="dim">(click to dismiss)</span></div>
    {/if}
  </div>
{/if}

{#if $album && $displayMode === 'fullscreen'}
  <!-- ── FULLSCREEN (immersive now-playing) ───────────────────── -->
  <div class="full" transition:fade={{ duration: 240 }}>
    <!-- Animated background: the cover, blown up + blurred + dimmed. -->
    <div class="full-bg" style:background-image={`url("${$album.cover_url}")`}></div>
    <div class="full-grain"></div>

    <header class="full-head" in:fly={{ y: -20, duration: 380, delay: 100, easing: expoOut }}>
      <div class="brand">
        <span class="brand-dot"></span>
        <span class="brand-name">Kernl · Now Playing</span>
      </div>
      <div class="full-actions">
        {#if sleepRemaining > 0}
          <span class="pill"><span class="zz">𝓏</span> {sleepRemaining}m</span>
        {/if}
        <button class="full-icon" on:click={() => sleepOpen = !sleepOpen} title="Sleep timer">𝓏</button>
        {#if sleepOpen}
          <div class="popover" transition:scale={{ duration: 160, easing: cubicOut }}>
            <div class="pop-title">Sleep in…</div>
            {#each [10, 20, 30, 45, 60, 90] as m}
              <button class="pop-item" on:click={() => { setSleepTimer(m); sleepOpen = false; }}>{m} minutes</button>
            {/each}
            <button class="pop-item dim" on:click={() => { setSleepTimer(null); sleepOpen = false; }}>Cancel timer</button>
          </div>
        {/if}

        <button class="full-icon" on:click={() => speedOpen = !speedOpen} title="Playback speed">{$playbackRate.toFixed(2)}×</button>
        {#if speedOpen}
          <div class="popover" transition:scale={{ duration: 160, easing: cubicOut }}>
            <div class="pop-title">Speed</div>
            {#each [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as r}
              <button class="pop-item" class:on={$playbackRate === r} on:click={() => { setSpeed(r); speedOpen = false; }}>{r}×</button>
            {/each}
          </div>
        {/if}

        <a class="full-icon" href={`https://archive.org/details/${$album.identifier}`} target="_blank" rel="noopener" title="Open on archive.org">↗</a>
        <button class="full-icon" on:click={() => setDisplayMode('drawer')} title="Drawer (Esc)">▭</button>
        <button class="full-icon" on:click={() => setDisplayMode('mini')} title="Minimize to topnav">↓</button>
        <button class="full-icon danger" on:click={closePlayer} title="Close">✕</button>
      </div>
    </header>

    <div class="full-body">
      <!-- LEFT: vinyl + tonearm -->
      <div class="stage" in:scale={{ duration: 600, start: 0.92, delay: 80, easing: expoOut }}>
        <div class="vinyl-wrap">
          <div class="vinyl" class:spinning={$playing}>
            <svg class="vinyl-svg" viewBox="0 0 400 400" aria-hidden="true">
              <defs>
                <radialGradient id="rec-r" cx="50%" cy="50%" r="50%">
                  <stop offset="0%"  stop-color="#272320" />
                  <stop offset="55%" stop-color="#0d0a08" />
                  <stop offset="100%" stop-color="#1a1612" />
                </radialGradient>
                <radialGradient id="rec-shine" cx="35%" cy="30%" r="60%">
                  <stop offset="0%"  stop-color="rgba(255,235,200,0.18)" />
                  <stop offset="50%" stop-color="rgba(255,235,200,0.04)" />
                  <stop offset="100%" stop-color="rgba(0,0,0,0)" />
                </radialGradient>
              </defs>
              <circle cx="200" cy="200" r="198" fill="url(#rec-r)" />
              {#each Array(28) as _, i}
                <circle cx="200" cy="200" r={70 + i * 4.2} fill="none" stroke="rgba(245,230,204,0.05)" stroke-width="0.8" />
              {/each}
              <circle cx="200" cy="200" r="198" fill="url(#rec-shine)" />
              <circle cx="200" cy="200" r="62" fill="#c5965a" />
              <circle cx="200" cy="200" r="62" fill="url(#rec-shine)" />
            </svg>
            <img class="vinyl-label" src={$album.cover_url} alt="" on:error={onCoverError} />
            <span class="vinyl-spindle"></span>
          </div>
          <!--
            Tonearm — a single SVG with the same coordinate space as
            the vinyl wrap. Pivot sits at top-right (just outside the
            disc), arm extends down-left toward the spindle. Rotation
            origin is the pivot circle, so the arm swings naturally
            from "parked" (away from the disc) to "playing" (needle on
            the outer groove). Numbers are tuned so the needle lands
            on the outer rim of the vinyl, not floating in space.
          -->
          <svg class="tonearm" class:on={$playing} viewBox="0 0 100 100" aria-hidden="true">
            <!-- Long thin arm. -->
            <line x1="84" y1="14" x2="56" y2="78" stroke="url(#arm-grad)" stroke-width="1.6" stroke-linecap="round" />
            <!-- Counterweight at the back of the pivot. -->
            <circle cx="92" cy="11" r="4.5" fill="#1a1410" stroke="#5a4326" stroke-width="0.8" />
            <!-- Pivot housing (rotation axis). -->
            <circle cx="84" cy="14" r="6" fill="url(#pivot-grad)" stroke="#3a2c1a" stroke-width="0.6" />
            <circle cx="84" cy="14" r="2.2" fill="#0a0806" />
            <!-- Headshell (the rectangular piece at the end). -->
            <rect x="50" y="76" width="11" height="7" rx="1.2" fill="#181410" stroke="#5a4326" stroke-width="0.5" transform="rotate(-22 55.5 79.5)" />
            <!-- Needle — tiny dot touching the vinyl. -->
            <circle cx="54" cy="84" r="0.9" fill="#d4a056" />
            <defs>
              <linearGradient id="arm-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%"  stop-color="#d8b884" />
                <stop offset="50%" stop-color="#b08854" />
                <stop offset="100%" stop-color="#6b4a26" />
              </linearGradient>
              <radialGradient id="pivot-grad" cx="35%" cy="35%" r="65%">
                <stop offset="0%"  stop-color="#e8c890" />
                <stop offset="60%" stop-color="#a07840" />
                <stop offset="100%" stop-color="#503418" />
              </radialGradient>
            </defs>
          </svg>
        </div>

        <!-- Spectrum lives below the vinyl, like a console VU strip. -->
        <div class="spectrum">
          <canvas use:setupCanvas></canvas>
        </div>
      </div>

      <!-- RIGHT: metadata + seek + queue -->
      <div class="info" in:fly={{ x: 30, duration: 480, delay: 200, easing: expoOut }}>
        <div class="info-tags">
          <span class="tag">{kindLabel($album.format_kind)}</span>
          {#if $album.year}<span class="tag dim">{$album.year}</span>{/if}
          {#if $album.language}<span class="tag dim">{$album.language}</span>{/if}
          <span class="tag dim">{$queue.length} tracks</span>
        </div>
        <h1 class="info-album">{$album.title}</h1>
        {#if $album.creator}
          <button type="button" class="info-creator creator-link" title="See all uploads by {$album.creator}" on:click|stopPropagation={() => goToCreator($album.creator)}>{$album.creator}</button>
        {/if}

        <div class="info-track">
          <span class="track-no">{($currentIndex + 1).toString().padStart(2, '0')}</span>
          <span class="track-title">{$currentTrack?.title ?? '—'}</span>
        </div>

        <div class="full-progress">
          <span class="t-cur">{fmtTime($currentTime)}</span>
          <div
            class="seek-rail tall"
            on:click={onSeekClick}
            on:mousemove={onSeekMove}
            on:mouseleave={onSeekLeave}
            role="slider"
            aria-valuemin="0"
            aria-valuemax={$duration}
            aria-valuenow={$currentTime}
            tabindex="0"
          >
            <span class="seek-buf"  style="width:{$duration ? ($buffered / $duration) * 100 : 0}%"></span>
            <span class="seek-fill" style="width:{$duration ? ($currentTime / $duration) * 100 : 0}%"></span>
            {#if seekHover != null}
              <span class="seek-hover" style="left:{seekHover * 100}%"></span>
              <span class="seek-tooltip" style="left:{seekHover * 100}%">{fmtTime(seekHover * ($duration || 0))}</span>
            {/if}
            <span class="seek-thumb" style="left:{$duration ? ($currentTime / $duration) * 100 : 0}%"></span>
          </div>
          <span class="t-dur">{fmtTime($duration)}</span>
        </div>

        <div class="full-controls">
          <button class="ctrl-aux icon-btn" class:on={$shuffleOn} on:click={toggleShuffle} title="Shuffle (S)">{@html shuffleSvg(18)}</button>
          <button class="ctrl-icon big" on:click={prev} title="Previous">⏮</button>
          <button class="ctrl-play big" on:click={toggle} title={$playing ? 'Pause' : 'Play'}>
            {#if $playing}❚❚{:else}▶{/if}
          </button>
          <button class="ctrl-icon big" on:click={next} title="Next">⏭</button>
          <button class="ctrl-aux icon-btn" class:on={$repeatMode !== 'off'} on:click={cycleRepeat} title="Repeat ({$repeatMode})">{@html repeatSvg($repeatMode, 18)}</button>

          <div class="vol-wrap big" title="Volume">
            <button class="ctrl-aux" on:click={() => toggleMute()}>{volumeIcon}</button>
            <input type="range" min="0" max="1" step="0.01" value={effectiveVolume} on:input={onVolumeInput} />
          </div>
        </div>

        <!--
          Tracklist — always visible in fullscreen so the user sees
          what's in the album. Each row is clickable: jumps to that
          track and starts playing. Scrolls when long.
        -->
        <section class="tracks-block">
          <header class="tracks-head">
            <span class="tracks-label">Tracks</span>
            <span class="tracks-count">{$queue.length}</span>
          </header>
          <div class="tracks-list">
            {#each $queue as t, i (t.name)}
              <button class="track-row" class:on={i === $currentIndex} on:click={() => jumpTo(i)}>
                <span class="tr-num">
                  {#if i === $currentIndex && $playing}
                    <span class="eq-mini" aria-hidden="true"><b></b><b></b><b></b></span>
                  {:else}
                    {(t.track ?? i + 1).toString().padStart(2, '0')}
                  {/if}
                </span>
                <span class="tr-title">{t.title}</span>
                <span class="tr-fmt">{t.format}</span>
                <span class="tr-len">{fmtTime(t.length_seconds)}</span>
              </button>
            {/each}
          </div>
        </section>

        {#if $album.description}
          <details class="info-desc">
            <summary class="info-desc-toggle">About</summary>
            <p class="info-desc-text">{stripHtml($album.description)}</p>
          </details>
        {/if}
      </div>
    </div>

    {#if $errorMsg}
      <div class="full-err" on:click={() => errorMsg.set(null)}>⚠ {$errorMsg}</div>
    {/if}
  </div>
{/if}

<style>
  /* ── Distinctive type — Fraunces is a variable serif with serious
       personality (curves, optical sizes), ideal for a vinyl-listening
       header. Loaded scoped to the player so it doesn't pollute the rest
       of the kernel. */
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&display=swap');

  :global(:root) {
    --mp-bg-1: #0d0c0a;
    --mp-bg-2: #1a1614;
    --mp-bg-3: #241e19;
    --mp-line: #3a312a;
    --mp-line-h: #564a3f;
    --mp-text-1: #f5e6cc;
    --mp-text-2: #c2a983;
    --mp-text-3: #6e604c;
    --mp-brass:  #d4a056;
    --mp-brass-2: #c5965a;
    --mp-brass-glow: rgba(212,160,86,0.35);
    --mp-wine:   #9b2335;
    --mp-cream:  #f5e6cc;
  }

  /* ── DRAWER ────────────────────────────────────────────────────── */
  .drawer {
    position: fixed;
    left: 18px; right: 18px; bottom: 14px;
    z-index: 70;
    background: linear-gradient(180deg, rgba(28,22,18,0.96), rgba(13,12,10,0.97));
    border: 1px solid var(--mp-line);
    border-radius: 14px;
    padding: 12px 14px;
    backdrop-filter: blur(18px) saturate(1.2);
    box-shadow:
      0 -2px 30px rgba(0,0,0,0.55),
      0 0 0 1px rgba(245,230,204,0.04) inset,
      0 1px 0 rgba(245,230,204,0.06) inset;
    color: var(--mp-text-1);
    font-family: 'Fraunces', Georgia, serif;
  }
  .drawer-grid {
    display: grid;
    grid-template-columns: 56px 1fr auto 1fr auto;
    gap: 16px;
    align-items: center;
  }
  @media (max-width: 900px) {
    .drawer-grid { grid-template-columns: 56px 1fr auto; }
    .drawer-progress, .drawer-aux { display: none; }
  }
  .drawer-cover {
    position: relative;
    width: 56px; height: 56px;
    border: 1px solid var(--mp-line);
    border-radius: 8px;
    overflow: hidden;
    padding: 0;
    background: var(--mp-bg-3);
    cursor: pointer;
    transition: transform 200ms cubic-bezier(.2,.8,.2,1), border-color 160ms;
  }
  .drawer-cover:hover { transform: scale(1.04); border-color: var(--mp-brass); }
  .drawer-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cover-pulse {
    position: absolute; inset: -4px;
    border-radius: 12px;
    border: 1px solid var(--mp-brass-glow);
    pointer-events: none;
    opacity: 0;
  }
  .cover-pulse.on { animation: pulse 2.4s ease-out infinite; }
  @keyframes pulse {
    0%   { opacity: 0.7; transform: scale(0.9); }
    80%  { opacity: 0;   transform: scale(1.18); }
    100% { opacity: 0;   transform: scale(1.18); }
  }

  .drawer-meta { min-width: 0; }
  .meta-track {
    font-family: 'Fraunces', serif;
    font-weight: 500;
    font-size: 16px;
    letter-spacing: -0.01em;
    color: var(--mp-text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .meta-album {
    font-size: 12px;
    color: var(--mp-text-3);
    margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .meta-album-name { color: var(--mp-text-2); }
  .meta-album-artist { color: var(--mp-text-3); margin-left: 4px; }

  /* Creator-link buttons: strip button chrome so they read as text, but
     stay keyboard-reachable and gain a hover affordance (brass + dashed
     underline) signalling they navigate to /music?creator=…. */
  .creator-link {
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    border-bottom: 1px dashed transparent;
    transition: color 140ms, border-color 140ms;
  }
  .creator-link:hover {
    color: var(--mp-brass);
    border-bottom-color: var(--mp-brass);
  }
  .creator-link:focus-visible {
    outline: 1px dashed var(--mp-brass);
    outline-offset: 3px;
  }
  .meta-sep { margin: 0 6px; opacity: 0.5; }

  .drawer-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ctrl-icon, .ctrl-play, .ctrl-aux {
    background: transparent;
    border: 1px solid transparent;
    color: var(--mp-text-2);
    font: inherit;
    cursor: pointer;
    transition: all 140ms;
    border-radius: 8px;
  }
  .ctrl-icon { padding: 8px 10px; font-size: 14px; }
  .ctrl-icon:hover { color: var(--mp-text-1); background: rgba(245,230,204,0.06); }
  .ctrl-play {
    width: 44px; height: 44px;
    background: var(--mp-brass);
    color: #1a1410;
    border-color: var(--mp-brass);
    font-size: 14px;
    font-weight: 700;
    box-shadow: 0 4px 18px var(--mp-brass-glow), inset 0 1px 0 rgba(255,255,255,0.18);
  }
  .ctrl-play:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .ctrl-play.big { width: 64px; height: 64px; font-size: 18px; }
  .ctrl-icon.big { padding: 14px 16px; font-size: 18px; }
  .ctrl-aux {
    padding: 7px 10px;
    font-size: 13px;
    color: var(--mp-text-3);
  }
  .ctrl-aux:hover { color: var(--mp-text-1); background: rgba(245,230,204,0.06); }
  .ctrl-aux.on { color: var(--mp-brass); }
  .ctrl-aux.danger:hover { color: #e87b85; background: rgba(155,35,53,0.18); }
  /* SVG-bearing aux buttons: tighten padding so the icon sits centered
     instead of leaving asymmetric whitespace from the text padding. */
  .ctrl-aux.icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 7px;
  }

  .drawer-progress {
    display: grid;
    grid-template-columns: 44px 1fr 44px;
    align-items: center;
    gap: 10px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px;
    color: var(--mp-text-3);
  }
  .t-cur { text-align: right; }
  .t-dur { text-align: left; }

  .drawer-aux {
    display: flex; align-items: center; gap: 4px;
  }
  .vol-wrap {
    display: flex; align-items: center; gap: 4px;
    padding-left: 6px;
  }
  .vol-wrap input[type=range] {
    width: 80px;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .vol-wrap.big input[type=range] { width: 110px; }
  .vol-wrap input[type=range]::-webkit-slider-runnable-track {
    height: 3px;
    background: linear-gradient(90deg, var(--mp-brass) 0% var(--vol-fill, 50%), var(--mp-line) var(--vol-fill, 50%) 100%);
    border-radius: 2px;
  }
  .vol-wrap input[type=range]::-moz-range-track {
    height: 3px;
    background: linear-gradient(90deg, var(--mp-brass) 0% var(--vol-fill, 50%), var(--mp-line) var(--vol-fill, 50%) 100%);
    border-radius: 2px;
  }
  .vol-wrap input[type=range]::-webkit-slider-thumb {
    appearance: none;
    margin-top: -5px;
    width: 12px; height: 12px;
    background: var(--mp-cream);
    border-radius: 50%;
    box-shadow: 0 0 6px var(--mp-brass-glow);
  }
  .vol-wrap input[type=range]::-moz-range-thumb {
    width: 12px; height: 12px;
    background: var(--mp-cream);
    border: 0;
    border-radius: 50%;
    box-shadow: 0 0 6px var(--mp-brass-glow);
  }

  /* ── Seek bar ────────────────────────────────────────────────── */
  .seek-rail {
    position: relative;
    height: 4px;
    background: var(--mp-bg-3);
    border-radius: 2px;
    cursor: pointer;
    overflow: visible;
  }
  .seek-rail.tall { height: 6px; }
  .seek-rail:hover .seek-thumb { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  .seek-buf {
    position: absolute; top: 0; left: 0; bottom: 0;
    background: rgba(245,230,204,0.10);
    border-radius: inherit;
  }
  .seek-fill {
    position: absolute; top: 0; left: 0; bottom: 0;
    background: linear-gradient(90deg, var(--mp-brass-2), var(--mp-cream));
    border-radius: inherit;
    box-shadow: 0 0 10px var(--mp-brass-glow);
  }
  .seek-hover {
    position: absolute;
    top: 0; bottom: 0;
    width: 1px;
    background: rgba(245,230,204,0.5);
    pointer-events: none;
  }
  .seek-tooltip {
    position: absolute;
    top: -22px;
    transform: translateX(-50%);
    background: var(--mp-bg-3);
    border: 1px solid var(--mp-line);
    color: var(--mp-text-1);
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    pointer-events: none;
    white-space: nowrap;
  }
  .seek-thumb {
    position: absolute;
    top: 50%;
    width: 11px; height: 11px;
    background: var(--mp-cream);
    border-radius: 50%;
    transform: translate(-50%, -50%) scale(0);
    transition: transform 140ms cubic-bezier(.2,.8,.2,1), opacity 140ms;
    opacity: 0;
    box-shadow: 0 0 10px var(--mp-brass-glow);
  }

  .drawer-err {
    margin-top: 8px;
    padding: 6px 10px;
    background: rgba(155,35,53,0.18);
    border: 1px solid rgba(155,35,53,0.35);
    border-radius: 6px;
    color: #e9bdc4;
    font-size: 12px;
    cursor: pointer;
  }
  .drawer-err .dim { color: #a78a8e; margin-left: 6px; }

  /* ── FULLSCREEN ──────────────────────────────────────────────── */
  .full {
    position: fixed; inset: 0;
    z-index: 80;
    background: var(--mp-bg-1);
    color: var(--mp-text-1);
    overflow: hidden;
    font-family: 'Fraunces', Georgia, serif;
    display: flex; flex-direction: column;
  }
  .full-bg {
    position: absolute; inset: -8%;
    background-size: cover;
    background-position: center;
    filter: blur(40px) saturate(1.3) brightness(0.42);
    transform: scale(1.18);
    opacity: 0.85;
    pointer-events: none;
    animation: bg-drift 32s ease-in-out infinite alternate;
  }
  @keyframes bg-drift {
    0%   { transform: scale(1.18) translate(0, 0); }
    100% { transform: scale(1.22) translate(2%, -1.5%); }
  }
  .full-grain {
    position: absolute; inset: 0;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.96 0 0 0 0 0.90 0 0 0 0 0.80 0 0 0 0.16 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
    opacity: 0.45;
    mix-blend-mode: overlay;
    pointer-events: none;
  }

  .full-head {
    position: relative;
    z-index: 2;
    display: flex; justify-content: space-between; align-items: center;
    padding: 18px 28px;
    border-bottom: 1px solid rgba(245,230,204,0.08);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand-dot {
    width: 8px; height: 8px;
    background: var(--mp-brass);
    border-radius: 50%;
    box-shadow: 0 0 10px var(--mp-brass-glow);
    animation: blink 2.4s ease-in-out infinite;
  }
  @keyframes blink { 50% { opacity: 0.35; } }
  .brand-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: var(--mp-text-2);
  }
  .full-actions {
    display: flex; align-items: center; gap: 4px;
    position: relative;
  }
  .full-icon {
    background: transparent;
    border: 1px solid transparent;
    color: var(--mp-text-2);
    width: 36px; height: 36px;
    border-radius: 8px;
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer;
    text-decoration: none;
    font: inherit;
    transition: all 140ms;
  }
  .full-icon:hover {
    color: var(--mp-text-1);
    background: rgba(245,230,204,0.07);
    border-color: var(--mp-line);
  }
  .full-icon.sm { width: 28px; height: 28px; font-size: 13px; }
  .full-icon.danger:hover { color: #e87b85; background: rgba(155,35,53,0.16); }

  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px;
    background: rgba(212,160,86,0.12);
    border: 1px solid var(--mp-brass);
    color: var(--mp-brass);
    border-radius: 999px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    margin-right: 6px;
  }
  .zz { font-family: 'Fraunces', serif; font-style: italic; }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    background: var(--mp-bg-2);
    border: 1px solid var(--mp-line);
    border-radius: 8px;
    padding: 4px;
    min-width: 160px;
    box-shadow: 0 12px 30px rgba(0,0,0,0.55);
    transform-origin: top right;
    z-index: 4;
  }
  .pop-title {
    padding: 8px 10px 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--mp-text-3);
  }
  .pop-item {
    display: block; width: 100%;
    background: transparent;
    border: 0;
    color: var(--mp-text-1);
    padding: 8px 12px;
    font: inherit;
    font-size: 13px;
    text-align: left;
    border-radius: 4px;
    cursor: pointer;
  }
  .pop-item:hover { background: rgba(245,230,204,0.06); }
  .pop-item.on { color: var(--mp-brass); }
  .pop-item.dim { color: var(--mp-text-3); }

  /* ── Stage (vinyl + spectrum) ──────────────────────────────── */
  .full-body {
    position: relative;
    z-index: 2;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(360px, 1fr) minmax(360px, 1.05fr);
    gap: 60px;
    padding: 32px 60px 50px;
    min-height: 0;
  }
  @media (max-width: 1100px) {
    .full-body { grid-template-columns: 1fr; gap: 36px; padding: 22px 26px 30px; }
  }
  .stage {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 28px;
    min-width: 0;
  }

  .vinyl-wrap {
    position: relative;
    width: min(54vh, 480px);
    aspect-ratio: 1;
    max-width: 100%;
  }
  .vinyl {
    position: absolute; inset: 0;
    border-radius: 50%;
    overflow: hidden;
    box-shadow:
      0 30px 60px rgba(0,0,0,0.65),
      0 0 0 4px rgba(0,0,0,0.6),
      0 0 0 6px rgba(245,230,204,0.06);
  }
  .vinyl.spinning { animation: spin 6.4s linear infinite; }
  .vinyl-svg { width: 100%; height: 100%; display: block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .vinyl-label {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 31%; height: 31%;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid #1a1410;
    box-shadow: 0 0 0 1px rgba(245,230,204,0.18);
  }
  .vinyl-spindle {
    position: absolute;
    top: 50%; left: 50%;
    width: 6px; height: 6px;
    transform: translate(-50%, -50%);
    background: #0a0806;
    border-radius: 50%;
    box-shadow: 0 0 0 2px #c5965a;
    pointer-events: none;
    z-index: 2;
  }

  /*
    Tonearm — full-square SVG overlay. Pivot is at (84,14) in the
    100x100 viewBox, so the rotation origin is set to the same percent.
    Parked: rotated -22deg (arm swung outside the disc to the upper
    right). Playing: rotated 0deg (arm rests on the outer rim, needle
    on the disc). Smooth swing on play/pause.
  */
  .tonearm {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    transform-origin: 84% 14%;
    transform: rotate(-22deg);
    transition: transform 800ms cubic-bezier(.2,.85,.25,1);
    filter: drop-shadow(0 4px 8px rgba(0,0,0,0.55));
    z-index: 3;
  }
  .tonearm.on { transform: rotate(0deg); }

  .spectrum {
    width: min(54vh, 480px);
    height: 60px;
    max-width: 100%;
    border-radius: 6px;
    background: linear-gradient(180deg, rgba(0,0,0,0.0), rgba(0,0,0,0.35));
    padding: 6px 4px;
  }
  .spectrum canvas { display: block; }

  /* ── Info side ──────────────────────────────────────────────── */
  .info {
    /*
      Anchored to the top, not centered, because:
        - long descriptions or many tracks can exceed viewport height
        - centering would push the head of the panel above the fold
      Vertical scroll is owned by THIS column so each opened section
      (tracklist, About) gets a unified scroll surface — no nested
      scroll wars.
    */
    display: flex; flex-direction: column; justify-content: flex-start;
    min-width: 0; min-height: 0;
    gap: 10px;
    overflow-y: auto;
    padding-right: 8px;            /* room for the scrollbar */
    scrollbar-width: thin;
    scrollbar-color: var(--mp-brass-2) transparent;
  }
  .info::-webkit-scrollbar       { width: 6px; }
  .info::-webkit-scrollbar-thumb { background: var(--mp-brass-2); border-radius: 3px; }
  .info-tags { display: flex; gap: 6px; flex-wrap: wrap; }
  .tag {
    display: inline-flex; align-items: center;
    padding: 3px 10px;
    background: rgba(212,160,86,0.12);
    border: 1px solid rgba(212,160,86,0.4);
    color: var(--mp-brass);
    border-radius: 999px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
  }
  .tag.dim {
    background: rgba(245,230,204,0.04);
    border-color: rgba(245,230,204,0.12);
    color: var(--mp-text-2);
  }

  .info-album {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 144, 'wght' 600;
    font-size: clamp(34px, 4.6vw, 64px);
    line-height: 1.05;
    letter-spacing: -0.02em;
    color: var(--mp-cream);
    margin: 6px 0 0;
    overflow-wrap: anywhere;
    text-shadow: 0 4px 30px rgba(0,0,0,0.5);
  }
  .info-creator {
    font-family: 'Fraunces', serif;
    font-style: italic;
    font-size: clamp(16px, 1.6vw, 22px);
    color: var(--mp-text-2);
    margin-bottom: 8px;
  }
  .info-track {
    display: flex; align-items: baseline; gap: 12px;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid rgba(245,230,204,0.08);
  }
  .track-no {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--mp-brass);
  }
  .track-title {
    font-family: 'Fraunces', serif;
    font-weight: 500;
    font-size: 18px;
    color: var(--mp-text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .full-progress {
    display: grid;
    grid-template-columns: 50px 1fr 50px;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--mp-text-3);
  }

  .full-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }

  /* ── Tracklist (always visible in fullscreen) ─────────────────── */
  .tracks-block {
    margin-top: 22px;
    padding-top: 16px;
    border-top: 1px solid rgba(245,230,204,0.08);
    display: flex; flex-direction: column;
    min-height: 0;
    /* Cap so it doesn't push the description off-screen on long
       albums — we scroll inside instead. */
    max-height: 38vh;
  }
  .tracks-head {
    display: flex; align-items: baseline; gap: 10px;
    margin-bottom: 8px;
  }
  .tracks-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: var(--mp-brass);
  }
  .tracks-count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--mp-text-3);
  }
  .tracks-list {
    overflow-y: auto;
    border: 1px solid rgba(245,230,204,0.06);
    border-radius: 8px;
    background: rgba(0,0,0,0.18);
    /* Custom scrollbar so it matches the brass palette. */
    scrollbar-width: thin;
    scrollbar-color: var(--mp-brass-2) transparent;
  }
  .tracks-list::-webkit-scrollbar       { width: 6px; }
  .tracks-list::-webkit-scrollbar-thumb { background: var(--mp-brass-2); border-radius: 3px; }
  .track-row {
    display: grid;
    grid-template-columns: 32px 1fr auto auto;
    gap: 14px;
    align-items: center;
    width: 100%;
    padding: 9px 14px;
    background: transparent;
    border: 0;
    color: var(--mp-text-2);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 140ms, color 140ms, border-color 140ms;
  }
  .track-row + .track-row { border-top: 1px solid rgba(245,230,204,0.04); }
  .track-row:hover { background: rgba(245,230,204,0.04); color: var(--mp-text-1); }
  .track-row.on {
    background: rgba(212,160,86,0.10);
    color: var(--mp-cream);
    border-left-color: var(--mp-brass);
  }
  .tr-num {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--mp-text-3);
    text-align: center;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .track-row.on .tr-num { color: var(--mp-brass); }
  .tr-title {
    font-family: 'Fraunces', serif;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tr-fmt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--mp-text-3);
    padding: 1px 6px;
    background: rgba(245,230,204,0.05);
    border-radius: 3px;
  }
  .tr-len {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--mp-text-3);
    min-width: 38px; text-align: right;
  }

  /* tiny equalizer used inside the track-row that's currently playing */
  .eq-mini {
    display: inline-flex; align-items: flex-end; gap: 1.5px;
    height: 12px;
  }
  .eq-mini b {
    width: 2px;
    background: var(--mp-brass);
    border-radius: 1px;
    animation: eq-bar 0.9s ease-in-out infinite;
  }
  .eq-mini b:nth-child(1) { animation-delay: -0.10s; }
  .eq-mini b:nth-child(2) { animation-delay: -0.30s; }
  .eq-mini b:nth-child(3) { animation-delay: -0.05s; }
  @keyframes eq-bar { 0%,100% { height: 22%; } 50% { height: 95%; } }

  /* Description: collapsible — opens with the disclosure triangle.
     The HTML in archive.org descriptions is stripped before render. */
  .info-desc {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid rgba(245,230,204,0.06);
  }
  .info-desc-toggle {
    cursor: pointer;
    list-style: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: var(--mp-brass);
    user-select: none;
  }
  .info-desc-toggle::-webkit-details-marker { display: none; }
  .info-desc-toggle::before {
    content: "▸";
    display: inline-block;
    margin-right: 6px;
    color: var(--mp-text-3);
    transition: transform 200ms;
  }
  .info-desc[open] > .info-desc-toggle::before { transform: rotate(90deg); }
  .info-desc-text {
    margin: 10px 0 0;
    padding: 12px 12px 12px 14px;
    color: var(--mp-text-2);
    font-family: 'Fraunces', serif;
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    /*
      Hard cap so the column owning the scroll can still reach its
      bottom. ~25vh ≈ 8 visible lines on a 1080p screen — long
      descriptions get an in-place scrollbar instead of pushing the
      page down.
    */
    max-height: 25vh;
    overflow-y: auto;
    opacity: 0.9;
    background: rgba(0,0,0,0.22);
    border: 1px solid rgba(245,230,204,0.06);
    border-radius: 6px;
    scrollbar-width: thin;
    scrollbar-color: var(--mp-brass-2) transparent;
  }
  .info-desc-text::-webkit-scrollbar       { width: 6px; }
  .info-desc-text::-webkit-scrollbar-thumb { background: var(--mp-brass-2); border-radius: 3px; }
  .dim { color: var(--mp-text-3); }

  .full-err {
    position: absolute;
    bottom: 18px; left: 50%;
    transform: translateX(-50%);
    z-index: 4;
    padding: 8px 14px;
    background: rgba(155,35,53,0.18);
    border: 1px solid rgba(155,35,53,0.35);
    border-radius: 6px;
    color: #e9bdc4;
    font-size: 12px;
    cursor: pointer;
  }
</style>
