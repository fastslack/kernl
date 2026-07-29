<script lang="ts">
  import { onMount } from 'svelte';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import Empty from '$lib/components/Empty.svelte';

  interface Rank {
    id: string; name: string; level: number;
    insignia: string; color: string; description: string;
    active: number;
  }
  interface AgentRow {
    id: string; name: string; rank_id?: string;
    flow_id?: string; role?: string;
  }
  interface Flow { id: string; name: string; color: string; }

  let ranks: Rank[] = [];
  let agents: AgentRow[] = [];
  let flows: Flow[] = [];
  let loading = true;
  let error = '';

  // ── Create form state ─────────────────────────────
  let showCreate = false;
  let newName = '';
  let newLevel = 1;
  let newInsignia = '★';
  let newColor = '#eab308';
  let newDescription = '';

  // ── Inline edit tracking (single-row draft) ──────
  let editingId = '';
  let draft: Rank | null = null;
  let savingId = '';

  $: sortedRanks = [...ranks].sort((a, b) => b.level - a.level);
  $: agentsByRank = (() => {
    const map = new Map<string, AgentRow[]>();
    for (const a of agents) {
      const key = a.rank_id || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return map;
  })();
  $: unranked = agentsByRank.get('') ?? [];
  $: assignedCount = agents.length - unranked.length;

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      const [ranksRes, graphRes] = await Promise.all([
        fetch('/api/agents/ranks').then(r => r.json()),
        fetch('/api/agents/graph').then(r => r.json()),
      ]);
      ranks = ranksRes.ranks ?? [];
      agents = (graphRes.agents ?? []).filter((a: AgentRow) => (a as any).active !== 0);
      flows = graphRes.flows ?? [];
    } catch (e) {
      error = `Error loading: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      loading = false;
    }
  }

  // ── CRUD handlers ─────────────────────────────────

  async function createRank() {
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/agents/ranks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          level: newLevel,
          insignia: newInsignia,
          color: newColor,
          description: newDescription,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? res.statusText);
      }
      showCreate = false;
      newName = ''; newLevel = 1; newInsignia = '★'; newColor = '#eab308'; newDescription = '';
      await load();
    } catch (e) {
      error = `Create failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function beginEdit(rank: Rank) {
    editingId = rank.id;
    draft = { ...rank };
  }

  function cancelEdit() {
    editingId = '';
    draft = null;
  }

  async function saveEdit() {
    if (!editingId || !draft) return;
    const id = editingId;
    savingId = id;
    try {
      const res = await fetch(`/api/agents/ranks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name,
          level: draft.level,
          insignia: draft.insignia,
          color: draft.color,
          description: draft.description,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? res.statusText);
      }
      cancelEdit();
      await load();
    } catch (e) {
      error = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      savingId = '';
    }
  }

  async function deleteRank(rank: Rank) {
    const count = (agentsByRank.get(rank.id) ?? []).length;
    const msg = count > 0
      ? `Delete "${rank.name}"? ${count} agent(s) will be left without a rank.`
      : `Delete "${rank.name}"?`;
    if (!confirm(msg)) return;
    try {
      const res = await fetch(`/api/agents/ranks/${rank.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(res.statusText);
      await load();
    } catch (e) {
      error = `Delete failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function assignAgentRank(agentId: string, rankId: string) {
    try {
      const res = await fetch(`/api/agents/${agentId}/rank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rank_id: rankId }),
      });
      if (!res.ok) throw new Error(res.statusText);
      await load();
    } catch (e) {
      error = `Assign failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function flowName(fid?: string): string {
    if (!fid) return '';
    return flows.find(f => f.id === fid)?.name ?? '';
  }

  function onAssignChange(agentId: string, ev: Event) {
    const sel = ev.currentTarget as HTMLSelectElement;
    assignAgentRank(agentId, sel.value);
  }
</script>

<ViewHeader title="Ranks" sub="{ranks.length} ranks · {assignedCount} agents assigned · {unranked.length} unassigned">
  <button class="btn-primary" on:click={() => showCreate = !showCreate}>
    {showCreate ? '× Cancel' : '+ New rank'}
  </button>
</ViewHeader>

{#if error}
  <div class="err-banner">{error} <button class="close" on:click={() => error = ''}>×</button></div>
{/if}

{#if loading}
  <div class="loading-view">Loading ranks…</div>
{:else}

<div class="kpi-row anim">
  <KpiCard label="Total ranks" value={ranks.length} accent="--gold" color="var(--gold)" />
  <KpiCard label="Assigned agents" value={assignedCount} accent="--teal" color="var(--teal)" />
  <KpiCard label="No rank" value={unranked.length} accent="--red" color={unranked.length > 0 ? 'var(--red)' : 'var(--text-2)'} />
  <KpiCard label="Highest level" value={sortedRanks[0]?.name ?? '—'} sub="{sortedRanks[0] ? `level ${sortedRanks[0].level}` : ''}" />
</div>

{#if showCreate}
  <Panel title="New rank" dotColor="var(--gold)" cls="anim d1">
    <div class="form-grid">
      <label>
        <span>Nombre</span>
        <input type="text" bind:value={newName} placeholder="Ej: Coronel" />
      </label>
      <label>
        <span>Level (1 = lowest)</span>
        <input type="number" bind:value={newLevel} min="1" />
      </label>
      <label>
        <span>Insignia (glyph o emoji)</span>
        <input type="text" bind:value={newInsignia} placeholder="★★★" />
      </label>
      <label>
        <span>Color</span>
        <div class="color-row">
          <input type="color" bind:value={newColor} />
          <input type="text" bind:value={newColor} placeholder="#eab308" />
        </div>
      </label>
      <label class="span2">
        <span>Description</span>
        <input type="text" bind:value={newDescription} placeholder="Opcional" />
      </label>
      <div class="preview span2">
        <span class="preview-label">Preview:</span>
        <span class="badge-preview" style="background:{newColor}22;border-color:{newColor};color:{newColor};">
          <span class="insignia-text" style="text-shadow:0 0 8px {newColor}, 0 0 2px #000;">{newInsignia}</span>
          <span>{newName || 'Sin nombre'}</span>
          <span class="level-chip">L{newLevel}</span>
        </span>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-primary" on:click={createRank} disabled={!newName.trim()}>Crear</button>
      <button class="btn-ghost" on:click={() => showCreate = false}>Cancelar</button>
    </div>
  </Panel>
{/if}

<Panel title="Escalafón" dotColor="var(--blue)" cls="anim d2">
  {#if !sortedRanks.length}
    <Empty message="No ranks yet. Create the first one with the button above." />
  {:else}
    <div class="ladder">
      {#each sortedRanks as r (r.id)}
        {@const count = (agentsByRank.get(r.id) ?? []).length}
        {@const isEditing = editingId === r.id}
        <div class="rank-row" style="--rc:{r.color}">
          <div class="rank-badge" style="background:{r.color}22;border-color:{r.color};color:{r.color};">
            <div class="insignia-big" style="text-shadow:0 0 10px {r.color},0 0 3px #000;">{r.insignia || '·'}</div>
            <div class="level-tag">L{r.level}</div>
          </div>
          <div class="rank-main">
            {#if isEditing && draft}
              <div class="edit-grid">
                <input type="text" bind:value={draft.name} placeholder="Nombre" class="edit-name" />
                <input type="number" bind:value={draft.level} min="1" class="edit-level" title="Nivel" />
                <input type="text" bind:value={draft.insignia} placeholder="Insignia" class="edit-insignia" />
                <div class="color-row edit-color">
                  <input type="color" bind:value={draft.color} />
                  <input type="text" bind:value={draft.color} />
                </div>
                <input type="text" bind:value={draft.description} placeholder="Description" class="edit-desc" />
              </div>
              <div class="row-actions">
                <button class="btn-sm btn-primary" on:click={saveEdit} disabled={savingId === r.id}>
                  {savingId === r.id ? 'Saving…' : 'Save'}
                </button>
                <button class="btn-sm btn-ghost" on:click={cancelEdit}>Cancelar</button>
              </div>
            {:else}
              <div class="rank-info">
                <div class="rank-name">{r.name}</div>
                {#if r.description}<div class="rank-desc">{r.description}</div>{/if}
                <div class="rank-meta">
                  <span class="chip">#{count} agent{count === 1 ? '' : 's'}</span>
                  <span class="chip chip-color" style="background:{r.color}22;border-color:{r.color};color:{r.color};">{r.color}</span>
                </div>
              </div>
              <div class="row-actions">
                <button class="btn-sm" on:click={() => beginEdit(r)}>Edit</button>
                <button class="btn-sm btn-danger" on:click={() => deleteRank(r)}>Delete</button>
              </div>
            {/if}
            {#if count > 0 && !isEditing}
              <details class="agents-list">
                <summary>Agents with this rank ({count})</summary>
                <div class="agents-grid">
                  {#each (agentsByRank.get(r.id) ?? []) as a}
                    <div class="agent-chip">
                      <span class="agent-name">{a.name}</span>
                      {#if a.flow_id}<span class="agent-flow">{flowName(a.flow_id)}</span>{/if}
                      <select
                        class="agent-select"
                        value={r.id}
                        on:change={(ev) => onAssignChange(a.id, ev)}
                      >
                        <option value="">— no rank —</option>
                        {#each sortedRanks as opt}
                          <option value={opt.id}>{opt.name} (L{opt.level})</option>
                        {/each}
                      </select>
                    </div>
                  {/each}
                </div>
              </details>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</Panel>

{#if unranked.length > 0}
  <Panel title="No rank assigned ({unranked.length})" dotColor="var(--red)" cls="anim d3">
    <div class="agents-grid">
      {#each unranked as a}
        <div class="agent-chip">
          <span class="agent-name">{a.name}</span>
          {#if a.flow_id}<span class="agent-flow">{flowName(a.flow_id)}</span>{/if}
          <select
            class="agent-select"
            on:change={(ev) => onAssignChange(a.id, ev)}
          >
            <option value="">— assign rank —</option>
            {#each sortedRanks as opt}
              <option value={opt.id}>{opt.name} (L{opt.level})</option>
            {/each}
          </select>
        </div>
      {/each}
    </div>
  </Panel>
{/if}

{/if}

<style>
  /* Shrink the page title just on this route — unmounted with the page */
  :global(.view-header .view-title) { font-size: 20px; }
  :global(.view-header .view-sub) { font-size: 11px; }

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

  .btn-primary {
    background: var(--gold);
    color: #1a1208;
    border: none;
    padding: 6px 14px;
    border-radius: 5px;
    font: 600 12px 'Manrope', sans-serif;
    cursor: pointer;
  }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 6px 14px;
    border-radius: 5px;
    font: 600 12px 'Manrope', sans-serif;
    cursor: pointer;
  }
  .btn-sm {
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-1);
    cursor: pointer;
  }
  .btn-sm:hover { background: var(--surface-3); }
  .btn-sm.btn-primary { background: var(--gold); color: #1a1208; border-color: var(--gold); }
  .btn-sm.btn-ghost { background: transparent; color: var(--text-2); }
  .btn-sm.btn-danger { background: transparent; color: var(--red); border-color: var(--red); }
  .btn-sm.btn-danger:hover { background: rgba(239, 68, 68, 0.12); }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    padding: 4px 0;
  }
  .form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-2); }
  .form-grid .span2 { grid-column: 1 / -1; }
  .form-grid input[type="text"], .form-grid input[type="number"] {
    padding: 6px 10px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 4px;
    font: 500 12px 'Fira Code', monospace;
  }
  .color-row { display: flex; gap: 6px; align-items: center; }
  .color-row input[type="color"] { width: 36px; height: 28px; padding: 0; border: 1px solid var(--border); background: none; border-radius: 4px; cursor: pointer; }
  .color-row input[type="text"] { flex: 1; }

  .preview { display: flex; align-items: center; gap: 10px; padding-top: 6px; }
  .preview-label { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 1px; }
  .badge-preview {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid;
    font: 700 12px 'Manrope', sans-serif;
  }
  .insignia-text { font: 900 13px 'Manrope', sans-serif; letter-spacing: 1.5px; }
  .level-chip { font: 600 9px 'Fira Code', monospace; opacity: 0.7; }

  .form-actions { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); margin-top: 8px; }

  .ladder { display: flex; flex-direction: column; gap: 6px; }
  .rank-row {
    display: flex;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--rc);
    border-radius: 6px;
    background: var(--surface-1);
    transition: background 0.15s;
  }
  .rank-row:hover { background: var(--surface-2); }
  .rank-badge {
    min-width: 58px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border: 1px solid;
    border-radius: 5px;
    padding: 6px 5px;
    font: 700 10px 'Manrope', sans-serif;
  }
  .insignia-big { font: 900 16px 'Manrope', sans-serif; letter-spacing: 1.5px; line-height: 1; }
  .level-tag { font: 600 8px 'Fira Code', monospace; opacity: 0.75; margin-top: 2px; }

  .rank-main { flex: 1; display: flex; flex-direction: column; gap: 5px; }
  .rank-info { display: flex; flex-direction: column; gap: 2px; }
  .rank-name { font: 700 12px 'Manrope', sans-serif; color: var(--text-1); }
  .rank-desc { font-size: 10px; color: var(--text-3); }
  .rank-meta { display: flex; gap: 6px; margin-top: 3px; }
  .chip {
    font: 600 9px 'Fira Code', monospace;
    padding: 2px 7px;
    border-radius: 3px;
    background: var(--surface-3);
    border: 1px solid var(--border);
    color: var(--text-2);
  }
  .chip-color { border-width: 1px; }

  .edit-grid {
    display: grid;
    grid-template-columns: 2fr 60px 80px 1fr 2fr;
    gap: 6px;
  }
  .edit-grid input {
    padding: 4px 8px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 3px;
    font: 500 11px 'Fira Code', monospace;
  }

  .row-actions { display: flex; gap: 6px; margin-top: 4px; }

  .agents-list { margin-top: 4px; }
  .agents-list summary {
    cursor: pointer;
    font: 600 10px 'Fira Code', monospace;
    color: var(--text-3);
    padding: 4px 0;
  }
  .agents-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 8px;
    padding: 6px 0;
  }
  .agent-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11px;
  }
  .agent-name { color: var(--text-1); font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-flow { font: 500 10px 'Fira Code', monospace; color: var(--text-3); }
  .agent-select {
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-1);
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 10px;
    max-width: 140px;
  }
</style>
