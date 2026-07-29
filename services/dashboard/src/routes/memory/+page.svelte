<script lang="ts">
  import { onMount } from 'svelte';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import { timeAgo } from '$lib/utils.js';
  import {
    getDistilledFacts,
    getDistilledSummary,
    type DistilledFact,
    type DistilledSummary,
  } from '$lib/api.js';

  // ── State ────────────────────────────────────────
  let summary: DistilledSummary = { categories: [], total: 0 };
  let facts: DistilledFact[] = [];
  let activeCategory: string | null = null;
  let searchQuery = '';
  let loading = true;
  let error = '';

  // ── Load ─────────────────────────────────────────
  async function load() {
    loading = true;
    error = '';
    try {
      const [s, f] = await Promise.all([
        getDistilledSummary(),
        getDistilledFacts({ category: activeCategory ?? undefined, limit: 200 }),
      ]);
      summary = s;
      facts = f;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load memory';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // ── Filtering ────────────────────────────────────
  $: filtered = searchQuery
    ? facts.filter(f =>
        f.fact.toLowerCase().includes(searchQuery.toLowerCase()) ||
        f.category.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : facts;

  $: groupedByCategory = (() => {
    const map = new Map<string, DistilledFact[]>();
    for (const f of filtered) {
      const list = map.get(f.category) ?? [];
      list.push(f);
      map.set(f.category, list);
    }
    return [...map.entries()]
      .map(([category, items]) => ({
        category,
        items: items.sort((a, b) => b.confidence - a.confidence),
      }))
      .sort((a, b) => b.items.length - a.items.length);
  })();

  function selectCategory(cat: string | null) {
    activeCategory = cat;
    void load();
  }

  // Confidence → color hint
  function confidenceColor(c: number): string {
    if (c >= 0.8) return 'var(--green, #10b981)';
    if (c >= 0.5) return 'var(--gold, #f59e0b)';
    return 'var(--text-2, #94a3b8)';
  }

  // Category → emoji hint (purely cosmetic — fallback to dot if unknown)
  const CATEGORY_ICON: Record<string, string> = {
    fact: '\u{1F4CC}',         // 📌
    preference: '✨',       // ✨
    plan: '\u{1F5D3}',          // 🗓
    decision: '✅',         // ✅
    contact: '\u{1F464}',       // 👤
  };
  function iconFor(cat: string): string {
    return CATEGORY_ICON[cat] ?? '•';
  }
</script>

<ViewHeader
  title="Memory"
  sub={`${summary.total} fact${summary.total === 1 ? '' : 's'} distilled across ${summary.categories.length} categor${summary.categories.length === 1 ? 'y' : 'ies'}`}
/>

{#if loading && facts.length === 0}
  <div class="loading-view">Loading memory...</div>
{:else if error}
  <Empty message={`Error: ${error}`} />
{:else if summary.total === 0}
  <Empty message="No durable memory yet — archive a chat session and the distiller will extract facts automatically." />
{:else}
  <div class="kpi-row anim">
    <KpiCard label="Total facts" value={summary.total} accent="--blue" />
    {#each summary.categories.slice(0, 3) as c}
      <KpiCard label={c.category} value={c.count} accent="--teal" />
    {/each}
  </div>

  <!-- Category filter chips -->
  <div class="chips anim d1">
    <button
      class="chip"
      class:active={activeCategory === null}
      on:click={() => selectCategory(null)}
    >All</button>
    {#each summary.categories as c}
      <button
        class="chip"
        class:active={activeCategory === c.category}
        on:click={() => selectCategory(c.category)}
      >
        {iconFor(c.category)} {c.category} <span class="chip-count">{c.count}</span>
      </button>
    {/each}
  </div>

  <!-- Search -->
  <div class="search-row anim d1">
    <input
      class="search"
      type="search"
      placeholder="Filter facts..."
      bind:value={searchQuery}
    />
    {#if searchQuery}
      <span class="search-count">{filtered.length} match{filtered.length === 1 ? '' : 'es'}</span>
    {/if}
  </div>

  {#if filtered.length === 0}
    <Empty message={searchQuery ? `No facts match "${searchQuery}"` : 'No facts in this category'} />
  {:else}
    {#each groupedByCategory as group, idx}
      <Panel
        title={`${iconFor(group.category)} ${group.category}`}
        dotColor="var(--blue, #3b82f6)"
        cls={`anim d${Math.min(idx + 2, 4)}`}
      >
        {#each group.items as fact}
          <div class="fact-row">
            <div class="fact-bullet" style="background:{confidenceColor(fact.confidence)}"></div>
            <div class="fact-body">
              <div class="fact-text">{fact.fact}</div>
              <div class="fact-meta">
                <Badge
                  text={`${Math.round(fact.confidence * 100)}%`}
                  variant={fact.confidence >= 0.8 ? 'green' : fact.confidence >= 0.5 ? 'gold' : 'overdue'}
                />
                <span class="fact-time">{timeAgo(fact.created_at)}</span>
                <span class="fact-episode" title={fact.episode_id}>
                  ep:{fact.episode_id.slice(0, 8)}
                </span>
              </div>
            </div>
          </div>
        {/each}
      </Panel>
    {/each}
  {/if}
{/if}

<style>
  .loading-view {
    padding: 32px;
    text-align: center;
    color: var(--text-2);
    font-size: 13px;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 16px 0 12px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--surface-1, #1e293b);
    color: var(--text-1, #e2e8f0);
    border: 1px solid var(--border, #334155);
    border-radius: 999px;
    font-size: 12px;
    cursor: pointer;
    transition: all 120ms ease;
  }
  .chip:hover {
    border-color: var(--blue, #3b82f6);
  }
  .chip.active {
    background: var(--blue, #3b82f6);
    color: white;
    border-color: var(--blue, #3b82f6);
  }
  .chip-count {
    background: rgba(0, 0, 0, 0.2);
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 16px;
  }
  .search {
    flex: 1;
    padding: 8px 12px;
    background: var(--surface-1, #1e293b);
    color: var(--text-1, #e2e8f0);
    border: 1px solid var(--border, #334155);
    border-radius: 6px;
    font-size: 13px;
  }
  .search:focus {
    outline: none;
    border-color: var(--blue, #3b82f6);
  }
  .search-count {
    color: var(--text-2, #94a3b8);
    font-size: 12px;
  }

  .fact-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-subtle, #1f2937);
  }
  .fact-row:last-child {
    border-bottom: none;
  }
  .fact-bullet {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 6px;
    flex-shrink: 0;
  }
  .fact-body {
    flex: 1;
  }
  .fact-text {
    color: var(--text-1, #e2e8f0);
    font-size: 13px;
    line-height: 1.5;
  }
  .fact-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-2, #94a3b8);
  }
  .fact-time {
    font-variant-numeric: tabular-nums;
  }
  .fact-episode {
    font-family: ui-monospace, monospace;
    background: var(--surface-2, #0f172a);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
  }
</style>
