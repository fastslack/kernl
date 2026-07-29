<script lang="ts">
  import { agents } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import Badge from '$lib/components/Badge.svelte';
  import { fmtTime, timeAgo } from '$lib/utils.js';
  import { runAgent, stopAgent, deleteAgent, createAgent, updateAgent } from '$lib/api.js';

  $: ag = ($agents as any);
  $: allAgents = ag?.agents ?? [];
  $: recentRuns = ag?.recentRuns ?? [];
  $: topAgents = ag?.topAgents ?? [];
  $: kpis = ag?.kpis ?? {};
  $: runsByStatus = ag?.runsByStatus ?? {};
  $: runsByTrigger = ag?.runsByTrigger ?? {};
  $: flows = ag?.flows ?? [];
  $: active = allAgents.filter((a: any) => a.enabled);
  $: showComposer = false;

  // ── Filters ──────────────────────────────────
  let filterCategory = 'all';
  let searchQuery = '';

  $: categories = (() => {
    // Source of truth for the filter: the list of offices (flows). We show
    // every existing office as a tab so filtering stays consistent even if a
    // flow has no active agents right now.
    const cats: Array<{ id: string; label: string; count: number; color?: string }> = [
      { id: 'all', label: 'All', count: allAgents.length },
    ];
    const countByFlow: Record<string, number> = {};
    let uncategorized = 0;
    for (const a of allAgents) {
      if (a.flow_name) countByFlow[a.flow_name] = (countByFlow[a.flow_name] || 0) + 1;
      else uncategorized++;
    }
    const sortedFlows = [...flows].sort((a: any, b: any) =>
      (a.name || '').localeCompare(b.name || ''));
    for (const f of sortedFlows) {
      cats.push({
        id: `flow:${f.name}`,
        label: f.name,
        count: countByFlow[f.name] || 0,
        color: f.color,
      });
    }
    if (uncategorized > 0) {
      cats.push({ id: 'uncategorized', label: 'Custom', count: uncategorized });
    }
    return cats;
  })();

  $: filteredAgents = allAgents.filter((a: any) => {
    // Category filter
    if (filterCategory === 'all') { /* pass */ }
    else if (filterCategory === 'uncategorized') { if (a.flow_name) return false; }
    else if (filterCategory.startsWith('flow:')) { if (a.flow_name !== filterCategory.slice(5)) return false; }

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const name = (a.name || '').toLowerCase();
      const desc = (a.description || '').toLowerCase();
      if (!name.includes(q) && !desc.includes(q)) return false;
    }
    return true;
  });

  $: runningAgentIds = new Set(
    recentRuns
      .filter((r: any) => r.status === 'running' || r.status === 'pending')
      .map((r: any) => r.agent_id)
  );

  let stoppingIds = new Set<string>();

  // ── Detail panel state ──────────────────────
  type DetailView = 'overview' | 'agent' | 'run';
  let detailView: DetailView = 'overview';
  let selectedAgent: any = null;
  let selectedAgentRuns: any[] = [];
  let selectedRun: any = null;
  let selectedRunSteps: any[] = [];
  let loadingDetail = false;

  async function selectAgent(agent: any) {
    selectedAgent = agent;
    selectedRun = null;
    selectedRunSteps = [];
    detailView = 'agent';
    loadingDetail = true;
    try {
      const data = await rpcOrCall('agents.detail', { id: agent.id }, async () => {
        const res = await fetch(`/api/agents/${agent.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      selectedAgent = data.agent ?? agent;
      selectedAgentRuns = data.runs ?? [];
    } catch { selectedAgentRuns = []; }
    loadingDetail = false;
  }

  async function selectRun(run: any) {
    selectedRun = run;
    detailView = 'run';
    loadingDetail = true;
    try {
      const data = await rpcOrCall('agents.runs.detail', { id: run.id }, async () => {
        const res = await fetch(`/api/agents/runs/${run.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      selectedRun = data.run ?? run;
      selectedRunSteps = data.steps ?? [];
    } catch { selectedRunSteps = []; }
    loadingDetail = false;
  }

  function backToOverview() {
    detailView = 'overview';
    selectedAgent = null;
    selectedRun = null;
    selectedRunSteps = [];
  }

  function backToAgent() {
    selectedRun = null;
    selectedRunSteps = [];
    detailView = 'agent';
  }

  // ── Preview Prompt (A/B lexical vs semantic) ─────────────────
  // Calls /api/agents/:id/preview-prompt twice in parallel (one per mode)
  // and renders the two result sets side-by-side. No LLM call, no run created.
  let showPreview = false;
  let previewGoal = '';
  let previewLoading = false;
  let previewError = '';
  let previewSemantic: any = null;
  let previewLexical: any = null;

  function openPreview() {
    if (!selectedAgent) return;
    previewError = '';
    previewSemantic = null;
    previewLexical = null;
    // Prefill with the agent's goal_template (resolved if it has placeholders)
    // so the user can hit Run immediately to see the default-case ranking.
    previewGoal = selectedAgent.goal_template || '';
    showPreview = true;
  }

  async function runPreview() {
    if (!selectedAgent) return;
    const goal = (previewGoal || '').trim();
    if (!goal) { previewError = 'goal required'; return; }
    previewLoading = true;
    previewError = '';
    try {
      const fetchMode = (mode: 'semantic' | 'lexical') =>
        fetch(`/api/agents/${selectedAgent.id}/preview-prompt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            goal,
            force_mode: mode,
            memory_pool: 100,
            memory_limit: 12,
            learnings_limit: 10,
            similar_runs_limit: 5,
          }),
        }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
      const [sem, lex] = await Promise.all([fetchMode('semantic'), fetchMode('lexical')]);
      previewSemantic = sem;
      previewLexical = lex;
    } catch (err) {
      previewError = err instanceof Error ? err.message : String(err);
    } finally {
      previewLoading = false;
    }
  }

  function closePreview() {
    showPreview = false;
    previewLoading = false;
  }

  // Fast set lookup so the UI can flag items present in one column but not the other.
  function idsFromBlocks(blocks: any, key: 'memory' | 'learnings' | 'similar_runs'): Set<string> {
    if (!blocks?.[key]) return new Set();
    return new Set(blocks[key].map((x: any) =>
      key === 'memory' ? `${x.role}|${x.created_at}` : x.id,
    ));
  }

  let copyStatus: 'idle' | 'copied' | 'error' = 'idle';
  let copyStatusTimer: ReturnType<typeof setTimeout> | null = null;

  function buildRunHistoryText(): string {
    if (!selectedRun) return '';
    const r: any = selectedRun;
    const lines: string[] = [];
    lines.push('═══════════════════════════════════════════');
    lines.push(`AGENT RUN HISTORY`);
    lines.push('═══════════════════════════════════════════');
    lines.push(`Agent      : ${r.agent_name ?? r.agent_id ?? '?'}`);
    lines.push(`Run ID     : ${r.id ?? '?'}`);
    lines.push(`Status     : ${r.status}`);
    lines.push(`Trigger    : ${r.trigger_type ?? '—'}`);
    lines.push(`Created    : ${r.created_at ?? '?'}`);
    lines.push(`Started    : ${r.started_at ?? '—'}`);
    lines.push(`Completed  : ${r.completed_at ?? '—'}`);
    lines.push(`Steps      : ${r.steps_count ?? selectedRunSteps.length}`);
    lines.push(`Tokens     : ${r.tokens_used ?? 0}`);
    if (r.goal) {
      lines.push('');
      lines.push('─── GOAL ─────────────────────────────────────');
      lines.push(String(r.goal));
    }
    if (r.result) {
      lines.push('');
      lines.push('─── RESULT ───────────────────────────────────');
      lines.push(String(r.result));
    }
    if (r.error) {
      lines.push('');
      lines.push('─── ERROR ────────────────────────────────────');
      lines.push(String(r.error));
    }
    if (selectedRunSteps.length) {
      lines.push('');
      lines.push(`─── STEPS (${selectedRunSteps.length}) ─────────────────────────────`);
      selectedRunSteps.forEach((s: any, i: number) => {
        const head = `[${i + 1}] ${s.type}` + (s.tool_name ? `: ${s.tool_name}` : '');
        const tokens = s.tokens_used ? ` (${s.tokens_used} tokens)` : '';
        lines.push('');
        lines.push(head + tokens);
        if (s.tool_input !== undefined && s.tool_input !== null && s.tool_input !== '') {
          const inputStr = typeof s.tool_input === 'string' ? s.tool_input : JSON.stringify(s.tool_input, null, 2);
          lines.push(`  input: ${inputStr}`);
        }
        if (s.content !== undefined && s.content !== null && s.content !== '') {
          const contentStr = typeof s.content === 'string' ? s.content : JSON.stringify(s.content, null, 2);
          lines.push(`  ${contentStr}`);
        }
        if (s.created_at) lines.push(`  @ ${s.created_at}`);
      });
    }
    lines.push('');
    lines.push('═══════════════════════════════════════════');
    return lines.join('\n');
  }

  async function copyRunHistory() {
    const text = buildRunHistoryText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyStatus = 'copied';
    } catch {
      // Fallback — legacy execCommand path
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copyStatus = 'copied';
      } catch {
        copyStatus = 'error';
      }
    }
    if (copyStatusTimer) clearTimeout(copyStatusTimer);
    copyStatusTimer = setTimeout(() => { copyStatus = 'idle'; }, 2000);
  }

  // Composer state
  let name = '', description = '', model = '', providerType = 'anthropic', trigger = 'manual', schedule = '', prompt = '';
  let creating = false;
  let composerError = '';

  async function doRunAgent(id: string) {
    try { await runAgent(id); }
    catch (e: any) { alert('Error: ' + e.message); }
  }

  async function doStopAgent(id: string) {
    stoppingIds.add(id);
    stoppingIds = stoppingIds;
    try { await stopAgent(id); }
    catch (e: any) { alert('Error stopping: ' + e.message); }
    finally { stoppingIds.delete(id); stoppingIds = stoppingIds; }
  }

  async function doDeleteAgent(id: string) {
    if (!confirm('Delete this agent?')) return;
    try { await deleteAgent(id); backToOverview(); }
    catch (e: any) { alert('Error: ' + e.message); }
  }

  // REVISION resolution:
  //   accept = keep this agent, just clear the review flag (it's not actually a duplicate)
  //   reject = deactivate this agent (soft delete — DB row stays for rollback)
  async function doAcceptRevision(id: string, name: string) {
    if (!confirm(`Keep "${name}"? This clears the REVISION flag and leaves the agent running as-is.`)) return;
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ under_revision: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e: any) { alert('Error: ' + e.message); }
  }

  async function doRejectRevision(id: string, name: string) {
    if (!confirm(`Reject "${name}"? It will be DEACTIVATED (active=0). The row stays in the DB so you can re-enable it later.`)) return;
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false, under_revision: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e: any) { alert('Error: ' + e.message); }
  }

  async function doCreateAgent() {
    creating = true; composerError = '';
    try {
      await createAgent({ name, description, model, providerType, trigger, schedule, prompt, enabled: true });
      showComposer = false;
      name = ''; description = ''; model = ''; prompt = '';
    } catch (e: any) {
      composerError = e.message;
    } finally { creating = false; }
  }

  function fmtTokens(n: number): string {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1_000_000).toFixed(1) + 'M';
  }

  function statusColor(s: string): string {
    if (s === 'completed') return 'var(--green)';
    if (s === 'failed') return 'var(--red)';
    if (s === 'running') return 'var(--teal)';
    return 'var(--text-3)';
  }

  function duration(start: string, end: string): string {
    if (!start || !end) return '—';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function parseTools(raw: string): string[] {
    try {
      const p = JSON.parse(raw || '[]');
      if (typeof p === 'string') return JSON.parse(p);
      return Array.isArray(p) ? p : [];
    } catch { return []; }
  }

  // ── Procedural skills attached to the selected agent ──
  // Skills come from /api/extensions?type=skill&status=active. The agent's
  // skills_json is a JSON array of slugs. We let the user attach/detach via
  // a modal (multi-select with search) and persist via PUT /api/agents/:id.

  interface SkillItem {
    id: string;
    slug: string;
    name: string;
    manifest: { description?: string; long_description?: string } | null;
    install_receipt: { source?: { type?: string; url?: string } } | null;
  }
  let installedSkills: SkillItem[] = [];
  let installedSkillsLoaded = false;
  let showSkillsPicker = false;
  let skillsPickerSearch = '';
  let savingSkills = false;

  async function loadInstalledSkills(): Promise<void> {
    if (installedSkillsLoaded) return;
    try {
      const r = await fetch('/api/extensions?type=skill&status=active');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      installedSkills = (body.items ?? []) as SkillItem[];
      installedSkillsLoaded = true;
    } catch (e) {
      console.warn('Failed to load installed skills', e);
    }
  }

  function getAttachedSkills(agent: any): string[] {
    if (!agent?.skills_json) return [];
    try {
      const p = JSON.parse(agent.skills_json);
      return Array.isArray(p) ? p.map(String) : [];
    } catch { return []; }
  }

  async function attachSkill(slug: string): Promise<void> {
    if (!selectedAgent) return;
    const current = new Set(getAttachedSkills(selectedAgent));
    current.add(slug);
    await persistSkills([...current]);
  }

  async function detachSkill(slug: string): Promise<void> {
    if (!selectedAgent) return;
    const current = getAttachedSkills(selectedAgent).filter((s) => s !== slug);
    await persistSkills(current);
  }

  async function persistSkills(skills: string[]): Promise<void> {
    if (!selectedAgent) return;
    savingSkills = true;
    try {
      await updateAgent(selectedAgent.id, { skills });
      // Reflect locally without a full re-fetch.
      selectedAgent = { ...selectedAgent, skills_json: JSON.stringify(skills) };
    } catch (e) {
      alert(`Failed to save skills: ${(e as Error).message}`);
    } finally {
      savingSkills = false;
    }
  }

  async function openSkillsPicker(): Promise<void> {
    await loadInstalledSkills();
    showSkillsPicker = true;
  }

  function estimateTokens(s: SkillItem): number {
    const body = s.manifest?.long_description ?? '';
    const desc = s.manifest?.description ?? '';
    return Math.ceil((body.length + desc.length) / 4);
  }

  $: filteredSkillsForPicker = (() => {
    const attached = selectedAgent ? new Set(getAttachedSkills(selectedAgent)) : new Set();
    const q = skillsPickerSearch.toLowerCase().trim();
    return installedSkills.filter((s) => {
      const hay = `${s.slug} ${s.name} ${s.manifest?.description ?? ''}`.toLowerCase();
      return !q || hay.includes(q);
    }).map((s) => ({ ...s, attached: attached.has(s.slug) }));
  })();

  // Slugs whose description tile is currently flipped open. Set + reassign
  // pattern so Svelte's reactivity catches the change.
  let expandedSkillSlugs: Set<string> = new Set();
  function toggleSkillExpand(slug: string): void {
    const next = new Set(expandedSkillSlugs);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    expandedSkillSlugs = next;
  }

  function stepIcon(type: string): string {
    if (type === 'tool_call') return '⚙';
    if (type === 'tool_result') return '←';
    if (type === 'thinking') return '💭';
    if (type === 'response') return '💬';
    return '·';
  }
</script>

{#if showComposer}
  <div class="compose-overlay" on:click|self={() => showComposer = false} role="presentation">
    <div class="compose-modal">
      <h3>New Agent</h3>
      <div class="compose-row"><label>Name</label><input class="search-input" bind:value={name} placeholder="My Agent" /></div>
      <div class="compose-row"><label>Description</label><input class="search-input" bind:value={description} placeholder="What does this agent do?" /></div>
      <div class="compose-row">
        <label>Provider</label>
        <select class="search-input" bind:value={providerType}>
          {#each ['anthropic','openai','lmstudio'] as p}<option value={p}>{p}</option>{/each}
        </select>
      </div>
      <div class="compose-row"><label>Model (optional)</label><input class="search-input" bind:value={model} placeholder="Leave blank for default" /></div>
      <div class="compose-row">
        <label>Trigger</label>
        <select class="search-input" bind:value={trigger}>
          {#each ['manual','schedule','event'] as t}<option value={t}>{t}</option>{/each}
        </select>
      </div>
      {#if trigger === 'schedule'}
        <div class="compose-row"><label>Schedule (cron)</label><input class="search-input" bind:value={schedule} placeholder="0 9 * * *" /></div>
      {/if}
      <div class="compose-row">
        <label>System Prompt</label>
        <textarea class="editor-textarea" bind:value={prompt} style="min-height:120px" placeholder="You are..."></textarea>
      </div>
      {#if composerError}<div style="color:var(--red);font-size:12px;margin-bottom:10px">{composerError}</div>{/if}
      <div class="compose-actions">
        <button class="compose-btn-cancel" on:click={() => showComposer = false}>Cancel</button>
        <button class="compose-btn-send" on:click={doCreateAgent} disabled={creating}>{creating ? 'Creating...' : 'Create Agent'}</button>
      </div>
    </div>
  </div>
{/if}

<div class="ag-page">
  <!-- Header -->
  <div class="ag-header">
    <div class="ag-header-left">
      <h1 class="ag-title">Agents</h1>
      <span class="ag-count">{allAgents.length}</span>
    </div>
    <div class="ag-header-right">
      <a href="/agents-flow" class="ag-btn ag-btn-ghost">Flow</a>
      <button type="button" class="ag-btn ag-btn-primary" on:click={() => showComposer = true}>+ New</button>
    </div>
  </div>

  {#if !ag}
    <div class="ag-loading">Loading agents...</div>
  {:else}
    <!-- KPI Row -->
    <div class="ag-kpis">
      <div class="ag-kpi">
        <span class="ag-kpi-val" style="color:var(--blue)">{kpis.totalAgents ?? allAgents.length}</span>
        <span class="ag-kpi-lbl">Total</span>
      </div>
      <div class="ag-kpi">
        <span class="ag-kpi-val" style="color:var(--green)">{kpis.activeAgents ?? active.length}</span>
        <span class="ag-kpi-lbl">Active</span>
      </div>
      <div class="ag-kpi">
        <span class="ag-kpi-val" style="color:var(--gold)">{kpis.runsToday ?? 0}</span>
        <span class="ag-kpi-lbl">Runs Today</span>
      </div>
      <div class="ag-kpi">
        <span class="ag-kpi-val" style="color:var(--green)">{kpis.completedRuns ?? 0}</span>
        <span class="ag-kpi-lbl">Completed</span>
      </div>
      <div class="ag-kpi">
        <span class="ag-kpi-val" style="color:var(--red)">{kpis.failedRuns ?? 0}</span>
        <span class="ag-kpi-lbl">Failed</span>
      </div>
      <div class="ag-kpi">
        <span class="ag-kpi-val" style="color:var(--teal)">{fmtTokens(kpis.totalTokens ?? 0)}</span>
        <span class="ag-kpi-lbl">Tokens</span>
      </div>
    </div>

    <!-- Main Grid -->
    <div class="ag-grid">
      <!-- Left: Agent List -->
      <div class="ag-panel">
        <div class="ag-panel-header">
          <span class="ag-panel-dot" style="background:var(--blue)"></span>
          <span class="ag-panel-title">Agents</span>
          <span class="ag-panel-count">{filteredAgents.length}/{allAgents.length}</span>
        </div>
        <!-- Category Tabs + Search -->
        <div class="ag-filters">
          <div class="ag-categories">
            {#each categories as cat}
              <button
                class="ag-cat"
                class:ag-cat-active={filterCategory === cat.id}
                on:click={() => filterCategory = cat.id}
              >
                {#if cat.color}<span class="ag-cat-dot" style="background:{cat.color}"></span>{/if}
                {cat.label}<span class="ag-cat-count">{cat.count}</span>
              </button>
            {/each}
          </div>
          <input
            class="ag-search"
            type="text"
            placeholder="Search..."
            bind:value={searchQuery}
          />
        </div>
        <div class="ag-panel-body">
          {#if !filteredAgents.length}
            <div class="ag-empty">
              <div class="ag-empty-text">{allAgents.length ? 'No matches' : 'No agents yet'}</div>
              <div class="ag-empty-sub">{allAgents.length ? 'Try a different filter' : 'Create one to get started'}</div>
            </div>
          {:else}
            {#each filteredAgents as agent}
              {@const running = runningAgentIds.has(agent.id)}
              <button
                class="ag-card"
                class:ag-card-running={running}
                class:ag-card-disabled={!agent.enabled}
                class:ag-card-selected={selectedAgent?.id === agent.id && detailView !== 'overview'}
                on:click={() => selectAgent(agent)}
              >
                <div class="ag-card-main">
                  <div class="ag-card-indicator" class:active={agent.enabled} class:running></div>
                  <div class="ag-card-body">
                    <div class="ag-card-top">
                      <span class="ag-card-name">{agent.name}</span>
                      <div class="ag-card-badges">
                        {#if agent.builtin_handler?.startsWith('script:')}<Badge text="script" variant="green" />
                        {:else if agent.builtin_handler?.startsWith('check:')}<Badge text="check" variant="gold" />
                        {:else if agent.builtin_handler?.startsWith('proactive:')}<Badge text="proactive" variant="blue" />
                        {:else if !agent.builtin_handler}<Badge text="llm" variant="teal" />{/if}
                        {#if agent.under_revision}<Badge text="REVISION" variant="orange" />{/if}
                        {#if agent.cron}<span class="ag-card-cron">{agent.cron}</span>{/if}
                        {#if running}<Badge text="running" variant="high" />{/if}
                      </div>
                    </div>
                    {#if agent.description}
                      <div class="ag-card-desc">{agent.description}</div>
                    {/if}
                    <div class="ag-card-meta">
                      {#if agent.providerType}<span>{agent.providerType}</span>{/if}
                      {#if agent.model}<span class="mono">{agent.model}</span>{/if}
                      {#if agent.last_run_at}<span>Last: {fmtTime(agent.last_run_at)}</span>{/if}
                    </div>
                  </div>
                  <div class="ag-card-actions">
                    {#if agent.under_revision}
                      <button type="button" class="ag-act ag-act-accept" on:click|stopPropagation={() => doAcceptRevision(agent.id, agent.name)} title="Accept — clear REVISION, keep agent">✓</button>
                      <button type="button" class="ag-act ag-act-reject" on:click|stopPropagation={() => doRejectRevision(agent.id, agent.name)} title="Reject — deactivate (rollback-safe)">✗</button>
                    {/if}
                    {#if running || stoppingIds.has(agent.id)}
                      <button type="button" class="ag-act ag-act-stop" on:click|stopPropagation={() => doStopAgent(agent.id)} disabled={stoppingIds.has(agent.id)}>
                        {stoppingIds.has(agent.id) ? '...' : '■'}
                      </button>
                    {:else}
                      <button type="button" class="ag-act ag-act-run" on:click|stopPropagation={() => doRunAgent(agent.id)} title="Run">▶</button>
                    {/if}
                    <button type="button" class="ag-act ag-act-del" on:click|stopPropagation={() => doDeleteAgent(agent.id)} title="Delete">✕</button>
                  </div>
                </div>
              </button>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Right Column -->
      <div class="ag-right">
        {#if detailView === 'agent' && selectedAgent}
          <!-- ═══ Agent Detail ═══ -->
          <div class="ag-panel ag-panel-detail">
            <div class="ag-panel-header">
              <button class="back-btn" on:click={backToOverview}>←</button>
              <span class="ag-panel-title">{selectedAgent.name}</span>
              <span class="ag-panel-dot" style="background:{selectedAgent.active ? 'var(--green)' : 'var(--surface-3)'}"></span>
            </div>
            <div class="ag-panel-body">
              {#if loadingDetail}
                <div class="ag-empty"><div class="ag-empty-sub">Loading...</div></div>
              {:else}
                <!-- Config -->
                <div class="detail-section">
                  <div class="detail-grid">
                    <div class="detail-item">
                      <span class="detail-label">Provider</span>
                      <span class="detail-value">{selectedAgent.provider || 'default'}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Model</span>
                      <span class="detail-value mono">{selectedAgent.model || 'default'}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Max Iter</span>
                      <span class="detail-value">{selectedAgent.max_iterations}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Timeout</span>
                      <span class="detail-value">{(selectedAgent.timeout_ms / 1000).toFixed(0)}s</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Max Tokens</span>
                      <span class="detail-value">{fmtTokens(selectedAgent.max_tokens ?? 0)}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Max Errors</span>
                      <span class="detail-value">{selectedAgent.max_errors ?? 3}</span>
                    </div>
                  </div>
                </div>

                {#if selectedAgent.description}
                  <div class="detail-section">
                    <h4 class="detail-heading">Description</h4>
                    <div class="detail-text">{selectedAgent.description}</div>
                  </div>
                {/if}

                {#if selectedAgent.system_prompt}
                  <div class="detail-section">
                    <h4 class="detail-heading">System Prompt</h4>
                    <div class="detail-code">{selectedAgent.system_prompt}</div>
                  </div>
                {/if}

                {#if selectedAgent.goal_template}
                  <div class="detail-section">
                    <h4 class="detail-heading">Goal Template</h4>
                    <div class="detail-code">{selectedAgent.goal_template}</div>
                  </div>
                {/if}

                <!-- Preview Prompt (A/B lexical vs semantic ranking) -->
                <div class="detail-section">
                  <button class="ag-btn ag-btn-ghost" on:click={openPreview} title="Compare what memory/learnings the executor would inject under lexical vs semantic ranking — without running the LLM.">
                    🔍 Preview prompt (A/B lexical vs semantic)
                  </button>
                </div>

                {@const tools = parseTools(selectedAgent.allowed_tools)}
                {#if tools.length}
                  <div class="detail-section">
                    <h4 class="detail-heading">Allowed Tools</h4>
                    <div class="tool-tags">
                      {#each tools as t}<span class="tool-tag">{t}</span>{/each}
                    </div>
                  </div>
                {/if}

                <!-- Procedural skills attached to this agent. Each slug surfaces
                     in the agent's system_prompt as a one-line index entry; the
                     model loads bodies on demand via kernel_skill_load. -->
                {@const attachedSkills = getAttachedSkills(selectedAgent)}
                <div class="detail-section">
                  <div class="skills-section-head">
                    <h4 class="detail-heading">
                      ✦ Skills (procedural)
                      {#if attachedSkills.length}
                        <span class="skills-count-badge">{attachedSkills.length}</span>
                      {/if}
                    </h4>
                    <button class="ag-btn ag-btn-ghost ag-btn-sm" on:click={openSkillsPicker}>
                      + Attach skill
                    </button>
                  </div>
                  {#if attachedSkills.length === 0}
                    <p class="skills-empty">
                      No skills attached. Skills are markdown playbooks loaded on demand —
                      add some from <a href="/extensions">/extensions</a> first, then attach here.
                    </p>
                  {:else}
                    <div class="skills-tags">
                      {#each attachedSkills as slug}
                        <span class="skill-chip">
                          <span class="skill-chip-glyph">✦</span>
                          {slug}
                          <button class="skill-chip-x" title="Detach"
                                  on:click={() => detachSkill(slug)}
                                  disabled={savingSkills}>×</button>
                        </span>
                      {/each}
                    </div>
                    <p class="skills-hint">
                      The model sees a one-line description for each skill in its system_prompt
                      and loads the full body via <code>kernel_skill_load</code> when triggered.
                    </p>
                  {/if}
                </div>

                {#if showSkillsPicker}
                  <div class="picker-scrim" role="presentation"
                       on:click={() => (showSkillsPicker = false)}
                       on:keydown={(e) => e.key === 'Escape' && (showSkillsPicker = false)}></div>
                  <aside class="skills-picker" role="dialog" aria-modal="true">
                    <header class="skills-picker-head">
                      <h3>Attach skills to {selectedAgent.name}</h3>
                      <button class="drawer-close" on:click={() => (showSkillsPicker = false)} aria-label="Close">×</button>
                    </header>
                    <input class="skills-picker-search" type="text"
                           bind:value={skillsPickerSearch}
                           placeholder="Search by slug or description…" />
                    <div class="skills-picker-list">
                      {#if filteredSkillsForPicker.length === 0}
                        <p class="skills-empty">
                          {installedSkills.length === 0
                            ? 'No installed skills yet. Subscribe to a repo in /extensions first.'
                            : 'No matches.'}
                        </p>
                      {:else}
                        <div class="skill-tiles">
                          {#each filteredSkillsForPicker as s (s.id)}
                            {@const expanded = expandedSkillSlugs.has(s.slug)}
                            <div class="skill-tile"
                                 class:skill-tile-attached={s.attached}
                                 class:skill-tile-expanded={expanded}>

                              {#if !expanded}
                                <button class="skill-tile-front"
                                        disabled={savingSkills}
                                        on:click={() => s.attached ? detachSkill(s.slug) : attachSkill(s.slug)}
                                        title={s.attached ? 'Detach' : 'Attach'}>
                                  {#if s.attached}
                                    <span class="skill-tile-corner" aria-hidden="true">
                                      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                        <polyline points="3 8.5 6.5 12 13 4.5"></polyline>
                                      </svg>
                                    </span>
                                  {/if}
                                  <span class="skill-tile-name">{s.slug}</span>
                                  <span class="skill-tile-foot">
                                    <span class="skill-tile-tok mono">{estimateTokens(s)}t</span>
                                    {#if s.install_receipt?.source?.type === 'git'}
                                      <span class="skill-tile-src">git</span>
                                    {/if}
                                  </span>
                                </button>

                                <button class="skill-tile-info"
                                        type="button"
                                        on:click|stopPropagation={() => toggleSkillExpand(s.slug)}
                                        aria-label="Show description"
                                        title="Show description">
                                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4">
                                    <circle cx="8" cy="8" r="6.5"></circle>
                                    <line x1="8" y1="7" x2="8" y2="11.5" stroke-linecap="round"></line>
                                    <circle cx="8" cy="4.6" r="0.9" fill="currentColor" stroke="none"></circle>
                                  </svg>
                                </button>
                              {:else}
                                <div class="skill-tile-back">
                                  <button class="skill-tile-close"
                                          type="button"
                                          on:click|stopPropagation={() => toggleSkillExpand(s.slug)}
                                          aria-label="Close description">×</button>
                                  <div class="skill-tile-back-name">{s.slug}</div>
                                  <div class="skill-tile-back-text">
                                    {s.manifest?.description ?? '(no description)'}
                                  </div>
                                </div>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <footer class="skills-picker-foot">
                      <span class="mono">{filteredSkillsForPicker.filter(s => s.attached).length} attached · {installedSkills.length} installed</span>
                      <button class="ag-btn" on:click={() => (showSkillsPicker = false)}>Done</button>
                    </footer>
                  </aside>
                {/if}

                {@const vars = selectedAgent.variables ? (() => { try { return Object.entries(JSON.parse(selectedAgent.variables)); } catch { return []; } })() : []}
                {#if vars.length}
                  <div class="detail-section">
                    <h4 class="detail-heading">Variables</h4>
                    {#each vars as [k, v]}
                      <div class="var-item"><strong>{k}:</strong> <code>{v}</code></div>
                    {/each}
                  </div>
                {/if}

                <!-- Agent's Runs -->
                {#if selectedAgentRuns.length}
                  <div class="detail-section">
                    <h4 class="detail-heading">Runs ({selectedAgentRuns.length})</h4>
                    {#each selectedAgentRuns as run}
                      <button class="run-card" on:click={() => selectRun(run)}>
                        <span class="run-dot" style="background:{statusColor(run.status)}"></span>
                        <span class="run-card-status" style="color:{statusColor(run.status)}">{run.status}</span>
                        <span class="run-card-steps mono">{run.steps_count} steps</span>
                        <span class="run-card-tokens mono">{fmtTokens(run.tokens_used)}</span>
                        <span class="run-card-time">{timeAgo(run.created_at)}</span>
                        <span class="run-card-arrow">›</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              {/if}
            </div>
          </div>

        {:else if detailView === 'run' && selectedRun}
          <!-- ═══ Run Detail ═══ -->
          <div class="ag-panel ag-panel-detail">
            <div class="ag-panel-header">
              <button class="back-btn" on:click={backToAgent}>←</button>
              <span class="ag-panel-title">Run Detail</span>
              <span class="run-dot" style="background:{statusColor(selectedRun.status)}"></span>
              <div style="flex:1"></div>
              <button
                class="copy-history-btn"
                class:copied={copyStatus === 'copied'}
                class:errored={copyStatus === 'error'}
                on:click={copyRunHistory}
                title="Copy full run history (goal, result, error, steps) to clipboard"
              >
                {#if copyStatus === 'copied'}
                  ✓ Copied
                {:else if copyStatus === 'error'}
                  ✗ Failed
                {:else}
                  📋 Copy history
                {/if}
              </button>
            </div>
            <div class="ag-panel-body">
              {#if loadingDetail}
                <div class="ag-empty"><div class="ag-empty-sub">Loading...</div></div>
              {:else}
                <!-- Run Info -->
                <div class="detail-section">
                  <div class="detail-grid">
                    <div class="detail-item">
                      <span class="detail-label">Status</span>
                      <span class="detail-value" style="color:{statusColor(selectedRun.status)};font-weight:700">{selectedRun.status}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Trigger</span>
                      <span class="detail-value">{selectedRun.trigger_type ?? '—'}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Steps</span>
                      <span class="detail-value">{selectedRun.steps_count}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Tokens</span>
                      <span class="detail-value mono">{fmtTokens(selectedRun.tokens_used)}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Duration</span>
                      <span class="detail-value">{duration(selectedRun.started_at, selectedRun.completed_at)}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Time</span>
                      <span class="detail-value">{timeAgo(selectedRun.created_at)}</span>
                    </div>
                  </div>
                </div>

                {#if selectedRun.goal}
                  <div class="detail-section">
                    <h4 class="detail-heading">Goal</h4>
                    <div class="detail-code">{selectedRun.goal}</div>
                  </div>
                {/if}

                {#if selectedRun.result}
                  <div class="detail-section">
                    <h4 class="detail-heading">Result</h4>
                    <div class="detail-code result-code">{selectedRun.result}</div>
                  </div>
                {/if}

                {#if selectedRun.error}
                  <div class="detail-section">
                    <h4 class="detail-heading">Error</h4>
                    <div class="detail-code error-code">{selectedRun.error}</div>
                  </div>
                {/if}

                {#if selectedRunSteps.length}
                  <div class="detail-section">
                    <h4 class="detail-heading">Steps ({selectedRunSteps.length})</h4>
                    {#each selectedRunSteps as step, i}
                      <div class="step-row">
                        <span class="step-num">{i + 1}</span>
                        <span class="step-icon">{stepIcon(step.type)}</span>
                        <div class="step-body">
                          <div class="step-type">{step.type}{step.type === 'tool_call' && step.tool_name ? `: ${step.tool_name}` : ''}</div>
                          {#if step.content}
                            <div class="step-content">{String(step.content).slice(0, 300)}{String(step.content).length > 300 ? '...' : ''}</div>
                          {/if}
                        </div>
                        {#if step.tokens_used}
                          <span class="step-tokens mono">{fmtTokens(step.tokens_used)}</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}
            </div>
          </div>

        {:else}
          <!-- ═══ Overview (default) ═══ -->
          <!-- Recent Runs -->
          <div class="ag-panel ag-panel-runs">
            <div class="ag-panel-header">
              <span class="ag-panel-dot" style="background:var(--teal)"></span>
              <span class="ag-panel-title">Recent Runs</span>
              <span class="ag-panel-count">{recentRuns.length}</span>
            </div>
            <div class="ag-panel-body">
              {#if !recentRuns.length}
                <div class="ag-empty"><div class="ag-empty-sub">No runs yet</div></div>
              {:else}
                {#each recentRuns as run}
                  <button class="run-row" on:click={() => selectRun(run)}>
                    <span class="run-dot" style="background:{statusColor(run.status)}"></span>
                    <span class="run-name">{run.agent_name}</span>
                    <span class="run-status" style="color:{statusColor(run.status)}">{run.status}</span>
                    <span class="run-tokens mono">{fmtTokens(run.tokens_used)}</span>
                    <span class="run-time">{timeAgo(run.created_at)}</span>
                  </button>
                {/each}
              {/if}
            </div>
          </div>

          <!-- Top Agents -->
          <div class="ag-panel ag-panel-top">
            <div class="ag-panel-header">
              <span class="ag-panel-dot" style="background:var(--gold)"></span>
              <span class="ag-panel-title">Top Agents</span>
            </div>
            <div class="ag-panel-body">
              {#if !topAgents.length}
                <div class="ag-empty"><div class="ag-empty-sub">No data</div></div>
              {:else}
                {#each topAgents.slice(0, 8) as ta}
                  <div class="top-row">
                    <span class="top-name">{ta.name}</span>
                    <span class="top-runs mono">{ta.run_count} runs</span>
                    <span class="top-tokens mono">{fmtTokens(ta.total_tokens)}</span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>

          <!-- Stats -->
          <div class="ag-panel ag-panel-stats">
            <div class="ag-panel-header">
              <span class="ag-panel-dot" style="background:var(--green)"></span>
              <span class="ag-panel-title">Breakdown</span>
            </div>
            <div class="ag-panel-body">
              <div class="stat-grid">
                <div class="stat-group">
                  <div class="stat-group-title">By Status</div>
                  {#each Object.entries(runsByStatus) as [k, v]}
                    <div class="stat-row">
                      <span class="stat-label">{k}</span>
                      <span class="stat-val mono" style="color:{statusColor(k)}">{v}</span>
                    </div>
                  {/each}
                </div>
                <div class="stat-group">
                  <div class="stat-group-title">By Trigger</div>
                  {#each Object.entries(runsByTrigger) as [k, v]}
                    <div class="stat-row">
                      <span class="stat-label">{k}</span>
                      <span class="stat-val mono">{v}</span>
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- ── Preview Prompt modal — A/B lexical vs semantic ranking ── -->
{#if showPreview}
  <div class="preview-overlay" on:click|self={closePreview} role="presentation">
    <div class="preview-modal">
      <div class="preview-header">
        <h3>Preview prompt — {selectedAgent?.name ?? 'agent'}</h3>
        <button class="preview-close" on:click={closePreview}>✕</button>
      </div>

      <div class="preview-controls">
        <textarea
          class="preview-goal"
          bind:value={previewGoal}
          placeholder="Goal to evaluate (e.g. 'Produce the weekly brief'). Default: the agent's goal_template."
          rows="3"
        ></textarea>
        <button class="ag-btn ag-btn-primary" on:click={runPreview} disabled={previewLoading}>
          {previewLoading ? 'Embedding…' : 'Run A/B'}
        </button>
      </div>

      {#if previewError}
        <div class="preview-error">⚠ {previewError}</div>
      {/if}

      {#if previewSemantic && previewLexical}
        {@const totalItems = (previewSemantic.counts.memory + previewSemantic.counts.learnings + previewSemantic.counts.similar_runs)
                           + (previewLexical.counts.memory + previewLexical.counts.learnings + previewLexical.counts.similar_runs)}
        {#if totalItems === 0}
          <div class="preview-empty-state">
            <div class="preview-empty-state-icon">📭</div>
            <h4>This agent has no history to rank against.</h4>
            <p>
              Zero memories, zero learnings, zero past runs — the A/B has nothing to compare.
              Try an agent that has already run (e.g. <em>Security Auditor</em>,
              <em>Frontend Dev</em>), or fire a couple of runs at this one first so it builds up context.
            </p>
            <p class="preview-empty-state-confirm">
              ✓ El endpoint anduvo bien — embed {previewSemantic.embeddings.embed_ms}ms
              with <code>{previewSemantic.embeddings.model}</code>. The emptiness is the agent's, not the pipeline's.
            </p>
          </div>
        {:else}
        {@const memSemIds = idsFromBlocks(previewSemantic.blocks, 'memory')}
        {@const memLexIds = idsFromBlocks(previewLexical.blocks, 'memory')}
        {@const learnSemIds = idsFromBlocks(previewSemantic.blocks, 'learnings')}
        {@const learnLexIds = idsFromBlocks(previewLexical.blocks, 'learnings')}
        {@const runSemIds = idsFromBlocks(previewSemantic.blocks, 'similar_runs')}
        {@const runLexIds = idsFromBlocks(previewLexical.blocks, 'similar_runs')}

        <div class="preview-meta">
          <span><strong>Semantic:</strong> {previewSemantic.embeddings.model} · embed {previewSemantic.embeddings.embed_ms}ms</span>
          <span class="preview-meta-sep">·</span>
          <span>Memory ovrlp: {[...memSemIds].filter(i => memLexIds.has(i)).length}/{memSemIds.size}</span>
          <span>· Learnings ovrlp: {[...learnSemIds].filter(i => learnLexIds.has(i)).length}/{learnSemIds.size}</span>
          <span>· Runs ovrlp: {[...runSemIds].filter(i => runLexIds.has(i)).length}/{runSemIds.size}</span>
        </div>

        <div class="preview-grid">
          <div class="preview-col">
            <div class="preview-col-header preview-lexical">📝 LEXICAL (current default)</div>

            <div class="preview-block">
              <h5>Memory ({previewLexical.counts.memory})</h5>
              {#each previewLexical.blocks.memory as m}
                <div class="preview-item" class:preview-only={!memSemIds.has(`${m.role}|${m.created_at}`)}>
                  <div class="preview-item-meta">[{m.role}] {m.created_at?.slice(5, 16).replace('T', ' ')}</div>
                  <div class="preview-item-text">{m.content?.slice(0, 220)}</div>
                </div>
              {:else}
                <div class="preview-empty">— empty —</div>
              {/each}
            </div>

            <div class="preview-block">
              <h5>Learnings ({previewLexical.counts.learnings})</h5>
              {#each previewLexical.blocks.learnings as l}
                <div class="preview-item" class:preview-only={!learnSemIds.has(l.id)}>
                  <div class="preview-item-meta">[{l.type}] conf={l.confidence?.toFixed(2)}</div>
                  <div class="preview-item-text">{l.content?.slice(0, 220)}</div>
                </div>
              {:else}
                <div class="preview-empty">— empty —</div>
              {/each}
            </div>

            <div class="preview-block">
              <h5>Similar past runs ({previewLexical.counts.similar_runs})</h5>
              {#each previewLexical.blocks.similar_runs as r}
                <div class="preview-item" class:preview-only={!runSemIds.has(r.id)}>
                  <div class="preview-item-meta">[{r.status}]</div>
                  <div class="preview-item-text">{r.goal?.slice(0, 200)}</div>
                </div>
              {:else}
                <div class="preview-empty">— empty —</div>
              {/each}
            </div>
          </div>

          <div class="preview-col">
            <div class="preview-col-header preview-semantic">🧠 SEMANTIC (cosine + lexical hybrid)</div>

            <div class="preview-block">
              <h5>Memory ({previewSemantic.counts.memory})</h5>
              {#each previewSemantic.blocks.memory as m}
                <div class="preview-item" class:preview-only={!memLexIds.has(`${m.role}|${m.created_at}`)}>
                  <div class="preview-item-meta">[{m.role}] {m.created_at?.slice(5, 16).replace('T', ' ')}</div>
                  <div class="preview-item-text">{m.content?.slice(0, 220)}</div>
                </div>
              {:else}
                <div class="preview-empty">— empty —</div>
              {/each}
            </div>

            <div class="preview-block">
              <h5>Learnings ({previewSemantic.counts.learnings})</h5>
              {#each previewSemantic.blocks.learnings as l}
                <div class="preview-item" class:preview-only={!learnLexIds.has(l.id)}>
                  <div class="preview-item-meta">[{l.type}] conf={l.confidence?.toFixed(2)}</div>
                  <div class="preview-item-text">{l.content?.slice(0, 220)}</div>
                </div>
              {:else}
                <div class="preview-empty">— empty —</div>
              {/each}
            </div>

            <div class="preview-block">
              <h5>Similar past runs ({previewSemantic.counts.similar_runs})</h5>
              {#each previewSemantic.blocks.similar_runs as r}
                <div class="preview-item" class:preview-only={!runLexIds.has(r.id)}>
                  <div class="preview-item-meta">[{r.status}]</div>
                  <div class="preview-item-text">{r.goal?.slice(0, 200)}</div>
                </div>
              {:else}
                <div class="preview-empty">— empty —</div>
              {/each}
            </div>
          </div>
        </div>

        <div class="preview-legend">
          <span class="preview-only-legend"></span> = item present on this side but NOT on the other
        </div>
        {/if}
      {:else if !previewLoading}
        <div class="preview-hint">Write a goal and hit "Run A/B" to see, side by side, which memories / learnings / past runs the executor would inject under each ranking strategy.</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ag-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 56px - 48px);
    overflow: hidden;
  }

  /* ── Header ──────────────────────────────────── */
  .ag-header {
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0; padding: 12px 0 8px;
  }
  .ag-header-left { display: flex; align-items: center; gap: 8px; }
  .ag-title { font-family: var(--font-display); font-size: 18px; font-weight: 700; margin: 0; }
  .ag-count {
    font-size: 10px; font-family: var(--font-mono);
    background: var(--surface-3); padding: 2px 7px; border-radius: 8px; color: var(--text-3);
  }
  .ag-header-right { display: flex; gap: 6px; }
  .ag-btn {
    padding: 5px 12px; border-radius: 8px; font-size: 11px; font-weight: 600;
    font-family: var(--font-body); cursor: pointer; transition: all 0.15s;
    border: 1px solid var(--border); text-decoration: none;
    display: flex; align-items: center; gap: 4px;
  }
  .ag-btn-ghost { background: none; color: var(--text-2); }
  .ag-btn-ghost:hover { background: var(--surface-2); color: var(--text-1); }
  .ag-btn-primary { background: var(--teal); border-color: var(--teal); color: var(--bg); }
  .ag-btn-primary:hover { opacity: 0.85; }

  /* ── KPIs ────────────────────────────────────── */
  .ag-kpis { display: flex; gap: 8px; flex-shrink: 0; margin-bottom: 10px; }
  .ag-kpi {
    flex: 1; background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 8px 10px; text-align: center;
  }
  .ag-kpi-val { font-family: var(--font-display); font-size: 18px; font-weight: 700; line-height: 1; display: block; }
  .ag-kpi-lbl { font-size: 8px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; display: block; }

  /* ── Main Grid ───────────────────────────────── */
  .ag-grid {
    flex: 1; min-height: 0;
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
  }

  /* ── Panels ──────────────────────────────────── */
  .ag-panel {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  }
  .ag-panel-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px 8px; flex-shrink: 0; border-bottom: 1px solid var(--border);
  }
  .ag-panel-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .ag-panel-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-2); flex: 1; }
  .ag-panel-count { font-size: 10px; font-family: var(--font-mono); color: var(--text-3); }
  .ag-panel-body {
    flex: 1; min-height: 0; overflow-y: auto; padding: 6px 10px;
    scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent;
  }

  /* ── Right column ────────────────────────────── */
  .ag-right { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .ag-panel-runs { flex: 1; min-height: 0; }
  .ag-panel-top { flex: 1; min-height: 0; }
  .ag-panel-stats { flex-shrink: 0; }
  .ag-panel-detail { flex: 1; min-height: 0; }

  /* ── Filters ────────────────────────────────── */
  .ag-filters {
    padding: 6px 10px 4px; flex-shrink: 0; border-bottom: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 6px;
  }
  .ag-categories {
    display: flex; gap: 4px; flex-wrap: wrap;
  }
  .ag-cat {
    padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 600;
    font-family: var(--font-body); cursor: pointer; transition: all 0.15s;
    border: 1px solid var(--border); background: none; color: var(--text-3);
    display: flex; align-items: center; gap: 4px;
  }
  .ag-cat:hover { background: var(--surface-2); color: var(--text-2); }
  .ag-cat-active { background: var(--teal); border-color: var(--teal); color: var(--bg); }
  .ag-cat-active:hover { background: var(--teal); color: var(--bg); }
  .ag-cat-count {
    font-size: 9px; font-family: var(--font-mono); opacity: 0.7;
  }
  .ag-cat-dot {
    width: 7px; height: 7px; border-radius: 50%;
    flex-shrink: 0; box-shadow: 0 0 0 1px rgba(0,0,0,0.3);
  }
  .ag-search {
    padding: 4px 8px; border-radius: 6px; font-size: 11px;
    font-family: var(--font-body); border: 1px solid var(--border);
    background: var(--surface-2); color: var(--text-1); outline: none;
  }
  .ag-search:focus { border-color: var(--teal); }
  .ag-search::placeholder { color: var(--text-3); }

  /* ── Agent Card ──────────────────────────────── */
  .ag-card {
    display: block; width: 100%; text-align: left;
    padding: 7px 10px; border-radius: 8px; transition: background 0.15s;
    border: none; border-bottom: 1px solid var(--border);
    background: none; cursor: pointer; font-family: inherit; color: inherit;
  }
  .ag-card:last-child { border-bottom: none; }
  .ag-card:hover { background: var(--surface-2); }
  .ag-card-running { background: rgba(61,214,200,0.04); }
  .ag-card-disabled { opacity: 0.5; }
  .ag-card-selected { background: var(--surface-2); border-left: 2px solid var(--teal); }
  .ag-card-main { display: flex; align-items: center; gap: 8px; }
  .ag-card-indicator {
    width: 7px; height: 7px; border-radius: 50%; background: var(--surface-3);
    flex-shrink: 0; transition: all 0.2s;
  }
  .ag-card-indicator.active { background: var(--green); }
  .ag-card-indicator.running { background: var(--teal); box-shadow: 0 0 6px var(--teal); animation: pulse 1.5s ease infinite; }
  .ag-card-body { flex: 1; min-width: 0; }
  .ag-card-top { display: flex; align-items: center; gap: 6px; }
  .ag-card-name { font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ag-card-badges { display: flex; gap: 3px; flex-shrink: 0; }
  .ag-card-cron {
    font-size: 9px; font-family: var(--font-mono); color: var(--text-3);
    background: var(--surface-2); padding: 1px 5px; border-radius: 4px;
  }
  .ag-card-desc { font-size: 10px; color: var(--text-3); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ag-card-meta { font-size: 9px; color: var(--text-3); margin-top: 1px; display: flex; gap: 6px; }
  .ag-card-actions { display: flex; gap: 3px; flex-shrink: 0; }
  .ag-act {
    width: 24px; height: 24px; border: 1px solid var(--border); border-radius: 5px;
    background: none; cursor: pointer; display: flex; align-items: center;
    justify-content: center; font-size: 10px; transition: all 0.15s;
  }
  .ag-act-run { color: var(--teal); }
  .ag-act-run:hover { border-color: var(--teal); background: rgba(61,214,200,0.1); }
  .ag-act-stop { color: var(--red); }
  .ag-act-stop:hover { border-color: var(--red); background: rgba(240,71,112,0.1); }
  .ag-act-stop:disabled { opacity: 0.4; cursor: default; }
  .ag-act-del { color: var(--text-3); }
  .ag-act-del:hover { color: var(--red); border-color: var(--red); background: rgba(240,71,112,0.1); }
  .ag-act-accept { color: var(--green); }
  .ag-act-accept:hover { border-color: var(--green); background: rgba(108,255,176,0.1); }
  .ag-act-reject { color: var(--orange); }
  .ag-act-reject:hover { border-color: var(--orange); background: rgba(240,136,62,0.12); }

  /* ── Back button ─────────────────────────────── */
  .back-btn {
    width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border);
    background: none; color: var(--text-2); cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; flex-shrink: 0;
  }
  .back-btn:hover { background: var(--surface-2); color: var(--text-1); }

  .copy-history-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    height: 26px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-2);
    cursor: pointer;
    font-size: 11.5px;
    font-weight: 600;
    font-family: var(--font-body);
    white-space: nowrap;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .copy-history-btn:hover {
    background: var(--surface-3);
    color: var(--gold);
    border-color: var(--gold);
  }
  .copy-history-btn:active {
    transform: scale(0.97);
  }
  .copy-history-btn.copied {
    background: rgba(61, 214, 140, 0.1);
    border-color: var(--green);
    color: var(--green);
  }
  .copy-history-btn.errored {
    background: rgba(240, 71, 112, 0.1);
    border-color: var(--red);
    color: var(--red);
  }

  /* ── Detail sections ─────────────────────────── */
  .detail-section { margin-bottom: 14px; }
  .detail-heading {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
    color: var(--text-3); margin: 0 0 6px; padding: 0;
  }
  .detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  .detail-item {
    background: var(--surface-2); border-radius: 6px; padding: 6px 8px;
  }
  .detail-label { font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-3); display: block; }
  .detail-value { font-size: 12px; color: var(--text-1); display: block; margin-top: 1px; }
  .detail-text { font-size: 11px; color: var(--text-2); line-height: 1.5; }
  .detail-code {
    font-size: 10px; color: var(--text-2); background: var(--surface-2);
    padding: 8px 10px; border-radius: 6px; font-family: var(--font-mono);
    white-space: pre-wrap; word-break: break-word;
    max-height: 200px; overflow-y: auto; line-height: 1.5;
    scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  }
  .result-code { border-left: 2px solid var(--green); }
  .error-code { border-left: 2px solid var(--red); color: var(--red); }

  /* ── Tool tags ───────────────────────────────── */
  .tool-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tool-tag {
    font-size: 9px; font-family: var(--font-mono); background: var(--surface-2);
    padding: 2px 6px; border-radius: 4px; color: var(--teal);
  }

  /* ── Variable items ──────────────────────────── */
  .var-item { font-size: 11px; color: var(--text-2); margin-bottom: 3px; }
  .var-item strong { color: var(--text-1); }
  .var-item code { font-size: 10px; font-family: var(--font-mono); background: var(--surface-2); padding: 1px 4px; border-radius: 3px; }

  /* ── Run card (in agent detail) ──────────────── */
  .run-card {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 6px 6px; border: none; background: none;
    border-bottom: 1px solid var(--border); font-size: 11px;
    cursor: pointer; transition: background 0.15s; font-family: inherit;
    color: var(--text-1); text-align: left;
  }
  .run-card:last-child { border-bottom: none; }
  .run-card:hover { background: var(--surface-2); border-radius: 4px; }
  .run-card-status { font-weight: 600; flex-shrink: 0; min-width: 56px; }
  .run-card-steps { font-size: 10px; color: var(--text-3); flex-shrink: 0; }
  .run-card-tokens { font-size: 10px; color: var(--text-3); flex-shrink: 0; min-width: 36px; text-align: right; }
  .run-card-time { font-size: 9px; color: var(--text-3); flex: 1; text-align: right; }
  .run-card-arrow { color: var(--text-3); font-size: 14px; flex-shrink: 0; }

  /* ── Step rows ───────────────────────────────── */
  .step-row {
    display: flex; align-items: flex-start; gap: 6px;
    padding: 5px 0; border-bottom: 1px solid var(--border);
  }
  .step-row:last-child { border-bottom: none; }
  .step-num { font-size: 9px; color: var(--text-3); font-family: var(--font-mono); min-width: 16px; text-align: right; padding-top: 1px; }
  .step-icon { font-size: 12px; flex-shrink: 0; padding-top: 1px; }
  .step-body { flex: 1; min-width: 0; }
  .step-type { font-size: 10px; font-weight: 600; color: var(--text-2); }
  .step-content {
    font-size: 10px; color: var(--text-3); margin-top: 2px;
    font-family: var(--font-mono); white-space: pre-wrap; word-break: break-word;
    line-height: 1.4;
  }
  .step-tokens { font-size: 9px; color: var(--text-3); flex-shrink: 0; }

  /* ── Run Row (overview) ──────────────────────── */
  .run-row {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 6px 4px; border: none; background: none;
    border-bottom: 1px solid var(--border); font-size: 11px;
    cursor: pointer; transition: background 0.15s; font-family: inherit;
    color: inherit; text-align: left;
  }
  .run-row:last-child { border-bottom: none; }
  .run-row:hover { background: var(--surface-2); border-radius: 4px; }
  .run-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .run-name { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-1); }
  .run-status { font-size: 10px; font-weight: 600; flex-shrink: 0; }
  .run-tokens { font-size: 10px; color: var(--text-3); flex-shrink: 0; min-width: 36px; text-align: right; }
  .run-time { font-size: 9px; color: var(--text-3); flex-shrink: 0; min-width: 48px; text-align: right; }

  /* ── Top Agents Row ──────────────────────────── */
  .top-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 4px; border-bottom: 1px solid var(--border); font-size: 11px;
  }
  .top-row:last-child { border-bottom: none; }
  .top-name { flex: 1; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .top-runs { font-size: 10px; color: var(--text-3); flex-shrink: 0; }
  .top-tokens { font-size: 10px; color: var(--teal); flex-shrink: 0; min-width: 44px; text-align: right; }

  /* ── Stats ───────────────────────────────────── */
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .stat-group-title { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-3); margin-bottom: 6px; }
  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 2px 0; font-size: 11px; }
  .stat-label { color: var(--text-2); text-transform: capitalize; }
  .stat-val { font-weight: 600; }

  /* ── Misc ────────────────────────────────────── */
  .mono { font-family: var(--font-mono); }
  .ag-empty { padding: 20px; text-align: center; }
  .ag-empty-text { font-family: var(--font-display); font-size: 14px; font-weight: 700; }
  .ag-empty-sub { font-size: 11px; color: var(--text-3); margin-top: 2px; }
  .ag-loading { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-3); font-size: 13px; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  @media (max-width: 800px) {
    .ag-grid { grid-template-columns: 1fr; }
    .ag-kpis { flex-wrap: wrap; }
    .ag-kpi { min-width: 60px; }
    .detail-grid { grid-template-columns: 1fr 1fr; }
  }

  /* ── Preview Prompt modal ── */
  .preview-overlay {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; padding: 24px;
  }
  .preview-modal {
    background: var(--bg-1, #1a1a1a);
    border: 1px solid var(--border, #333);
    border-radius: 8px;
    width: 100%; max-width: 1400px;
    max-height: 90vh;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .preview-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 20px; border-bottom: 1px solid var(--border, #333);
  }
  .preview-header h3 { margin: 0; font-size: 16px; }
  .preview-close {
    background: none; border: none; color: var(--text-2, #888);
    font-size: 18px; cursor: pointer; padding: 4px 8px;
  }
  .preview-close:hover { color: var(--text-1, #fff); }
  .preview-controls {
    display: flex; gap: 10px; padding: 14px 20px;
    border-bottom: 1px solid var(--border, #333);
    align-items: flex-start;
  }
  .preview-goal {
    flex: 1; background: var(--bg-2, #222); color: var(--text-1, #fff);
    border: 1px solid var(--border, #333); border-radius: 4px;
    padding: 8px 10px; font-family: inherit; font-size: 13px;
    resize: vertical;
  }
  .preview-error {
    padding: 10px 20px; background: rgba(255, 80, 80, 0.12);
    color: #ff8080; font-size: 13px;
  }
  .preview-meta {
    padding: 10px 20px; font-size: 12px; color: var(--text-2, #888);
    border-bottom: 1px solid var(--border, #333);
    display: flex; gap: 12px; flex-wrap: wrap;
  }
  .preview-meta-sep { opacity: 0.4; }
  .preview-grid {
    flex: 1; display: grid; grid-template-columns: 1fr 1fr;
    overflow: hidden;
  }
  .preview-col {
    overflow-y: auto;
    padding: 14px 20px;
    border-right: 1px solid var(--border, #333);
  }
  .preview-col:last-child { border-right: none; }
  .preview-col-header {
    font-size: 12px; font-weight: 600;
    padding: 6px 10px; border-radius: 4px; margin-bottom: 12px;
    display: inline-block;
  }
  .preview-lexical { background: rgba(120, 120, 200, 0.18); color: #aab; }
  .preview-semantic { background: rgba(120, 200, 140, 0.18); color: #afb; }
  .preview-block { margin-bottom: 16px; }
  .preview-block h5 {
    margin: 0 0 6px 0; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-2, #888);
  }
  .preview-item {
    padding: 6px 8px; margin-bottom: 4px;
    background: var(--bg-2, #222); border-radius: 3px;
    border-left: 2px solid transparent;
  }
  .preview-item.preview-only {
    border-left-color: #f5a623;
    background: rgba(245, 166, 35, 0.06);
  }
  .preview-item-meta {
    font-size: 10px; color: var(--text-2, #888);
    margin-bottom: 2px; font-family: var(--font-mono, monospace);
  }
  .preview-item-text {
    font-size: 12px; color: var(--text-1, #ddd);
    line-height: 1.4; word-break: break-word;
  }
  .preview-empty {
    font-size: 12px; color: var(--text-2, #888);
    font-style: italic; padding: 4px 8px;
  }
  .preview-hint {
    padding: 30px 20px; text-align: center;
    color: var(--text-2, #888); font-size: 13px;
  }
  .preview-legend {
    padding: 10px 20px; font-size: 11px; color: var(--text-2, #888);
    border-top: 1px solid var(--border, #333);
    display: flex; align-items: center; gap: 6px;
  }
  .preview-only-legend {
    display: inline-block; width: 14px; height: 14px;
    border-left: 2px solid #f5a623;
    background: rgba(245, 166, 35, 0.06);
  }
  .preview-empty-state {
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; text-align: center; padding: 40px 30px;
    overflow-y: auto;
  }
  .preview-empty-state-icon { font-size: 48px; margin-bottom: 12px; }
  .preview-empty-state h4 {
    margin: 0 0 12px 0; font-size: 15px; color: var(--text-1, #fff);
  }
  .preview-empty-state p {
    margin: 0 0 10px 0; max-width: 540px;
    font-size: 13px; line-height: 1.5; color: var(--text-2, #aaa);
  }
  .preview-empty-state em { color: var(--text-1, #ddd); font-style: normal; font-weight: 500; }
  .preview-empty-state-confirm {
    margin-top: 14px !important; padding: 10px 14px;
    background: rgba(120, 200, 140, 0.08);
    border: 1px solid rgba(120, 200, 140, 0.25);
    border-radius: 4px; font-size: 12px !important;
  }
  .preview-empty-state-confirm code {
    font-family: var(--font-mono, monospace); font-size: 11px;
  }

  /* ── Procedural skills panel (in agent detail view) ────────────── */
  .skills-section-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px; gap: 12px;
  }
  .skills-count-badge {
    display: inline-block;
    background: color-mix(in srgb, var(--purple) 18%, transparent);
    color: var(--purple);
    border: 1px solid color-mix(in srgb, var(--purple) 40%, transparent);
    border-radius: 999px; padding: 1px 8px;
    font-size: 11px; font-weight: 600;
    margin-left: 8px;
  }
  .ag-btn-sm { padding: 4px 10px; font-size: 11.5px; }
  .skills-empty {
    margin: 4px 0; font-size: 12px; color: var(--text-2);
    line-height: 1.55;
  }
  .skills-empty a { color: var(--gold); }
  .skills-tags {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .skill-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 6px 3px 10px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--purple) 14%, var(--surface-2)), var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--purple) 35%, var(--border));
    border-radius: 999px;
    font-size: 11.5px; color: var(--text-1);
  }
  .skill-chip-glyph { color: var(--purple); font-size: 10px; }
  .skill-chip-x {
    background: transparent; border: none; color: var(--text-3);
    font-size: 14px; line-height: 1;
    width: 18px; height: 18px;
    border-radius: 50%; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .skill-chip-x:hover {
    background: color-mix(in srgb, var(--red) 30%, transparent);
    color: var(--text-1);
  }
  .skills-hint {
    margin-top: 8px; font-size: 11px; color: var(--text-3);
    font-style: italic; line-height: 1.5;
  }
  .skills-hint code {
    background: var(--surface-2); padding: 1px 4px; border-radius: 3px;
    color: var(--gold); font-style: normal;
  }

  /* ── Skills picker modal ──────────────────────────────────────── */
  .picker-scrim {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(2px);
    z-index: 90;
  }
  .skills-picker {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(960px, 94vw); max-height: 82vh;
    background:
      radial-gradient(circle at top right, color-mix(in srgb, var(--purple) 8%, transparent), transparent 55%),
      var(--surface-1);
    border: 1px solid color-mix(in srgb, var(--purple) 30%, var(--border));
    border-radius: 14px;
    z-index: 100;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 70px rgba(0,0,0,0.7), 0 0 0 1px rgba(139,124,246,0.06);
    padding: 18px 20px;
  }
  .skills-picker-head {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 12px;
  }
  .skills-picker-head h3 {
    font-size: 15px; margin: 0; color: var(--text-1);
  }
  .drawer-close {
    background: transparent; border: none; color: var(--text-2);
    font-size: 24px; cursor: pointer; line-height: 1;
    padding: 0 6px;
  }
  .drawer-close:hover { color: var(--gold); }
  .skills-picker-search {
    width: 100%; padding: 8px 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text-1);
    font-size: 13px;
    margin-bottom: 12px;
  }
  .skills-picker-search:focus { outline: none; border-color: var(--purple); }
  .skills-picker-list {
    flex: 1; overflow-y: auto;
    display: flex; flex-direction: column; gap: 4px;
    padding-right: 4px;
  }
  .skills-picker-foot {
    margin-top: 14px;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; color: var(--text-3);
  }

  /* ── Skill tile grid (replaces .skill-row list) ──────────── */
  .skill-tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(138px, 1fr));
    gap: 8px;
    padding-bottom: 4px;
  }

  .skill-tile {
    position: relative;
    height: 118px;
    border-radius: 9px;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.025) 0%, transparent 35%),
      var(--surface-2);
    border: 1px solid var(--border);
    overflow: hidden;
    transition:
      transform 0.18s cubic-bezier(.2,.7,.3,1.2),
      border-color 0.18s ease,
      box-shadow 0.2s ease,
      background 0.2s ease;
  }
  .skill-tile::before {
    /* ambient diagonal sheen — barely visible, gives the tile a panel feel */
    content: '';
    position: absolute; inset: 0;
    background: linear-gradient(135deg, transparent 0%, rgba(139,124,246,0.04) 50%, transparent 100%);
    pointer-events: none;
    opacity: 0; transition: opacity 0.25s;
  }
  .skill-tile:hover { transform: translateY(-1px); border-color: var(--border-h); box-shadow: 0 4px 14px rgba(0,0,0,0.4); }
  .skill-tile:hover::before { opacity: 1; }

  .skill-tile-attached {
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--purple) 18%, var(--surface-2)) 0%, var(--surface-2) 100%);
    border-color: color-mix(in srgb, var(--purple) 50%, var(--border));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--purple) 22%, transparent);
  }
  .skill-tile-attached:hover {
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--purple) 35%, transparent),
      0 4px 18px rgba(139,124,246,0.18);
  }

  .skill-tile-front {
    position: absolute; inset: 0;
    padding: 10px 12px 9px 12px;
    background: transparent; border: 0; cursor: pointer;
    color: var(--text-1); text-align: left;
    display: flex; flex-direction: column; gap: 6px;
    font-family: inherit;
  }
  .skill-tile-front:disabled { cursor: not-allowed; opacity: 0.55; }
  .skill-tile-front:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--purple) 60%, transparent);
    border-radius: 9px;
  }

  .skill-tile-corner {
    position: absolute; top: 0; right: 0;
    width: 24px; height: 24px;
    background: var(--purple);
    color: #fff;
    clip-path: polygon(100% 0, 100% 100%, 0 0);
    display: flex; align-items: flex-start; justify-content: flex-end;
    padding: 3px 3px 0 0;
    box-shadow: 0 0 12px rgba(139,124,246,0.4);
  }
  .skill-tile-corner svg {
    position: absolute; top: 3px; right: 3px;
  }

  .skill-tile-name {
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.005em;
    color: var(--text-1);
    padding-right: 24px; /* clear of info icon (or attached corner) */
    margin-top: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: break-word;
    /* Slightly compressed character for a "label" feel without changing the font family */
    font-variant: tabular-nums;
  }
  .skill-tile-attached .skill-tile-name { color: #fff; }

  .skill-tile-foot {
    margin-top: auto;
    display: flex; align-items: center; gap: 5px;
    font-size: 9px; line-height: 1.2;
  }
  .skill-tile-tok {
    color: var(--text-3);
    background: color-mix(in srgb, var(--bg) 65%, transparent);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 9.5px;
    letter-spacing: 0.02em;
  }
  .skill-tile-attached .skill-tile-tok {
    color: color-mix(in srgb, #fff 80%, var(--purple));
    background: rgba(0,0,0,0.18);
  }
  .skill-tile-src {
    font-size: 8.5px;
    color: var(--teal);
    border: 1px solid color-mix(in srgb, var(--teal) 35%, transparent);
    padding: 1px 5px;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .skill-tile-info {
    position: absolute; top: 6px; right: 6px;
    width: 22px; height: 22px;
    border: 0;
    background: rgba(255,255,255,0.04);
    border-radius: 5px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-3);
    cursor: pointer;
    transition: all 0.15s ease;
    z-index: 2;
  }
  .skill-tile-info:hover {
    background: var(--surface-3);
    color: var(--purple);
    transform: scale(1.08);
  }
  .skill-tile-info:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--purple);
  }
  /* Tuck the info button to the left when the attached corner is showing
     so they don't overlap. */
  .skill-tile-attached .skill-tile-info {
    right: 30px;
  }

  .skill-tile-expanded {
    background: linear-gradient(180deg, var(--surface-1), var(--surface-2));
    border-color: color-mix(in srgb, var(--purple) 35%, var(--border));
  }
  .skill-tile-back {
    position: absolute; inset: 0;
    padding: 9px 12px 10px 12px;
    display: flex; flex-direction: column; gap: 4px;
    animation: skillTileFlip 0.22s ease;
  }
  @keyframes skillTileFlip {
    from { opacity: 0; transform: translateY(2px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .skill-tile-close {
    position: absolute; top: 4px; right: 4px;
    width: 22px; height: 22px;
    border: 0; background: rgba(255,255,255,0.04);
    border-radius: 5px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-2);
    font-size: 16px; line-height: 1; cursor: pointer;
    transition: all 0.12s ease;
  }
  .skill-tile-close:hover { background: var(--surface-3); color: var(--purple); }
  .skill-tile-back-name {
    font-size: 10.5px;
    font-weight: 700;
    color: var(--purple);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding-right: 28px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .skill-tile-back-text {
    flex: 1; min-height: 0; overflow-y: auto;
    font-size: 10.5px; line-height: 1.4;
    color: var(--text-2);
    padding-right: 4px;
    scrollbar-width: thin;
    scrollbar-color: var(--surface-3) transparent;
    word-break: break-word;
  }
  .skill-tile-back-text::-webkit-scrollbar { width: 4px; }
  .skill-tile-back-text::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 2px; }

  @media (max-width: 540px) {
    .skill-tiles { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
    .skill-tile { height: 108px; }
  }
</style>
