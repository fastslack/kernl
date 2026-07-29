<!--
  PerfOverlay — drop-in benchmark HUD for the 3D scene.

  Usage:
    <PerfOverlay {renderer} extra={{ agents: 69, walkers: 0 }} />

  Toggle with `Shift+P`. Shows rolling FPS, 1% low, frame ms, draw calls,
  triangles, geometries, textures and any extra counters the parent passes in.
  The "snapshot" button copies a labelled metrics blob to the clipboard so
  before/after runs are easy to paste back in chat.
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  /**
   * The parent feeds `stats` from its OWN render loop instead of the overlay
   * polling. That avoids two issues: (a) headless chrome throttling RAF on
   * inactive tabs, and (b) the overlay reading renderer.info AFTER post-
   * process passes (which would zero out main-scene draws).
   */
  export let stats: {
    fps: number;
    avgMs: number;
    p99Ms: number;
    calls: number;
    tris: number;
    geom: number;
    tex: number;
  } = { fps: 0, avgMs: 0, p99Ms: 0, calls: 0, tris: 0, geom: 0, tex: 0 };
  export let extra: Record<string, number | string> = {};
  // Hidden by default — the parent drives this through the unified hq-bar
  // toggle. Shift+P still works as a power-user shortcut once shown.
  export let visible = false;
  export let label = 'baseline';

  let copied = false;
  $: ({ fps, avgMs, p99Ms, calls, tris, geom, tex } = stats);

  function pad(s: string | number, n: number): string {
    return String(s).padStart(n);
  }

  function fmtTris(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }

  function snapshot() {
    const lines: string[] = [
      `─── ${label} @ ${new Date().toISOString()} ───`,
      `fps        ${fps.toFixed(1)}`,
      `1% low     ${(1000 / Math.max(p99Ms, 0.01)).toFixed(1)}  (worst frame ${p99Ms.toFixed(1)}ms)`,
      `frame avg  ${avgMs.toFixed(2)}ms`,
      `draws      ${calls.toLocaleString()}`,
      `tris       ${fmtTris(tris)}`,
      `geometries ${geom}`,
      `textures   ${tex}`,
    ];
    for (const [k, v] of Object.entries(extra)) lines.push(`${k.padEnd(10)} ${v}`);
    const out = lines.join('\n');
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(out).then(() => {
        copied = true;
        setTimeout(() => (copied = false), 1500);
      }).catch(() => {});
    }
    console.log('[perf-snapshot]\n' + out);
  }

  function onKey(e: KeyboardEvent) {
    if (e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      visible = !visible;
      e.preventDefault();
    }
  }

  onMount(() => {
    if (typeof document !== 'undefined') document.addEventListener('keydown', onKey);
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey);
  });
</script>

{#if visible}
  <div class="perf">
    <div class="perf-head">
      <span class="lbl">perf · {label}</span>
      <button class="snap" on:click={snapshot} title="copy metrics to clipboard (Shift+P toggles)">
        {copied ? '✓ copied' : '⧉ snap'}
      </button>
      <button class="hide" on:click={() => (visible = false)} title="Shift+P to reopen">×</button>
    </div>
    <pre class="grid">
fps      <span class={fps >= 55 ? 'g' : fps >= 30 ? 'a' : 'r'}>{pad(fps.toFixed(1), 7)}</span>
1% low   <span class={1000/p99Ms >= 30 ? 'g' : 1000/p99Ms >= 20 ? 'a' : 'r'}>{pad((1000 / Math.max(p99Ms, 0.01)).toFixed(1), 7)}</span>
frame    <span class={avgMs <= 18 ? 'g' : avgMs <= 33 ? 'a' : 'r'}>{pad(avgMs.toFixed(1) + 'ms', 7)}</span>
worst    <span class={p99Ms <= 33 ? 'g' : p99Ms <= 50 ? 'a' : 'r'}>{pad(p99Ms.toFixed(1) + 'ms', 7)}</span>
draws    {pad(calls.toLocaleString(), 7)}
tris     {pad(fmtTris(tris), 7)}
geom     {pad(geom, 7)}
tex      {pad(tex, 7)}{#each Object.entries(extra) as [k, v]}
{k.padEnd(8)} {pad(String(v), 7)}{/each}</pre>
  </div>
{/if}

<style>
  .perf {
    position: fixed;
    top: 80px;
    right: 16px;
    z-index: 200;
    background: rgba(5, 10, 7, 0.92);
    border: 1px solid #1f8048;
    box-shadow: 0 0 18px rgba(51, 255, 119, 0.25);
    padding: 4px 8px 6px;
    font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 11px;
    color: #33ff77;
    min-width: 180px;
    pointer-events: auto;
  }
  .perf-head {
    display: flex;
    align-items: center;
    gap: 6px;
    border-bottom: 1px dashed #1a3320;
    padding-bottom: 3px;
    margin-bottom: 4px;
  }
  .lbl { color: #ffb000; font-weight: 700; flex: 1; }
  .snap, .hide {
    background: #0a1410;
    border: 1px solid #1a3320;
    color: #4ddbff;
    padding: 1px 6px;
    cursor: pointer;
    font: inherit;
    font-size: 10px;
    border-radius: 2px;
  }
  .snap:hover, .hide:hover { border-color: #ffb000; color: #ffb000; }
  .grid {
    margin: 0;
    line-height: 1.35;
    white-space: pre;
  }
  .g { color: #33ff77; }
  .a { color: #ffb000; }
  .r { color: #ff3850; text-shadow: 0 0 6px rgba(255, 56, 80, 0.5); }
</style>
