<script lang="ts">
  /**
   * Topnav music indicator.
   *
   * Visible in the global header whenever an album is loaded. Shows:
   *   - 4-bar animated equalizer when audio is playing
   *   - static "music" glyph when paused
   * On hover, expands inline to show the current track + thumbnail.
   *
   * Click       → toggle drawer (mini ⇄ drawer)
   * Right-click → fullscreen
   *
   * The indicator never owns audio state — it just reads from the player
   * store. The audio element itself lives in MusicPlayer.svelte (also
   * mounted in the layout, so it survives nav).
   */

  import { fade, fly } from 'svelte/transition';
  import {
    album, currentTrack, playing, displayMode,
    toggle, setDisplayMode,
  } from '$lib/music-player.js';

  function onClick(): void {
    // mini → open drawer; drawer → minimize; fullscreen → drawer.
    const m = $displayMode;
    if (m === 'mini' || m === 'hidden') setDisplayMode('drawer');
    else if (m === 'drawer') setDisplayMode('mini');
    else setDisplayMode('drawer');
  }
  function onContext(e: MouseEvent): void {
    e.preventDefault();
    setDisplayMode('fullscreen');
  }
  function onCoverError(e: Event): void {
    const img = e.target as HTMLImageElement | null;
    if (img) img.style.opacity = '0.2';
  }

  // Show as "active" when drawer or fullscreen is currently visible.
  $: active = $displayMode === 'drawer' || $displayMode === 'fullscreen';
</script>

{#if $album}
  <div class="mn-wrap" transition:fade={{ duration: 180 }}>
    <button
      class="mn"
      class:active
      class:playing={$playing}
      on:click={onClick}
      on:contextmenu={onContext}
      title={`${$currentTrack?.title ?? '—'} — ${$album.creator || $album.title}\nClick: drawer · Right-click: fullscreen`}
    >
      <span class="cover" aria-hidden="true">
        <img src={$album.cover_url} alt="" on:error={onCoverError} />
      </span>
      <span class="eq" aria-hidden="true">
        <span class="bar"></span><span class="bar"></span>
        <span class="bar"></span><span class="bar"></span>
      </span>
      <span class="meta">
        <span class="t-title">{$currentTrack?.title ?? '—'}</span>
        <span class="t-artist">{$album.creator || $album.title}</span>
      </span>
      <button class="play-poke" on:click|stopPropagation={toggle} title={$playing ? 'Pause' : 'Play'}>
        {#if $playing}❚❚{:else}▶{/if}
      </button>
    </button>
  </div>
{/if}

<style>
  .mn-wrap {
    display: inline-flex;
    align-items: center;
    margin-right: 6px;
  }
  .mn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px 5px 5px;
    background: linear-gradient(180deg, rgba(212,160,86,0.10), rgba(212,160,86,0.04));
    border: 1px solid rgba(212,160,86,0.28);
    border-radius: 999px;
    color: #f5e6cc;
    font: inherit;
    cursor: pointer;
    transition: all 200ms cubic-bezier(.2,.8,.2,1);
    max-width: 60px;     /* collapsed: only cover + eq fits */
    overflow: hidden;
    position: relative;
  }
  .mn:hover, .mn.active {
    max-width: 320px;
    background: linear-gradient(180deg, rgba(212,160,86,0.20), rgba(212,160,86,0.08));
    border-color: rgba(212,160,86,0.55);
    box-shadow: 0 0 22px rgba(212,160,86,0.22);
  }
  .mn.active {
    background: linear-gradient(180deg, rgba(212,160,86,0.26), rgba(212,160,86,0.10));
  }

  .cover {
    width: 26px; height: 26px;
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
    background: #1a1614;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.6), 0 0 0 1px #c5965a;
    position: relative;
  }
  .cover::after {
    /* center spindle */
    content: '';
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 4px; height: 4px;
    background: #0a0806;
    border-radius: 50%;
  }
  .cover img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }
  .mn.playing .cover { animation: spin 5.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Equalizer — only visible when playing. Otherwise we show a tiny ♪. */
  .eq {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 16px;
    width: 16px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 160ms;
  }
  .mn.playing .eq { opacity: 1; }
  .eq .bar {
    width: 2.5px;
    background: linear-gradient(180deg, #f5e6cc, #d4a056);
    border-radius: 1px;
    transform-origin: bottom;
  }
  .mn.playing .eq .bar:nth-child(1) { animation: bar 0.9s -0.10s ease-in-out infinite; }
  .mn.playing .eq .bar:nth-child(2) { animation: bar 1.2s -0.30s ease-in-out infinite; }
  .mn.playing .eq .bar:nth-child(3) { animation: bar 0.7s -0.05s ease-in-out infinite; }
  .mn.playing .eq .bar:nth-child(4) { animation: bar 1.1s -0.50s ease-in-out infinite; }
  @keyframes bar {
    0%, 100% { height: 22%; }
    50%      { height: 95%; }
  }

  .meta {
    display: flex; flex-direction: column;
    min-width: 0;
    overflow: hidden;
    line-height: 1.15;
    padding-right: 4px;
    opacity: 0;
    transform: translateX(-4px);
    transition: opacity 200ms 60ms, transform 200ms 60ms;
  }
  .mn:hover .meta, .mn.active .meta { opacity: 1; transform: translateX(0); }
  .t-title {
    font-family: 'Fraunces', Georgia, serif;
    font-size: 12px;
    font-weight: 500;
    color: #f5e6cc;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 200px;
  }
  .t-artist {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 9px;
    color: #c2a983;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 200px;
    margin-top: 1px;
  }

  .play-poke {
    width: 22px; height: 22px;
    border-radius: 50%;
    border: 0;
    background: #d4a056;
    color: #1a1410;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    box-shadow: 0 0 10px rgba(212,160,86,0.45);
    opacity: 0;
    transform: scale(0.6);
    transition: opacity 200ms 90ms, transform 200ms 90ms cubic-bezier(.2,.8,.2,1);
  }
  .mn:hover .play-poke, .mn.active .play-poke { opacity: 1; transform: scale(1); }
  .play-poke:hover { filter: brightness(1.1); }
</style>
