<script lang="ts">
  // /crm/leads — migrated from services/dashboard/src/routes/crm/leads/+page.svelte
  // (Fase 2b). Leads endpoints are HTTP-only (no WS RPC), served by the crm
  // backend — fetched via ctx.fetchJson (auth attached, throws on !ok).
  import { onMount } from 'svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  function listLeads(opts: { status?: string; source?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.source) params.set('source', opts.source);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return ctx.fetchJson(`/api/crm/leads${qs ? '?' + qs : ''}`);
  }
  const listLeadSources = () => ctx.fetchJson('/api/crm/leads/sources');
  const setLeadStatus = (id: string, status: string) =>
    ctx.fetchJson('/api/crm/leads/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) });

  type Lead = {
    id: string;
    name: string;
    company: string;
    phone: string;
    email: string;
    lead_status: 'new' | 'drafted' | 'contacted' | 'qualified' | 'won' | 'lost';
    lead_source: string;
    instagram_handle: string;
    linkedin_url: string;
    x_handle: string;
    website: string;
    notes: string;
    updated_at: string;
  };

  type Counts = Record<string, number>;

  const STATUSES = ['new', 'drafted', 'contacted', 'qualified', 'won', 'lost'] as const;
  type Status = typeof STATUSES[number] | 'any';

  let leads: Lead[] = [];
  let counts: Counts = { new: 0, drafted: 0, contacted: 0, qualified: 0, won: 0, lost: 0 };
  let sources: Array<{ source: string; count: number }> = [];
  let activeStatus: Status = 'any';
  let activeSource = '';
  let loading = false;
  let busy = '';
  let toast = '';
  let toastKind: 'ok' | 'err' = 'ok';

  async function load() {
    loading = true;
    try {
      const r = await listLeads({
        status: activeStatus,
        source: activeSource || undefined,
        limit: 500,
      }) as { total: number; counts_by_status: Counts; leads: Lead[] };
      leads = r.leads ?? [];
      counts = r.counts_by_status ?? counts;

      const s = await listLeadSources() as { sources: typeof sources };
      sources = s.sources ?? [];
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      loading = false;
    }
  }

  async function changeStatus(lead: Lead, status: Status) {
    if (status === 'any') return;
    busy = lead.id;
    try {
      await setLeadStatus(lead.id, status);
      flash(`${lead.name} → ${status}`);
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      busy = '';
    }
  }

  function flash(msg: string, kind: 'ok' | 'err' = 'ok') {
    toast = msg;
    toastKind = kind;
    setTimeout(() => { toast = ''; }, 2400);
  }

  function statusColor(s: string): string {
    switch (s) {
      case 'new':       return '#3b82f6';
      case 'drafted':   return '#f59e0b';
      case 'contacted': return '#a855f7';
      case 'qualified': return '#10b981';
      case 'won':       return '#16a34a';
      case 'lost':      return '#94a3b8';
      default:          return '#64748b';
    }
  }

  function fmtTime(ts: string): string {
    if (!ts) return '';
    try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
    catch { return ts.slice(0, 10); }
  }

  onMount(load);
</script>

<main class="page">
  <header class="head">
    <button class="back" on:click={() => ctx.navigate('/crm')}>← CRM</button>
    <h1>Leads</h1>
    <button class="reload" on:click={load} disabled={loading}>{loading ? 'Loading…' : '↻ Reload'}</button>
  </header>

  <section class="filters">
    <div class="tabs">
      <button class:active={activeStatus === 'any'} on:click={() => { activeStatus = 'any'; load(); }}>
        All <span class="count">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
      </button>
      {#each STATUSES as s}
        <button
          class:active={activeStatus === s}
          on:click={() => { activeStatus = s; load(); }}
          style="--accent:{statusColor(s)}"
        >
          {s} <span class="count">{counts[s] ?? 0}</span>
        </button>
      {/each}
    </div>
    {#if sources.length > 1}
      <div class="src-filter">
        <span>source:</span>
        <select bind:value={activeSource} on:change={load}>
          <option value="">all</option>
          {#each sources as s}
            <option value={s.source}>{s.source} ({s.count})</option>
          {/each}
        </select>
      </div>
    {/if}
  </section>

  {#if leads.length === 0 && !loading}
    <div class="empty">No leads yet for this filter.</div>
  {/if}

  <ul class="leads">
    {#each leads as lead (lead.id)}
      <li class="lead" class:busy={busy === lead.id}>
        <div class="row1">
          <span class="badge" style="background:{statusColor(lead.lead_status)}1a;color:{statusColor(lead.lead_status)}">
            {lead.lead_status}
          </span>
          <strong class="name">{lead.name}</strong>
          {#if lead.company}<span class="company">@ {lead.company}</span>{/if}
          {#if lead.lead_source}<span class="src">via {lead.lead_source}</span>{/if}
          <span class="ts">{fmtTime(lead.updated_at)}</span>
        </div>

        <div class="surfaces">
          {#if lead.phone}<a href="tel:{lead.phone}">📞 {lead.phone}</a>{/if}
          {#if lead.email}<a href="mailto:{lead.email}">✉ {lead.email}</a>{/if}
          {#if lead.instagram_handle}
            <a href="https://instagram.com/{lead.instagram_handle.replace(/^@/, '')}" target="_blank" rel="noreferrer">
              📷 {lead.instagram_handle}
            </a>
          {/if}
          {#if lead.linkedin_url}
            <a href={lead.linkedin_url} target="_blank" rel="noreferrer">💼 LinkedIn</a>
          {/if}
          {#if lead.x_handle}
            <a href="https://x.com/{lead.x_handle.replace(/^@/, '')}" target="_blank" rel="noreferrer">
              𝕏 {lead.x_handle}
            </a>
          {/if}
          {#if lead.website}
            <a href={lead.website} target="_blank" rel="noreferrer">🌐 site</a>
          {/if}
        </div>

        {#if lead.notes}
          <p class="notes">{lead.notes}</p>
        {/if}

        <div class="actions">
          {#each STATUSES as s}
            <button
              type="button"
              class="action"
              class:current={lead.lead_status === s}
              disabled={busy === lead.id || lead.lead_status === s}
              on:click={() => changeStatus(lead, s)}
              style="--accent:{statusColor(s)}"
            >
              {s}
            </button>
          {/each}
        </div>
      </li>
    {/each}
  </ul>

  {#if toast}
    <div class="toast" class:err={toastKind === 'err'}>{toast}</div>
  {/if}
</main>

<style>
  .page { max-width: 1100px; margin: 0 auto; padding: 18px 20px 64px; }
  .head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  .head h1 { margin: 0; font-size: 22px; flex: 1; }
  .back, .reload {
    background: var(--surface, #1f2937); color: var(--fg, #e5e7eb);
    border: 1px solid var(--border, #374151); border-radius: 8px;
    padding: 5px 12px; font-size: 13px; cursor: pointer; text-decoration: none;
  }
  .back:hover, .reload:hover { background: var(--surface-hover, #2d3748); }

  .filters { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
  .tabs button {
    background: transparent; color: var(--fg-muted, #94a3b8);
    border: 1px solid var(--border, #374151); border-radius: 999px;
    padding: 4px 12px; font-size: 13px; cursor: pointer; text-transform: capitalize;
  }
  .tabs button:hover { color: var(--fg, #e5e7eb); }
  .tabs button.active {
    color: var(--accent, #3b82f6); border-color: var(--accent, #3b82f6);
    background: color-mix(in oklab, var(--accent, #3b82f6) 12%, transparent);
  }
  .tabs button .count { font-weight: 600; opacity: 0.7; margin-left: 4px; }
  .src-filter { font-size: 13px; color: var(--fg-muted, #94a3b8); display: flex; gap: 6px; align-items: center; }
  .src-filter select {
    background: var(--surface, #1f2937); color: var(--fg, #e5e7eb);
    border: 1px solid var(--border, #374151); border-radius: 6px; padding: 4px 8px; font-size: 13px;
  }

  .empty {
    text-align: center; color: var(--fg-muted, #94a3b8); padding: 40px 0; font-style: italic;
  }
  .leads { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .lead {
    background: var(--surface, #1f2937); border: 1px solid var(--border, #374151);
    border-radius: 12px; padding: 12px 14px; transition: opacity 0.2s;
  }
  .lead.busy { opacity: 0.5; }
  .row1 { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; text-transform: capitalize; }
  .name { font-size: 15px; }
  .company { color: var(--fg-muted, #94a3b8); font-size: 13px; }
  .src { font-size: 11px; color: #94a3b8; background: rgba(148, 163, 184, 0.12); padding: 2px 8px; border-radius: 999px; }
  .ts { margin-left: auto; font-size: 12px; color: var(--fg-muted, #94a3b8); }

  .surfaces { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .surfaces a {
    font-size: 12px; padding: 3px 9px; border-radius: 8px;
    background: rgba(59, 130, 246, 0.08); color: #93c5fd;
    text-decoration: none; border: 1px solid rgba(59, 130, 246, 0.18);
  }
  .surfaces a:hover { background: rgba(59, 130, 246, 0.18); }

  .notes {
    font-size: 13px; color: var(--fg-muted, #cbd5e1); margin: 8px 0;
    line-height: 1.5; white-space: pre-wrap;
  }

  .actions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
  .actions .action {
    background: transparent; color: var(--fg-muted, #94a3b8);
    border: 1px solid var(--border, #374151); border-radius: 6px;
    padding: 3px 10px; font-size: 12px; cursor: pointer; text-transform: capitalize;
  }
  .actions .action:hover:not(:disabled) {
    color: var(--accent, #3b82f6); border-color: var(--accent, #3b82f6);
  }
  .actions .action.current {
    background: color-mix(in oklab, var(--accent, #3b82f6) 18%, transparent);
    color: var(--accent, #3b82f6); border-color: var(--accent, #3b82f6); cursor: default;
  }
  .actions .action:disabled { opacity: 0.6; cursor: not-allowed; }

  .toast {
    position: fixed; bottom: 22px; right: 22px;
    background: var(--surface, #1f2937); color: var(--fg, #e5e7eb);
    padding: 9px 14px; border-radius: 10px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    border-left: 3px solid #16a34a;
  }
  .toast.err { border-left-color: #dc2626; }
</style>
