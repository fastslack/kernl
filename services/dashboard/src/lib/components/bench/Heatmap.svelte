<script lang="ts">
  /**
   * Models × categories: which model is good at what. The number is always
   * written in the cell; the color band only helps the eye. A category the
   * provider cannot run reads "n/a"; one it has not reached yet, "…".
   */
  import { t } from '$lib/i18n';
  import { CATEGORIES, SCORE_COLORS, scoreBand, scoreTint, shortModel, type ModelRow } from './model.js';

  export let models: ModelRow[];
  export let colors: Record<string, string>;

  const TOOL_CATS = new Set(['tools', 'agent']);
  const label = (m: ModelRow, c: string) => (!m.supportsTools && TOOL_CATS.has(c) ? 'n/a' : '…');
</script>

<div class="hm" style="--cols:{CATEGORIES.length}">
  <span></span>
  {#each CATEGORIES as c (c)}<span class="h" title={$t(`bench.cat.${c}.hint`)}>{$t(`bench.cat.${c}`)}</span>{/each}
  {#each models as m (m.key)}
    <span class="name" title="{m.name} · {m.model}"><i style="background:{colors[m.key]};color:{colors[m.key]}"></i>{shortModel(m.model)}</span>
    {#each CATEGORIES as c (c)}
      {@const v = m.categories[c]}
      <span class="cell num" class:empty={v === null} style="background:{scoreTint(v)};--edge:{scoreBand(v)}"
        title={v === null ? '' : `${$t(`bench.cat.${c}`)}: ${Math.round(v)} / 100`}>{v === null ? label(m, c) : Math.round(v)}</span>
    {/each}
  {/each}
</div>
<div class="legend" aria-hidden="true">
  <span>0</span>{#each SCORE_COLORS as c (c)}<i style="background:{c}"></i>{/each}<span>100</span>
</div>

<style>
  .hm { display: grid; grid-template-columns: minmax(96px, 1.5fr) repeat(var(--cols), minmax(36px, 1fr)); gap: 4px; font-size: 12.5px; }
  .h { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--text-1); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name i { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 8px currentColor; }
  .cell { text-align: center; padding: 6px 0; border-radius: 6px; font-weight: 700; color: #fff; border-bottom: 2px solid var(--edge); transition: transform .15s var(--ease-out, ease-out); }
  .cell:hover { transform: translateY(-1px); }
  .cell.empty { color: var(--text-3); font-weight: 500; background: var(--surface-2) !important; border-bottom-color: transparent; }
  .legend { display: flex; align-items: center; gap: 3px; margin-top: 6px; font-size: 10px; color: var(--text-3); justify-content: flex-end; }
  .legend i { width: 18px; height: 6px; border-radius: 3px; }
  .num { font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) { .cell { transition: none; } .cell:hover { transform: none; } }
</style>
