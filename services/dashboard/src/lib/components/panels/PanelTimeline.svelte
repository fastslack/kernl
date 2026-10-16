<!-- src/lib/components/panels/PanelTimeline.svelte -->
<script lang="ts">
  import { locale } from '$lib/i18n/index.js';
  import { CYCLE, RED } from '$lib/panels/look.js';
  import Icon from '$lib/components/ui/Icon.svelte';
  export let items: Array<{ at: string; text: string }> = [];
  $: sorted = [...items].sort((a, b) => (a.at < b.at ? 1 : -1));
  $: en = $locale.startsWith('en');
  const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
  function ago(iso: string, english: boolean): string {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return iso;
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return english ? 'just now' : 'recién';
    const [n, u] = s < 3600 ? [Math.floor(s / 60), 'min'] : s < 86400 ? [Math.floor(s / 3600), 'h'] : [Math.floor(s / 86400), english ? 'd' : 'd'];
    return english ? `${n} ${u} ago` : `hace ${n} ${u}`;
  }
  // A failed audit line (✗) reads red; the rest walk the palette so neighbours never look alike.
  const hue = (text: string, i: number) => (text.startsWith('✗') ? RED : CYCLE[i % CYCLE.length]);
</script>

<ol class="ptl">
  {#each sorted as it, i (it.at + i)}
    <li style="--hue:{hue(it.text, i)}">
      <span class="ptl-dot" aria-hidden="true"></span>
      <div class="ptl-body">
        <span class="ptl-text">{it.text}</span>
        <time datetime={it.at} title={fmt(it.at)}><Icon name="clock" size={11} />{ago(it.at, en)}</time>
      </div>
    </li>
  {:else}
    <li class="ptl-empty"><Icon name="activity" size={22} /><span>{en ? 'Nothing has happened yet.' : 'Todavía no pasó nada.'}</span></li>
  {/each}
</ol>

<style>
  .ptl { list-style: none; margin: 0; padding: 4px 0 4px 6px; max-height: 62vh; overflow: auto; display: flex; flex-direction: column; gap: 6px; position: relative; }
  .ptl li:not(.ptl-empty) { position: relative; display: grid; grid-template-columns: 14px 1fr; gap: 10px; align-items: start; }
  .ptl li:not(.ptl-empty):not(:last-child)::after {
    content: ''; position: absolute; left: 6px; top: 16px; bottom: -10px; width: 2px; border-radius: 2px;
    background: linear-gradient(var(--hue), color-mix(in srgb, var(--hue) 10%, transparent));
  }
  .ptl-dot { width: 12px; height: 12px; margin-top: 9px; border-radius: 50%; background: var(--hue); box-shadow: 0 0 10px var(--hue); border: 2px solid var(--surface-1); }
  .ptl-body {
    display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 10px; min-width: 0;
    background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 11%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, var(--hue) 28%, var(--border));
    transition: transform .2s ease-out, border-color .2s, box-shadow .2s;
  }
  .ptl-body:hover { transform: translateX(2px); border-color: color-mix(in srgb, var(--hue) 55%, var(--border)); box-shadow: 0 10px 22px -16px var(--hue); }
  .ptl-text { flex: 1; min-width: 0; font: 600 12.5px/1.45 'Manrope', sans-serif; color: var(--text-1); overflow-wrap: anywhere; }
  .ptl time { flex: none; display: inline-flex; align-items: center; gap: 4px; font: 700 10.5px 'Manrope', sans-serif; color: var(--hue); white-space: nowrap; }
  .ptl-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 28px 0; color: var(--text-3); font: 500 12.5px 'Manrope', sans-serif; }
  .ptl-empty :global(svg) { color: #A78BFA; }
  @media (prefers-reduced-motion: reduce) { .ptl-body { transition: none; } .ptl-body:hover { transform: none; } }
</style>
