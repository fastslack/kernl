<script lang="ts">
  // /shopping — migrated from services/dashboard/src/routes/shopping/+page.svelte
  // (Fase 3). Formerly navigated by the shopping-nav suite (UI-only); the page
  // now ships with the shopping extension, which owns the data. The shell keeps
  // hydrating the "data" store (dashboard channel); $lib/api shopping helpers
  // are ported inline over ctx.rpc.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { fmtTime, formatCents } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const data = ctx.getStore('data');

  // Ports of checkShoppingItem / createShoppingList from $lib/api.js
  function checkShoppingItem(itemId: string, checked: boolean) {
    return ctx.rpc('shopping.items.check', { id: itemId, checked }, () =>
      ctx.fetchJson('/api/shopping/check-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: itemId, checked })
      })
    );
  }
  function createShoppingList(name: string) {
    return ctx.rpc('shopping.lists.create', { name }, () =>
      ctx.fetchJson('/api/shopping/create-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
    );
  }

  $: d = ($data as any);
  $: shopping = d?.shopping ?? {};
  // API shape: { activeLists:[], lowStock:[], recentPurchases:[], weeklySpending:[], productCount }
  $: activeLists = (shopping.activeLists ?? []) as any[];
  $: lowStock = (shopping.lowStock ?? []) as any[];
  $: recentPurchases = (shopping.recentPurchases ?? []) as any[];
  // weeklySpending is an array of {week, total} — sum totals
  $: weekSpend = ((shopping.weeklySpending ?? []) as any[]).reduce((acc: number, w: any) => acc + (w.total ?? 0), 0);

  let newListName = '';
  let creating = false;

  function checkedCount(list: any) {
    return (list.items ?? []).filter((i: any) => i.checked).length;
  }

  function onCheckChange(e: Event, itemId: string) {
    const checked = (e.target as HTMLInputElement).checked;
    doCheckItem(itemId, checked);
  }

  async function doCheckItem(itemId: string, checked: boolean) {
    await checkShoppingItem(itemId, checked);
  }

  async function doCreateList() {
    if (!newListName.trim()) return;
    creating = true;
    try {
      await createShoppingList(newListName.trim());
      newListName = '';
    } finally { creating = false; }
  }
</script>

<ViewHeader title="Shopping" sub="Lists & inventory" />

{#if !d}
  <div class="loading-view">Loading shopping...</div>
{:else}
  <div class="kpi-row anim">
    <KpiCard label="Active Lists" value={activeLists.length} accent="--teal" color="var(--teal)" sub="{shopping.productCount ?? 0} products" />
    <KpiCard label="Low Stock" value={lowStock.length} accent="--orange" color={lowStock.length > 0 ? 'var(--orange)' : 'var(--text-1)'} />
    <KpiCard label="Week Spend" value={formatCents(weekSpend)} accent="--gold" color="var(--gold)" />
    <KpiCard label="Recent Purchases" value={recentPurchases.length} accent="--blue" />
  </div>

  <!-- Low Stock -->
  {#if lowStock.length}
    <Panel title="Low Stock ({lowStock.length})" dotColor="var(--orange)" cls="anim d1">
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        {#each lowStock as p}
          <div class="badge badge-orange" style="display:inline-flex;align-items:center;gap:4px">
            {p.name}
            <span style="font-size:9px;opacity:.7">{p.current_stock}/{p.min_stock}</span>
          </div>
        {/each}
      </div>
    </Panel>
  {/if}

  <!-- Create list -->
  <Panel title="Create List" dotColor="var(--green)" cls="anim d2">
    <div class="search-input-row">
      <input class="search-input" bind:value={newListName} placeholder="List name..." on:keypress={e => e.key === 'Enter' && doCreateList()} />
      <button class="search-btn" on:click={doCreateList} disabled={creating}>{creating ? 'Creating...' : '+ Create'}</button>
    </div>
  </Panel>

  <!-- Active Lists -->
  {#each activeLists as list}
    <Panel title="{list.name}" dotColor="var(--teal)" cls="anim d3">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <Badge text={list.status} variant={list.status === 'active' ? 'done' : 'low'} />
        <span style="font-size:11px;color:var(--text-3)">{checkedCount(list)}/{list.items?.length ?? 0} checked</span>
      </div>
      {#if !list.items?.length}
        <Empty message="No items" />
      {:else}
        {#each list.items as item}
          <div class="agenda-item">
             <input type="checkbox" checked={item.checked} on:change={e => onCheckChange(e, item.id)} style="margin-top:2px;cursor:pointer;accent-color:var(--teal)" />
            <div class="agenda-content" style={item.checked ? 'opacity:.5;text-decoration:line-through' : ''}>
              <div style="font-size:13px">{item.name}</div>
              {#if item.quantity && item.quantity !== 1}
                <div style="font-size:11px;color:var(--text-3)">{item.quantity} {item.unit || 'pcs'}</div>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </Panel>
  {/each}

  {#if activeLists.length === 0}
    <Panel cls="anim d3">
      <Empty
        icon="🛒"
        title="Nothing on the list — yet"
        hint="Create a list above, or just tell your assistant “add milk and eggs to groceries” and it lands here automatically."
      />
    </Panel>
  {/if}

  <!-- Recent Purchases -->
  {#if recentPurchases.length}
    <Panel title="Recent Purchases" dotColor="var(--gold)" cls="anim d4">
      {#each recentPurchases.slice(0, 10) as p}
        <div class="agenda-item">
          <span class="agenda-time">{fmtTime(p.purchased_at)}</span>
          <div class="agenda-content">
            <div class="agenda-title">{p.product_name ?? p.product_id}</div>
            <div class="agenda-meta">
              <span style="font-size:11px;color:var(--gold)">{formatCents(p.total_price, p.currency ?? 'EUR')}</span>
              {#if p.store_name}<span style="font-size:11px;color:var(--text-3)">{p.store_name}</span>{/if}
            </div>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}
{/if}
