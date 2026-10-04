<script lang="ts">
  // The download, the checksum and the unpack all finish before the kernel
  // exits, so the progress has something real to show for the part of the
  // wait that is actually long. Determinate only when the server sent a
  // content-length, because an invented percentage is worse than an honest
  // spinner.
  //
  // Two looks over one store: `bar` sits in the shell's update strip and is
  // styled globally (app.css, `.update-bar-*`); `card` sits in the About card
  // of Settings and carries its own styles below.
  import { updating, updateProgress } from '$lib/update.js';

  export let variant: 'bar' | 'card';
</script>

{#if $updating && $updateProgress}
  {@const p = $updateProgress}
  {@const pct = p.total > 0 ? Math.round((p.received / p.total) * 100) : null}
  <div class:update-bar-progress={variant === 'bar'} class:upd-progress={variant === 'card'}>
    <div
      class:update-bar-track={variant === 'bar'}
      class:upd-bar={variant === 'card'}
      class:indeterminate={pct === null}
    >
      <span style={pct === null ? '' : `width:${pct}%`}></span>
    </div>
    <span class:update-bar-phase={variant === 'bar'} class:upd-phase={variant === 'card'}>
      {p.phase === 'downloading'
        ? (pct === null
            ? `${(p.received / 1048576).toFixed(1)} MB`
            : `${pct}% · ${(p.received / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} MB`)
        : p.phase}
    </span>
  </div>
{/if}

<style>
  /* Update progress. Indeterminate when the server sends no content-length —
     a sliding band rather than a percentage nobody can stand behind. */
  .upd-progress { display: flex; align-items: center; gap: .5rem; width: 100%; margin-top: .5rem; }
  .upd-bar { position: relative; flex: 1; height: 6px; border-radius: 999px;
             background: rgba(255, 255, 255, .12); overflow: hidden; }
  .upd-bar > span { display: block; height: 100%; border-radius: 999px;
                    background: #6366f1; transition: width 200ms ease; }
  .upd-bar.indeterminate > span { width: 35%; animation: upd-slide 1.1s ease-in-out infinite; }
  @keyframes upd-slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
  }
  .upd-phase { font-size: .75rem; opacity: .75; white-space: nowrap;
               font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) {
    .upd-bar.indeterminate > span { animation: none; width: 100%; opacity: .5; }
  }
</style>
