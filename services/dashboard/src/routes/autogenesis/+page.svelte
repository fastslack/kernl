<script lang="ts">
  import { onMount } from 'svelte';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import { timeAgo } from '$lib/utils.js';
  import {
    listPromptVersions,
    diffPromptVersions,
    restorePromptVersion,
    activatePromptVersion,
    listEvolutionRuns,
    runEvolutionCycle,
    acceptEvolution,
    rejectEvolution,
  } from '$lib/api.js';

  interface AgentRow {
    id: string; name: string;
    provider: string; model: string;
    active?: number;
    flow_id?: string;
    system_prompt?: string;
    builtin_handler?: string;
  }
  interface Flow { id: string; name: string; color: string }
  interface PromptVersion {
    id: string;
    agent_id: string;
    version: number;
    system_prompt: string;
    goal_template: string;
    parent_version: number;
    source: 'manual' | 'reflection' | 'restore' | 'initial';
    note: string;
    active: number;
    created_at: string;
  }
  interface EvolutionRun {
    id: string;
    agent_id: string;
    base_version: number;
    candidate_version: number;
    hypothesis: string;
    proposal: string;
    status: 'proposed' | 'accepted' | 'rejected' | 'rolled_back' | 'failed';
    baseline_score: number;
    candidate_score: number;
    evaluation: string;
    error: string;
    created_at: string;
    committed_at: string | null;
  }
  interface DiffLine { kind: 'same' | 'added' | 'removed'; text: string }

  let agents: AgentRow[] = [];
  let flows: Flow[] = [];
  let stats: Record<string, { total_runs: number; completed: number; failed: number; success_rate: number }> = {};
  let loading = true;
  let error = '';
  let filterText = '';

  // Selection state
  let selectedAgentId = '';
  let versions: PromptVersion[] = [];
  let activeVersion: number | null = null;
  let evolution: EvolutionRun[] = [];
  let loadingDetail = false;

  // Diff state
  let diffFrom: number | null = null;
  let diffTo: number | null = null;
  let diffLines: DiffLine[] = [];
  let diffLoading = false;

  // Evolution action in-flight
  let busyAction = '';

  onMount(load);

  async function load() {
    loading = true; error = '';
    try {
      const graphRes = await fetch('/api/agents/graph').then(r => r.json()) as {
        agents: AgentRow[];
        flows: Flow[];
        stats: typeof stats;
      };
      // Only LLM agents with an actual prompt can evolve — scripts (builtin
       // handlers) and empty-prompt rows have nothing for the reflection
       // loop to rewrite, so they'd clutter the sidebar.
      agents = (graphRes.agents ?? []).filter(a =>
        a.active !== 0
        && !((a.builtin_handler ?? '').trim())
        && !!((a.system_prompt ?? '').trim()),
      );
      flows = graphRes.flows ?? [];
      stats = graphRes.stats ?? {};
      if (!selectedAgentId && agents.length > 0) {
        await selectAgent(agents[0].id);
      }
    } catch (e) {
      error = `Error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      loading = false;
    }
  }

  async function selectAgent(id: string) {
    selectedAgentId = id;
    loadingDetail = true;
    diffFrom = null; diffTo = null; diffLines = [];
    try {
      const [v, e] = await Promise.all([
        listPromptVersions(id) as Promise<{ versions: PromptVersion[]; active_version: number | null }>,
        listEvolutionRuns(id) as Promise<{ evolution_runs: EvolutionRun[] }>,
      ]);
      versions = v.versions ?? [];
      activeVersion = v.active_version;
      evolution = e.evolution_runs ?? [];
      // Default diff = active vs previous
      if (versions.length >= 2) {
        const idx = versions.findIndex(x => x.version === activeVersion);
        if (idx >= 0 && idx + 1 < versions.length) {
          diffFrom = versions[idx + 1].version;
          diffTo = versions[idx].version;
          await refreshDiff();
        }
      }
    } catch (e) {
      error = `Load detail failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      loadingDetail = false;
    }
  }

  async function refreshDiff() {
    if (!selectedAgentId || diffFrom === null || diffTo === null) return;
    diffLoading = true;
    try {
      const res = await diffPromptVersions(selectedAgentId, diffFrom, diffTo) as { lines: DiffLine[] };
      diffLines = res.lines ?? [];
    } catch (e) {
      error = `Diff failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      diffLoading = false;
    }
  }

  async function doRestore(version: number) {
    if (!selectedAgentId) return;
    if (!confirm(`Restore system_prompt to v${version}? This creates a new version pointing at it.`)) return;
    busyAction = `restore:${version}`;
    try {
      await restorePromptVersion(selectedAgentId, version);
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `Restore failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busyAction = '';
    }
  }

  async function doActivate(version: number) {
    if (!selectedAgentId) return;
    busyAction = `activate:${version}`;
    try {
      await activatePromptVersion(selectedAgentId, version);
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `Activate failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busyAction = '';
    }
  }

  async function triggerReflection() {
    if (!selectedAgentId) return;
    busyAction = 'reflect';
    try {
      const res = await runEvolutionCycle(selectedAgentId, { dryRun: true }) as { triggered: boolean; reason?: string };
      if (!res.triggered) {
        alert(`No cycle triggered — ${res.reason ?? 'not enough failures'}`);
      }
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `Reflection failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busyAction = '';
    }
  }

  async function doAccept(runId: string) {
    busyAction = `accept:${runId}`;
    try {
      await acceptEvolution(runId);
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `Accept failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busyAction = '';
    }
  }

  async function doReject(runId: string) {
    busyAction = `reject:${runId}`;
    try {
      await rejectEvolution(runId);
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `Reject failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busyAction = '';
    }
  }

  function flowName(fid?: string): string {
    if (!fid) return '—';
    return flows.find(f => f.id === fid)?.name ?? '—';
  }

  function sourceBadgeVariant(src: PromptVersion['source']): string {
    if (src === 'reflection') return 'teal';
    if (src === 'restore') return 'gold';
    if (src === 'initial') return 'text-3';
    return 'blue';
  }

  function sourceLabel(src: PromptVersion['source']): string {
    if (src === 'reflection') return 'reflexión';
    if (src === 'restore') return 'restaurado';
    if (src === 'initial') return 'inicial';
    return 'manual';
  }

  function statusBadgeVariant(st: EvolutionRun['status']): string {
    if (st === 'accepted') return 'teal';
    if (st === 'rejected') return 'red';
    if (st === 'failed') return 'red';
    if (st === 'rolled_back') return 'gold';
    return 'blue';
  }

  function statusLabel(st: EvolutionRun['status']): string {
    if (st === 'accepted') return 'aceptada';
    if (st === 'rejected') return 'rechazada';
    if (st === 'failed') return 'fallida';
    if (st === 'rolled_back') return 'revertida';
    if (st === 'proposed') return 'propuesta';
    return st;
  }

  $: filtered = filterText
    ? agents.filter(a =>
        a.name.toLowerCase().includes(filterText.toLowerCase()) ||
        flowName(a.flow_id).toLowerCase().includes(filterText.toLowerCase()),
      )
    : agents;

  $: selectedAgent = agents.find(a => a.id === selectedAgentId) ?? null;
  $: totalVersions = versions.length;
  $: totalProposed = evolution.filter(e => e.status === 'proposed').length;
  $: totalAccepted = evolution.filter(e => e.status === 'accepted').length;
  $: evolvedAgents = agents.filter(a => {
    // A proxy: agents whose active_version > 1 would need a per-agent fetch.
    // Keep it simple — just show overall evolution count across visible selection.
    return true;
  }).length;
</script>

<ViewHeader
  title="Autogenesis"
  sub="Prompt version lineage and self-evolution · {agents.length} agents · {totalProposed} pending proposals · {totalAccepted} auto-committed"
>
  <input type="text" class="filter-input" placeholder="Filter agents…" bind:value={filterText} />
</ViewHeader>

{#if error}
  <div class="err-banner">{error} <button class="close" on:click={() => (error = '')}>×</button></div>
{/if}

{#if loading}
  <div class="loading-view">Loading agents…</div>
{:else}

<div class="kpi-row anim">
  <KpiCard label="Active agents" value={agents.length} accent="--blue" />
  <KpiCard label="Active prompt versions" value={totalVersions} sub="for the selected agent" accent="--teal" />
  <KpiCard label="Pending proposals" value={totalProposed} accent="--gold" color={totalProposed > 0 ? 'var(--gold)' : 'var(--text-2)'} />
  <KpiCard label="Auto-commiteadas" value={totalAccepted} accent="--teal" />
</div>

<div class="layout">
  <!-- Agent list -->
  <Panel title="Agents" dotColor="var(--blue)" cls="anim d1">
    <div class="agent-list">
      {#each filtered as a (a.id)}
        <button
          class="agent-item"
          class:selected={a.id === selectedAgentId}
          on:click={() => selectAgent(a.id)}
        >
          <div class="agent-main">
            <div class="agent-name">{a.name}</div>
            <div class="agent-sub">{flowName(a.flow_id)}</div>
          </div>
          {#if stats[a.id]}
            <div class="agent-stat">
              <span class="stat-ok">{stats[a.id].completed}</span>
              <span class="stat-sep">/</span>
              <span class="stat-fail">{stats[a.id].failed}</span>
            </div>
          {/if}
        </button>
      {/each}
      {#if filtered.length === 0}
        <div class="empty-list">Sin coincidencias.</div>
      {/if}
    </div>
  </Panel>

  <!-- Detail pane -->
  <div class="detail-col">
    {#if !selectedAgent}
      <Empty message="Select an agent on the left." />
    {:else}
      <Panel title="{selectedAgent.name}" dotColor="var(--teal)" cls="anim d2">
        <div class="agent-header">
          <div class="agent-meta">
            <div class="meta-item"><span class="meta-label">Provider</span><span class="meta-value">{selectedAgent.provider || '—'}</span></div>
            <div class="meta-item"><span class="meta-label">Modelo</span><span class="meta-value">{selectedAgent.model || '—'}</span></div>
            <div class="meta-item"><span class="meta-label">Office</span><span class="meta-value">{flowName(selectedAgent.flow_id)}</span></div>
            <div class="meta-item"><span class="meta-label">Active version</span><span class="meta-value">v{activeVersion ?? '—'}</span></div>
          </div>
          <button
            class="btn-sm btn-primary"
            disabled={busyAction === 'reflect'}
            on:click={triggerReflection}
            title="Run a full SEPL cycle (reflect → select → improve → evaluate) — dryRun by default, does not auto-commit."
          >
            {busyAction === 'reflect' ? 'Reflecting…' : '↻ Reflection cycle'}
          </button>
        </div>
      </Panel>

      <!-- Prompt versions -->
      <Panel title="Prompt lineage (RSPL)" dotColor="var(--blue)" cls="anim d3">
        {#if loadingDetail}
          <div class="loading-pad">Loading…</div>
        {:else if versions.length === 0}
          <Empty message="This agent has no versions (unusual)." />
        {:else}
          <div class="versions-table">
            <div class="vt-header">
              <span>v</span>
              <span>Fuente</span>
              <span>Creada</span>
              <span>Note</span>
              <span class="vt-actions">Actions</span>
            </div>
            {#each versions as v (v.id)}
              <div class="vt-row" class:vt-active={v.active === 1}>
                <span class="vt-ver">v{v.version}{#if v.parent_version > 0}<span class="vt-parent"> ← v{v.parent_version}</span>{/if}</span>
                <span><Badge text={sourceLabel(v.source)} variant={sourceBadgeVariant(v.source)} /></span>
                <span class="vt-time">{timeAgo(v.created_at)}</span>
                <span class="vt-note" title={v.note}>{v.note || '—'}</span>
                <span class="vt-actions">
                  <button
                    class="btn-xs"
                    on:click={() => { diffTo = v.version; if (diffFrom === null) diffFrom = v.version; refreshDiff(); }}
                    title="Use as the right-hand side of the diff"
                  >▶ diff</button>
                  <button
                    class="btn-xs"
                    on:click={() => { diffFrom = v.version; refreshDiff(); }}
                    title="Use as the left-hand side of the diff"
                  >◀ diff</button>
                  {#if v.active !== 1}
                    <button
                      class="btn-xs"
                      disabled={busyAction === `activate:${v.version}`}
                      on:click={() => doActivate(v.version)}
                    >activate</button>
                    <button
                      class="btn-xs btn-danger"
                      disabled={busyAction === `restore:${v.version}`}
                      on:click={() => doRestore(v.version)}
                      title="Restore creates a new version holding the contents of v{v.version}"
                    >restore</button>
                  {:else}
                    <span class="badge-active">● active</span>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </Panel>

      <!-- Diff -->
      {#if diffFrom !== null && diffTo !== null}
        <Panel title="Diff v{diffFrom} → v{diffTo}" dotColor="var(--gold)" cls="anim d4">
          {#if diffLoading}
            <div class="loading-pad">Comparing…</div>
          {:else if diffLines.length === 0}
            <div class="loading-pad">No differences.</div>
          {:else}
            <pre class="diff"><code>{#each diffLines as line}<span class="d-{line.kind}">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} {line.text}</span>
{/each}</code></pre>
          {/if}
        </Panel>
      {/if}

      <!-- Evolution runs -->
      <Panel title="Evolution runs (SEPL)" dotColor="var(--teal)" cls="anim d5">
        {#if evolution.length === 0}
          <Empty message="No reflection cycles recorded yet." />
        {:else}
          <div class="evo-list">
            {#each evolution as evo (evo.id)}
              <div class="evo-card">
                <div class="evo-head">
                  <Badge text={statusLabel(evo.status)} variant={statusBadgeVariant(evo.status)} />
                  <span class="evo-ver">v{evo.base_version} → v{evo.candidate_version || '·'}</span>
                  <span class="evo-time">{timeAgo(evo.created_at)}</span>
                  <span class="evo-scores">
                    base <strong>{evo.baseline_score.toFixed(1)}</strong> · cand <strong>{evo.candidate_score.toFixed(1)}</strong>
                    {#if evo.candidate_score > evo.baseline_score}
                      <span class="delta-plus">Δ+{(evo.candidate_score - evo.baseline_score).toFixed(1)}</span>
                    {:else if evo.candidate_score < evo.baseline_score}
                      <span class="delta-neg">Δ{(evo.candidate_score - evo.baseline_score).toFixed(1)}</span>
                    {/if}
                  </span>
                </div>
                {#if evo.hypothesis}
                  <div class="evo-line">
                    <span class="evo-label">Hipótesis</span>
                    <span class="evo-body">{evo.hypothesis}</span>
                  </div>
                {/if}
                {#if evo.evaluation}
                  <div class="evo-line">
                    <span class="evo-label">Juez</span>
                    <span class="evo-body">{evo.evaluation}</span>
                  </div>
                {/if}
                {#if evo.error}
                  <div class="evo-line evo-err">
                    <span class="evo-label">Error</span>
                    <span class="evo-body">{evo.error}</span>
                  </div>
                {/if}
                {#if evo.proposal}
                  <details class="evo-proposal">
                    <summary>Ver propuesta ({evo.proposal.length} chars)</summary>
                    <pre>{evo.proposal}</pre>
                  </details>
                {/if}
                {#if evo.status === 'proposed' || evo.status === 'rejected'}
                  {#if evo.candidate_version > 0}
                    <div class="evo-actions">
                      <button
                        class="btn-xs btn-primary"
                        disabled={busyAction === `accept:${evo.id}`}
                        on:click={() => doAccept(evo.id)}
                      >Aceptar & activar v{evo.candidate_version}</button>
                      {#if evo.status === 'proposed'}
                        <button
                          class="btn-xs"
                          disabled={busyAction === `reject:${evo.id}`}
                          on:click={() => doReject(evo.id)}
                        >Rechazar</button>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </Panel>
    {/if}
  </div>
</div>

{/if}

<style>
  :global(.view-header .view-title) { font-size: 20px; }
  :global(.view-header .view-sub) { font-size: 11px; }

  .filter-input {
    padding: 6px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 4px;
    font: 500 12px 'Fira Code', monospace;
    min-width: 240px;
  }

  .err-banner {
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid var(--red);
    color: var(--red);
    padding: 10px 14px;
    border-radius: 6px;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
  }
  .err-banner .close {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 18px; padding: 0 4px;
  }
  .loading-view { padding: 40px; text-align: center; color: var(--text-2); }
  .loading-pad { padding: 20px; color: var(--text-2); font: 500 12px 'Fira Code', monospace; }

  .layout {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 12px;
    align-items: start;
  }

  .detail-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

  .agent-list { display: flex; flex-direction: column; gap: 2px; max-height: 70vh; overflow-y: auto; }
  .agent-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 10px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 3px;
    cursor: pointer;
    text-align: left;
  }
  .agent-item:hover { background: var(--surface-2); }
  .agent-item.selected {
    background: var(--surface-3);
    border-left: 3px solid var(--teal);
  }
  .agent-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .agent-name { font: 700 12px 'Manrope', sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agent-sub { font: 500 10px 'Fira Code', monospace; color: var(--text-3); }
  .agent-stat { font: 600 10px 'Fira Code', monospace; white-space: nowrap; }
  .stat-ok { color: var(--teal); }
  .stat-fail { color: var(--red); }
  .stat-sep { color: var(--text-3); margin: 0 2px; }
  .empty-list { padding: 16px; color: var(--text-3); font-size: 12px; }

  .agent-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }
  .agent-meta {
    display: grid;
    grid-template-columns: repeat(4, auto);
    gap: 16px 24px;
  }
  .meta-item { display: flex; flex-direction: column; gap: 2px; }
  .meta-label { font: 600 9px 'Fira Code', monospace; color: var(--text-3); text-transform: uppercase; letter-spacing: 1px; }
  .meta-value { font: 600 12px 'Fira Code', monospace; color: var(--text-1); }

  .versions-table { display: flex; flex-direction: column; gap: 2px; }
  .vt-header,
  .vt-row {
    display: grid;
    grid-template-columns: 80px 90px 90px 1fr auto;
    gap: 8px;
    align-items: center;
    padding: 6px 8px;
    font: 500 11px 'Fira Code', monospace;
    border-radius: 3px;
  }
  .vt-header {
    color: var(--text-3);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 1px;
    border-bottom: 1px solid var(--border);
  }
  .vt-row {
    background: var(--surface-1);
    border: 1px solid var(--border);
  }
  .vt-row.vt-active {
    border-left: 3px solid var(--teal);
    background: var(--surface-2);
  }
  .vt-ver { font-weight: 700; color: var(--text-1); }
  .vt-parent { color: var(--text-3); font-weight: 400; }
  .vt-time { color: var(--text-2); }
  .vt-note { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vt-actions { display: flex; gap: 3px; justify-content: flex-end; }
  .badge-active { color: var(--teal); font-weight: 600; font-size: 10px; padding: 0 6px; }

  .btn-xs {
    padding: 3px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 3px;
    cursor: pointer;
    font: 600 10px 'Manrope', sans-serif;
  }
  .btn-xs:hover { background: var(--surface-3); }
  .btn-xs:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-xs.btn-primary { background: var(--gold); color: #1a1208; border-color: var(--gold); }
  .btn-xs.btn-danger { color: var(--red); border-color: rgba(239, 68, 68, 0.3); }
  .btn-xs.btn-danger:hover { background: rgba(239, 68, 68, 0.12); }

  .btn-sm {
    padding: 5px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 3px;
    cursor: pointer;
    font: 600 11px 'Manrope', sans-serif;
  }
  .btn-sm:hover { background: var(--surface-3); }
  .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm.btn-primary { background: var(--gold); color: #1a1208; border-color: var(--gold); }

  .diff {
    padding: 12px;
    background: var(--surface-2);
    border-radius: 4px;
    overflow: auto;
    max-height: 400px;
    font: 500 11px 'Fira Code', monospace;
    line-height: 1.55;
  }
  .diff code { display: block; }
  .diff .d-added { color: var(--teal); background: rgba(20, 184, 166, 0.08); display: block; }
  .diff .d-removed { color: var(--red); background: rgba(239, 68, 68, 0.08); display: block; text-decoration: line-through; opacity: 0.85; }
  .diff .d-same { color: var(--text-2); display: block; }

  .evo-list { display: flex; flex-direction: column; gap: 8px; }
  .evo-card {
    padding: 10px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .evo-head {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .evo-ver { font: 700 11px 'Fira Code', monospace; color: var(--text-1); }
  .evo-time { font-size: 10px; color: var(--text-3); }
  .evo-scores { margin-left: auto; font: 500 11px 'Fira Code', monospace; color: var(--text-2); }
  .evo-scores strong { color: var(--text-1); }
  .delta-plus { color: var(--teal); margin-left: 4px; font-weight: 700; }
  .delta-neg { color: var(--red); margin-left: 4px; font-weight: 700; }

  .evo-line { display: flex; gap: 8px; font-size: 12px; }
  .evo-label {
    font: 600 9px 'Fira Code', monospace;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 1px;
    flex-shrink: 0;
    width: 70px;
    padding-top: 2px;
  }
  .evo-body { color: var(--text-2); }
  .evo-err .evo-body { color: var(--red); }

  .evo-proposal summary {
    font: 600 10px 'Fira Code', monospace;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px 0;
  }
  .evo-proposal pre {
    padding: 10px;
    background: var(--surface-2);
    border-radius: 3px;
    max-height: 260px;
    overflow: auto;
    font: 500 11px 'Fira Code', monospace;
    color: var(--text-1);
    white-space: pre-wrap;
  }

  .evo-actions { display: flex; gap: 6px; }
</style>
