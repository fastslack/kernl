<script lang="ts">
  /**
   * One value per day as bars — a single series, so the title names it and
   * there is no legend. Hovering a day (the whole column is the target, wider
   * than the bar) shows its exact numbers. Days with no data still get their
   * slot, so gaps read as quiet days rather than missing ones.
   */
  import { locale } from '$lib/i18n';

  export let days: Array<{ day: string; value: number; extra?: string }>;
  export let color: string;
  export let label: (v: number) => string;
  export let ariaLabel: string;

  const W = 640, H = 120, L = 34, R = 6, T = 8, B = 18;
  let hover = -1;
  $: max = Math.max(1, ...days.map((d) => d.value));
  $: nice = niceMax(max);
  $: n = days.length;
  $: slot = n ? (W - L - R) / n : 0;
  $: bw = Math.max(2, slot - 3);
  const y = (v: number, top: number) => T + (1 - v / top) * (H - T - B);
  function niceMax(v: number): number {
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  $: fmtDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString($locale, { day: '2-digit', month: '2-digit' });
  $: nf = new Intl.NumberFormat($locale);
</script>

<div class="wrap">
  <svg viewBox="0 0 {W} {H}" role="img" aria-label={ariaLabel} on:mouseleave={() => (hover = -1)}>
    {#each [0, 0.5, 1] as f (f)}
      <line x1={L} x2={W - R} y1={y(nice * f, nice)} y2={y(nice * f, nice)} class="grid" />
      <text x={L - 6} y={y(nice * f, nice) + 3} class="ax" text-anchor="end">{nf.format(nice * f)}</text>
    {/each}
    {#each days as d, i (d.day)}
      {@const h = (d.value / nice) * (H - T - B)}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <g on:mouseenter={() => (hover = i)}>
        <rect x={L + i * slot} y={T} width={slot} height={H - T - B} fill="transparent" />
        {#if d.value > 0}
          <path d="M{L + i * slot + (slot - bw) / 2},{H - B} v{-Math.max(0, h - 2)} q0,-2 2,-2 h{bw - 4} q2,0 2,2 v{Math.max(0, h - 2)} z"
                fill={color} opacity={hover === -1 || hover === i ? 1 : 0.45} />
        {/if}
      </g>
      {#if i % Math.ceil(n / 6) === 0 || i === n - 1}
        <text x={L + i * slot + slot / 2} y={H - 5} class="ax" text-anchor="middle">{fmtDay(d.day)}</text>
      {/if}
    {/each}
  </svg>
  {#if hover >= 0 && days[hover]}
    {@const d = days[hover]}
    <div class="tip" style="left:{((L + hover * slot + slot / 2) / W) * 100}%">
      <b>{fmtDay(d.day)}</b><span>{label(d.value)}</span>{#if d.extra}<span class="ex">{d.extra}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  svg { width: 100%; height: 120px; display: block; }
  .grid { stroke: var(--border); stroke-width: 1; }
  .ax { font-size: 9.5px; fill: var(--text-3); font-variant-numeric: tabular-nums; }
  .tip {
    position: absolute; top: 2px; transform: translateX(-50%); pointer-events: none; z-index: 2;
    display: flex; flex-direction: column; gap: 1px; padding: 6px 9px; border-radius: 8px; white-space: nowrap;
    background: var(--surface-3); border: 1px solid var(--border-h); box-shadow: 0 8px 18px rgba(0, 0, 0, .45);
    font-size: 11.5px; color: var(--text-1); font-variant-numeric: tabular-nums;
  }
  .tip .ex { color: var(--text-2); }
</style>
