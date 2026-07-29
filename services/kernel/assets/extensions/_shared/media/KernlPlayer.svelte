<script lang="ts">
  /*
    KernlPlayer — the one video component for cinema, torrents and TV.

    It replaces the browser's native controls with our own bar, because the
    native one can't express what these players need:

      · TV is a BROADCAST. You cannot pause a broadcast, you cannot seek it,
        and a scrubber that pretends otherwise is a lie. Live mode shows a
        read-only progress of the current programme, a LIVE badge, and a
        "rejoin" action instead of transport controls.
      · cinema/torrents are ON DEMAND: full transport, scrubbing, speed.

    Captions are part of the bar — a real CC control next to volume, not a
    floating box bolted on top of the picture.

    Everything is opt-in via props, so a host enables exactly what its medium
    supports.
  */
  import { onDestroy, onMount } from 'svelte';
  import type { SubsController, SubTrack } from './subs-client';
  import { phaseLabel, relativeAge } from './subs-client';
  import {
    loadCaptionStyle, saveCaptionStyle, captionInlineStyle,
    type CaptionStyle,
  } from './caption-style';

  /** Media source. Changing it reloads the element. */
  export let src = '';
  export let poster = '';
  /** Live broadcast: no pause, no seek. */
  export let live = false;
  /** Seconds into `src` the broadcast currently is (live only). */
  export let liveOffset = 0;
  /** Programme/track duration in seconds, for the live progress read-out. */
  export let liveDuration = 0;
  /** Caption controller. Omit to hide the CC control entirely. */
  export let ctl: SubsController | null = null;
  /** Bumped by the host on controller changes. */
  export let tick = 0;
  export let allowTranslate = true;
  export let allowManage = true;
  /** Playback speeds offered on demand. Empty disables the control. */
  export let speeds: number[] = [0.5, 1, 1.25, 1.5, 2];
  export let autoplay = true;
  /** Passed through for CORS-sensitive sources (torrent streams need it). */
  export let crossorigin: string | null = null;

  export let video: HTMLVideoElement | null = null;

  let shell: HTMLDivElement | null = null;
  let playing = false;
  let muted = false;
  let volume = 1;
  let current = 0;
  let duration = 0;
  let buffered = 0;
  let rate = 1;
  let fullscreen = false;
  let menu: '' | 'cc' | 'speed' | 'style' = '';

  // Captions are painted by US, not the browser: the track stays hidden and we
  // render `ctl.cueText` into an overlay, which is the only way to give the
  // viewer real control over font, size, colour and placement.
  let caption: CaptionStyle = loadCaptionStyle();
  $: cueText = (tick, ctl?.cueText ?? '');
  $: capStyle = captionInlineStyle(caption);
  function updateCaption(patch: Partial<CaptionStyle>): void {
    caption = { ...caption, ...patch };
    saveCaptionStyle(caption);
  }
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let idle = false;

  $: job = (tick, ctl?.job ?? null);
  $: tracks = (tick, ctl?.tracks ?? []);
  $: languages = (tick, ctl?.languages ?? []);
  $: activeTrack = (tick, ctl?.active ?? null);
  $: showing = (tick, ctl?.showing ?? false);
  $: subsRunning = job?.status === 'running';
  $: subsFailed = job?.status === 'error';
  $: subsPct = Math.round((job?.progress ?? 0) * 100);
  $: offerable = languages.filter((l) => !tracks.some((t) => t.lang === l.code));
  $: models = (tick, ctl?.models ?? []);
  $: pickedModel = (tick, ctl?.model ?? '');
  $: trials = (tick, ctl?.trials ?? []);
  $: benchmarking = (tick, ctl?.benchmarking ?? false);

  // Live: progress is the BROADCAST's, not the element's — the file may have
  // started downloading at any point, but the programme's clock is absolute.
  $: liveElapsed = live ? Math.min(liveOffset, liveDuration || liveOffset) : 0;
  $: progressPct = live
    ? (liveDuration > 0 ? (liveElapsed / liveDuration) * 100 : 0)
    : (duration > 0 ? (current / duration) * 100 : 0);
  $: bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;

  function clock(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
    return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
  }

  // ── Transport (no-ops in live mode, by design) ──────────────────
  function togglePlay(): void {
    if (!video || live) return;
    if (video.paused) void video.play(); else video.pause();
  }
  function seekTo(fraction: number): void {
    if (!video || live || !duration) return;
    video.currentTime = Math.max(0, Math.min(duration, fraction * duration));
  }
  function onScrub(e: MouseEvent): void {
    if (live) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width);
  }
  function nudge(by: number): void {
    if (!video || live) return;
    video.currentTime = Math.max(0, Math.min(duration || 0, video.currentTime + by));
  }
  function toggleMute(): void {
    if (!video) return;
    video.muted = !video.muted;
    muted = video.muted;
  }
  function setVolume(v: number): void {
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, v));
    volume = video.volume;
    if (volume > 0 && video.muted) { video.muted = false; muted = false; }
  }
  function setRate(r: number): void {
    if (!video) return;
    video.playbackRate = r;
    rate = r;
    menu = '';
  }
  async function toggleFullscreen(): Promise<void> {
    if (!shell) return;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    else await shell.requestFullscreen().catch(() => {});
  }

  function onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    switch (e.key) {
      case ' ': case 'k': if (!live) { e.preventDefault(); togglePlay(); } break;
      case 'ArrowLeft': if (!live) { e.preventDefault(); nudge(-5); } break;
      case 'ArrowRight': if (!live) { e.preventDefault(); nudge(5); } break;
      case 'm': toggleMute(); break;
      case 'f': void toggleFullscreen(); break;
      case 'c': if (ctl) ctl.toggle(); break;
    }
  }

  function wake(): void {
    idle = false;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (playing && !menu) idle = true; }, 2600);
  }

  async function run(fn: () => Promise<void>): Promise<void> {
    try { await fn(); } catch { /* the controller records the error */ }
  }
  function trackLabel(t: SubTrack): string { return t.label || t.lang.toUpperCase(); }

  onMount(() => {
    const onFs = () => { fullscreen = Boolean(document.fullscreenElement); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  });
  onDestroy(() => { if (hideTimer) clearTimeout(hideTimer); });
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
<div
  class="kp"
  class:idle
  class:live
  bind:this={shell}
  on:mousemove={wake}
  on:mouseleave={() => { if (playing) idle = true; }}
>
  <!-- svelte-ignore a11y-media-has-caption -->
  <video
    bind:this={video}
    {src}
    {poster}
    {autoplay}
    crossorigin={crossorigin}
    playsinline
    class="kp-video"
    on:click={togglePlay}
    on:play={() => { playing = true; wake(); }}
    on:pause={() => { playing = false; idle = false; }}
    on:timeupdate={() => { if (video) current = video.currentTime; }}
    on:durationchange={() => { if (video) duration = video.duration || 0; }}
    on:volumechange={() => { if (video) { volume = video.volume; muted = video.muted; } }}
    on:progress={() => {
      if (video && video.buffered.length) buffered = video.buffered.end(video.buffered.length - 1);
    }}
  ></video>

  <!-- Big centre affordance, on demand only. -->
  {#if !live && !playing}
    <button class="kp-big" on:click={togglePlay} aria-label="Play">▶</button>
  {/if}

  <!-- Caption overlay: our own render of the hidden track's active cues. -->
  {#if cueText && showing}
    <div class="kp-caps" class:top={caption.position === 'top'}>
      <div class="kp-caps-box" style={capStyle}>
        {#each cueText.split('\n') as line}
          <div class="kp-caps-line">{line}</div>
        {/each}
      </div>
    </div>
  {/if}

  <slot name="overlay" />

  <div class="kp-bar">
    <!-- Progress. Live is READ-ONLY: a broadcast can't be scrubbed. -->
    <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
    <div class="kp-seek" class:ro={live} on:click={onScrub}>
      {#if !live}<span class="kp-buf" style="width:{bufferedPct}%"></span>{/if}
      <span class="kp-fill" style="width:{progressPct}%"></span>
      {#if !live}<span class="kp-knob" style="left:{progressPct}%"></span>{/if}
    </div>

    <div class="kp-row">
      {#if live}
        <span class="kp-live"><span class="kp-dot"></span>LIVE</span>
      {:else}
        <button class="kp-btn" on:click={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
      {/if}

      <span class="kp-time">
        {#if live}
          {clock(liveElapsed)} <em>/ {clock(liveDuration)}</em>
        {:else}
          {clock(current)} <em>/ {clock(duration)}</em>
        {/if}
      </span>

      <button class="kp-btn" on:click={toggleMute} aria-label="Mute">
        {muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
      </button>
      <input
        class="kp-vol" type="range" min="0" max="1" step="0.02"
        value={muted ? 0 : volume}
        on:input={(e) => setVolume(+(e.currentTarget).value)}
        aria-label="Volume"
      />

      <span class="kp-grow"></span>

      {#if subsRunning}
        <span class="kp-job" title={job?.hint ?? ''}>
          <span class="kp-spin"></span>{phaseLabel(job?.phase ?? '')} {subsPct}%
        </span>
      {/if}

      {#if ctl}
        <button
          class="kp-btn kp-cc" class:on={showing}
          on:click={() => (menu = menu === 'cc' ? '' : 'cc')}
          aria-label="Subtitles"
        >
          CC{#if showing && activeTrack}<em>{activeTrack.lang.toUpperCase()}</em>{/if}
        </button>
      {/if}

      {#if ctl}
        <button class="kp-btn" title="Subtitle style" on:click={() => (menu = menu === 'style' ? '' : 'style')}>
          Aa
        </button>
      {/if}

      {#if !live && speeds.length > 0}
        <button class="kp-btn kp-rate" on:click={() => (menu = menu === 'speed' ? '' : 'speed')}>
          {rate}×
        </button>
      {/if}

      <slot name="actions" />

      <button class="kp-btn" on:click={toggleFullscreen} aria-label="Fullscreen">
        {fullscreen ? '⤡' : '⤢'}
      </button>
    </div>

    {#if menu === 'speed'}
      <div class="kp-menu kp-menu-right">
        {#each speeds as sp (sp)}
          <button class="kp-item" class:sel={rate === sp} on:click={() => setRate(sp)}>{sp}×</button>
        {/each}
      </div>
    {/if}

    {#if menu === 'style'}
      <div class="kp-menu kp-menu-right">
        <div class="kp-menu-head">Subtitle style</div>

        <label class="kp-srow">
          <span>Size</span>
          <input type="range" min="14" max="72" step="1"
                 value={caption.fontSize}
                 on:input={(e) => updateCaption({ fontSize: +(e.currentTarget).value })} />
          <em>{caption.fontSize}px</em>
        </label>

        <div class="kp-srow">
          <span>Font</span>
          <div class="kp-seg">
            {#each ['sans', 'serif', 'mono'] as f (f)}
              <button class:on={caption.fontFamily === f}
                      on:click={() => updateCaption({ fontFamily: f })}>{f}</button>
            {/each}
          </div>
        </div>

        <label class="kp-srow">
          <span>Colour</span>
          <input type="color" value={caption.textColor}
                 on:input={(e) => updateCaption({ textColor: (e.currentTarget).value })} />
          <em>{caption.textColor}</em>
        </label>

        <label class="kp-srow">
          <span>Backdrop</span>
          <input type="range" min="0" max="1" step="0.05"
                 value={caption.bgOpacity}
                 on:input={(e) => updateCaption({ bgOpacity: +(e.currentTarget).value })} />
          <em>{Math.round(caption.bgOpacity * 100)}%</em>
        </label>

        <div class="kp-srow">
          <span>Edge</span>
          <div class="kp-seg">
            {#each ['none', 'outline', 'shadow'] as ed (ed)}
              <button class:on={caption.edge === ed}
                      on:click={() => updateCaption({ edge: ed })}>{ed}</button>
            {/each}
          </div>
        </div>

        <div class="kp-srow">
          <span>Position</span>
          <div class="kp-seg">
            {#each ['bottom', 'top'] as pos (pos)}
              <button class:on={caption.position === pos}
                      on:click={() => updateCaption({ position: pos })}>{pos}</button>
            {/each}
          </div>
        </div>
      </div>
    {/if}

    {#if menu === 'cc' && ctl}
      <div class="kp-menu kp-menu-right kp-cc-menu">
        <div class="kp-menu-head">Subtitles</div>

        {#if subsRunning && job}
          <div class="kp-menu-job">
            <div class="kp-menu-job-top">
              <span>{phaseLabel(job.phase)}</span><span class="kp-grow"></span><span>{subsPct}%</span>
              <button class="kp-x" title="Cancel" on:click={() => run(() => ctl.cancel())}>✕</button>
            </div>
            <div class="kp-menu-track"><span style="width:{Math.max(3, subsPct)}%"></span></div>
            {#if job.hint}<p class="kp-hint">{job.hint}</p>{/if}
          </div>
        {/if}

        {#if tracks.length > 0}
          <button class="kp-item" class:sel={!showing} on:click={() => ctl.off()}>Off</button>
          {#each tracks as t (t.id)}
            <div class="kp-item-row">
              <button class="kp-item" class:sel={showing && activeTrack?.id === t.id} on:click={() => run(() => ctl.show(t))}>
                {trackLabel(t)}
                {#if t.createdAt}<em>{relativeAge(t.createdAt)}</em>{/if}
              </button>
              {#if allowManage}
                <button class="kp-x" title="Delete" on:click={() => run(() => ctl.remove(t))}>🗑</button>
              {/if}
            </div>
          {/each}
        {/if}

        {#if !subsRunning}
          {#if tracks.length === 0}
            <button class="kp-item kp-primary" on:click={() => run(() => ctl.generate())}>
              {subsFailed ? 'Retry subtitles' : '✦ Generate subtitles'}
            </button>
          {:else if allowTranslate && offerable.length > 0}
            <div class="kp-menu-head kp-sub">Translate to</div>
            {#if models.length > 1}
              <button class="kp-item kp-bench" disabled={benchmarking}
                      on:click={() => run(() => ctl.benchmark())}>
                {benchmarking ? 'Testing models…' : '🧪 Find the best model'}
              </button>
            {/if}
            {#if trials.length > 0}
              <div class="kp-trials">
                {#each trials as t, i (t.model)}
                  <div class="kp-trial" class:win={i === 0 && t.score > 0}>
                    <span class="kp-trial-m">{t.model}</span>
                    <span class="kp-trial-s">{t.score > 0 ? t.score.toFixed(2) : '—'}</span>
                    <em>{t.note}</em>
                  </div>
                {/each}
              </div>
            {/if}
            {#if models.length > 0}
              <!-- Which model does the translating. Small/fast models handle
                   subtitle batches as well as frontier ones, far cheaper. -->
              <select
                class="kp-model"
                value={pickedModel}
                on:change={(e) => ctl.setModel((e.currentTarget).value)}
              >
                <option value="">Default model</option>
                {#each models as m (m.provider + ':' + m.id)}
                  <option value={m.id}>{m.label}{m.provider ? ` (${m.provider})` : ''}</option>
                {/each}
              </select>
            {/if}
            <div class="kp-langs">
              {#each offerable as l (l.code)}
                <button class="kp-lang" on:click={() => run(() => ctl.translate(l.code, activeTrack?.lang))}>
                  {l.name}
                </button>
              {/each}
            </div>
          {/if}
          {#if subsFailed && job?.error}<p class="kp-err">{job.error}</p>{/if}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .kp { position:relative; width:100%; height:100%; background:#000; overflow:hidden; }
  .kp-video { width:100%; height:100%; display:block; object-fit:contain; background:#000; cursor:pointer }
  .kp.live .kp-video { cursor:default }

  .kp-big {
    position:absolute; inset:0; margin:auto; width:64px; height:64px; border-radius:50%;
    background:rgba(8,9,13,.7); border:1px solid rgba(255,255,255,.18); color:#fff;
    font-size:22px; cursor:pointer; backdrop-filter:blur(6px);
  }
  .kp-big:hover { border-color:#F0B429; color:#F0B429 }

  /* ── Control bar ────────────────────────────────────────────── */
  .kp-bar {
    position:absolute; left:0; right:0; bottom:0; z-index:6; padding:0 10px 8px;
    background:linear-gradient(to top, rgba(4,5,8,.92) 0%, rgba(4,5,8,.65) 55%, transparent 100%);
    transition:opacity .25s ease, transform .25s ease;
    font-family:var(--font-mono, ui-monospace);
  }
  .kp.idle .kp-bar { opacity:0; transform:translateY(8px); pointer-events:none }

  .kp-seek { position:relative; height:4px; border-radius:3px; background:rgba(255,255,255,.18); cursor:pointer; margin-bottom:7px }
  .kp-seek.ro { cursor:default }
  .kp-buf { position:absolute; inset:0 auto 0 0; background:rgba(255,255,255,.22); border-radius:3px }
  .kp-fill {
    position:absolute; inset:0 auto 0 0; border-radius:3px;
    background:linear-gradient(90deg, #C98A1E, #F0B429); box-shadow:0 0 8px rgba(240,180,41,.5);
  }
  .kp-knob {
    position:absolute; top:50%; width:11px; height:11px; margin-left:-5.5px; border-radius:50%;
    background:#F0B429; transform:translateY(-50%) scale(0); transition:transform .15s ease;
  }
  .kp-seek:hover .kp-knob { transform:translateY(-50%) scale(1) }

  .kp-row { display:flex; align-items:center; gap:8px; color:#E0E2EA }
  .kp-grow { flex:1 }
  .kp-btn {
    background:none; border:0; color:#E0E2EA; cursor:pointer; line-height:1;
    padding:5px 7px; border-radius:5px; font-size:12px; font-family:inherit;
  }
  .kp-btn:hover { background:rgba(255,255,255,.12); color:#F0B429 }
  .kp-cc { font-size:10px; font-weight:700; letter-spacing:.1em; display:inline-flex; gap:4px; align-items:center }
  .kp-cc.on { color:#F0B429; box-shadow:inset 0 0 0 1px rgba(240,180,41,.5) }
  .kp-cc em, .kp-time em { font-style:normal; opacity:.6 }
  .kp-rate { font-size:10px; font-weight:700 }

  .kp-time { font-size:11px; font-variant-numeric:tabular-nums; opacity:.9; white-space:nowrap }
  .kp-live {
    display:inline-flex; align-items:center; gap:5px; font-size:10px; font-weight:700;
    letter-spacing:.18em; color:#FF6B62; padding:0 2px;
  }
  .kp-dot { width:6px; height:6px; border-radius:50%; background:#FF3B30; animation:kp-pulse 2s ease-out infinite }
  @keyframes kp-pulse { 0%,100% { box-shadow:0 0 0 0 rgba(255,59,48,.6) } 55% { box-shadow:0 0 0 5px rgba(255,59,48,0) } }

  .kp-vol { width:70px; accent-color:#F0B429; cursor:pointer }

  .kp-job {
    display:inline-flex; align-items:center; gap:6px; font-size:9.5px; font-weight:600;
    letter-spacing:.1em; text-transform:uppercase; color:#F0B429; white-space:nowrap;
  }
  .kp-spin {
    width:8px; height:8px; border-radius:50%;
    border:1.5px solid rgba(240,180,41,.25); border-top-color:#F0B429;
    animation:kp-spin .8s linear infinite;
  }
  @keyframes kp-spin { to { transform:rotate(360deg) } }

  /* ── Menus ──────────────────────────────────────────────────── */
  .kp-menu {
    position:absolute; bottom:52px; min-width:190px; max-height:min(58vh,340px); overflow-y:auto;
    padding:7px; border-radius:9px;
    background:rgba(10,11,16,.95); backdrop-filter:blur(14px);
    border:1px solid rgba(255,255,255,.12); box-shadow:0 18px 44px -18px #000;
  }
  .kp-menu-right { right:10px }
  .kp-menu-head {
    font-size:9px; font-weight:700; letter-spacing:.2em; text-transform:uppercase;
    color:#8A8FA8; padding:4px 6px 6px;
  }
  .kp-sub { border-top:1px solid rgba(255,255,255,.08); margin-top:5px; padding-top:8px }
  .kp-item-row { display:flex; align-items:center; gap:3px }
  .kp-item {
    flex:1; display:block; width:100%; text-align:left; padding:6px 8px; border-radius:5px;
    background:none; border:0; color:#E0E2EA; cursor:pointer;
    font-family:var(--font-body, system-ui); font-size:12px;
  }
  .kp-item:hover { background:rgba(255,255,255,.08) }
  .kp-item.sel { background:rgba(240,180,41,.15); color:#F0B429 }
  .kp-item em { font-style:normal; font-size:9.5px; color:#4A4F6A; margin-left:6px }
  .kp-primary { background:#F0B429; color:#0B0C10; text-align:center; font-weight:700 }
  .kp-primary:hover { background:#F0B429; filter:brightness(1.1) }
  .kp-x { background:none; border:0; color:#4A4F6A; cursor:pointer; font-size:11px; padding:3px 5px; border-radius:4px }
  .kp-x:hover { color:#F04770 }

  .kp-model {
    width:calc(100% - 8px); margin:0 4px 7px; padding:5px 7px; border-radius:5px;
    background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.14); color:#E0E2EA;
    font-family:var(--font-body, system-ui); font-size:11px; cursor:pointer;
  }
  .kp-model:focus { outline:none; border-color:#F0B429 }
  .kp-bench { text-align:center; border:1px dashed rgba(255,255,255,.18); margin-bottom:6px }
  .kp-bench:disabled { opacity:.6; cursor:default }
  .kp-trials { padding:0 4px 6px; display:flex; flex-direction:column; gap:3px }
  .kp-trial {
    display:grid; grid-template-columns:1fr auto; gap:4px 8px; align-items:baseline;
    padding:4px 6px; border-radius:4px; background:rgba(255,255,255,.03);
    font-family:var(--font-body, system-ui); font-size:11px; color:#8A8FA8;
  }
  .kp-trial.win { background:rgba(240,180,41,.14); color:#F0B429 }
  .kp-trial-m { overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .kp-trial-s { font-family:var(--font-mono, ui-monospace); font-weight:700; font-variant-numeric:tabular-nums }
  .kp-trial em { grid-column:1 / -1; font-style:normal; font-size:9.5px; color:#4A4F6A }
  .kp-langs { display:flex; flex-wrap:wrap; gap:4px; padding:0 4px 4px }
  .kp-lang {
    font-family:var(--font-body, system-ui); font-size:11px; padding:4px 9px; border-radius:999px;
    background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); color:#8A8FA8; cursor:pointer;
  }
  .kp-lang:hover { border-color:#F0B429; color:#F0B429 }

  .kp-menu-job { padding:6px; border-radius:6px; background:rgba(255,255,255,.05); margin-bottom:6px }
  .kp-menu-job-top { display:flex; align-items:center; gap:6px; font-size:9.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:#F0B429 }
  .kp-menu-track { height:3px; border-radius:2px; background:rgba(255,255,255,.12); overflow:hidden; margin-top:5px }
  .kp-menu-track span { display:block; height:100%; background:linear-gradient(90deg,#C98A1E,#F0B429); transition:width .6s ease }
  .kp-hint { font-size:9.5px; color:#8A8FA8; margin-top:5px }
  .kp-err { font-family:var(--font-body, system-ui); font-size:10.5px; color:#F04770; padding:4px 6px; line-height:1.4 }

  /* ── Caption overlay (we paint it, so it can be styled) ─────── */
  .kp-caps {
    position:absolute; left:0; right:0; bottom:14%; z-index:5;
    display:flex; justify-content:center; align-items:flex-end;
    padding:0 8%; pointer-events:none;
  }
  .kp-caps.top { bottom:auto; top:6%; align-items:flex-start }
  .kp-caps-box {
    display:inline-block; max-width:100%; text-align:center;
    line-height:1.25; font-weight:500; padding:.15em .65em;
  }
  .kp-caps-line { display:block }

  /* ── Style panel ────────────────────────────────────────────── */
  .kp-srow {
    display:flex; align-items:center; gap:8px; padding:5px 6px;
    font-family:var(--font-body, system-ui); font-size:11.5px; color:#E0E2EA;
  }
  .kp-srow > span { flex:0 0 62px; color:#8A8FA8; font-size:10.5px }
  .kp-srow input[type="range"] { flex:1; accent-color:#F0B429; cursor:pointer; min-width:0 }
  .kp-srow input[type="color"] { width:30px; height:20px; padding:0; border:0; background:none; cursor:pointer }
  .kp-srow em {
    font-style:normal; font-family:var(--font-mono, ui-monospace); font-size:9.5px;
    color:#4A4F6A; min-width:3.4em; text-align:right;
  }
  .kp-seg { display:flex; gap:3px; flex:1 }
  .kp-seg button {
    flex:1; padding:4px 6px; border-radius:4px; cursor:pointer;
    background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12);
    color:#8A8FA8; font-family:inherit; font-size:10.5px;
  }
  .kp-seg button:hover { border-color:#F0B429; color:#F0B429 }
  .kp-seg button.on { background:rgba(240,180,41,.15); border-color:#F0B429; color:#F0B429 }
</style>
