<script lang="ts">
  /**
   * Graph explorer: look at Kernl's graph. Pick a label or search, click a
   * node to see its properties, double-click (or "Expand") to pull in its
   * neighbours. Reads /api/graph/* (kernel graph-query module).
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import { apiFetchRaw } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';

  interface GNode { id: string; labels: string[]; name: string; props: Record<string, unknown>; x?: number; y?: number; z?: number }
  interface GLink { id: string; source: string | GNode; target: string | GNode; type: string }
  interface LabelInfo { label: string; count: number }

  let labels: LabelInfo[] = [];
  let nodes: GNode[] = [];
  let links: GLink[] = [];
  let selected: GNode | null = null;
  let query = '';
  let results: GNode[] = [];
  let error = '';
  let loading = false;
  let depth = 1;
  let container: HTMLDivElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fg: any = null;
  let resizeObs: ResizeObserver | null = null;

  const PALETTE = ['#D4A84B', '#3DD6C8', '#8B7CF6', '#5B9BF7', '#3DD68C', '#F04770', '#F0883E', '#E879F9', '#A3E635', '#FACC15'];
  const colorOf = new Map<string, string>();
  function color(label: string): string {
    if (!colorOf.has(label)) colorOf.set(label, PALETTE[colorOf.size % PALETTE.length]);
    return colorOf.get(label)!;
  }
  const mainLabel = (n: GNode) => n.labels[0] ?? '';

  async function getJson<T>(url: string): Promise<T> {
    const r = await apiFetchRaw(url);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
    return body as T;
  }

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    loading = true;
    error = '';
    try {
      return await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return undefined;
    } finally {
      loading = false;
    }
  }

  /** Add nodes and links, keeping positions of what is already drawn. */
  function merge(data: { nodes: GNode[]; links: GLink[] }, replace = false) {
    if (replace) {
      nodes = [];
      links = [];
    }
    const have = new Map(nodes.map((n) => [n.id, n]));
    for (const n of data.nodes) if (!have.has(n.id)) have.set(n.id, n);
    const linkIds = new Set(links.map((l) => l.id));
    const added = data.links.filter((l) => !linkIds.has(l.id));
    nodes = [...have.values()];
    links = [...links, ...added];
    fg?.graphData({ nodes, links });
  }

  async function showLabel(label: string) {
    selected = null;
    const data = await run(() => getJson<{ nodes: GNode[]; links: GLink[] }>(`/api/graph/sample?label=${encodeURIComponent(label)}&limit=150`));
    if (data) merge(data, true);
  }

  async function search() {
    const q = query.trim();
    if (!q) { results = []; return; }
    const data = await run(() => getJson<{ nodes: GNode[] }>(`/api/graph/search?q=${encodeURIComponent(q)}&limit=30`));
    results = data?.nodes ?? [];
  }

  async function expand(n: GNode, replace = false) {
    const data = await run(() => getJson<{ nodes: GNode[]; links: GLink[] }>(`/api/graph/neighborhood?id=${encodeURIComponent(n.id)}&depth=${depth}&limit=150`));
    if (data) {
      merge(data, replace);
      selected = nodes.find((x) => x.id === n.id) ?? null;
      focus(selected);
    }
  }

  function focus(n: GNode | null) {
    if (!fg || !n || n.x === undefined) return;
    const d = 80;
    const r = 1 + d / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
    fg.cameraPosition({ x: (n.x ?? 0) * r, y: (n.y ?? 0) * r, z: (n.z ?? 0) * r }, n, 800);
  }

  function clear() {
    selected = null;
    merge({ nodes: [], links: [] }, true);
  }

  onMount(async () => {
    const schema = await run(() => getJson<{ labels: LabelInfo[]; relationships: Array<{ from: string; to: string; count: number }> }>('/api/graph/schema'));
    labels = (schema?.labels ?? []).filter((l) => l.count > 0);
    // Start where there is something to see: the label with the most relationships.
    const linked = new Map<string, number>();
    for (const r of schema?.relationships ?? []) {
      linked.set(r.from, (linked.get(r.from) ?? 0) + r.count);
      linked.set(r.to, (linked.get(r.to) ?? 0) + r.count);
    }
    await tick();
    // Loosely typed on purpose: the library's accessors take its own node type, ours carry more.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ForceGraph3D = (await import('3d-force-graph')).default as unknown as new (el: HTMLElement, cfg?: object) => any;
    fg = new ForceGraph3D(container, { controlType: 'orbit' })
      .showNavInfo(false)
      .backgroundColor('#101113')
      .width(container.clientWidth)
      .height(container.clientHeight)
      .nodeLabel((n: GNode) => `${n.name || $t('graph.no_name')} · ${n.labels.join(':')}`)
      .nodeColor((n: GNode) => (selected?.id === n.id ? '#ffffff' : color(mainLabel(n))))
      .nodeVal((n: GNode) => (selected?.id === n.id ? 6 : 2))
      .linkLabel((l: GLink) => l.type)
      .linkColor(() => 'rgba(177,180,188,0.35)')
      .linkDirectionalArrowLength(3)
      .linkDirectionalArrowRelPos(1)
      .onNodeClick((n: GNode) => {
        selected = n;
        fg.nodeColor(fg.nodeColor());
      })
      .onNodeRightClick((n: GNode) => expand(n))
      .onBackgroundClick(() => { selected = null; fg.nodeColor(fg.nodeColor()); })
      .graphData({ nodes, links });
    resizeObs = new ResizeObserver(() => fg?.width(container.clientWidth).height(container.clientHeight));
    resizeObs.observe(container);
    const first = labels.find((l) => l.label === 'Person')
      ?? [...labels].sort((a, b) => (linked.get(b.label) ?? 0) - (linked.get(a.label) ?? 0))[0];
    if (first) await showLabel(first.label);
  });

  onDestroy(() => {
    resizeObs?.disconnect();
    fg?._destructor?.();
    fg = null;
  });

  $: shownLabels = [...new Set(nodes.map(mainLabel))];
</script>

<ViewHeader title={$t('graph.title')} sub={$t('graph.sub')} />

<div class="explorer">
  <aside class="side">
    <form class="search" on:submit|preventDefault={search}>
      <input type="search" placeholder={$t('graph.search.placeholder')} bind:value={query} aria-label={$t('graph.search.aria')} />
      <button type="submit" disabled={loading}>{$t('graph.search.button')}</button>
    </form>

    {#if results.length}
      <div class="block">
        <div class="block-title">{$t('graph.results')} <button class="link" on:click={() => (results = [])}>{$t('graph.clear')}</button></div>
        <ul class="list">
          {#each results as r (r.id)}
            <li><button class="row" on:click={() => expand(r, true)}>
              <span class="dot" style="background:{color(mainLabel(r))}"></span>
              <span class="nm">{r.name || $t('graph.no_name')}</span><span class="lb">{mainLabel(r)}</span>
            </button></li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="block">
      <div class="block-title">{$t('graph.labels')}</div>
      <ul class="list">
        {#each labels as l (l.label)}
          <li><button class="row" on:click={() => showLabel(l.label)}>
            <span class="dot" style="background:{color(l.label)}"></span>
            <span class="nm">{l.label}</span><span class="lb">{l.count.toLocaleString()}</span>
          </button></li>
        {:else}
          <li class="muted">{loading ? $t('graph.loading') : $t('graph.labels.empty')}</li>
        {/each}
      </ul>
    </div>

    <div class="block controls">
      <label>{$t('graph.depth')}
        <select bind:value={depth}><option value={1}>{$t('graph.depth.1')}</option><option value={2}>{$t('graph.depth.2')}</option></select>
      </label>
      <button class="link" on:click={clear}>{$t('graph.clear_view')}</button>
      <span class="muted">{$t('graph.counts', { nodes: nodes.length, links: links.length })}</span>
    </div>
  </aside>

  <div class="stage">
    <div class="canvas" bind:this={container}></div>
    {#if error}<div class="toast err">{error}</div>{/if}
    {#if loading}<div class="toast">{$t('graph.loading')}</div>{/if}
    {#if !loading && !error && nodes.length > 1 && links.length === 0}<div class="toast">{$t('graph.loose')}</div>{/if}
    <div class="help">{$t('graph.help')}</div>
    {#if shownLabels.length}
      <div class="legend">
        {#each shownLabels as l}<span><i style="background:{color(l)}"></i>{l}</span>{/each}
      </div>
    {/if}
    {#if selected}
      <div class="detail">
        <div class="detail-head">
          <span class="dot" style="background:{color(mainLabel(selected))}"></span>
          <strong>{selected.name || $t('graph.no_name')}</strong>
          <span class="lb">{selected.labels.join(' · ')}</span>
        </div>
        <dl>
          {#each Object.entries(selected.props) as [k, v]}
            <dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
          {/each}
        </dl>
        <div class="detail-actions">
          <button on:click={() => selected && expand(selected)}>{$t('graph.expand')}</button>
          <button on:click={() => selected && expand(selected, true)}>{$t('graph.focus')}</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .explorer { display: grid; grid-template-columns: 260px 1fr; gap: 12px; height: calc(100vh - 150px); min-height: 480px; }
  .side { display: flex; flex-direction: column; gap: 12px; overflow: auto; }
  .search { display: flex; gap: 6px; }
  .search input { flex: 1; min-width: 0; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); border-radius: 8px; padding: 7px 10px; }
  button { background: var(--surface-3); color: var(--text-1); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; cursor: pointer; font: inherit; }
  button:hover { border-color: var(--border-h); }
  button:disabled { opacity: 0.5; cursor: default; }
  .link { background: none; border: none; color: var(--text-3); padding: 0; text-decoration: underline; }
  .block { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
  .block-title { display: flex; justify-content: space-between; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-3); margin-bottom: 6px; }
  .list { list-style: none; margin: 0; padding: 0; max-height: 40vh; overflow: auto; }
  .row { width: 100%; display: flex; align-items: center; gap: 8px; background: none; border: none; padding: 5px 4px; text-align: left; border-radius: 6px; }
  .row:hover { background: var(--surface-2); }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lb { color: var(--text-3); font-size: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .muted { color: var(--text-3); font-size: 12px; }
  .controls { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--text-2); }
  .controls select { margin-left: 6px; background: var(--surface-2); color: var(--text-1); border: 1px solid var(--border); border-radius: 6px; }
  .stage { position: relative; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--bg); }
  .canvas { position: absolute; inset: 0; }
  .toast { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); background: var(--surface-2); border: 1px solid var(--border); padding: 6px 12px; border-radius: 8px; font-size: 13px; }
  .toast.err { border-color: var(--red); color: var(--red); }
  .help { position: absolute; right: 10px; bottom: 10px; font-size: 11px; color: var(--text-3); }
  .legend { position: absolute; left: 10px; bottom: 10px; display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--text-2); background: rgba(16, 17, 19, 0.8); padding: 6px 10px; border-radius: 8px; max-width: 60%; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  .detail { position: absolute; top: 10px; right: 10px; width: 320px; max-height: calc(100% - 20px); overflow: auto; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
  .detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; margin: 0; font-size: 12px; }
  dt { color: var(--text-3); }
  dd { margin: 0; color: var(--text-1); word-break: break-word; }
  .detail-actions { display: flex; gap: 6px; margin-top: 10px; }
  @media (max-width: 760px) {
    .explorer { grid-template-columns: 1fr; height: auto; }
    .stage { height: 60vh; }
    .detail { position: static; width: auto; margin: 8px; }
  }
</style>
