<script lang="ts">
  /**
   * Every task × every model, as the mean of its attempts (0–100). A row opens
   * to the attempts themselves: score, what the check saw, latency, the tool
   * calls and the raw answer — so any number on the screen can be audited.
   */
  import { t } from '$lib/i18n';
  import { rpcPost } from '$lib/api';
  import { CATEGORIES, scoreBand, scoreTint, secs, shortModel, type Attempt, type Category, type ModelRow, type Overview } from './model.js';

  export let tasks: Overview['tasks'];
  export let models: ModelRow[];
  export let runId: string;
  export let colors: Record<string, string>;

  let filter: Category | '' = '';
  let open = '';
  let attempts: Record<string, Attempt[] | 'loading' | 'error'> = {};

  $: shown = tasks.filter((x) => !filter || x.category === filter);
  // A new run: what was loaded belongs to the old one.
  $: runId, (attempts = {}), (open = '');

  async function toggle(id: string) {
    open = open === id ? '' : id;
    if (!open) return;
    for (const m of models) {
      const k = `${id}|${m.key}`;
      if (attempts[k]) continue;
      attempts = { ...attempts, [k]: 'loading' };
      try {
        const r = await rpcPost('bench.attempts', { run: runId, task: id, slug: m.slug, model: m.model });
        attempts = { ...attempts, [k]: (r ?? []) as Attempt[] };
      } catch { attempts = { ...attempts, [k]: 'error' }; }
    }
  }
  const cell = (m: ModelRow, id: string) => m.tasks[id];
</script>

<div class="tt">
  <div class="filters" role="group" aria-label={$t('bench.tasks.filter')}>
    <button type="button" class:on={!filter} on:click={() => (filter = '')}>{$t('bench.tasks.all')}</button>
    {#each CATEGORIES as c (c)}<button type="button" class:on={filter === c} on:click={() => (filter = c)}>{$t(`bench.cat.${c}`)}</button>{/each}
  </div>
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th class="tl">{$t('bench.tasks.task')}</th>
          {#each models as m (m.key)}<th title="{m.name} · {m.model}"><i style="background:{colors[m.key]}"></i>{shortModel(m.model)}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each shown as task (task.id)}
          <tr class="row" class:open={open === task.id} on:click={() => toggle(task.id)}>
            <td class="tl"><button type="button" class="tbtn" aria-expanded={open === task.id}>
              <span class="chev">{open === task.id ? '▾' : '▸'}</span>{task.title}<span class="tid">{task.id}</span></button></td>
            {#each models as m (m.key)}
              {@const s = cell(m, task.id)}
              {@const v = s?.mean === null || s?.mean === undefined ? null : Math.round(s.mean * 100)}
              <td class="num c" style="background:{scoreTint(v)};--edge:{scoreBand(v)}" title={s && s.n > 1 ? `± ${Math.round(s.stdev * 100)}` : ''}>
                {#if !s}<span class="muted">{!m.supportsTools && task.needsTools ? 'n/a' : '…'}</span>{:else if s.status === 'na'}<span class="muted">n/a</span>{:else if s.status === 'provider_error'}<span class="err">{$t('bench.tasks.provErr')}</span>{:else}{v}{/if}
              </td>
            {/each}
          </tr>
          {#if open === task.id}
            <tr class="detail"><td colspan={models.length + 1}>
              <div class="att-grid" style="--n:{models.length}">
                {#each models as m (m.key)}
                  {@const a = attempts[`${task.id}|${m.key}`]}
                  <div class="att-col">
                    <div class="att-h"><i style="background:{colors[m.key]}"></i>{shortModel(m.model)}</div>
                    {#if a === 'loading' || a === undefined}<span class="muted">…</span>
                    {:else if a === 'error'}<span class="err">{$t('bench.tasks.loadFail')}</span>
                    {:else}
                      {#each a as at (at.attempt)}
                        <details class="att">
                          <summary>
                            <b class="num" style="background:{scoreTint(at.status === 'ok' ? at.score * 100 : null)}">{at.status === 'na' ? 'n/a' : at.status === 'provider_error' ? '!' : Math.round(at.score * 100)}</b>
                            <span>#{at.attempt}</span><span class="muted num">{secs(at.latency_ms)}</span>
                            {#if at.invalid}<span class="err">{at.invalid}</span>{/if}
                          </summary>
                          <p class="chk">{at.detail}</p>
                          {#if at.calls.length}<pre class="calls">{at.calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join('\n')}</pre>{/if}
                          {#if at.output}<pre class="out">{at.output}</pre>{/if}
                        </details>
                      {/each}
                    {/if}
                  </div>
                {/each}
              </div>
            </td></tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .tt { display: flex; flex-direction: column; gap: 6px; min-height: 0; height: 100%; }
  .filters { display: flex; flex-wrap: wrap; gap: 4px; }
  .filters button { font-size: 11px; padding: 3px 8px; border-radius: 10px; border: 1px solid var(--border); background: none; color: var(--text-2); cursor: pointer; }
  .filters button.on { background: var(--b-accent); color: #0b0d12; border-color: var(--b-accent); font-weight: 700; }
  .filters button:hover:not(.on) { border-color: var(--b-accent); color: var(--text-1); }
  .filters button:focus-visible, .tbtn:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .scroll { overflow: auto; min-height: 0; flex: 1; border: 1px solid var(--border); border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); font-size: 10.5px; font-weight: 600; color: var(--text-3); padding: 5px 6px; text-align: center; white-space: nowrap; }
  th i, .att-h i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; }
  .tl { text-align: left; }
  td { padding: 3px 6px; border-top: 1px solid var(--border); color: var(--text-1); }
  td.c { text-align: center; font-weight: 700; width: 72px; color: #fff; box-shadow: inset 0 -2px 0 var(--edge); }
  .row { cursor: pointer; }
  .row:hover td.tl { background: var(--surface-2); }
  .tbtn { all: unset; display: flex; align-items: baseline; gap: 6px; cursor: pointer; width: 100%; }
  .chev { color: var(--text-3); width: 10px; }
  .tid { color: var(--text-3); font-size: 10px; font-family: var(--font-mono); margin-left: auto; }
  .detail td { background: var(--surface-1); padding: 8px; }
  .att-grid { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 10px; }
  .att-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .att-h { font-size: 11px; font-weight: 600; color: var(--text-2); }
  .att summary { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11.5px; }
  .att summary b { min-width: 28px; text-align: center; border-radius: 4px; padding: 1px 4px; }
  .chk { margin: 4px 0; font-size: 11px; color: var(--text-2); }
  pre { margin: 4px 0; font-size: 10.5px; font-family: var(--font-mono); white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; background: var(--surface-2); padding: 6px; border-radius: 4px; color: var(--text-1); }
  .calls { color: var(--b-cyan); }
  .muted { color: var(--text-3); }
  .err { color: var(--orange); font-size: 11px; }
  .num { font-variant-numeric: tabular-nums; }
</style>
