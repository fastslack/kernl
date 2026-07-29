<script lang="ts">
  import { apiRegistry } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import Empty from '$lib/components/Empty.svelte';

  $: data = ($apiRegistry as any);
  $: cats = (data?.categories ?? []) as any[];
  $: apis = (data?.apis ?? []) as any[];
  $: stats = data?.stats ?? {};

  let search = '';
  let selectedCat = '';

  $: filtered = apis.filter((api: any) => {
    const q = search.toLowerCase();
    const matchQ = !q || api.name?.toLowerCase().includes(q) || api.description?.toLowerCase().includes(q) || (api.tags ?? '').toLowerCase().includes(q);
    const matchCat = !selectedCat || api.category_id === selectedCat;
    return matchQ && matchCat;
  });

  let testingId: string | null = null;
  let testResults: Record<string, { ok: boolean; msg: string }> = {};

  async function testApi(api: any) {
    testingId = api.id;
    testResults[api.id] = { ok: false, msg: 'Testing...' };
    testResults = { ...testResults };
    try {
      const d = await rpcOrCall('registry.apis.test', { id: api.id }, async () => {
        const res = await fetch(`/api/registry/apis/${api.id}/test`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      if (d.ok) {
        testResults[api.id] = { ok: true, msg: `OK ${d.latencyMs ?? ''}ms` };
      } else {
        testResults[api.id] = { ok: false, msg: 'Failed' };
      }
    } catch (e: any) {
      testResults[api.id] = { ok: false, msg: 'Error' };
    } finally {
      testingId = null;
      testResults = { ...testResults };
      // Clear after 3s
      setTimeout(() => {
        delete testResults[api.id];
        testResults = { ...testResults };
      }, 3000);
    }
  }
</script>

<ViewHeader title="API Repository" sub="Browse and configure external APIs" />

{#if !data}
  <Panel cls="anim"><Empty message="API Registry not available." /></Panel>
{:else}
  <!-- KPI Row -->
  <div class="kpi-row anim">
    <KpiCard label="Total APIs" value={stats.totalApis ?? apis.length} sub="available" accent="--teal" color="var(--teal)" />
    <KpiCard label="Categories" value={stats.totalCategories ?? cats.length} sub="types" accent="--purple" color="var(--purple)" />
    <KpiCard label="With Keys" value={stats.withKeys ?? 0} sub="configured" accent="--green" color="var(--green)" />
    <KpiCard label="Free APIs" value={stats.freeApis ?? 0} sub="no auth needed" accent="--gold" color="var(--gold)" />
  </div>

  <!-- Search bar -->
  <Panel cls="anim" style="padding:12px;margin-bottom:16px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <input 
        type="text" 
        class="search-input"
        placeholder="Search APIs..."
        style="flex:1;min-width:200px"
        bind:value={search}
      />
      <select 
        class="search-input"
        style="min-width:150px"
        bind:value={selectedCat}
      >
        <option value="">All Categories</option>
        {#each cats as c}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    </div>
  </Panel>

  <!-- API Grid -->
  <Panel cls="anim" title="APIs" dotColor="var(--teal)">
    {#if filtered.length === 0}
      <Empty message="No APIs found." />
    {:else}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;margin-top:12px">
        {#each filtered as api}
          <div 
            class="api-card hoverable"
            style="padding:16px;border-radius:10px;background:var(--surface-2);border:1px solid var(--border);cursor:pointer;transition:border-color 0.2s"
            role="button"
            tabindex="0"
          >
            <!-- Header -->
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
              <div>
                <div style="font-weight:600;font-size:14px">{api.name}</div>
                <div style="font-size:11px;color:var(--text-3);margin-top:2px">{api.category_name ?? 'Uncategorized'}</div>
              </div>
              <div style="display:flex;gap:4px">
                {#if api.hasKey}
                  <span class="badge" style="background:var(--green);color:#fff;font-size:9px;padding:2px 6px">KEY</span>
                {/if}
                {#if api.is_free}
                  <span class="badge" style="background:var(--gold);color:#000;font-size:9px;padding:2px 6px">FREE</span>
                {/if}
                <span class="badge" style="background:var(--surface-3);font-size:9px;padding:2px 6px">{api.auth_type ?? 'none'}</span>
              </div>
            </div>

            <!-- Description -->
            {#if api.description}
              <div style="font-size:12px;color:var(--text-2);line-height:1.4;margin-bottom:8px;max-height:40px;overflow:hidden">
                {api.description.length > 120 ? api.description.slice(0, 120) + '...' : api.description}
              </div>
            {/if}

            <!-- Footer -->
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:8px;border-top:1px solid var(--border)">
              <div style="display:flex;gap:4px;flex-wrap:wrap">
                {#each (api.tags ?? '').split(',').filter(Boolean).slice(0, 3) as tag}
                  <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--surface-3);color:var(--text-2)">{tag.trim()}</span>
                {/each}
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                {#if api.docs_url}
                  <a href={api.docs_url} target="_blank" rel="noopener" style="font-size:11px;color:var(--teal);text-decoration:none">Docs</a>
                {/if}
                <button 
                  style="font-size:11px;padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--surface-3);color:{testResults[api.id]?.ok ? 'var(--green)' : testResults[api.id]?.msg ? 'var(--red)' : 'var(--text-1)'};cursor:pointer"
                  disabled={testingId === api.id}
                  on:click|stopPropagation={() => testApi(api)}
                >
                  {testResults[api.id]?.msg ?? 'Test'}
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </Panel>
{/if}

<style>
  .api-card:hover {
    border-color: var(--teal) !important;
  }
</style>
