<script lang="ts">
  /**
   * Parts of one whole: a ring with a 2px surface gap between slices, the
   * headline number in the middle, and a legend that names every slice with
   * its count and share — the slices never speak by color alone.
   */
  export let parts: Array<{ label: string; value: number; color: string }>;
  export let center: string;
  export let centerLabel: string;
  export let ariaLabel: string;

  const R = 46, SW = 14, C = 2 * Math.PI * R;
  $: total = parts.reduce((a, p) => a + p.value, 0);
  $: arcs = (() => {
    let acc = 0;
    return parts.filter((p) => p.value > 0).map((p) => {
      const len = (p.value / Math.max(1, total)) * C;
      const gap = parts.filter((x) => x.value > 0).length > 1 ? Math.min(2, len / 2) : 0;
      const a = { ...p, dash: `${Math.max(0, len - gap)} ${C}`, offset: -acc };
      acc += len;
      return a;
    });
  })();
  const pct = (v: number) => (total ? Math.round((v / total) * 1000) / 10 : 0);
</script>

<div class="dn">
  <div class="ringbox">
    <svg viewBox="0 0 120 120" role="img" aria-label={ariaLabel}>
      <circle cx="60" cy="60" r={R} fill="none" stroke="color-mix(in srgb, var(--text-3) 14%, transparent)" stroke-width={SW} />
      {#each arcs as a (a.label)}
        <circle cx="60" cy="60" r={R} fill="none" stroke={a.color} stroke-width={SW} stroke-dasharray={a.dash} stroke-dashoffset={a.offset}
                transform="rotate(-90 60 60)"><title>{a.label}: {a.value} ({pct(a.value)} %)</title></circle>
      {/each}
    </svg>
    <div class="mid"><b>{center}</b><span>{centerLabel}</span></div>
  </div>
  <ul class="lg">
    {#each parts as p (p.label)}
      <li><i style="background:{p.color}"></i><span class="l">{p.label}</span><span class="v">{p.value.toLocaleString()}</span><span class="pc">{pct(p.value)} %</span></li>
    {/each}
  </ul>
</div>

<style>
  .dn { display: flex; align-items: center; gap: 16px; }
  .ringbox { position: relative; width: 120px; height: 120px; flex: none; }
  svg { width: 120px; height: 120px; }
  .mid { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
  .mid b { font-size: 20px; font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .mid span { font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3); font-weight: 700; }
  .lg { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
  .lg li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; gap: 8px; align-items: center; font-size: 12.5px; }
  .lg i { width: 10px; height: 10px; border-radius: 3px; }
  .l { color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .v { color: var(--text-1); font-weight: 700; font-variant-numeric: tabular-nums; }
  .pc { color: var(--text-3); font-variant-numeric: tabular-nums; min-width: 46px; text-align: right; }
</style>
