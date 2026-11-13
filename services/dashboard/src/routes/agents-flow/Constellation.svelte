<script lang="ts">
  /**
   * A3 · The constellation of lessons, beside the sky it draws over the
   * building (office3d/constellation.ts). Relate compares every lesson with
   * every other by embedding in one statement; the kernel places them by
   * meaning and names the groups. Pick a constellation to light it alone.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { apiFetch } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';

  export let world: any = null;
  const dispatch = createEventDispatcher<{ close: void }>();

  type Sky = {
    stars: Array<{ id: string; agent_id: string; type: string; content: string; confidence: number; active: boolean; uses: number; x: number; y: number; group: number }>;
    links: Array<{ a: string; b: string; s: number }>;
    groups: Array<{ id: number; name: string; size: number; x: number; y: number }>;
    query_ms: number | null; pairs: number; cypher: string; graph: boolean;
  };
  let sky: Sky | null = null;
  let loading = true;
  let error = '';
  let lit: number | null = null;
  let showQuery = false;
  let placeTimer: ReturnType<typeof setInterval> | null = null;

  function light(g: number | null): void {
    lit = g;
    world?.constellationHighlight?.(g);
  }

  onMount(async () => {
    try {
      sky = (await apiFetch('/api/agents/learnings/constellation')) as Sky;
      if (!sky.graph) { error = $t('lib.noGraph'); return; }
      const s = sky;
      const place = () => { if (!world?.constellationShow?.(s)) return false; world.constellationFocus?.(); return true; };
      if (!place()) {
        let tries = 0;
        placeTimer = setInterval(() => { if (place() || ++tries > 60) { if (placeTimer) clearInterval(placeTimer); placeTimer = null; } }, 1000);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });
  onDestroy(() => { if (placeTimer) clearInterval(placeTimer); world?.constellationClose?.(); });

  function close(): void { world?.constellationClose?.(); dispatch('close'); }
  const fmt = (v: number | null) => (v == null ? '—' : v < 10 ? v.toFixed(1) : Math.round(v).toString());
</script>

<aside class="sky" aria-label={$t('sky.title')}>
  <header>
    <span class="title"><span aria-hidden="true">✦</span> {$t('sky.title')}</span>
    <button class="icon" on:click={() => world?.constellationFocus?.()} aria-label={$t('sky.look')} title={$t('sky.look')}>🔭</button>
    <button class="icon" on:click={close} aria-label={$t('sky.close')} title={$t('sky.close')}>✕</button>
  </header>
  {#if loading}
    <p class="msg">{$t('sky.loading')}</p>
  {:else if error}
    <p class="msg err">{error}</p>
  {:else if sky && sky.stars.length === 0}
    <p class="msg">{$t('sky.none')}</p>
  {:else if sky}
    <p class="stats">{$t('sky.stats', { stars: sky.stars.length, links: sky.links.length, groups: sky.groups.length })}</p>
    <div class="groups" role="group">
      <button class:on={lit === null} on:click={() => light(null)} aria-pressed={lit === null}>{$t('sky.all')}</button>
      {#each sky.groups as g (g.id)}
        <button class:on={lit === g.id} on:click={() => light(lit === g.id ? null : g.id)} aria-pressed={lit === g.id}>{g.name || '·'} <b>{g.size}</b></button>
      {/each}
    </div>
    {#if lit !== null}
      <ul class="lessons">
        {#each sky.stars.filter((s) => s.group === lit).slice(0, 12) as s (s.id)}
          <li class={s.type} class:off={!s.active}>{s.content}</li>
        {/each}
      </ul>
    {/if}
    <p class="legend">{$t('sky.legend')}</p>
    <footer>
      <span>{$t('sky.engine', { pairs: sky.pairs, ms: fmt(sky.query_ms) })}</span>
      <button class="q" on:click={() => (showQuery = !showQuery)} aria-expanded={showQuery}>{$t('sky.query')}</button>
    </footer>
    {#if showQuery}<pre>{sky.cypher}</pre>{/if}
  {/if}
</aside>

<style>
  .sky {
    position: absolute; top: 12px; right: 12px; z-index: 41; max-height: calc(100% - 24px); overflow-y: auto;
    width: min(380px, calc(100% - 24px)); display: flex; flex-direction: column; gap: 10px;
    background: rgba(12, 8, 30, 0.88); backdrop-filter: blur(10px);
    border: 1px solid rgba(201, 168, 255, 0.3); border-radius: 14px;
    color: #e8e2f8; padding: 12px 14px; box-shadow: 0 10px 40px rgba(0,0,0,.45); font-size: 13px;
  }
  header { display: flex; align-items: center; gap: 6px; }
  .title { flex: 1; font-weight: 700; color: #cdb8ff; }
  button { cursor: pointer; font: inherit; color: inherit; }
  button:focus-visible { outline: 2px solid #cdb8ff; outline-offset: 2px; }
  .icon { background: none; border: none; font-size: 15px; }
  .msg { margin: 0; color: #a49cbc; }
  .msg.err { color: #ff8a8a; }
  .stats { margin: 0; font-weight: 600; }
  .groups { display: flex; flex-wrap: wrap; gap: 4px; }
  .groups button { background: rgba(201,168,255,.1); border: 1px solid rgba(201,168,255,.25); border-radius: 12px; padding: 2px 9px; font-size: 11px; }
  .groups button.on { background: rgba(201,168,255,.3); border-color: #cdb8ff; }
  .groups b { font: 600 10px 'JetBrains Mono', monospace; opacity: .8; }
  .lessons { margin: 0; padding: 0 0 0 4px; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .lessons li { padding-left: 8px; border-left: 3px solid #ffd36b; }
  .lessons li.avoid { border-color: #ff6b6b; }
  .lessons li.prefer { border-color: #5df2a0; }
  .lessons li.pattern { border-color: #7fb6ff; }
  .lessons li.off { opacity: .5; }
  .legend { margin: 0; font-size: 11px; color: #a49cbc; }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; font: 500 10px 'JetBrains Mono', monospace; color: #8f88a8; }
  .q { background: none; border: 1px solid rgba(201,168,255,.35); color: #cdb8ff; border-radius: 4px; padding: 1px 7px; font: 600 10px 'JetBrains Mono', monospace; }
  pre { margin: 0; padding: 8px; border-radius: 5px; background: rgba(0,0,0,.35); font: 400 10px/1.5 'JetBrains Mono', monospace; white-space: pre-wrap; }
</style>
