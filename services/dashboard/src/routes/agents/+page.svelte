<script lang="ts">
  import { agents } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import Badge from '$shared/components/Badge.svelte';
  import Skeleton from '$shared/components/Skeleton.svelte';
  // El mismo drawer que monta /agents-flow. Esta página tenía el suyo: una
  // grilla de solo lectura, sin skills, sin triggers y sin nada editable.
  import AgentDrawer from '$lib/components/agent/AgentDrawer.svelte';
  import OverviewTab from '$lib/components/agent/tabs/OverviewTab.svelte';
  import SkillsTab from '$lib/components/agent/tabs/SkillsTab.svelte';
  import { fmtTime, timeAgo } from '$shared/utils';
  import { runAgent, stopAgent, deleteAgent, createAgent, updateAgent } from '$lib/api.js';
  import { agentFromResponse } from '$lib/stores/agent-detail.js';
  import { toast, confirm as confirmDialog, describeError } from '$shared/feedback';
  import { onMount } from 'svelte';
  import { locale } from '$lib/i18n';
  import { PALETTE } from '$lib/components/bench/model.js';

  const L = {
    es: {
      title: 'Agentes', sub: '{n} agentes · {a} activos · {w} trabajando ahora', flow: 'Ver en 3D', create: 'Nuevo agente',
      kTotal: 'agentes', kActive: 'activos', kToday: 'corridas hoy', kDone: 'completadas', kFailed: 'con error', kTokens: 'tokens',
      list: 'Agentes', search: 'Buscar agente o descripción…', all: 'Todos', working: 'Trabajando', failing: 'Con fallas', paused: 'Pausados',
      offices: 'Oficinas', allOffices: 'Todas las oficinas', custom: 'Sin oficina', none: 'Ningún agente coincide.', noneSub: 'Probá con otro filtro.', empty: 'Todavía no hay agentes.', emptySub: 'Creá el primero con «Nuevo agente».',
      last: 'última', never: 'nunca corrió', ok: 'éxito', run: 'Correr', stop: 'Detener', open3d: 'Abrir en el 3D', open: 'Abrir', del: 'Eliminar', keep: 'Mantener (quitar revisión)', reject: 'Apagar (rechazar)',
      inARow: '{n} fallas seguidas', autoPaused: 'pausado solo', revision: 'en revisión',
      recent: 'Corridas recientes', top: 'Los que más corren', byStatus: 'Por estado', byTrigger: 'Por disparador', runs: 'corridas', noRuns: 'Todavía no hay corridas.', noData: 'Sin datos.',
      st: { completed: 'terminó', failed: 'falló', running: 'trabajando', pending: 'en cola', cancelled: 'cancelada' } as Record<string, string>,
    },
    en: {
      title: 'Agents', sub: '{n} agents · {a} active · {w} working now', flow: 'See in 3D', create: 'New agent',
      kTotal: 'agents', kActive: 'active', kToday: 'runs today', kDone: 'completed', kFailed: 'failed', kTokens: 'tokens',
      list: 'Agents', search: 'Search agent or description…', all: 'All', working: 'Working', failing: 'Failing', paused: 'Paused',
      offices: 'Offices', allOffices: 'All offices', custom: 'No office', none: 'No agent matches.', noneSub: 'Try another filter.', empty: 'No agents yet.', emptySub: 'Create the first one with "New agent".',
      last: 'last', never: 'never ran', ok: 'success', run: 'Run', stop: 'Stop', open3d: 'Open in 3D', open: 'Open', del: 'Delete', keep: 'Keep (clear review)', reject: 'Switch off (reject)',
      inARow: '{n} failures in a row', autoPaused: 'auto-paused', revision: 'under review',
      recent: 'Recent runs', top: 'Busiest agents', byStatus: 'By status', byTrigger: 'By trigger', runs: 'runs', noRuns: 'No runs yet.', noData: 'No data.',
      st: { completed: 'done', failed: 'failed', running: 'working', pending: 'queued', cancelled: 'cancelled' } as Record<string, string>,
    },
  };
  $: tx = $locale === 'es' ? L.es : L.en;
  const fill = (s: string, p: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));

  // Per-agent success rate: the graph endpoint already computes it; the list store does not carry it.
  let stats: Record<string, { total_runs: number; success_rate: number }> = {};
  onMount(() => {
    fetch('/api/agents/graph').then((r) => r.json()).then((g) => { stats = g?.stats ?? {}; }).catch(() => {});
    const close = () => (menuFor = '');
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  });
  let menuFor = '';
  function toggleMenu(id: string, e: MouseEvent) { e.stopPropagation(); menuFor = menuFor === id ? '' : id; }

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
  let statusFilter: '' | 'working' | 'failing' | 'paused' = '';
  const isFailing = (a: any) => (a.consecutive_failures ?? 0) > 0 || !!a.auto_paused_at;

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

    // State filter
    if (statusFilter === 'working' && !runningAgentIds.has(a.id)) return false;
    if (statusFilter === 'failing' && !isFailing(a)) return false;
    if (statusFilter === 'paused' && a.enabled) return false;

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
  $: workingN = allAgents.filter((a: any) => runningAgentIds.has(a.id)).length;
  $: failingN = allAgents.filter(isFailing).length;
  $: pausedN = allAgents.filter((a: any) => !a.enabled).length;
  $: flowColor = new Map<string, string>(flows.map((f: any) => [f.name, f.color]));
  /** The latest run of each agent among the recent ones: its outcome colours the row's dot. */
  $: maxTopRuns = Math.max(1, ...topAgents.slice(0, 8).map((x: any) => Number(x.run_count) || 0));
  $: lastRunOf = (() => {
    const m = new Map<string, any>();
    for (const r of recentRuns) if (!m.has(r.agent_id)) m.set(r.agent_id, r);
    return m;
  })();

  // ── Detail panel state ──────────────────────
  type DetailView = 'overview' | 'agent' | 'run';
  let detailView: DetailView = 'overview';
  let selectedAgent: any = null;
  let selectedAgentRuns: any[] = [];
  let selectedRun: any = null;
  let selectedRunSteps: any[] = [];
  let loadingDetail = false;

  // ── Drawer plumbing ─────────────────────────────
  // AgentDrawer owns the agent and every edit inside it; what stays here is
  // what only this page can do — the writes that also have to move its own
  // list row, and the tab the run drill-down navigates away from and back to.
  let panelTab: string = 'info';
  let starting = false;
  let startMsg = '';
  let togglingPause = false;
  let revisionBusy = false;
  let savingName = false;
  let editingName = false;
  let editNameValue = '';
  let msgTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Apply a saved row (or the fields of one) to the agent the drawer is
   * showing.
   *
   * This is the only way a write reaches the drawer from out here, and the
   * store treats what arrives as newer than the detail row it fetched when it
   * opened — which is what makes a Pause taken here show up as paused instead
   * of being overwritten by the `active` captured at open.
   */
  /**
   * The office the drawer paints its accent and header chip from. The 3D
   * world hands over the flow object it already has; here it is looked up by
   * name, which is what the list row carries.
   */
  $: selectedFlow = selectedAgent?.flow_name
    ? (flows.find((f: any) => f.name === selectedAgent.flow_name) ?? { name: selectedAgent.flow_name })
    : null;

  function refreshRow(patch: Record<string, unknown> | null | undefined): void {
    if (!selectedAgent || !patch) return;
    selectedAgent = { ...selectedAgent, ...patch };
  }

  /** Transient line in the drawer's action row; it is not worth an alert. */
  function flash(msg: string): void {
    startMsg = msg;
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { startMsg = ''; }, 4000);
  }

  async function runSelected() {
    if (!selectedAgent) return;
    starting = true;
    startMsg = '';
    try { await runAgent(selectedAgent.id); flash('✓ started'); }
    catch (e: any) { flash('✗ ' + (e?.message ?? String(e))); }
    finally { starting = false; }
  }

  /** Detener: cancel the selected agent's run in flight. */
  async function stopSelected() {
    if (!selectedAgent) return;
    try {
      const r = await fetch('/api/agents/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: selectedAgent.id }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      flash(b.cancelled ? '⏹ stopped' : 'nothing to stop');
    } catch (e: any) { flash('✗ ' + (e?.message ?? String(e))); }
  }

  /** Pause and Resume are one toggle; which way it goes is read off the row. */
  async function togglePause() {
    if (!selectedAgent) return;
    const resume = selectedAgent.active !== 1;
    togglingPause = true;
    try {
      const saved = agentFromResponse(await updateAgent(selectedAgent.id, { active: resume }));
      // The saved row when there is one: if the kernel refused the change,
      // the button must not claim it took.
      refreshRow(saved ?? { active: resume ? 1 : 0 });
      flash(resume ? '▶ resumed' : '⏸ paused');
    } catch (e: any) {
      flash('✗ ' + (e?.message ?? String(e)));
    } finally { togglingPause = false; }
  }

  async function resolveRevision(mode: 'accept' | 'reject') {
    if (!selectedAgent) return;
    revisionBusy = true;
    try {
      const done = mode === 'accept'
        ? await doAcceptRevision(selectedAgent.id, selectedAgent.name)
        : await doRejectRevision(selectedAgent.id, selectedAgent.name);
      if (done) refreshRow(mode === 'accept' ? { under_revision: 0 } : { under_revision: 0, active: 0 });
    } finally { revisionBusy = false; }
  }

  function beginEditName() {
    editNameValue = selectedAgent?.name ?? '';
    editingName = true;
  }

  function cancelEditName() { editingName = false; }

  async function saveEditName() {
    const next = (editNameValue || '').trim();
    if (!selectedAgent || !next || next === selectedAgent.name) { editingName = false; return; }
    savingName = true;
    try {
      const saved = agentFromResponse(await updateAgent(selectedAgent.id, { name: next }));
      refreshRow(saved ?? { name: next });
      editingName = false;
    } catch (e: any) {
      flash('✗ ' + (e?.message ?? String(e)));
    } finally { savingName = false; }
  }

  async function selectAgent(agent: any) {
    selectedAgent = agent;
    selectedRun = null;
    selectedRunSteps = [];
    detailView = 'agent';
    panelTab = 'info';
    editingName = false;
    startMsg = '';
    loadingDetail = true;
    try {
      const data = await rpcOrCall('agents.detail', { id: agent.id }, async () => {
        const res = await fetch(`/api/agents/${agent.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      // Merged, not replaced: the detail row is a raw `agents` row, while the
      // list row arrives with `flow_name` joined onto it — and that is what
      // names the office in the drawer's header.
      selectedAgent = { ...agent, ...(data.agent ?? {}) };
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
    catch (e: any) { const d = describeError(e); toast.error(d.title, { detail: d.detail, action: { label: 'Retry', run: () => doRunAgent(id) } }); }
  }

  async function doStopAgent(id: string) {
    stoppingIds.add(id);
    stoppingIds = stoppingIds;
    try { await stopAgent(id); }
    catch (e: any) { const d = describeError(e); toast.error(d.title, { detail: d.detail, action: { label: 'Retry', run: () => doStopAgent(id) } }); }
    finally { stoppingIds.delete(id); stoppingIds = stoppingIds; }
  }

  async function doDeleteAgent(id: string) {
    const agentName = String(allAgents.find((a: any) => a.id === id)?.name ?? '');
    const ok = await confirmDialog({
      title: 'Delete this agent?',
      body: 'The agent, its schedule and its settings are removed for good. This cannot be undone.',
      confirmLabel: 'Delete agent',
      danger: true,
      ...(agentName ? { typeToConfirm: agentName } : {}),
    });
    if (!ok) return;
    try { await deleteAgent(id); backToOverview(); }
    catch (e: any) { const d = describeError(e); toast.error(d.title, { detail: d.detail }); }
  }

  // REVISION resolution:
  //   accept = keep this agent, just clear the review flag (it's not actually a duplicate)
  //   reject = deactivate this agent (soft delete — DB row stays for rollback)
  //
  // Both answer whether the change actually went through, so the drawer's copy
  // of the row is only updated when it did — a declined confirm or a failed
  // PUT must leave the REVISION badge exactly where it is.
  async function doAcceptRevision(id: string, name: string): Promise<boolean> {
    if (!(await confirmDialog({
      title: `Keep "${name}"?`,
      body: 'The review flag is cleared and the agent keeps running exactly as it is.',
      confirmLabel: 'Keep agent',
    }))) return false;
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ under_revision: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (e: any) { const d = describeError(e); toast.error(d.title, { detail: d.detail }); return false; }
  }

  async function doRejectRevision(id: string, name: string): Promise<boolean> {
    if (!(await confirmDialog({
      title: `Reject "${name}"?`,
      body: 'The agent is switched off and stops running. Nothing is deleted: you can turn it back on later.',
      confirmLabel: 'Switch off',
    }))) return false;
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false, under_revision: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (e: any) { const d = describeError(e); toast.error(d.title, { detail: d.detail }); return false; }
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

<div class="agp">
  <header class="top">
    <div class="ttl">
      <h1>{tx.title}</h1>
      <p>{fill(tx.sub, { n: allAgents.length, a: kpis.activeAgents ?? active.length, w: workingN })}</p>
    </div>
    <div class="tiles">
      <button class="tile" class:on={statusFilter === ''} style="--c: {PALETTE.sky}" on:click={() => (statusFilter = '')}><b>{kpis.totalAgents ?? allAgents.length}</b><span>{tx.kTotal}</span></button>
      <div class="tile" style="--c: {PALETTE.emerald}"><b>{kpis.activeAgents ?? active.length}</b><span>{tx.kActive}</span></div>
      <div class="tile" style="--c: {PALETTE.gold}"><b>{kpis.runsToday ?? 0}</b><span>{tx.kToday}</span></div>
      <div class="tile" style="--c: {PALETTE.lime}"><b>{fmtTokens(kpis.completedRuns ?? 0)}</b><span>{tx.kDone}</span></div>
      <button class="tile" class:on={statusFilter === 'failing'} style="--c: {PALETTE.pink}" on:click={() => (statusFilter = statusFilter === 'failing' ? '' : 'failing')}><b>{kpis.failedRuns ?? 0}</b><span>{tx.kFailed}</span></button>
      <div class="tile" style="--c: {PALETTE.violet}"><b>{fmtTokens(kpis.totalTokens ?? 0)}</b><span>{tx.kTokens}</span></div>
    </div>
    <div class="hact">
      <a href="/agents-flow" class="btn ghost">◈ {tx.flow}</a>
      <button type="button" class="btn primary" on:click={() => showComposer = true}>+ {tx.create}</button>
    </div>
  </header>

  {#if !ag}
    <div class="ag-loading"><div style="width:100%;max-width:720px;padding:16px"><Skeleton variant="rows" rows={6} /></div></div>
  {:else}
    <div class="body">
      <!-- ── Left: the agents ── -->
      <section class="card list-card">
        <div class="ch"><h2>{tx.list}</h2><em>{filteredAgents.length}/{allAgents.length}</em></div>
        <div class="filters">
          <input class="search" type="text" placeholder={tx.search} aria-label={tx.search} bind:value={searchQuery} />
          <div class="states" role="group">
            <button class="sc" class:on={statusFilter === ''} on:click={() => (statusFilter = '')}>{tx.all}<i>{allAgents.length}</i></button>
            <button class="sc" class:on={statusFilter === 'working'} style="--c: #22D3EE" on:click={() => (statusFilter = statusFilter === 'working' ? '' : 'working')}><span class="d live"></span>{tx.working}<i>{workingN}</i></button>
            <button class="sc" class:on={statusFilter === 'failing'} style="--c: #F43F5E" on:click={() => (statusFilter = statusFilter === 'failing' ? '' : 'failing')}><span class="d"></span>{tx.failing}<i>{failingN}</i></button>
            <button class="sc" class:on={statusFilter === 'paused'} style="--c: #94A3B8" on:click={() => (statusFilter = statusFilter === 'paused' ? '' : 'paused')}><span class="d"></span>{tx.paused}<i>{pausedN}</i></button>
          </div>
        </div>
        <div class="cats" aria-label={tx.offices}>
          {#each categories as cat (cat.id)}
            <button class="cat" class:on={filterCategory === cat.id} style="--fc: {cat.color ?? '#94A3B8'}" on:click={() => filterCategory = cat.id}>
              {#if cat.color}<span class="fd"></span>{/if}{cat.id === 'all' ? tx.allOffices : cat.id === 'uncategorized' ? tx.custom : cat.label}<i>{cat.count}</i>
            </button>
          {/each}
        </div>
        <div class="rows">
          {#if !filteredAgents.length}
            <div class="ag-empty">
              <div class="ag-empty-text">{allAgents.length ? tx.none : tx.empty}</div>
              <div class="ag-empty-sub">{allAgents.length ? tx.noneSub : tx.emptySub}</div>
            </div>
          {:else}
            {#each filteredAgents as agent (agent.id)}
              {@const running = runningAgentIds.has(agent.id)}
              {@const lr = lastRunOf.get(agent.id)}
              {@const st = stats[agent.id]}
              {@const fails = agent.consecutive_failures ?? 0}
              {@const tone = running ? '#22D3EE' : !agent.enabled ? '#64748B' : agent.auto_paused_at || fails >= 2 ? '#F43F5E' : lr?.status === 'failed' || fails ? '#FB923C' : '#34D399'}
              <div class="row" class:sel={selectedAgent?.id === agent.id && detailView !== 'overview'} class:off={!agent.enabled}
                style="--oc: {flowColor.get(agent.flow_name) ?? '#94A3B8'}; --tc: {tone}">
                <button class="rmain" on:click={() => selectAgent(agent)} title={agent.description || agent.name}>
                  <span class="sd" class:live={running} aria-hidden="true"></span>
                  <span class="rtxt">
                    <span class="rl1">
                      <b>{agent.name}</b>
                      {#if agent.builtin_handler?.startsWith('script:')}<span class="k" style="--c: #34D399">script</span>
                      {:else if agent.builtin_handler?.startsWith('check:')}<span class="k" style="--c: #FBBF24">check</span>
                      {:else if agent.builtin_handler?.startsWith('proactive:')}<span class="k" style="--c: #60A5FA">proactive</span>
                      {:else if !agent.builtin_handler}<span class="k" style="--c: #22D3EE">llm</span>{/if}
                      {#if agent.under_revision}<span class="k" style="--c: #FB923C">{tx.revision}</span>{/if}
                      {#if agent.auto_paused_at}<span class="k" style="--c: #F43F5E">{tx.autoPaused}</span>{:else if fails >= 2}<span class="k" style="--c: #F43F5E">{fill(tx.inARow, { n: fails })}</span>{/if}
                      {#if agent.cron}<span class="cron">{agent.cron}</span>{/if}
                    </span>
                    {#if agent.description}<span class="rdesc">{agent.description}</span>{/if}
                    <span class="rmeta">
                      {#if agent.flow_name}<span class="of"><span class="fd"></span>{agent.flow_name}</span>{/if}
                      {#if agent.model}<span class="mono">{agent.model}</span>{:else if agent.providerType}<span>{agent.providerType}</span>{/if}
                      <span>{agent.last_run_at ? `${tx.last} ${timeAgo(agent.last_run_at)}` : tx.never}</span>
                    </span>
                  </span>
                  {#if st && st.total_runs > 0}
                    <span class="rate" title="{st.success_rate}% {tx.ok} · {st.total_runs} {tx.runs}">
                      <span class="rbar"><i style="width: {st.success_rate}%; --rc: {st.success_rate >= 85 ? '#34D399' : st.success_rate >= 60 ? '#FBBF24' : '#F43F5E'}"></i></span>
                      <small class="mono">{st.success_rate}%</small>
                    </span>
                  {:else}<span class="rate"></span>{/if}
                </button>
                {#if running || stoppingIds.has(agent.id)}
                  <button type="button" class="act stop" on:click|stopPropagation={() => doStopAgent(agent.id)} disabled={stoppingIds.has(agent.id)} title={tx.stop} aria-label="{tx.stop} {agent.name}">{stoppingIds.has(agent.id) ? '…' : '■'}</button>
                {:else}
                  <button type="button" class="act run" on:click|stopPropagation={() => doRunAgent(agent.id)} title={tx.run} aria-label="{tx.run} {agent.name}">▶</button>
                {/if}
                <div class="more">
                  <button type="button" class="dots" aria-haspopup="menu" aria-expanded={menuFor === agent.id} aria-label="Más acciones" on:click={(e) => toggleMenu(agent.id, e)}>⋯</button>
                  {#if menuFor === agent.id}
                    <div class="menu" role="menu" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
                      <button role="menuitem" on:click={() => { menuFor = ''; selectAgent(agent); }}>{tx.open}</button>
                      <a role="menuitem" href="/agents-flow?agent={agent.id}">{tx.open3d}</a>
                      {#if agent.under_revision}
                        <button role="menuitem" on:click={() => { menuFor = ''; doAcceptRevision(agent.id, agent.name); }}>{tx.keep}</button>
                        <button role="menuitem" on:click={() => { menuFor = ''; doRejectRevision(agent.id, agent.name); }}>{tx.reject}</button>
                      {/if}
                      <button role="menuitem" class="danger" on:click={() => { menuFor = ''; doDeleteAgent(agent.id); }}>{tx.del}</button>
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </section>

      <!-- ── Right: the agent, a run, or the overview ── -->
      <div class="ag-right">
        {#if detailView === 'agent' && selectedAgent}
          <!-- ═══ Agent Detail — the shared drawer ═══
               Same component /agents-flow mounts, so an agent is read and
               configured identically wherever it is opened. What this page
               still supplies is what only it has: its run list (which is also
               the way into the run drill-down below) and the prompt preview.
               `compact` makes the drawer fill this column instead of floating
               over a 3D canvas. -->
          <AgentDrawer
            agentId={selectedAgent.id}
            listRow={selectedAgent}
            flow={selectedFlow}
            compact
            running={runningAgentIds.has(selectedAgent.id)}
            historyCount={selectedAgentRuns.length}
            {starting}
            {startMsg}
            {togglingPause}
            {revisionBusy}
            {savingName}
            bind:editingName
            bind:editNameValue
            bind:panelTab
            on:close={backToOverview}
            on:run={runSelected}
            on:stop={stopSelected}
            on:resume={togglePause}
            on:revision={(e) => resolveRevision(e.detail.mode)}
            on:rename-begin={beginEditName}
            on:rename-cancel={cancelEditName}
            on:rename-save={saveEditName}
            on:changed={(e) => refreshRow(e.detail.agent)}
          >
            <svelte:fragment slot="overview" let:store>
              <OverviewTab
                {store}
                compact
                loading={loadingDetail}
                lastRun={selectedAgentRuns[0] ?? null}
              >
                <!-- The one block of the overview this page adds. It calls
                     back into this scope, so it goes in as a slot rather than
                     as a prop. -->
                <svelte:fragment slot="footer">
                  <div class="ip-extra">
                    <button class="ag-btn ag-btn-ghost" on:click={openPreview} title="Compare what memory/learnings the executor would inject under lexical vs semantic ranking — without running the LLM.">
                      🔍 Preview prompt (A/B lexical vs semantic)
                    </button>
                  </div>
                </svelte:fragment>
              </OverviewTab>
            </svelte:fragment>

            <svelte:fragment slot="skills">
              <div class="ip-body">
                <SkillsTab
                  agent={selectedAgent}
                  compact
                  on:change={(e) => refreshRow({ skills_json: JSON.stringify(e.detail.skills) })}
                />
              </div>
            </svelte:fragment>

            <svelte:fragment slot="history">
              <div class="ip-body">
                {#if selectedAgentRuns.length}
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
                {:else}
                  <div class="ag-empty"><div class="ag-empty-sub">{loadingDetail ? 'Loading…' : 'No runs yet'}</div></div>
                {/if}
              </div>
            </svelte:fragment>
          </AgentDrawer>

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
                <Skeleton variant="text" rows={6} />
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
          <section class="card runs-card">
            <div class="ch"><h2>{tx.recent}</h2><em>{recentRuns.length}</em></div>
            <div class="rows">
              {#if !recentRuns.length}
                <div class="ag-empty"><div class="ag-empty-sub">{tx.noRuns}</div></div>
              {:else}
                {#each recentRuns as run (run.id)}
                  <button class="run-row" style="--sc: {statusColor(run.status)}" on:click={() => selectRun(run)}>
                    <span class="sd" class:live={run.status === 'running'}></span>
                    <span class="run-name">{run.agent_name}</span>
                    <span class="run-status">{tx.st[run.status] ?? run.status}</span>
                    <span class="run-tokens mono">{fmtTokens(run.tokens_used)}</span>
                    <span class="run-time">{timeAgo(run.created_at)}</span>
                  </button>
                {/each}
              {/if}
            </div>
          </section>
          <div class="pair">
            <section class="card">
              <div class="ch"><h2>{tx.top}</h2></div>
              <div class="rows">
                {#if !topAgents.length}
                  <div class="ag-empty"><div class="ag-empty-sub">{tx.noData}</div></div>
                {:else}
                  {#each topAgents.slice(0, 8) as ta (ta.id ?? ta.name)}
                    <div class="top-row">
                      <span class="top-name">{ta.name}</span>
                      <span class="tbar"><i style="width: {(100 * ta.run_count) / maxTopRuns}%"></i></span>
                      <span class="top-runs mono">{ta.run_count}</span>
                    </div>
                  {/each}
                {/if}
              </div>
            </section>
            <section class="card">
              <div class="ch"><h2>{tx.byStatus}</h2></div>
              <div class="stat-grid">
                <div>
                  {#each Object.entries(runsByStatus) as [k, v]}
                    <div class="stat-row"><span class="stat-label"><span class="sd" style="--sc: {statusColor(k)}"></span>{tx.st[k] ?? k}</span><span class="stat-val mono">{v}</span></div>
                  {/each}
                </div>
                <div>
                  <div class="stat-group-title">{tx.byTrigger}</div>
                  {#each Object.entries(runsByTrigger) as [k, v]}
                    <div class="stat-row"><span class="stat-label">{k}</span><span class="stat-val mono">{v}</span></div>
                  {/each}
                </div>
              </div>
            </section>
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
  /* ── page: one screen, only the lists scroll inside their cards ── */
  .agp { height: 100%; min-height: 0; box-sizing: border-box; padding: 12px 18px 14px; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
  .top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center; }
  .ttl h1 { margin: 0; font-size: 22px; font-weight: 800; line-height: 1.1; background: linear-gradient(90deg, #22D3EE, #A78BFA 55%, #F472B6); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .ttl p { margin: 2px 0 0; font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
  .tiles { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
  .tile { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; padding: 6px 11px; border-radius: 12px; font: inherit; color: inherit; text-align: left;
    background: linear-gradient(160deg, color-mix(in srgb, var(--c) 18%, var(--surface-1)), var(--surface-1) 72%); border: 1px solid color-mix(in srgb, var(--c) 32%, var(--border)); transition: transform .15s, box-shadow .15s; }
  button.tile { cursor: pointer; }
  button.tile:hover { transform: translateY(-1px); box-shadow: 0 10px 22px -16px var(--c); }
  .tile.on { border-color: var(--c); box-shadow: 0 0 0 1px var(--c) inset; }
  .tile b { font-size: 19px; font-weight: 800; line-height: 1.15; font-variant-numeric: tabular-nums; color: color-mix(in srgb, var(--c) 75%, white); text-shadow: 0 0 14px color-mix(in srgb, var(--c) 45%, transparent); }
  .tile span { font-size: 10.5px; color: color-mix(in srgb, var(--c) 45%, var(--text-2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .hact { display: flex; gap: 6px; }
  .btn { display: inline-flex; align-items: center; gap: 5px; padding: 7px 12px; border-radius: 9px; font: 700 12px var(--font-body); cursor: pointer; white-space: nowrap; border: 1px solid transparent; text-decoration: none; transition: transform .15s; }
  .btn.ghost { color: var(--text-2); background: none; border-color: var(--border); }
  .btn.ghost:hover { color: var(--text-1); border-color: #A78BFA; }
  .btn.primary { color: #06202a; background: linear-gradient(135deg, #67E8F9, #22D3EE); box-shadow: 0 8px 20px -12px #22D3EE; }
  .btn.primary:hover { transform: translateY(-1px); }

  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 12px; }
  .card { min-height: 0; display: flex; flex-direction: column; gap: 7px; padding: 11px 13px; border-radius: 14px; overflow: hidden;
    background: linear-gradient(160deg, rgba(34, 211, 238, .05), var(--surface-1) 55%); border: 1px solid var(--border); }
  .ch { display: flex; align-items: center; gap: 8px; flex: none; }
  .ch h2 { margin: 0; font-size: 13px; font-weight: 800; color: var(--text-1); display: flex; align-items: center; gap: 8px; }
  .ch h2::before { content: ''; width: 3px; height: 14px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); }
  .ch em { margin-left: auto; font-style: normal; font-size: 11px; font-weight: 700; color: var(--text-3); }
  .rows { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 3px; }

  .filters { display: flex; gap: 8px; align-items: center; flex: none; }
  .search { flex: 1; min-width: 0; background: var(--bg, #0d0f16); border: 1px solid var(--border); color: var(--text-1); border-radius: 9px; padding: 6px 10px; font-size: 12.5px; }
  .search:focus { outline: none; border-color: #22D3EE; }
  .states { display: flex; gap: 4px; flex: none; }
  .sc, .cat { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font: 700 11px var(--font-body); cursor: pointer; color: var(--text-2); background: none; border: 1px solid var(--border); white-space: nowrap; }
  .sc i, .cat i { font-style: normal; font-weight: 600; color: var(--text-3); }
  .sc.on { --c2: var(--c, #22D3EE); color: color-mix(in srgb, var(--c2) 70%, white); background: color-mix(in srgb, var(--c2) 18%, transparent); border-color: color-mix(in srgb, var(--c2) 45%, transparent); }
  .sc .d { width: 7px; height: 7px; border-radius: 50%; background: var(--c); box-shadow: 0 0 6px var(--c); }
  .sc .d.live { animation: pulse 1.3s ease-in-out infinite; }
  .cats { display: flex; flex-wrap: nowrap; gap: 4px; overflow-x: auto; overflow-y: hidden; flex: none; padding-bottom: 3px; scrollbar-width: thin;
    -webkit-mask-image: linear-gradient(90deg, #000 90%, transparent); mask-image: linear-gradient(90deg, #000 90%, transparent); }
  .cats > :global(*) { flex: none; }
  .cat { padding: 2px 8px; font-size: 10.5px; }
  .cat.on { color: color-mix(in srgb, var(--fc) 70%, white); background: color-mix(in srgb, var(--fc) 18%, transparent); border-color: color-mix(in srgb, var(--fc) 45%, transparent); }
  .fd { width: 6px; height: 6px; border-radius: 50%; background: var(--fc, var(--oc)); box-shadow: 0 0 5px var(--fc, var(--oc)); flex: none; }

  .row { display: flex; align-items: center; gap: 4px; border-radius: 10px; border: 1px solid transparent; transition: background .15s, border-color .15s; }
  .row:hover { background: color-mix(in srgb, var(--oc) 7%, transparent); }
  .row.sel { background: linear-gradient(90deg, color-mix(in srgb, var(--oc) 18%, transparent), transparent); border-color: color-mix(in srgb, var(--oc) 45%, transparent); }
  .row.off { opacity: .55; }
  .rmain { flex: 1; min-width: 0; display: grid; grid-template-columns: 10px minmax(0, 1fr) 74px; gap: 9px; align-items: center; padding: 5px 7px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 10px; }
  .rmain:focus-visible, .act:focus-visible, .dots:focus-visible, .sc:focus-visible, .cat:focus-visible, .tile:focus-visible { outline: 2px solid #22D3EE; outline-offset: 1px; }
  .sd { width: 8px; height: 8px; border-radius: 50%; background: var(--tc, var(--sc, #94A3B8)); box-shadow: 0 0 8px var(--tc, var(--sc, #94A3B8)); flex: none; display: inline-block; }
  .sd.live { animation: pulse 1.3s ease-in-out infinite; }
  .rtxt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .rl1 { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .rl1 b { font-size: 12.5px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k { flex: none; font: 800 9.5px var(--font-mono); text-transform: uppercase; letter-spacing: .04em; padding: 0 6px; border-radius: 999px;
    color: color-mix(in srgb, var(--c) 70%, white); background: color-mix(in srgb, var(--c) 16%, transparent); border: 1px solid color-mix(in srgb, var(--c) 42%, transparent); }
  .cron { flex: none; font: 600 10px var(--font-mono); color: var(--text-3); }
  .rdesc { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rmeta { display: flex; gap: 10px; font-size: 10.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; }
  .of { display: inline-flex; align-items: center; gap: 5px; color: color-mix(in srgb, var(--oc) 65%, white); font-weight: 700; }
  .rate { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .rbar { width: 64px; height: 5px; border-radius: 3px; background: rgba(148, 163, 184, .15); overflow: hidden; }
  .rbar i { display: block; height: 100%; border-radius: 3px; background: var(--rc); box-shadow: 0 0 6px var(--rc); }
  .rate small { font-size: 10px; color: var(--text-3); }
  .act { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; cursor: pointer; font-size: 11px; background: none; border: 1px solid var(--border); color: var(--text-3); transition: color .15s, border-color .15s, background .15s; }
  .act.run:hover { color: #34D399; border-color: #34D399; background: rgba(52, 211, 153, .1); }
  .act.stop { color: #22D3EE; border-color: color-mix(in srgb, #22D3EE 50%, transparent); }
  .act.stop:hover { color: #F43F5E; border-color: #F43F5E; }
  .act:disabled { opacity: .5; cursor: wait; }
  .more { position: relative; flex: none; margin-right: 4px; }
  .dots { width: 28px; height: 28px; border-radius: 8px; border: 1px solid transparent; background: none; color: var(--text-3); font-size: 16px; line-height: 1; cursor: pointer; }
  .row:hover .dots, .dots[aria-expanded='true'] { color: var(--text-1); border-color: var(--border); background: var(--surface-2, #1f2230); }
  .menu { position: absolute; right: 0; top: 32px; z-index: 30; min-width: 190px; padding: 4px; border-radius: 10px; display: flex; flex-direction: column;
    background: var(--surface-1); border: 1px solid var(--border); box-shadow: 0 16px 34px -14px rgba(0, 0, 0, .7); }
  .menu button, .menu a { text-align: left; padding: 7px 10px; border: 0; background: none; color: var(--text-1); font: 600 12.5px var(--font-body); border-radius: 7px; cursor: pointer; text-decoration: none; }
  .menu button:hover, .menu a:hover { background: var(--surface-2, #1f2230); }
  .menu .danger { color: #fda4af; }
  .menu .danger:hover { background: color-mix(in srgb, #F43F5E 14%, transparent); }

  .ag-right { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: hidden; }
  .runs-card { flex: 1.25; }
  .pair { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .run-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) 78px 46px 70px; gap: 8px; align-items: center; padding: 5px 7px; border-radius: 9px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .run-row:hover { background: rgba(255, 255, 255, .05); }
  .run-name { font-size: 12px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-status { font-size: 11px; font-weight: 700; color: color-mix(in srgb, var(--sc) 80%, white); }
  .run-tokens { font-size: 10.5px; color: var(--text-3); text-align: right; }
  .run-time { font-size: 10.5px; color: var(--text-3); text-align: right; }
  .top-row { display: grid; grid-template-columns: minmax(0, 1fr) 54px 44px; gap: 8px; align-items: center; padding: 3px 4px; }
  .top-name { font-size: 11.5px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tbar { height: 5px; border-radius: 3px; background: rgba(251, 191, 36, .12); overflow: hidden; }
  .tbar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #FBBF24, #F472B6); box-shadow: 0 0 6px rgba(251, 191, 36, .55); }
  .top-runs { font-size: 11px; color: #fde68a; text-align: right; }
  .stat-grid { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .stat-group-title { font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); margin-bottom: 2px; }
  .stat-row { display: flex; justify-content: space-between; align-items: center; gap: 6px; padding: 3px 2px; font-size: 11.5px; }
  .stat-label { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }
  .stat-val { color: var(--text-1); font-weight: 700; }

  @media (prefers-reduced-motion: reduce) { .sd.live, .sc .d.live { animation: none; } }
  @media (max-height: 760px) { .rdesc { display: none; } .tile b { font-size: 16px; } }
  @media (max-width: 1100px) {
    .agp { height: auto; overflow: visible; }
    .top { grid-template-columns: 1fr auto; } .tiles { grid-column: 1 / -1; grid-row: 2; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .body { grid-template-columns: 1fr; } .card { max-height: 75vh; } .filters { flex-wrap: wrap; }
    .detail-grid { grid-template-columns: 1fr 1fr; }
  }


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

  /* ── Panels ──────────────────────────────────── */
  .ag-panel {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  }
  .ag-panel-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px 8px; flex-shrink: 0; border-bottom: 1px solid var(--border);
  }
  .ag-panel-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-2); flex: 1; }
  .ag-panel-body {
    flex: 1; min-height: 0; overflow-y: auto; padding: 6px 10px;
    scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent;
  }

  /* ── The shared drawer, embedded ─────────────── */
  /* `.ip-body` belongs to AgentDrawer, and Svelte scopes CSS per component:
     the two tab bodies THIS page fills have to carry the rule themselves,
     exactly as the 3D world's slots do. */
  .ip-body {
    flex: 1; overflow-y: auto; overflow-x: hidden;
    padding: 16px 18px 24px;
    scrollbar-width: thin; scrollbar-color: rgba(120,130,160,.25) transparent;
  }
  .ip-body::-webkit-scrollbar { width: 6px; }
  .ip-body::-webkit-scrollbar-thumb { background: rgba(120,130,160,.2); border-radius: 3px; }
  /* The one block this page adds to the overview, spaced like the sections
     above it rather than butted against the last one. */
  .ip-extra { margin-top: 14px; }
  .ag-panel-detail { flex: 1; min-height: 0; }

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
  .detail-code {
    font-size: 10px; color: var(--text-2); background: var(--surface-2);
    padding: 8px 10px; border-radius: 6px; font-family: var(--font-mono);
    white-space: pre-wrap; word-break: break-word;
    max-height: 200px; overflow-y: auto; line-height: 1.5;
    scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  }
  .result-code { border-left: 2px solid var(--green); }
  .error-code { border-left: 2px solid var(--red); color: var(--red); }

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
  .run-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

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

</style>
