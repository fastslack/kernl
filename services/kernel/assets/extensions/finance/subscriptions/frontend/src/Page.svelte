<script lang="ts">
  // /subscriptions — migrated from services/dashboard/src/routes/subscriptions/+page.svelte
  // (Fase 3). All data flows through ctx.rpc (rpcOrCall semantics preserved).
  import { onMount } from 'svelte';
  import { fmtDate, formatCents } from '$shared/utils';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const rpcOrCall = (action: string, params: Record<string, unknown>, fallback: () => Promise<any>) =>
    ctx.rpc(action, params, fallback);

  interface Sub {
    id: string; name: string; provider: string;
    amount_cents: number; currency: string;
    billing_cycle: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
    category: string; group: string;
    status: 'active' | 'paused' | 'cancelled';
    start_date: string; next_billing: string;
    url: string; notes: string;
  }

  let subs: Sub[] = [];
  let loading = true;
  let error = '';
  let filterStatus: 'all' | 'active' | 'paused' | 'cancelled' = 'active';
  let filterGroup: string = 'all';
  let filterCategory: string = 'all';
  let searchQuery = '';

  // Modal state
  let showCreate = false;
  let editingId: string | null = null;
  let form = {
    name: '',
    provider: '',
    amount: '',
    currency: 'EUR',
    billing_cycle: 'monthly' as Sub['billing_cycle'],
    category: '',
    start_date: new Date().toISOString().slice(0, 10),
    url: '',
    notes: '',
  };
  let suggestedCategory = '';
  let saving = false;

  // Categories from backend
  let allCategories: string[] = [];
  let categoryGroups: Record<string, string[]> = {};

  async function loadAll() {
    loading = true;
    try {
      const res: any = await rpcOrCall('subscriptions.list', {}, async () => {
        const r = await ctx.fetchRaw('/api/dashboard/subscriptions');
        return r.json();
      });
      subs = res?.subscriptions ?? [];
    } catch (e: any) {
      error = e.message ?? 'Failed to load';
    }
    loading = false;
  }

  async function loadCategories() {
    try {
      const res: any = await rpcOrCall('subscriptions.categories', {}, async () => ({ categories: [], groups: {} }));
      allCategories = res?.categories ?? [];
      categoryGroups = res?.groups ?? {};
    } catch { /* ignore */ }
  }

  async function suggestCategory() {
    if (!form.name.trim()) return;
    try {
      const res: any = await rpcOrCall('subscriptions.suggest_category', { name: form.name, provider: form.provider }, async () => ({ category: '' }));
      suggestedCategory = res?.category ?? '';
      if (!form.category) form.category = suggestedCategory;
    } catch { /* ignore */ }
  }

  async function saveSubscription() {
    if (!form.name.trim() || !form.amount) return;
    saving = true;
    try {
      const amount_cents = Math.round(parseFloat(form.amount) * 100);
      const payload = {
        name: form.name.trim(),
        provider: form.provider.trim(),
        amount_cents,
        currency: form.currency,
        billing_cycle: form.billing_cycle,
        category: form.category || undefined,
        start_date: form.start_date,
        url: form.url.trim(),
        notes: form.notes.trim(),
      };
      if (editingId) {
        await rpcOrCall('subscriptions.update', { id: editingId, ...payload }, async () => ({}));
      } else {
        await rpcOrCall('subscriptions.create', payload, async () => ({}));
      }
      await loadAll();
      closeModal();
    } catch (e: any) {
      alert('Error: ' + e.message);
    }
    saving = false;
  }

  async function cancelSub(id: string) {
    if (!confirm('Cancel this subscription?')) return;
    try {
      await rpcOrCall('subscriptions.cancel', { id }, async () => ({}));
      await loadAll();
    } catch { /* ignore */ }
  }

  async function pauseSub(id: string) {
    try {
      await rpcOrCall('subscriptions.pause', { id }, async () => ({}));
      await loadAll();
    } catch { /* ignore */ }
  }

  async function resumeSub(id: string) {
    try {
      await rpcOrCall('subscriptions.resume', { id }, async () => ({}));
      await loadAll();
    } catch { /* ignore */ }
  }

  function openEdit(sub: Sub) {
    editingId = sub.id;
    form = {
      name: sub.name,
      provider: sub.provider,
      amount: (sub.amount_cents / 100).toFixed(2),
      currency: sub.currency,
      billing_cycle: sub.billing_cycle,
      category: sub.category,
      start_date: sub.start_date,
      url: sub.url,
      notes: sub.notes,
    };
    showCreate = true;
  }

  function openCreate() {
    editingId = null;
    form = {
      name: '', provider: '', amount: '', currency: 'EUR',
      billing_cycle: 'monthly', category: '',
      start_date: new Date().toISOString().slice(0, 10),
      url: '', notes: '',
    };
    suggestedCategory = '';
    showCreate = true;
  }

  function closeModal() {
    showCreate = false;
    editingId = null;
  }

  // Convert to monthly cents for unified comparison
  function toMonthly(amount: number, cycle: string): number {
    switch (cycle) {
      case 'weekly': return Math.round(amount * 52 / 12);
      case 'monthly': return amount;
      case 'quarterly': return Math.round(amount / 3);
      case 'yearly': return Math.round(amount / 12);
      default: return amount;
    }
  }

  // Days until next billing
  function daysUntil(dateStr: string): number {
    if (!dateStr) return 999;
    const today = new Date(); today.setHours(0,0,0,0);
    const date = new Date(dateStr); date.setHours(0,0,0,0);
    return Math.ceil((date.getTime() - today.getTime()) / 86400000);
  }

  // ── Derived stats ──
  $: filtered = subs.filter(s => {
    if (filterStatus !== 'all' && s.status !== filterStatus) return false;
    if (filterGroup !== 'all' && s.group !== filterGroup) return false;
    if (filterCategory !== 'all' && s.category !== filterCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !s.provider.toLowerCase().includes(q) && !s.category.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  $: activeSubs = subs.filter(s => s.status === 'active');
  $: monthlyTotal = activeSubs.reduce((sum, s) => sum + toMonthly(s.amount_cents, s.billing_cycle), 0);
  $: yearlyTotal = monthlyTotal * 12;
  $: pausedCount = subs.filter(s => s.status === 'paused').length;
  $: cancelledCount = subs.filter(s => s.status === 'cancelled').length;

  // Group breakdown for active subs
  $: groupBreakdown = (() => {
    const map = new Map<string, { count: number; monthly: number }>();
    for (const s of activeSubs) {
      const g = s.group || 'Other';
      const cur = map.get(g) ?? { count: 0, monthly: 0 };
      cur.count++;
      cur.monthly += toMonthly(s.amount_cents, s.billing_cycle);
      map.set(g, cur);
    }
    return Array.from(map.entries())
      .map(([group, data]) => ({ group, ...data, percent: monthlyTotal > 0 ? (data.monthly / monthlyTotal) * 100 : 0 }))
      .sort((a, b) => b.monthly - a.monthly);
  })();

  // Category breakdown
  $: categoryBreakdown = (() => {
    const map = new Map<string, { count: number; monthly: number }>();
    for (const s of activeSubs) {
      const cat = s.category || 'other';
      const cur = map.get(cat) ?? { count: 0, monthly: 0 };
      cur.count++;
      cur.monthly += toMonthly(s.amount_cents, s.billing_cycle);
      map.set(cat, cur);
    }
    return Array.from(map.entries())
      .map(([category, data]) => ({ category, ...data, percent: monthlyTotal > 0 ? (data.monthly / monthlyTotal) * 100 : 0 }))
      .sort((a, b) => b.monthly - a.monthly);
  })();

  // Upcoming renewals (next 14 days)
  $: upcomingRenewals = activeSubs
    .filter(s => s.next_billing)
    .map(s => ({ ...s, days: daysUntil(s.next_billing) }))
    .filter(s => s.days >= 0 && s.days <= 14)
    .sort((a, b) => a.days - b.days);

  // Expensive subscriptions (top 5 by monthly cost)
  $: topExpensive = activeSubs
    .map(s => ({ ...s, monthly: toMonthly(s.amount_cents, s.billing_cycle) }))
    .sort((a, b) => b.monthly - a.monthly)
    .slice(0, 5);

  // Smart insights
  $: insights = (() => {
    const tips: Array<{ icon: string; text: string; severity: 'info' | 'warn' | 'critical' }> = [];
    if (activeSubs.length === 0) return tips;
    // Yearly cycle savings opportunity
    const monthlyOnes = activeSubs.filter(s => s.billing_cycle === 'monthly' && s.amount_cents > 500);
    if (monthlyOnes.length > 0) {
      tips.push({
        icon: '\u{1F4A1}',
        text: `${monthlyOnes.length} monthly subscription${monthlyOnes.length > 1 ? 's' : ''} could save 15-20% switching to yearly billing`,
        severity: 'info',
      });
    }
    // Category concentration
    if (groupBreakdown.length > 0 && groupBreakdown[0].percent > 50) {
      tips.push({
        icon: '\u{1F4CA}',
        text: `${groupBreakdown[0].group} is ${groupBreakdown[0].percent.toFixed(0)}% of your spending`,
        severity: 'warn',
      });
    }
    // Renewals this week
    const thisWeek = upcomingRenewals.filter(r => r.days <= 7).length;
    if (thisWeek > 0) {
      tips.push({
        icon: '\u{23F0}',
        text: `${thisWeek} renewal${thisWeek > 1 ? 's' : ''} in the next 7 days`,
        severity: thisWeek > 3 ? 'critical' : 'info',
      });
    }
    // Duplicate detection
    const streaming = activeSubs.filter(s => s.category === 'streaming-video').length;
    if (streaming >= 3) {
      tips.push({
        icon: '\u{1F4FA}',
        text: `${streaming} video streaming services — consider consolidating`,
        severity: 'warn',
      });
    }
    const music = activeSubs.filter(s => s.category === 'streaming-music').length;
    if (music >= 2) {
      tips.push({
        icon: '\u{1F3B5}',
        text: `${music} music streaming services — usually only one is needed`,
        severity: 'warn',
      });
    }
    // Uncategorized
    const uncat = activeSubs.filter(s => !s.category || s.category === 'other').length;
    if (uncat > 2) {
      tips.push({
        icon: '\u{1F3F7}',
        text: `${uncat} subscription${uncat > 1 ? 's' : ''} need categorization`,
        severity: 'info',
      });
    }
    return tips;
  })();

  // Available group/category options based on data
  $: availableGroups = Array.from(new Set(subs.map(s => s.group || 'Other'))).sort();
  $: availableCategories = Array.from(new Set(subs.map(s => s.category || 'other'))).sort();

  function statusColor(status: string): string {
    if (status === 'active') return 'var(--green)';
    if (status === 'paused') return 'var(--gold)';
    return 'var(--text-3)';
  }

  function cycleLabel(c: string): string {
    if (c === 'weekly') return '/wk';
    if (c === 'monthly') return '/mo';
    if (c === 'quarterly') return '/qtr';
    if (c === 'yearly') return '/yr';
    return '';
  }

  function categoryColor(cat: string): string {
    // Hash category to a color from a palette
    const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#14b8a6', '#f97316'];
    let h = 0;
    for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }

  onMount(async () => {
    await Promise.all([loadAll(), loadCategories()]);
  });
</script>

<svelte:head><title>Subscriptions — Kernl</title></svelte:head>

<ViewHeader title="Subscriptions" sub="{activeSubs.length} active · {formatCents(monthlyTotal)}/mo">
  <button class="btn-primary" on:click={openCreate}>+ New subscription</button>
</ViewHeader>

{#if loading}
  <Panel cls="anim"><Empty message="Loading..." /></Panel>
{:else}
  <!-- KPIs -->
  <div class="kpi-row anim">
    <KpiCard label="Active" value={activeSubs.length} accent="--green" color="var(--green)" />
    <KpiCard label="Monthly" value={formatCents(monthlyTotal)} accent="--gold" color="var(--gold)" />
    <KpiCard label="Yearly" value={formatCents(yearlyTotal)} accent="--purple" color="var(--purple)" />
    <KpiCard label="Paused" value={pausedCount} accent="--blue" />
    <KpiCard label="Cancelled" value={cancelledCount} accent="--red" />
  </div>

  <!-- Insights -->
  {#if insights.length > 0}
    <Panel title="Smart Insights" dotColor="var(--teal)" cls="anim d1">
      <div class="insights">
        {#each insights as tip}
          <div class="insight insight-{tip.severity}">
            <span class="insight-icon">{tip.icon}</span>
            <span class="insight-text">{tip.text}</span>
          </div>
        {/each}
      </div>
    </Panel>
  {/if}

  <div class="grid-2 anim d1">
    <!-- By Group -->
    <Panel title="Spending by Group" dotColor="var(--purple)">
      {#if groupBreakdown.length === 0}
        <Empty message="No active subscriptions" />
      {:else}
        <div class="bars">
          {#each groupBreakdown as g}
            <div class="bar-row">
              <div class="bar-head">
                <span class="bar-label">{g.group}</span>
                <span class="bar-value">{formatCents(g.monthly)}/mo</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" style="width:{g.percent}%;background:var(--purple)"></div>
              </div>
              <div class="bar-meta">{g.count} subs · {g.percent.toFixed(0)}%</div>
            </div>
          {/each}
        </div>
      {/if}
    </Panel>

    <!-- Top Expensive -->
    <Panel title="Top 5 Expenses" dotColor="var(--gold)">
      {#if topExpensive.length === 0}
        <Empty message="No subscriptions" />
      {:else}
        <div class="top-list">
          {#each topExpensive as s, i}
            <div class="top-item">
              <span class="top-rank">#{i + 1}</span>
              <div class="top-info">
                <div class="top-name">{s.name}</div>
                <div class="top-cat" style="color:{categoryColor(s.category)}">{s.category || 'uncategorized'}</div>
              </div>
              <div class="top-cost">
                <div>{formatCents(s.monthly)}/mo</div>
                <div class="top-yearly">{formatCents(s.monthly * 12)}/yr</div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </Panel>
  </div>

  <!-- Upcoming renewals -->
  {#if upcomingRenewals.length > 0}
    <Panel title="Upcoming Renewals (next 14 days)" dotColor="var(--gold)" cls="anim d2">
      <div class="renewals">
        {#each upcomingRenewals as r}
          <div class="renewal-item" class:renewal-soon={r.days <= 3}>
            <div class="renewal-days">
              <div class="renewal-num">{r.days === 0 ? 'TODAY' : r.days}</div>
              {#if r.days > 0}<div class="renewal-unit">days</div>{/if}
            </div>
            <div class="renewal-info">
              <div class="renewal-name">{r.name}</div>
              <div class="renewal-meta">{fmtDate(r.next_billing)} · {r.category || 'uncategorized'}</div>
            </div>
            <div class="renewal-cost">{formatCents(r.amount_cents)}</div>
          </div>
        {/each}
      </div>
    </Panel>
  {/if}

  <!-- All subscriptions table -->
  <Panel title="All Subscriptions" dotColor="var(--text-2)" cls="anim d3">
    <!-- Filters -->
    <div class="filters">
      <input type="text" class="filter-search" placeholder="Search..." bind:value={searchQuery} />
      <select class="filter-select" bind:value={filterStatus}>
        <option value="all">All status</option>
        <option value="active">Active</option>
        <option value="paused">Paused</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <select class="filter-select" bind:value={filterGroup}>
        <option value="all">All groups</option>
        {#each availableGroups as g}<option value={g}>{g}</option>{/each}
      </select>
      <select class="filter-select" bind:value={filterCategory}>
        <option value="all">All categories</option>
        {#each availableCategories as c}<option value={c}>{c}</option>{/each}
      </select>
    </div>

    {#if filtered.length === 0}
      <Empty message="No subscriptions match your filters" />
    {:else}
      <div class="sub-list">
        {#each filtered as s}
          <div class="sub-row" class:sub-paused={s.status === 'paused'} class:sub-cancelled={s.status === 'cancelled'}>
            <div class="sub-status-dot" style="background:{statusColor(s.status)}"></div>
            <div class="sub-main">
              <div class="sub-name-row">
                <span class="sub-name">{s.name}</span>
                {#if s.provider}<span class="sub-provider">{s.provider}</span>{/if}
                {#if s.category}<span class="sub-cat-pill" style="background:{categoryColor(s.category)}22;color:{categoryColor(s.category)}">{s.category}</span>{/if}
              </div>
              <div class="sub-meta">
                {#if s.status === 'active'}Next: {fmtDate(s.next_billing)}{:else}{s.status}{/if}
                · {s.billing_cycle}
                {#if s.group}· {s.group}{/if}
              </div>
            </div>
            <div class="sub-cost">
              <div class="sub-amount">{formatCents(s.amount_cents)}<span class="sub-cycle">{cycleLabel(s.billing_cycle)}</span></div>
              <div class="sub-monthly">{formatCents(toMonthly(s.amount_cents, s.billing_cycle))}/mo equiv</div>
            </div>
            <div class="sub-actions">
              <button class="btn-icon" on:click={() => openEdit(s)} title="Edit">&#9998;</button>
              {#if s.status === 'active'}
                <button class="btn-icon" on:click={() => pauseSub(s.id)} title="Pause">&#10074;&#10074;</button>
                <button class="btn-icon btn-danger" on:click={() => cancelSub(s.id)} title="Cancel">&times;</button>
              {:else if s.status === 'paused'}
                <button class="btn-icon" on:click={() => resumeSub(s.id)} title="Resume">&#9654;</button>
                <button class="btn-icon btn-danger" on:click={() => cancelSub(s.id)} title="Cancel">&times;</button>
              {/if}
              {#if s.url}<a href={s.url} target="_blank" rel="noopener" class="btn-icon" title="Open URL">&#x2197;</a>{/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </Panel>
{/if}

<!-- Create/Edit Modal -->
{#if showCreate}
  <div class="modal-overlay" on:click={closeModal} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && closeModal()}>
    <div class="modal-box" on:click|stopPropagation role="presentation">
      <div class="modal-title">{editingId ? 'Edit' : 'New'} Subscription</div>

      <label class="modal-label">Name
        <input type="text" class="modal-input" bind:value={form.name} on:blur={suggestCategory} placeholder="e.g. Netflix, Spotify..." />
      </label>

      <label class="modal-label">Provider (optional)
        <input type="text" class="modal-input" bind:value={form.provider} on:blur={suggestCategory} placeholder="Company name" />
      </label>

      <div class="modal-row">
        <label class="modal-label modal-half">Amount
          <input type="number" step="0.01" class="modal-input" bind:value={form.amount} placeholder="9.99" />
        </label>
        <label class="modal-label modal-half">Currency
          <select class="modal-input" bind:value={form.currency}>
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
            <option value="ARS">ARS</option>
          </select>
        </label>
      </div>

      <label class="modal-label">Billing cycle
        <select class="modal-input" bind:value={form.billing_cycle}>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
          <option value="yearly">Yearly</option>
        </select>
      </label>

      <label class="modal-label">Category
        {#if suggestedCategory && !form.category}
          <button type="button" class="suggest-pill" on:click={() => form.category = suggestedCategory}>
            Suggested: {suggestedCategory}
          </button>
        {/if}
        <select class="modal-input" bind:value={form.category}>
          <option value="">(auto)</option>
          {#each allCategories as c}<option value={c}>{c}</option>{/each}
        </select>
      </label>

      <label class="modal-label">Start date
        <input type="date" class="modal-input" bind:value={form.start_date} />
      </label>

      <label class="modal-label">URL (optional)
        <input type="url" class="modal-input" bind:value={form.url} placeholder="https://..." />
      </label>

      <label class="modal-label">Notes
        <textarea class="modal-textarea" bind:value={form.notes} rows="2"></textarea>
      </label>

      <div class="modal-actions">
        <button class="btn-cancel" on:click={closeModal}>Cancel</button>
        <button class="btn-save" on:click={saveSubscription} disabled={saving || !form.name.trim() || !form.amount}>
          {saving ? 'Saving...' : (editingId ? 'Save' : 'Create')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .btn-primary {
    padding: 6px 14px; border-radius: 6px; font: 600 11px var(--font-display);
    background: var(--purple); color: #fff; border: none; cursor: pointer; transition: all .15s;
  }
  .btn-primary:hover { filter: brightness(1.1); }

  /* ── Insights ── */
  .insights { display: flex; flex-direction: column; gap: 6px; }
  .insight {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 8px;
    font: 500 12px var(--font-body); line-height: 1.4;
  }
  .insight-info { background: rgba(99,102,241,.1); color: var(--text-2); border-left: 2px solid var(--purple); }
  .insight-warn { background: rgba(245,158,11,.12); color: #f59e0b; border-left: 2px solid #f59e0b; }
  .insight-critical { background: rgba(239,68,68,.12); color: #ef4444; border-left: 2px solid #ef4444; }
  .insight-icon { font-size: 16px; flex-shrink: 0; }
  .insight-text { flex: 1; }

  /* ── Bar charts ── */
  .bars { display: flex; flex-direction: column; gap: 10px; }
  .bar-row { display: flex; flex-direction: column; gap: 3px; }
  .bar-head { display: flex; justify-content: space-between; font: 500 11px var(--font-body); }
  .bar-label { color: var(--text-1); }
  .bar-value { color: var(--gold); font-family: var(--font-mono); }
  .bar-track { height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; transition: width .3s; }
  .bar-meta { font: 500 9px var(--font-mono); color: var(--text-3); }

  /* ── Top expensive ── */
  .top-list { display: flex; flex-direction: column; gap: 6px; }
  .top-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border-radius: 6px; background: var(--surface-2);
  }
  .top-rank { font: 700 14px var(--font-mono); color: var(--text-3); width: 22px; }
  .top-info { flex: 1; min-width: 0; }
  .top-name { font: 600 12px var(--font-body); color: var(--text-1); }
  .top-cat { font: 500 9px var(--font-mono); margin-top: 2px; }
  .top-cost { text-align: right; font: 600 12px var(--font-mono); color: var(--gold); }
  .top-yearly { font: 400 9px var(--font-mono); color: var(--text-3); margin-top: 2px; }

  /* ── Renewals ── */
  .renewals { display: flex; flex-direction: column; gap: 4px; }
  .renewal-item {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 10px; border-radius: 6px; background: var(--surface-2);
    border-left: 3px solid var(--gold);
  }
  .renewal-soon { border-left-color: #ef4444; background: rgba(239,68,68,.06); }
  .renewal-days { text-align: center; min-width: 40px; }
  .renewal-num { font: 700 16px var(--font-mono); color: var(--gold); line-height: 1; }
  .renewal-soon .renewal-num { color: #ef4444; }
  .renewal-unit { font: 500 8px var(--font-mono); color: var(--text-3); margin-top: 2px; }
  .renewal-info { flex: 1; }
  .renewal-name { font: 600 12px var(--font-body); color: var(--text-1); }
  .renewal-meta { font: 500 9px var(--font-mono); color: var(--text-3); margin-top: 2px; }
  .renewal-cost { font: 600 13px var(--font-mono); color: var(--text-1); }

  /* ── Filters ── */
  .filters { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
  .filter-search {
    flex: 1; min-width: 180px; padding: 6px 12px; border-radius: 6px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font: 500 11px var(--font-body); outline: none;
  }
  .filter-search:focus { border-color: var(--purple); }
  .filter-select {
    padding: 6px 10px; border-radius: 6px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font: 500 11px var(--font-body); outline: none; cursor: pointer;
  }
  .filter-select:focus { border-color: var(--purple); }

  /* ── Subscription list ── */
  .sub-list { display: flex; flex-direction: column; gap: 4px; }
  .sub-row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-radius: 8px; background: var(--surface-2);
    border-left: 3px solid var(--green); transition: all .15s;
  }
  .sub-row:hover { background: var(--surface-3); }
  .sub-paused { border-left-color: var(--gold); opacity: .75; }
  .sub-cancelled { border-left-color: var(--text-3); opacity: .5; }
  .sub-status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .sub-main { flex: 1; min-width: 0; }
  .sub-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sub-name { font: 600 13px var(--font-body); color: var(--text-1); }
  .sub-provider { font: 500 10px var(--font-mono); color: var(--text-3); }
  .sub-cat-pill { font: 600 8px var(--font-mono); padding: 2px 7px; border-radius: 3px; text-transform: uppercase; letter-spacing: .3px; }
  .sub-meta { font: 500 10px var(--font-mono); color: var(--text-3); margin-top: 3px; }
  .sub-cost { text-align: right; min-width: 100px; }
  .sub-amount { font: 700 13px var(--font-mono); color: var(--text-1); }
  .sub-cycle { font: 500 10px var(--font-mono); color: var(--text-3); margin-left: 2px; }
  .sub-monthly { font: 500 9px var(--font-mono); color: var(--text-3); margin-top: 2px; }
  .sub-actions { display: flex; gap: 2px; }
  .btn-icon {
    width: 26px; height: 26px; border-radius: 5px;
    background: transparent; border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer; font: 500 12px var(--font-mono);
    display: flex; align-items: center; justify-content: center;
    text-decoration: none; transition: all .12s;
  }
  .btn-icon:hover { background: var(--surface-3); color: var(--text-1); border-color: var(--text-3); }
  .btn-danger:hover { color: #ef4444; border-color: #ef4444; }

  /* ── Modal ── */
  .modal-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,.6); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  }
  .modal-box {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 12px; padding: 20px; width: 420px; max-width: 90vw;
    max-height: 90vh; overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,.5);
  }
  .modal-title { font: 600 16px var(--font-display); color: var(--text-1); margin-bottom: 16px; }
  .modal-label {
    display: block; font: 600 9px var(--font-body); color: var(--text-3);
    text-transform: uppercase; letter-spacing: .5px; margin-bottom: 12px;
  }
  .modal-input {
    display: block; width: 100%; margin-top: 5px; padding: 8px 12px;
    border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font: 500 12px var(--font-body); outline: none;
    box-sizing: border-box; transition: border-color .15s;
  }
  .modal-input:focus { border-color: var(--purple); }
  .modal-textarea {
    display: block; width: 100%; margin-top: 5px; padding: 8px 12px;
    border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font: 500 11px var(--font-body); outline: none;
    box-sizing: border-box; resize: vertical;
  }
  .modal-row { display: flex; gap: 10px; }
  .modal-half { flex: 1; }
  .suggest-pill {
    display: inline-block; margin-top: 5px; padding: 3px 10px;
    border-radius: 4px; background: rgba(61,214,200,.15); border: 1px solid rgba(61,214,200,.4);
    color: var(--teal); font: 600 9px var(--font-mono); cursor: pointer; text-transform: lowercase;
  }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
  .btn-cancel, .btn-save {
    padding: 8px 18px; border-radius: 6px; font: 600 11px var(--font-display);
    border: 1px solid var(--border); cursor: pointer; transition: all .15s;
  }
  .btn-cancel { background: var(--surface-2); color: var(--text-2); }
  .btn-cancel:hover { background: var(--surface-3); }
  .btn-save { background: var(--purple); color: #fff; border-color: transparent; }
  .btn-save:hover { filter: brightness(1.1); }
  .btn-save:disabled { opacity: .4; cursor: not-allowed; }
</style>
