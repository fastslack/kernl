<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { agentFlowEvents, type AgentFlowEvent } from '$lib/stores.js';
  import { runAgent, stopAgent, updateAgent } from '$lib/api.js';
  import { rpcOrCall } from '$lib/ws.js';
  import { timeAgo } from '$lib/utils.js';
  import MessageStream from './MessageStream.svelte';
  import AgentWorld3D from './AgentWorld3D.svelte';
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import SkillsTab from '$lib/components/agent/tabs/SkillsTab.svelte';

  // ── Commander integration ──────────────────────
  // Open the Filesystem Commander in the agent's workspace directory.
  // Workspaces live at /app/data/workspaces/<flow_id> by default (the
  // 'main' workspace per flow, auto-created by WorkspaceService). If an
  // agent doesn't declare flow_id yet we bail out gracefully.
  function openAgentWorkspace(agent: AgentData | null): void {
    if (!agent?.flow_id) {
      alert('Agent has no flow_id — workspace not available.');
      return;
    }
    const path = `/app/data/workspaces/${agent.flow_id}`;
    const label = `${agent.name} · workspace`;
    const qs = new URLSearchParams({ provider: 'local', path, label });
    goto(`/commander?${qs.toString()}`);
  }

  // ── Types ──────────────────────────────────────
  interface AgentData {
    id: string; name: string; description: string;
    system_prompt: string; goal_template: string;
    provider: string; model: string;
    max_iterations: number; timeout_ms: number; active: number;
    max_tokens: number; max_errors: number;
    allowed_tools: string; denied_tools: string;
    show_on_dashboard: number;
    builtin_handler: string;
    variables: string; // JSON key-value pairs
    flow_id: string;
    /** JSON array of procedural-skill slugs — see <SkillsTab>. */
    skills_json?: string;
  }
  interface ChainData {
    id: string; source_agent_id: string; target_agent_id: string;
    label: string; condition: string; pass_result: number;
    delay_ms: number; active: number;
  }
  interface TriggerData { id: string; agent_id: string; event_name: string; cooldown_ms: number; }
  interface ScheduleData { id: string; agent_id: string; interval_ms: number; next_run_at: string; }
  interface RunData {
    id: string; agent_id: string; trigger_type: string;
    status: string; steps_count: number; tokens_used: number; created_at: string;
  }
  interface StatsData { total_runs: number; completed: number; failed: number; success_rate: number; }
  interface FlowData {
    id: string; name: string; description: string;
    color: string; active: number;
    created_at: string; updated_at: string;
  }
  interface RankData {
    id: string; name: string; level: number;
    insignia: string; color: string; description: string;
    active: number;
  }
  interface GraphData {
    agents: AgentData[]; chains: ChainData[];
    triggers: TriggerData[]; schedules: ScheduleData[];
    recentRuns: RunData[];
    stats: Record<string, StatsData>;
    flows: FlowData[];
    ranks: RankData[];
  }
  interface Pos { x: number; y: number; layer: number; }

  // ── Constants ──────────────────────────────────
  const PALETTE = [
    { color: '#6366f1', glow: 'rgba(99,102,241,0.15)' },
    { color: '#8b5cf6', glow: 'rgba(139,92,246,0.15)' },
    { color: '#ec4899', glow: 'rgba(236,72,153,0.15)' },
    { color: '#06b6d4', glow: 'rgba(6,182,212,0.15)' },
    { color: '#10b981', glow: 'rgba(16,185,129,0.15)' },
    { color: '#f59e0b', glow: 'rgba(245,158,11,0.15)' },
    { color: '#ef4444', glow: 'rgba(239,68,68,0.15)' },
    { color: '#3b82f6', glow: 'rgba(59,130,246,0.15)' },
    { color: '#14b8a6', glow: 'rgba(20,184,166,0.15)' },
    { color: '#f97316', glow: 'rgba(249,115,22,0.15)' },
  ];
  const CARD_W = 220, CARD_H = 150, GAP_X = 120, GAP_Y = 30, MARGIN_X = 80, MARGIN_Y = 40;

  // ── Node type helpers ────────────────────────────
  function nodeType(agent: AgentData): 'agent' | 'function' | 'cli' {
    if (!agent.builtin_handler) return 'agent';
    if (agent.builtin_handler.startsWith('script:')) return 'cli';
    return 'function';
  }

  function nodeTypeLabel(agent: AgentData): string {
    const t = nodeType(agent);
    return t === 'agent' ? 'LLM Agent' : t === 'function' ? 'Function' : 'CLI Script';
  }

  function nodeTypeColor(agent: AgentData): string {
    const t = nodeType(agent);
    return t === 'agent' ? '#8b5cf6' : t === 'function' ? '#3dd6c8' : '#f59e0b';
  }

  function nodeTypeIcon(agent: AgentData): string {
    const t = nodeType(agent);
    return t === 'agent' ? '\u25C8' : t === 'function' ? '\u0192' : '>';
  }

  // ── State ──────────────────────────────────────
  let graphData: GraphData | null = null;
  // First-fetch lifecycle for the 3D boot loader: it must keep the loader up
  // until the graph data has actually arrived (or definitively failed), instead
  // of revealing an empty office on a blind timer.
  let dataLoaded = false;   // first fetchGraph() has resolved (success or empty)
  let dataError = false;    // first fetchGraph() returned null / threw
  let selectedAgentId: string | null = null;
  let agentColors: Record<string, { color: string; glow: string }> = {};
  let positions: Record<string, Pos> = {};
  let pollTimer: ReturnType<typeof setInterval>;
  let hostTimer: ReturnType<typeof setInterval>;
  let hostCurrent: { repo: string; iid: string } | null = null;  // issue the host engine is resolving
  let hostDeploying = false;  // a deploy is in flight on the host → animate the Deployer
  let streamOpen = false;
  let streamAutoScroll = true;
  let streamHeight = 280;

  // View mode: 3D by default
  let viewMode: '2d' | '3d' = '3d';

  // ── Stream features ──────────────────────
  let streamSearch = '';
  let streamTypeFilter = 'all';
  let streamAgentFilter = 'all';
  let persistedEvents: any[] = [];
  let persistedTotal = 0;
  let showPersisted = false;
  let persistedLoading = false;

  // Flow selector
  let selectedFlowId: string | null = null;
  let flows: FlowData[] = [];
  let ranks: RankData[] = [];

  // Assign to flow
  let showAssignFlow = false;
  let assignAgentId = '';
  let assignFlowId = '';

  // Chain drag state
  let chainDragging = false;
  let chainDragSource: string | null = null;
  let chainDragMouse: { x: number; y: number } = { x: 0, y: 0 };
  let canvasEl: HTMLDivElement;

  // Run / Stop
  let stoppingIds = new Set<string>();

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

  // ── Chain drag handlers ─────────────────────
  function onChainDragStart(agentId: string, e: MouseEvent) {
    e.stopPropagation();
    chainDragging = true;
    chainDragSource = agentId;
    const rect = canvasEl.getBoundingClientRect();
    chainDragMouse = { x: e.clientX - rect.left + canvasEl.scrollLeft, y: e.clientY - rect.top + canvasEl.scrollTop };
  }

  function onChainDragMove(e: MouseEvent) {
    if (!chainDragging || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    chainDragMouse = { x: e.clientX - rect.left + canvasEl.scrollLeft, y: e.clientY - rect.top + canvasEl.scrollTop };
  }

  function onChainDragEnd(e: MouseEvent) {
    if (!chainDragging || !chainDragSource) { chainDragging = false; return; }
    const target = (e.target as HTMLElement).closest('.agent-card');
    const targetId = target?.getAttribute('data-agent-id');
    if (targetId && targetId !== chainDragSource) {
      createChain(chainDragSource, targetId);
    }
    chainDragging = false;
    chainDragSource = null;
  }

  async function createChain(sourceId: string, targetId: string) {
    try {
      await rpcOrCall('agents.chain.create', { source_agent_id: sourceId, target_agent_id: targetId, pass_result: true }, async () => {
        const res = await fetch('/api/agents/chain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_agent_id: sourceId, target_agent_id: targetId, pass_result: true }),
        });
        return res.json();
      });
      graphData = await fetchGraph();
      if (graphData) {
        assignColors(graphData.agents);
        positions = computeLayout(graphData.agents, graphData.chains);
      }
    } catch { /* ignore */ }
  }

  async function deleteChain(chainId: string) {
    try {
      await rpcOrCall('agents.chain.delete', { id: chainId }, async () => {
        await fetch(`/api/agents/chain/${chainId}`, { method: 'DELETE' });
      });
      graphData = await fetchGraph();
      if (graphData) {
        assignColors(graphData.agents);
        positions = computeLayout(graphData.agents, graphData.chains);
      }
    } catch { /* ignore */ }
  }

  // Edit mode
  let editing = false;
  let editData: Record<string, any> = {};
  let saving = false;
  let saveError = '';

  let editVars: Array<{ key: string; value: string }> = [];

  function parseVars(json: string): Array<{ key: string; value: string }> {
    try {
      const obj = JSON.parse(json || '{}');
      return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
    } catch { return []; }
  }

  function parseTools(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw || '[]');
      // Handle double-encoded JSON: "\"[...]\""
      if (typeof parsed === 'string') return JSON.parse(parsed);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  let editAllowedTools = '';
  let editDeniedTools = '';

  function startEditing() {
    if (!selectedAgent) return;
    editData = {
      name: selectedAgent.name,
      description: selectedAgent.description || '',
      provider: selectedAgent.provider || '',
      model: selectedAgent.model || '',
      max_iterations: selectedAgent.max_iterations,
      timeout_ms: selectedAgent.timeout_ms,
      max_tokens: selectedAgent.max_tokens ?? 50000,
      max_errors: selectedAgent.max_errors ?? 3,
      active: !!selectedAgent.active,
      show_on_dashboard: !!selectedAgent.show_on_dashboard,
      system_prompt: selectedAgent.system_prompt || '',
      goal_template: selectedAgent.goal_template || '',
    };
    editAllowedTools = parseTools(selectedAgent.allowed_tools).join(', ');
    editDeniedTools = parseTools(selectedAgent.denied_tools).join(', ');
    editVars = parseVars(selectedAgent.variables);
    editing = true;
    saveError = '';
  }

  function addVar() { editVars = [...editVars, { key: '', value: '' }]; }
  function removeVar(i: number) { editVars = editVars.filter((_, idx) => idx !== i); }

  function cancelEditing() {
    editing = false;
    editData = {};
    saveError = '';
  }

  async function saveAgent() {
    if (!selectedAgentId) return;
    saving = true;
    saveError = '';
    try {
      // Build variables object from key-value pairs
      const varsObj: Record<string, string> = {};
      for (const v of editVars) {
        if (v.key.trim()) varsObj[v.key.trim()] = v.value;
      }
      // Parse tool lists from comma-separated strings
      const allowed = editAllowedTools.split(',').map(s => s.trim()).filter(Boolean);
      const denied = editDeniedTools.split(',').map(s => s.trim()).filter(Boolean);
      await updateAgent(selectedAgentId, { ...editData, variables: varsObj, allowed_tools: allowed, denied_tools: denied });
      editing = false;
      // Refresh graph data
      graphData = await fetchGraph();
      if (graphData) {
        assignColors(graphData.agents);
        positions = computeLayout(graphData.agents, graphData.chains);
      }
    } catch (e: any) {
      saveError = e.message;
    } finally {
      saving = false;
    }
  }

  /**
   * The skills panel already persisted the change; patch `graphData` in place
   * so the drawer reflects it. A full fetchGraph() here would also work but
   * costs a re-layout of the 3D world for a field the world doesn't render.
   */
  function onSkillsChange(e: CustomEvent<{ skills: string[] }>): void {
    if (!graphData || !selectedAgentId) return;
    const skills_json = JSON.stringify(e.detail.skills);
    graphData = {
      ...graphData,
      agents: graphData.agents.map((a) => (a.id === selectedAgentId ? { ...a, skills_json } : a)),
    };
  }

  // Derived
  $: agents = graphData?.agents ?? [];
  $: chains = graphData?.chains ?? [];
  $: triggers = graphData?.triggers ?? [];
  $: schedules = graphData?.schedules ?? [];
  $: runs = graphData?.recentRuns ?? [];
  $: stats = graphData?.stats ?? {};
  $: activeCount = agents.filter(a => a.active).length;
  $: triggerCount = triggers.length + schedules.length;
  $: todayRuns = runs.filter(r => (r.created_at || '').startsWith(new Date().toISOString().slice(0, 10))).length;
  $: runningAgents = new Set(runs.filter(r => r.status === 'running').map(r => r.agent_id));
  $: agentMap = Object.fromEntries(agents.map(a => [a.id, a]));
  $: chainCountOut = chains.reduce((m, c) => { m[c.source_agent_id] = (m[c.source_agent_id] || 0) + 1; return m; }, {} as Record<string, number>);
  $: chainCountIn = chains.reduce((m, c) => { m[c.target_agent_id] = (m[c.target_agent_id] || 0) + 1; return m; }, {} as Record<string, number>);
  $: triggersByAgent = triggers.reduce((m, t) => { (m[t.agent_id] ||= []).push(t); return m; }, {} as Record<string, TriggerData[]>);
  $: schedulesByAgent = schedules.reduce((m, s) => { (m[s.agent_id] ||= []).push(s); return m; }, {} as Record<string, ScheduleData[]>);
  $: runsByAgent = (() => {
    const m: Record<string, RunData[]> = {};
    for (const r of runs) { const arr = (m[r.agent_id] ||= []); if (arr.length < 8) arr.push(r); }
    return m;
  })();
  $: selectedAgent = selectedAgentId ? agents.find(a => a.id === selectedAgentId) : null;
  $: selectedStats = selectedAgentId ? (stats[selectedAgentId] || { total_runs: 0, completed: 0, failed: 0, success_rate: 0 }) : null;
  $: selectedChains = selectedAgentId ? chains.filter(c => c.source_agent_id === selectedAgentId || c.target_agent_id === selectedAgentId) : [];
  $: selectedTriggers = selectedAgentId ? (triggersByAgent[selectedAgentId] || []) : [];
  $: selectedSchedules = selectedAgentId ? (schedulesByAgent[selectedAgentId] || []) : [];
  $: selectedRuns = selectedAgentId ? runs.filter(r => r.agent_id === selectedAgentId).slice(0, 10) : [];
  $: canvasBounds = computeBounds(positions);

  // ── Live flow events (real-time WS) ────────────
  $: flowEvents = $agentFlowEvents;

  // ── Stream filtering & metrics ───────────────
  $: streamAgentNames = (() => {
    const names = new Set<string>();
    for (const e of flowEvents) {
      const n = String(e.data.agent_name ?? e.data.source_agent_name ?? '');
      if (n) names.add(n);
    }
    return Array.from(names).sort();
  })();

  $: filteredFlowEvents = (() => {
    let evts = flowEvents;
    if (streamTypeFilter !== 'all') {
      evts = evts.filter(e => {
        const t = e.event.split(':').pop() ?? '';
        if (streamTypeFilter === 'step') return t === 'step';
        if (streamTypeFilter === 'run') return t === 'run_started' || t === 'run_completed';
        if (streamTypeFilter === 'chain') return t === 'chain_triggered';
        if (streamTypeFilter === 'error') return t === 'run_completed' && e.data.status !== 'completed';
        if (streamTypeFilter === 'rate_limit') return String(e.data.type) === 'rate_limit_wait';
        return true;
      });
    }
    if (streamAgentFilter !== 'all') {
      evts = evts.filter(e => {
        const n = String(e.data.agent_name ?? e.data.source_agent_name ?? '');
        return n === streamAgentFilter;
      });
    }
    if (streamSearch) {
      const q = streamSearch.toLowerCase();
      evts = evts.filter(e => eventDetail(e).toLowerCase().includes(q) || eventAgentName(e).toLowerCase().includes(q) || e.event.toLowerCase().includes(q));
    }
    return evts;
  })();

  $: streamTokenTotal = flowEvents.reduce((sum, e) => sum + (Number(e.data.tokens_used) || 0), 0);

  $: streamRunDurations = (() => {
    const starts: Record<string, string> = {};
    const durations: Record<string, number> = {};
    for (const e of flowEvents) {
      const rid = String(e.data.run_id ?? '');
      if (!rid) continue;
      if (e.event.includes('run_started')) starts[rid] = e.ts;
      if (e.event.includes('run_completed') && starts[rid]) {
        durations[rid] = new Date(e.ts).getTime() - new Date(starts[rid]).getTime();
      }
    }
    return durations;
  })();

  async function loadPersistedEvents() {
    persistedLoading = true;
    try {
      const d = await rpcOrCall('agents.eventLog.list', { limit: 500 }, async () => {
        const r = await fetch('/api/agents/event-log?limit=500');
        return r.json();
      });
      persistedEvents = d.events ?? [];
      persistedTotal = d.total ?? 0;
    } catch { /* ignore */ }
    persistedLoading = false;
  }

  async function clearPersistedEvents() {
    if (!confirm('Clear all persisted event logs?')) return;
    try { await rpcOrCall('agents.eventLog.clear', {}, async () => { await fetch('/api/agents/event-log', { method: 'DELETE' }); }); } catch { /* ignore */ }
    persistedEvents = [];
    persistedTotal = 0;
  }

  // Agents with currently running runs (based on real-time events)
  $: liveRunningAgents = (() => {
    const started = new Set<string>();
    const completedRuns = new Set<string>();
    for (const e of flowEvents) {
      if (e.event === 'agent:flow:run_completed') completedRuns.add(String(e.data.run_id));
    }
    for (const e of flowEvents) {
      if (e.event === 'agent:flow:run_started' && !completedRuns.has(String(e.data.run_id))) {
        started.add(String(e.data.agent_id));
      }
    }
    return started;
  })();
  // The Resolver "runs" while the host engine is resolving an issue (even when it isn't
  // a Kernl agent_run) → so the 3D world animates it as the one fixing the code.
  $: hostResolverId = hostCurrent ? (agents.find(a => a.name === 'Resolver')?.id ?? null) : null;
  // The Deployer "runs" while a deploy is in flight on the host (approve-fix/batch), even
  // when it isn't a Kernl agent_run → so the 3D world animates it when you deploy.
  $: hostDeployerId = hostDeploying ? (agents.find(a => a.name === 'Deployer')?.id ?? null) : null;
  $: effectiveRunning = new Set([...runningAgents, ...liveRunningAgents,
      ...(hostResolverId ? [hostResolverId] : []), ...(hostDeployerId ? [hostDeployerId] : [])]);

  // Chains recently triggered (within 10s — for animation)
  $: activeChainIds = (() => {
    const s = new Set<string>();
    const now = Date.now();
    for (const e of flowEvents) {
      if (e.event === 'agent:flow:chain_triggered') {
        const elapsed = now - new Date(e.ts).getTime();
        if (elapsed < 10000) s.add(String(e.data.chain_id));
      }
    }
    return s;
  })();

  // Live step counts per agent
  $: liveStepCounts = flowEvents
    .filter(e => e.event === 'agent:flow:step')
    .reduce((acc, e) => {
      const aid = String(e.data.agent_id);
      acc[aid] = (acc[aid] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

  // Live events for selected agent
  $: selectedLiveEvents = selectedAgentId
    ? flowEvents.filter(e => e.data.agent_id === selectedAgentId).slice(0, 30)
    : [];

  // Pre-computed connection data
  interface ConnectionData {
    chain: ChainData;
    d: string;
    arrow: string;
    lp: { x: number; y: number };
    srcPal: { color: string; glow: string };
    tgtPal: { color: string; glow: string };
    ports: PortOffsets;
    srcPos: Pos;
    tgtPos: Pos;
    gradX1: number; gradY1: number; gradX2: number; gradY2: number;
  }
  $: connectionData = chains.map(chain => {
    const src = positions[chain.source_agent_id];
    const tgt = positions[chain.target_agent_id];
    const ports = portMap[chain.id];
    if (!src || !tgt || !ports) return null;
    return {
      chain,
      d: chainPath(chain),
      arrow: arrowPath(chain),
      lp: labelPos(chain),
      srcPal: agentColors[chain.source_agent_id] ?? PALETTE[0],
      tgtPal: agentColors[chain.target_agent_id] ?? PALETTE[0],
      ports,
      srcPos: src,
      tgtPos: tgt,
      gradX1: src.x + CARD_W, gradY1: ports.srcY,
      gradX2: tgt.x, gradY2: ports.tgtY,
    } as ConnectionData;
  }).filter((c): c is ConnectionData => c !== null && c.d !== '');

  let svgEl: SVGSVGElement;

  // ── Fetch ──────────────────────────────────────
  async function fetchGraph() {
    try {
      const args: Record<string, unknown> = selectedFlowId ? { flow_id: selectedFlowId } : {};
      return await rpcOrCall<GraphData | null>('agents.graph', args, async () => {
        const url = selectedFlowId ? `/api/agents/graph?flow_id=${selectedFlowId}` : '/api/agents/graph';
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json() as GraphData;
      });
    } catch { return null; }
  }

  async function fetchFlows() {
    try {
      const data = await rpcOrCall('agents.flows.list', {}, async () => {
        const res = await fetch('/api/agents/flows');
        if (!res.ok) return { flows: [] };
        return res.json();
      });
      flows = data.flows ?? [];
    } catch { /* ignore */ }
  }

  async function selectFlow(id: string | null) {
    selectedFlowId = id;
    selectedAgentId = null;
    graphData = await fetchGraph();
    if (graphData) {
      flows = graphData.flows ?? flows;
      ranks = graphData.ranks ?? ranks;
      assignColors(graphData.agents);
      positions = computeLayout(graphData.agents, graphData.chains);
    }
  }

  async function deleteFlow(id: string) {
    try {
      await rpcOrCall('agents.flows.delete', { id }, async () => {
        await fetch(`/api/agents/flows/${id}`, { method: 'DELETE' });
      });
      if (selectedFlowId === id) selectedFlowId = null;
      await fetchFlows();
      graphData = await fetchGraph();
      if (graphData) {
        assignColors(graphData.agents);
        positions = computeLayout(graphData.agents, graphData.chains);
      }
    } catch { /* ignore */ }
  }

  async function assignToFlow() {
    if (!assignAgentId || !assignFlowId) return;
    try {
      await rpcOrCall('agents.flows.assign', { id: assignFlowId, agent_ids: [assignAgentId] }, async () => {
        await fetch(`/api/agents/flows/${assignFlowId}/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_ids: [assignAgentId] }),
        });
      });
      showAssignFlow = false;
      assignAgentId = '';
      assignFlowId = '';
      graphData = await fetchGraph();
      if (graphData) {
        flows = graphData.flows ?? flows;
        ranks = graphData.ranks ?? ranks;
        assignColors(graphData.agents);
        positions = computeLayout(graphData.agents, graphData.chains);
      }
    } catch { /* ignore */ }
  }

  // ── Layout ─────────────────────────────────────
  function computeLayout(ag: AgentData[], ch: ChainData[]): Record<string, Pos> {
    const pos: Record<string, Pos> = {};
    if (ag.length === 0) return pos;
    const incoming: Record<string, string[]> = {};
    const outgoing: Record<string, string[]> = {};
    for (const a of ag) { incoming[a.id] = []; outgoing[a.id] = []; }
    for (const c of ch) {
      if (incoming[c.target_agent_id]) incoming[c.target_agent_id].push(c.source_agent_id);
      if (outgoing[c.source_agent_id]) outgoing[c.source_agent_id].push(c.target_agent_id);
    }
    const layers: Record<string, number> = {};
    const visited = new Set<string>();
    const roots = ag.filter(a => incoming[a.id].length === 0 && outgoing[a.id].length > 0);
    let queue = roots.map(a => ({ id: a.id, layer: 0 }));
    while (queue.length > 0) {
      const next: { id: string; layer: number }[] = [];
      for (const { id, layer } of queue) {
        if (visited.has(id)) { if (layers[id] < layer) layers[id] = layer; continue; }
        visited.add(id); layers[id] = layer;
        for (const tid of (outgoing[id] || [])) {
          next.push({ id: tid, layer: layer + 1 });
        }
      }
      queue = next;
    }
    const standalone = ag.filter(a => !visited.has(a.id));
    const layerGroups: Record<number, string[]> = {};
    for (const [id, layer] of Object.entries(layers)) {
      if (!layerGroups[layer]) layerGroups[layer] = [];
      layerGroups[layer].push(id);
    }
    let maxY = 0;
    for (const layer of Object.keys(layerGroups).map(Number).sort((a, b) => a - b)) {
      const ids = layerGroups[layer];
      const x = MARGIN_X + layer * (CARD_W + GAP_X);
      for (let i = 0; i < ids.length; i++) {
        const y = MARGIN_Y + i * (CARD_H + GAP_Y);
        pos[ids[i]] = { x, y, layer };
        maxY = Math.max(maxY, y + CARD_H);
      }
    }
    if (standalone.length > 0) {
      const startY = maxY + 60;
      const cols = Math.min(standalone.length, 4);
      standalone.forEach((a, i) => {
        pos[a.id] = {
          x: MARGIN_X + (i % cols) * (CARD_W + GAP_X),
          y: startY + Math.floor(i / cols) * (CARD_H + GAP_Y),
          layer: -1,
        };
      });
    }
    return pos;
  }

  function computeBounds(pos: Record<string, Pos>) {
    let maxX = 800, maxY = 600;
    for (const p of Object.values(pos)) {
      maxX = Math.max(maxX, p.x + CARD_W + MARGIN_X + 40);
      maxY = Math.max(maxY, p.y + CARD_H + MARGIN_Y + 40);
    }
    return { w: maxX, h: maxY };
  }

  function assignColors(ag: AgentData[]) {
    const c: typeof agentColors = {};
    ag.forEach((a, i) => { c[a.id] = PALETTE[i % PALETTE.length]; });
    agentColors = c;
  }

  // ── Connection port offsets ─────────────────────
  interface PortOffsets { srcY: number; tgtY: number; }

  $: portMap = computePortMap(chains, positions);

  function computePortMap(ch: ChainData[], pos: Record<string, Pos>): Record<string, PortOffsets> {
    const map: Record<string, PortOffsets> = {};
    if (ch.length === 0) return map;
    const outgoing: Record<string, ChainData[]> = {};
    const incoming: Record<string, ChainData[]> = {};
    for (const c of ch) {
      (outgoing[c.source_agent_id] ||= []).push(c);
      (incoming[c.target_agent_id] ||= []).push(c);
    }
    for (const agentId of Object.keys(outgoing)) {
      outgoing[agentId].sort((a, b) => (pos[a.target_agent_id]?.y ?? 0) - (pos[b.target_agent_id]?.y ?? 0));
    }
    for (const agentId of Object.keys(incoming)) {
      incoming[agentId].sort((a, b) => (pos[a.source_agent_id]?.y ?? 0) - (pos[b.source_agent_id]?.y ?? 0));
    }
    const PAD = 28;
    const usableH = CARD_H - PAD * 2;
    for (const c of ch) {
      const srcPos = pos[c.source_agent_id];
      const tgtPos = pos[c.target_agent_id];
      if (!srcPos || !tgtPos) { map[c.id] = { srcY: 0, tgtY: 0 }; continue; }
      const outList = outgoing[c.source_agent_id] || [];
      const inList = incoming[c.target_agent_id] || [];
      const outIdx = outList.indexOf(c);
      const inIdx = inList.indexOf(c);
      const outCount = outList.length;
      const inCount = inList.length;
      const srcY = srcPos.y + PAD + (outCount === 1 ? usableH / 2 : (usableH * outIdx) / (outCount - 1));
      const tgtY = tgtPos.y + PAD + (inCount === 1 ? usableH / 2 : (usableH * inIdx) / (inCount - 1));
      map[c.id] = { srcY, tgtY };
    }
    return map;
  }

  // ── SVG path helpers ───────────────────────────
  function chainPath(chain: ChainData): string {
    const src = positions[chain.source_agent_id];
    const tgt = positions[chain.target_agent_id];
    const ports = portMap[chain.id];
    if (!src || !tgt || !ports) return '';
    const x1 = src.x + CARD_W, y1 = ports.srcY;
    const x2 = tgt.x, y2 = ports.tgtY;
    const dx = Math.abs(x2 - x1);
    const cpx = Math.max(dx * 0.45, 60);
    return `M ${x1} ${y1} C ${x1 + cpx} ${y1}, ${x2 - cpx} ${y2}, ${x2} ${y2}`;
  }

  function arrowPath(chain: ChainData): string {
    const src = positions[chain.source_agent_id];
    const tgt = positions[chain.target_agent_id];
    const ports = portMap[chain.id];
    if (!src || !tgt || !ports) return '';
    const x1 = src.x + CARD_W, y1 = ports.srcY;
    const x2 = tgt.x, y2 = ports.tgtY;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const s = 8;
    const ax = x2 - s * Math.cos(angle - 0.4), ay = y2 - s * Math.sin(angle - 0.4);
    const bx = x2 - s * Math.cos(angle + 0.4), by = y2 - s * Math.sin(angle + 0.4);
    return `M ${ax} ${ay} L ${x2} ${y2} L ${bx} ${by}`;
  }

  function labelPos(chain: ChainData): { x: number; y: number } {
    const src = positions[chain.source_agent_id];
    const tgt = positions[chain.target_agent_id];
    const ports = portMap[chain.id];
    if (!src || !tgt || !ports) return { x: 0, y: 0 };
    const x1 = src.x + CARD_W, y1 = ports.srcY;
    const x2 = tgt.x, y2 = ports.tgtY;
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 2 };
  }

  // ── Drag & Drop ─────────────────────────────────
  let dragging: { id: string; startX: number; startY: number; origX: number; origY: number } | null = null;
  let hasDragged = false;

  function onDragStart(e: MouseEvent, agentId: string) {
    const pos = positions[agentId];
    if (!pos) return;
    dragging = { id: agentId, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    hasDragged = false;
    e.preventDefault();
  }

  function onDragMove(e: MouseEvent) {
    if (!dragging) return;
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    if (!hasDragged && Math.abs(dx) + Math.abs(dy) > 4) hasDragged = true;
    if (!hasDragged) return;
    positions = {
      ...positions,
      [dragging.id]: { ...positions[dragging.id], x: dragging.origX + dx, y: dragging.origY + dy },
    };
  }

  function onDragEnd() {
    if (dragging && !hasDragged) {
      selectAgent(dragging.id);
    }
    dragging = null;
  }

  // ── Interaction ────────────────────────────────
  function selectAgent(id: string) {
    selectedAgentId = selectedAgentId === id ? null : id;
    expandedRunId = null;
    runSteps = [];
    editing = false;
    editData = {};
  }

  // ── Run Steps Expansion ────────────────────────
  interface StepData {
    id: string; run_id: string; step_number: number;
    type: string; content: string; tool_name: string;
    tool_input: string; tool_output: string; tokens: number;
    created_at: string;
  }
  let expandedRunId: string | null = null;
  let runSteps: StepData[] = [];
  let runDetail: any = null;
  let runEvents: any[] = [];
  let loadingSteps = false;

  // ── Run summary (goal/result/metrics/evaluation) ──
  function runEval(events: any[]): { score: number; outcome: string; confidence: number } | null {
    const e = (events || []).find((x) => x.event_subtype === 'auto_eval');
    if (!e) return null;
    try { const d = JSON.parse(e.raw_data); return { score: d.score, outcome: d.outcome, confidence: d.confidence }; }
    catch { return null; }
  }
  function runDuration(run: any): string {
    if (!run?.started_at || !run?.completed_at) return '';
    const ms = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  function stars(n: number): string { return '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n)); }
  function statusLabel(s: string): string {
    return s === 'completed' ? '✓ completed' : s === 'failed' ? '✗ failed' : s === 'running' ? '⋯ running' : s;
  }

  async function toggleRunSteps(runId: string) {
    if (expandedRunId === runId) { expandedRunId = null; runSteps = []; return; }
    expandedRunId = runId;
    loadingSteps = true;
    runSteps = [];
    runDetail = null;
    runEvents = [];
    expandedSteps = new Set();
    try {
      const data = await rpcOrCall('agents.runs.detail', { id: runId }, async () => {
        const res = await fetch(`/api/agents/runs/${runId}`);
        if (res.ok) return res.json();
        return { steps: [] };
      });
      runSteps = data.steps ?? [];
      runDetail = data.run ?? null;
      runEvents = data.events ?? [];
    } catch { /* ignore */ }
    loadingSteps = false;
  }

  // ── Narrative run timeline: each step → icon + human label + summary ──
  let expandedSteps = new Set<string>();
  function toggleStep(id: string) {
    if (expandedSteps.has(id)) expandedSteps.delete(id); else expandedSteps.add(id);
    expandedSteps = expandedSteps; // trigger reactividad
  }
  function firstLine(s: string, n = 88): string {
    if (!s) return '';
    const line = String(s).replace(/\s+/g, ' ').trim();
    return line.length > n ? line.slice(0, n) + '…' : line;
  }
  const TOOL_LABELS: Record<string, [string, string]> = {
    ToolSearch: ['🔍', 'buscó herramientas'],
    Bash: ['💻', 'ran a command'],
    kernel_office_exec: ['🏢', 'ran in the office'],
    kernel_office_env_status: ['📊', 'consultó el contenedor'],
    kernel_agents_flows_list: ['📋', 'listed the offices'],
    Read: ['📄', 'read a file'],
    Edit: ['✏️', 'edited a file'],
    Write: ['📝', 'wrote a file'],
    Grep: ['🔎', 'searched the code'],
  };
  // Groups consecutive ToolSearch steps (call+result) into one item with a counter.
  function groupSteps(steps: any[]): any[] {
    const out: any[] = [];
    for (const s of steps) {
      if (s.tool_name === 'ToolSearch') {
        const prev = out[out.length - 1];
        if (prev && prev.__searchGroup) {
          prev.members.push(s);
          if (s.type === 'tool_call') prev.count++;
          continue;
        }
        out.push({ __searchGroup: true, id: 'sg-' + s.id, type: 'tool_call', tool_name: 'ToolSearch', count: s.type === 'tool_call' ? 1 : 0, members: [s] });
        continue;
      }
      out.push(s);
    }
    return out;
  }
  function stepInfo(step: any): { icon: string; label: string; color: string; tone: string } {
    if (step.__searchGroup) return { icon: '🔍', label: 'buscó herramientas', color: 'var(--teal)', tone: 'tool' };
    const t = step.type;
    if (t === 'thought') return { icon: '💭', label: 'pensó', color: 'var(--purple)', tone: 'thought' };
    if (t === 'final')   return { icon: '📤', label: 'resultado final', color: 'var(--gold)', tone: 'final' };
    if (t === 'error')   return { icon: '⚠️', label: 'error', color: 'var(--red)', tone: 'error' };
    if (t === 'tool_result') return { icon: '↳', label: 'devolvió', color: 'var(--green)', tone: 'result' };
    const [icon, label] = TOOL_LABELS[step.tool_name] ?? ['⚙️', step.tool_name || 'used a tool'];
    return { icon, label, color: 'var(--teal)', tone: 'tool' };
  }
  function stepSub(step: any): string {
    if (step.__searchGroup) return step.count > 1 ? `×${step.count}` : '';
    if (step.type === 'tool_call') {
      if (step.tool_input && step.tool_input !== '{}') {
        try {
          const o = JSON.parse(step.tool_input);
          return firstLine(o.command || o.query || o.goal || o.file_path || o.pattern || Object.values(o)[0]);
        } catch { return firstLine(step.tool_input); }
      }
      return '';
    }
    if (step.type === 'tool_result') return firstLine(formatToolOutput(step.tool_output));
    return firstLine(step.content);
  }
  function stepDetail(step: any): string {
    if (step.__searchGroup) return step.members.filter((m: any) => m.type === 'tool_call').map((m: any) => formatJson(m.tool_input)).join('\n———\n');
    if (step.type === 'tool_call') return formatJson(step.tool_input);
    if (step.type === 'tool_result') return formatToolOutput(step.tool_output);
    return formatToolOutput(step.content);
  }
  function hasDetail(step: any): boolean {
    if (step.__searchGroup) return true;
    const d = stepDetail(step);
    return !!d && d !== '{}' && d.trim().length > 0;
  }

  function formatJson(s: string): string {
    try { return JSON.stringify(JSON.parse(s), null, 2); }
    catch { return s; }
  }
  /**
   * Render tool_output (and freeform content) human-readable:
   *   - MCP wrapper `{content:[{type:"text",text:...}]}` → extract the text
   *     and recurse (the text itself is often JSON serialized too).
   *   - JSON object/array → pretty-print with 2-space indent.
   *   - Anything else (markdown, plain text) → leave as-is.
   *
   * Idempotent and safe on non-JSON input — falls back to the raw string.
   */
  function formatToolOutput(s: string): string {
    if (!s) return '';
    const trimmed = s.trim();
    if (!trimmed) return s;
    // Quick reject on inputs that obviously aren't JSON to avoid noisy parse attempts.
    const first = trimmed[0];
    if (first !== '{' && first !== '[' && first !== '"') return s;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); }
    catch { return s; }
    // MCP-shaped result: {content: [{type: "text", text: "..."}], isError?: bool}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.content)) {
        const parts: string[] = [];
        for (const item of obj.content as unknown[]) {
          if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
            const text = String((item as Record<string, unknown>).text ?? '');
            // The text payload may itself be JSON — recurse one level.
            parts.push(formatToolOutput(text));
          }
        }
        if (parts.length > 0) {
          const flag = obj.isError ? '⚠ tool error\n' : '';
          return flag + parts.join('\n\n');
        }
      }
    }
    // Plain JSON value — pretty-print.
    return JSON.stringify(parsed, null, 2);
  }
  function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + '\n…(truncated)' : s;
  }

  // ── Copy run + steps to clipboard (paste-friendly for Claude Code) ──
  let copyStatus: Record<string, 'idle' | 'copied' | 'error'> = {};
  let copyTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  function buildRunStepsText(run: RunData, steps: StepData[]): string {
    const agentName = graphData?.agents.find(a => a.id === run.agent_id)?.name ?? run.agent_id ?? '?';
    const lines: string[] = [];
    lines.push('═══════════════════════════════════════════');
    lines.push('AGENT RUN');
    lines.push('═══════════════════════════════════════════');
    lines.push(`Agent      : ${agentName}`);
    lines.push(`Run ID     : ${run.id}`);
    lines.push(`Status     : ${run.status}`);
    lines.push(`Trigger    : ${run.trigger_type ?? '—'}`);
    lines.push(`Created    : ${run.created_at ?? '?'}`);
    lines.push(`Steps      : ${run.steps_count ?? steps.length}`);
    lines.push(`Tokens     : ${run.tokens_used ?? 0}`);
    if (steps.length === 0) {
      lines.push('');
      lines.push('(no steps recorded)');
    } else {
      lines.push('');
      lines.push(`─── STEPS (${steps.length}) ─────────────────────────`);
      for (const s of steps) {
        const head = `[${s.step_number}] ${s.type}` + (s.tool_name ? `: ${s.tool_name}` : '');
        const tokens = s.tokens ? ` (${s.tokens} tokens)` : '';
        lines.push('');
        lines.push(head + tokens);
        if (s.tool_input && s.tool_input !== '' && s.tool_input !== '{}') {
          lines.push('  input:');
          for (const ln of formatJson(String(s.tool_input)).split('\n')) lines.push('    ' + ln);
        }
        if (s.tool_output) {
          lines.push('  output:');
          for (const ln of String(s.tool_output).split('\n')) lines.push('    ' + ln);
        }
        if (s.content) {
          for (const ln of String(s.content).split('\n')) lines.push('  ' + ln);
        }
        if (s.created_at) lines.push(`  @ ${s.created_at}`);
      }
    }
    lines.push('');
    lines.push('═══════════════════════════════════════════');
    return lines.join('\n');
  }

  async function copyRunSteps(run: RunData, evt?: Event): Promise<void> {
    if (evt) evt.stopPropagation();
    const text = buildRunStepsText(run, runSteps);
    if (!text) return;
    const id = run.id;
    try {
      await navigator.clipboard.writeText(text);
      copyStatus = { ...copyStatus, [id]: 'copied' };
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copyStatus = { ...copyStatus, [id]: 'copied' };
      } catch {
        copyStatus = { ...copyStatus, [id]: 'error' };
      }
    }
    if (copyTimers[id]) clearTimeout(copyTimers[id]);
    copyTimers[id] = setTimeout(() => {
      copyStatus = { ...copyStatus, [id]: 'idle' };
    }, 2000);
  }

  // ── Helpers ────────────────────────────────────
  function formatMs(ms: number): string {
    if (ms < 60000) return (ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'min';
    return Math.round(ms / 3600000) + 'h';
  }
  function formatTime(iso: string): string {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  }
  function statusColor(status: string): string {
    if (status === 'completed') return 'var(--green)';
    if (status === 'failed') return 'var(--red)';
    if (status === 'running') return 'var(--blue)';
    return 'var(--text-3)';
  }

  // ── Lifecycle ──────────────────────────────────
  onMount(async () => {
    graphData = await fetchGraph();
    if (graphData) {
      flows = graphData.flows ?? [];
      ranks = graphData.ranks ?? [];
      assignColors(graphData.agents);
      positions = computeLayout(graphData.agents, graphData.chains);
    } else {
      dataError = true;
    }
    // Signal the 3D loader that the first fetch is done — even an empty/failed
    // result counts, so it can reveal the (empty) office or an error instead of
    // spinning forever.
    dataLoaded = true;
    // Optional host→3D bridge: an external extension can expose a host engine's
    // state to animate the Resolver. In core this is a no-op.
    const pollHost = async () => {
      try {
        return;
      } catch {}
    };
    pollHost();
    hostTimer = setInterval(pollHost, 3000);
    pollTimer = setInterval(async () => {
      const newData = await fetchGraph();
      if (!newData) return;
      const agentsChanged = JSON.stringify(newData.agents.map(a => a.id + a.active)) !==
                            JSON.stringify((graphData?.agents ?? []).map(a => a.id + a.active));
      const chainsChanged = JSON.stringify(newData.chains.map(c => c.id)) !==
                            JSON.stringify((graphData?.chains ?? []).map(c => c.id));
      // Only reassign graphData when something the UI cares about changed — a
      // fresh array ref would otherwise re-trigger reactive blocks (3D scene
      // fingerprint, derived stats) on every poll with no structural diff.
      if (agentsChanged || chainsChanged) {
        graphData = newData;
        assignColors(graphData.agents);
        positions = computeLayout(graphData.agents, graphData.chains);
      } else {
        // Stats/runs may have updated — refresh only those slots in place.
        graphData = { ...graphData!, stats: newData.stats, recentRuns: newData.recentRuns };
      }
    }, 60000);
  });

  // ── Stream helpers (kept in parent for filteredFlowEvents search) ──
  function eventAgentName(evt: AgentFlowEvent): string {
    return String(evt.data.agent_name ?? evt.data.source_agent_name ?? '');
  }

  function eventDetail(evt: AgentFlowEvent): string {
    const t = evt.event.split(':').pop() ?? '';
    if (t === 'run_started') return `Goal: ${String(evt.data.goal ?? '').slice(0, 120)}`;
    if (t === 'run_completed') {
      const status = evt.data.status === 'completed' ? 'Success' : 'Failed';
      return `${status} | ${evt.data.steps_count ?? 0} steps | ${evt.data.tokens_used ?? 0} tokens | ${String(evt.data.result_preview ?? evt.data.error ?? '').slice(0, 150)}`;
    }
    if (t === 'chain_triggered') return `Triggering "${evt.data.target_agent_name}" via chain "${evt.data.chain_label}"`;
    if (t === 'step') {
      const st = String(evt.data.type ?? '');
      if (st === 'tool_call') return `${evt.data.tool_name}(${String(evt.data.content_preview ?? '').slice(0, 150)})`;
      return String(evt.data.content_preview ?? '').slice(0, 200);
    }
    return JSON.stringify(evt.data).slice(0, 150);
  }

  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); if (hostTimer) clearInterval(hostTimer); });
</script>

<svelte:head>
  <title>Agent Flow — Kernl</title>
</svelte:head>

<svelte:window on:mousemove={e => { onDragMove(e); onChainDragMove(e); }} on:mouseup={e => { onDragEnd(); onChainDragEnd(e); }} />

<div class="flow-shell">
  <!-- Stat bar (2D only — in 3D the hq-bar inside AgentWorld3D replaces this) -->
  {#if viewMode === '2d'}
    <div class="flow-stats">
      <div class="flow-filter">
        <select class="flow-select" bind:value={selectedFlowId} on:change={() => selectFlow(selectedFlowId)}>
          <option value={null}>All departments</option>
          {#each flows as flow (flow.id)}
            <option value={flow.id}>{flow.name}</option>
          {/each}
        </select>
        {#if selectedFlowId}
          <button class="flow-filter-del" on:click={() => selectedFlowId && deleteFlow(selectedFlowId)} title="Delete this flow">&times;</button>
        {/if}
        <!-- Office + agent creation is unified through the "New Office" AI
             chat in the HQ menu (3D view). The legacy form-based buttons
             (+ flow, + Node, AI Agent) used to live here. -->
      </div>
      <div class="stats-sep"></div>
      <div class="stat-pill"><div class="dot" style="background:var(--purple)"></div> Agents: <span class="num">{activeCount}</span></div>
      <div class="stat-pill"><div class="dot" style="background:var(--red)"></div> Chains: <span class="num">{chains.length}</span></div>
      <div class="stat-pill"><div class="dot" style="background:var(--blue)"></div> Triggers: <span class="num">{triggerCount}</span></div>
      <div class="stat-pill"><div class="dot" style="background:var(--green)"></div> Runs today: <span class="num">{todayRuns}</span></div>
      <div class="live-indicator"><div class="live-dot"></div></div>
    </div>
  {/if}

  <!-- Assign to Flow Modal -->
  {#if showAssignFlow}
    <div class="modal-overlay" on:click={() => showAssignFlow = false} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && (showAssignFlow = false)}>
      <div class="modal-content" on:click|stopPropagation role="presentation">
        <h3>Assign to Flow</h3>
        <p class="modal-desc">Assign <strong>{agentMap[assignAgentId]?.name ?? assignAgentId}</strong> to a flow:</p>
        <div class="flow-pick-list">
          {#each flows as flow (flow.id)}
            <button class="flow-pick-item" class:selected={assignFlowId === flow.id}
              on:click={() => assignFlowId = flow.id}>
              <span class="flow-tab-dot" style="background:{flow.color}"></span>
              {flow.name}
            </button>
          {/each}
          {#if flows.length === 0}
            <p class="modal-desc">No flows yet. Create one first.</p>
          {/if}
        </div>
        <div class="modal-actions">
          <button class="modal-btn modal-cancel" on:click={() => showAssignFlow = false}>Cancel</button>
          <button class="modal-btn modal-confirm" on:click={assignToFlow} disabled={!assignFlowId}>Assign</button>
        </div>
      </div>
    </div>
  {/if}
  <!-- Canvas + Detail wrapper -->
  <div class="flow-body">
    <!-- View mode toggle (floating) -->
    <div class="view-toggle">
      <button class="view-btn" class:active={viewMode === '2d'} on:click={() => viewMode = '2d'} title="2D Canvas">2D</button>
      <button class="view-btn" class:active={viewMode === '3d'} on:click={() => viewMode = '3d'} title="3D Command Center">3D</button>
    </div>

    {#if viewMode === '3d'}
      <div class="world3d-wrapper">
        <AgentWorld3D
          {agents}
          {chains}
          {flows}
          {ranks}
          {dataLoaded}
          {dataError}
          flowEvents={$agentFlowEvents}
          runningAgentIds={effectiveRunning}
          {stats}
          {triggerCount}
          {todayRuns}
          on:refresh={async () => {
            dataError = false;
            const fresh = await fetchGraph();
            if (fresh) {
              graphData = fresh;
              flows = graphData.flows ?? flows;
              ranks = graphData.ranks ?? ranks;
              assignColors(graphData.agents);
              positions = computeLayout(graphData.agents, graphData.chains);
            } else {
              dataError = true;
            }
            dataLoaded = true;
          }}
        />
      </div>
    {:else}
    <!-- Canvas -->
    <div class="canvas" class:detail-open={selectedAgent != null} bind:this={canvasEl}>
      <div class="canvas-inner" style="width:{canvasBounds.w}px;height:{canvasBounds.h}px">
        <!-- SVG Connections -->
        <svg class="connections-svg" bind:this={svgEl} width={canvasBounds.w} height={canvasBounds.h}>
          <defs>
            {#each connectionData as cd (cd.chain.id)}
              <linearGradient id="grad-{cd.chain.id}" gradientUnits="userSpaceOnUse"
                x1={cd.gradX1} y1={cd.gradY1} x2={cd.gradX2} y2={cd.gradY2}>
                <stop offset="0%" stop-color={cd.srcPal.color} />
                <stop offset="100%" stop-color={cd.tgtPal.color} />
              </linearGradient>
            {/each}
          </defs>

          {#each connectionData as cd (cd.chain.id)}
            {@const isActive = activeChainIds.has(cd.chain.id)}
            <!-- Glow: only visible when chain is transmitting -->
            <path d={cd.d} class="chain-path-glow" class:chain-active={isActive} stroke="url(#grad-{cd.chain.id})" />
            <!-- Path: static dashes by default, animated only when active -->
            <path d={cd.d} class="chain-path" class:chain-path-animated={isActive} class:chain-idle={!isActive} stroke="url(#grad-{cd.chain.id})" id="path-{cd.chain.id}" />
            <!-- Particles: only rendered when chain is actively transmitting -->
            {#if isActive}
              <circle class="chain-particle chain-particle-active" fill={cd.srcPal.color} r="3">
                <animateMotion dur="1.5s" repeatCount="indefinite"><mpath href="#path-{cd.chain.id}" /></animateMotion>
              </circle>
              <circle class="chain-particle chain-particle-active" fill={cd.tgtPal.color} r="2.5">
                <animateMotion dur="1.5s" begin="0.75s" repeatCount="indefinite"><mpath href="#path-{cd.chain.id}" /></animateMotion>
              </circle>
            {/if}
            <path d={cd.arrow} class="chain-arrow" class:chain-arrow-active={isActive} stroke={cd.tgtPal.color} />
            {#if cd.chain.label}
              <rect x={cd.lp.x - cd.chain.label.length * 3 - 6} y={cd.lp.y - 9}
                width={cd.chain.label.length * 6 + 12} height="18" class="chain-label-bg" class:chain-label-active={isActive} />
              <text x={cd.lp.x} y={cd.lp.y} class="chain-label-text" class:chain-label-text-active={isActive}>{cd.chain.label}</text>
            {/if}
            <!-- Port dots: brighter when active -->
            <circle cx={cd.gradX1} cy={cd.gradY1} r={isActive ? 5 : 4} fill={cd.srcPal.color} opacity={isActive ? 1 : 0.4} class="port-dot" class:port-dot-active={isActive} />
            <circle cx={cd.gradX2} cy={cd.gradY2} r={isActive ? 5 : 4} fill={cd.tgtPal.color} opacity={isActive ? 1 : 0.4} class="port-dot" class:port-dot-active={isActive} />
          {/each}

          {#if chainDragging && chainDragSource && positions[chainDragSource]}
            {@const src = positions[chainDragSource]}
            {@const x1 = src.x + CARD_W}
            {@const y1 = src.y + CARD_H / 2}
            {@const x2 = chainDragMouse.x}
            {@const y2 = chainDragMouse.y}
            {@const cpx = Math.max(Math.abs(x2 - x1) * 0.45, 60)}
            <path d="M {x1} {y1} C {x1 + cpx} {y1}, {x2 - cpx} {y2}, {x2} {y2}"
              fill="none" stroke="var(--teal)" stroke-width="2" stroke-dasharray="6 4" opacity="0.7" />
            <circle cx={x2} cy={y2} r="5" fill="var(--teal)" opacity="0.7" />
          {/if}
        </svg>

        <!-- Agent Cards -->
        {#each agents as agent, i (agent.id)}
          {@const pos = positions[agent.id]}
          {@const pal = agentColors[agent.id] ?? PALETTE[0]}
          {@const isRunning = effectiveRunning.has(agent.id)}
          {@const st = stats[agent.id] ?? { total_runs: 0, completed: 0, failed: 0, success_rate: 0 }}
          {@const aTriggers = triggersByAgent[agent.id] ?? []}
          {@const aSchedules = schedulesByAgent[agent.id] ?? []}
          {@const aRuns = runsByAgent[agent.id] ?? []}
          {@const cOut = chainCountOut[agent.id] ?? 0}
          {@const cIn = chainCountIn[agent.id] ?? 0}
          {#if pos}
            <div class="agent-card"
              data-agent-id={agent.id}
              class:inactive={!agent.active}
              class:running={isRunning}
              class:live-running={liveRunningAgents.has(agent.id)}
              class:selected={selectedAgentId === agent.id}
              class:dragging={dragging?.id === agent.id}
              style="left:{pos.x}px;top:{pos.y}px;--agent-color:{pal.color};--agent-glow:{pal.glow};--node-type-color:{nodeTypeColor(agent)};animation-delay:{i * 0.06}s"
              on:mousedown={e => onDragStart(e, agent.id)}
              role="button" tabindex="0"
              on:keydown={e => e.key === 'Enter' && selectAgent(agent.id)}>
              <div class="card-port card-port-in" data-agent-id={agent.id}></div>
              <div class="card-port card-port-out" on:mousedown|stopPropagation={(e) => onChainDragStart(agent.id, e)} title="Drag to connect"></div>
              <div class="card-header">
                <div class="card-status" class:active={agent.active && !isRunning} class:running-dot={isRunning} class:inactive-dot={!agent.active}></div>
                <span class="card-type-icon" style="color:{nodeTypeColor(agent)}">{nodeTypeIcon(agent)}</span>
                <div class="card-name">{agent.name}</div>
              </div>
              <div class="card-desc">{agent.description || 'No description'}</div>
              <div class="card-badges">
                <span class="flow-badge badge-type" style="background:{nodeTypeColor(agent)}22;color:{nodeTypeColor(agent)}">{nodeTypeLabel(agent)}</span>
                <span class="flow-badge badge-provider">{agent.provider || 'default'}</span>
                {#if aTriggers.length > 0}
                  <span class="flow-badge badge-trigger">{aTriggers.length} trigger{aTriggers.length > 1 ? 's' : ''}</span>
                {/if}
                {#if aSchedules.length > 0}
                  <span class="flow-badge badge-schedule">schedule</span>
                {/if}
                {#if cOut > 0 || cIn > 0}
                  <span class="flow-badge badge-chain">
                    {#if cIn > 0}{cIn} in{/if}{#if cIn > 0 && cOut > 0} / {/if}{#if cOut > 0}{cOut} out{/if}
                  </span>
                {/if}
              </div>
              <div class="card-stats">
                <div class="card-stat">Runs: <span>{st.total_runs}</span></div>
                <div class="card-stat">Success: <span>{st.success_rate}%</span></div>
                <div class="card-stat">Failed: <span>{st.failed}</span></div>
                {#if liveStepCounts[agent.id]}
                  <div class="card-stat live-steps">{liveStepCounts[agent.id]} steps <span class="live-dot-mini"></span></div>
                {/if}
              </div>
              {#if aRuns.length > 0}
                <div class="card-run-dots">
                  {#each aRuns as r}
                    <div class="run-dot {r.status}" title="{r.status} — {timeAgo(r.created_at)}"></div>
                  {/each}
                </div>
              {/if}
              <div class="card-actions">
                {#if isRunning || stoppingIds.has(agent.id)}
                  <button type="button" class="card-act card-act-stop"
                    on:mousedown|stopPropagation
                    on:click|stopPropagation={() => doStopAgent(agent.id)}
                    disabled={stoppingIds.has(agent.id)}>
                    {stoppingIds.has(agent.id) ? '...' : '■'} Stop
                  </button>
                {:else}
                  <button type="button" class="card-act card-act-run"
                    on:mousedown|stopPropagation
                    on:click|stopPropagation={() => doRunAgent(agent.id)}>
                    ▶ Run
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        {/each}

        <!-- Empty state -->
        {#if agents.length === 0}
          <div class="empty-state">
            <h2>No agents yet</h2>
            <p>Create agents via MCP tools and they'll appear here with their connections, chains, and execution history.</p>
          </div>
        {/if}
      </div>
    </div>

    <!-- Detail Panel -->
    <div class="detail-panel" class:open={selectedAgent != null}>
      {#if selectedAgent}
        {@const pal = agentColors[selectedAgent.id] ?? PALETTE[0]}
        <div class="detail-top-row">
          <div class="detail-title" style="color:{pal.color}">{selectedAgent.name}</div>
          {#if !editing}
            <button
              class="edit-btn"
              on:click={() => openAgentWorkspace(selectedAgent)}
              title="Open workspace in Commander"
              disabled={!selectedAgent.flow_id}
            >&#9783;</button>
            <button class="edit-btn" on:click={startEditing} title="Edit">&#9998;</button>
          {/if}
          <button class="detail-close" on:click={() => selectedAgentId = null}>&times;</button>
        </div>
        <div class="detail-id">{selectedAgent.id}</div>

        {#if editing}
          <!-- Editable fields -->
          <div class="detail-section">
            <h3>Info</h3>
            <label class="edit-label">Name
              <input class="edit-input" bind:value={editData.name} />
            </label>
            <label class="edit-label">Description
              <input class="edit-input" bind:value={editData.description} placeholder="What does this agent do?" />
            </label>
            <div class="edit-row-2">
              <label class="edit-label">Provider
                <select class="edit-input" bind:value={editData.provider}>
                  <option value="">default</option>
                  <option value="anthropic">anthropic</option>
                  <option value="openai">openai</option>
                  <option value="lmstudio">lmstudio</option>
                </select>
              </label>
              <label class="edit-label">Model
                <input class="edit-input" bind:value={editData.model} placeholder="Leave blank for default" />
              </label>
            </div>
            <div class="edit-row-2">
              <label class="edit-label">Max Iterations
                <input class="edit-input" type="number" bind:value={editData.max_iterations} min="1" max="100" />
              </label>
              <label class="edit-label">Timeout (ms)
                <input class="edit-input" type="number" bind:value={editData.timeout_ms} min="10000" step="10000" />
              </label>
            </div>
            <div class="edit-row-2">
              <label class="edit-label">Max Tokens
                <input class="edit-input" type="number" bind:value={editData.max_tokens} min="1000" step="1000" />
              </label>
              <label class="edit-label">Max Errors
                <input class="edit-input" type="number" bind:value={editData.max_errors} min="1" max="20" />
              </label>
            </div>
            <div class="edit-row-2">
              <label class="edit-label edit-toggle">
                <input type="checkbox" bind:checked={editData.active} /> Active
              </label>
              <label class="edit-label edit-toggle">
                <input type="checkbox" bind:checked={editData.show_on_dashboard} /> Show on Dashboard
              </label>
            </div>
          </div>

          <div class="detail-section">
            <h3>System Prompt</h3>
            <textarea class="edit-textarea" bind:value={editData.system_prompt} rows="14" placeholder="You are..."></textarea>
          </div>

          <div class="detail-section">
            <h3>Goal Template</h3>
            <textarea class="edit-textarea" bind:value={editData.goal_template} rows="4" placeholder="Execute the agent..."></textarea>
          </div>

          <div class="detail-section">
            <h3>Tools</h3>
            <label class="edit-label">Allowed Tools <span class="vars-hint">comma-separated</span>
              <textarea class="edit-textarea" bind:value={editAllowedTools} rows="2" placeholder="kernel_dev_read_file, kernel_dev_search, ..."></textarea>
            </label>
            <label class="edit-label">Denied Tools <span class="vars-hint">comma-separated</span>
              <textarea class="edit-textarea" bind:value={editDeniedTools} rows="2" placeholder="Leave empty for none"></textarea>
            </label>
          </div>

          <div class="detail-section">
            <h3>Variables <span class="vars-hint">Use &#123;&#123;key&#125;&#125; in prompts</span></h3>
            {#each editVars as v, i}
              <div class="var-row">
                <input class="edit-input var-key" bind:value={v.key} placeholder="key" />
                <input class="edit-input var-val" bind:value={v.value} placeholder="value" />
                <button class="var-del" on:click={() => removeVar(i)} title="Remove">&times;</button>
              </div>
            {/each}
            <button class="var-add" on:click={addVar}>+ Add variable</button>
          </div>

          {#if saveError}
            <div class="edit-error">{saveError}</div>
          {/if}
          <div class="edit-actions">
            <button class="edit-cancel" on:click={cancelEditing}>Cancel</button>
            <button class="edit-save" on:click={saveAgent} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        {:else}
          <!-- Read-only view -->
          <div class="detail-section">
            <h3>Info</h3>
            <div class="detail-field"><strong>Status:</strong> {selectedAgent.active ? 'Active' : 'Inactive'}{selectedAgent.show_on_dashboard ? ' · Dashboard widget' : ''}</div>
            <div class="detail-field"><strong>Provider:</strong> {(selectedAgent.provider || 'default')}{selectedAgent.model ? ' / ' + selectedAgent.model : ''}</div>
            <div class="detail-field"><strong>Max iterations:</strong> {selectedAgent.max_iterations} · <strong>Max tokens:</strong> {selectedAgent.max_tokens ?? '—'} · <strong>Max errors:</strong> {selectedAgent.max_errors ?? '—'}</div>
            <div class="detail-field"><strong>Timeout:</strong> {formatMs(selectedAgent.timeout_ms)}</div>
            {#if selectedAgent.description}
              <div class="detail-field">{selectedAgent.description}</div>
            {/if}
            <button class="assign-flow-btn" on:click={() => { assignAgentId = selectedAgent?.id ?? ''; showAssignFlow = true; }}>
              Assign to Flow
            </button>
          </div>

          {#if selectedAgent.system_prompt}
            <div class="detail-section">
              <h3>System Prompt</h3>
              <div class="detail-prompt">{selectedAgent.system_prompt}</div>
            </div>
          {/if}

          {#if selectedAgent.goal_template}
            <div class="detail-section">
              <h3>Goal Template</h3>
              <div class="detail-prompt">{selectedAgent.goal_template}</div>
            </div>
          {/if}

          {@const allowedTools = parseTools(selectedAgent.allowed_tools)}
          {@const deniedTools = parseTools(selectedAgent.denied_tools)}
          {#if allowedTools.length > 0 || deniedTools.length > 0}
            <div class="detail-section">
              <h3>Tools</h3>
              {#if allowedTools.length > 0}
                <div class="detail-field"><strong>Allowed:</strong> {allowedTools.join(', ')}</div>
              {/if}
              {#if deniedTools.length > 0}
                <div class="detail-field"><strong>Denied:</strong> {deniedTools.join(', ')}</div>
              {/if}
            </div>
          {/if}

          {@const agentVars = parseVars(selectedAgent.variables)}
          {#if agentVars.length > 0}
            <div class="detail-section">
              <h3>Variables</h3>
              {#each agentVars as v}
                <div class="detail-field"><strong>{v.key}:</strong> <code>{v.value}</code></div>
              {/each}
            </div>
          {/if}

          <!-- The drawer's SKILLS tab, in the 2D list. Same component the
               drawer mounts on both surfaces, so an agent picked off the
               floor plan is configured exactly like one picked off the list. -->
          <div class="detail-section">
            <SkillsTab agent={selectedAgent} compact on:change={onSkillsChange} />
          </div>
        {/if}

        {#if selectedStats}
          <div class="detail-section">
            <h3>Performance</h3>
            <div class="detail-field"><strong>Total runs:</strong> {selectedStats.total_runs}</div>
            <div class="detail-field"><strong>Success rate:</strong> {selectedStats.success_rate}%</div>
            <div class="detail-field"><strong>Completed / Failed:</strong> {selectedStats.completed} / {selectedStats.failed}</div>
          </div>
        {/if}

        {#if selectedChains.length > 0}
          <div class="detail-section">
            <h3>Chains ({selectedChains.length})</h3>
            {#each selectedChains as c}
              {@const isOut = c.source_agent_id === selectedAgentId}
              {@const otherId = isOut ? c.target_agent_id : c.source_agent_id}
              {@const otherPal = agentColors[otherId] ?? PALETTE[0]}
              <div class="detail-field chain-row">
                <span style="color:{otherPal.color}">{isOut ? '\u2192' : '\u2190'}</span>
                <strong>{agentMap[otherId]?.name ?? otherId}</strong>
                {#if c.label} — {c.label}{/if}
                {#if c.pass_result} (passes result){/if}
                {#if c.delay_ms > 0} delay:{c.delay_ms}ms{/if}
                <button class="chain-del" on:click|stopPropagation={() => deleteChain(c.id)} title="Remove chain">&times;</button>
              </div>
            {/each}
          </div>
        {/if}

        {#if selectedTriggers.length > 0 || selectedSchedules.length > 0}
          <div class="detail-section">
            <h3>Triggers</h3>
            {#each selectedTriggers as t}
              <div class="detail-field"><strong>{t.event_name}</strong> cooldown:{t.cooldown_ms}ms</div>
            {/each}
            {#each selectedSchedules as s}
              <div class="detail-field">every <strong>{formatMs(s.interval_ms)}</strong> next: {formatTime(s.next_run_at)}</div>
            {/each}
          </div>
        {/if}

        {#if selectedLiveEvents.length > 0}
          <div class="detail-section">
            <h3>Live <span class="live-badge">LIVE</span></h3>
            <div class="live-feed">
              {#each selectedLiveEvents as evt}
                <div class="live-event live-event-{evt.event.split(':').pop()}">
                  <span class="live-event-type">{evt.event.split(':').pop()}</span>
                  {#if evt.data.tool_name}<span class="step-tool">{evt.data.tool_name}</span>{/if}
                  <span class="live-event-preview">{evt.data.content_preview || evt.data.status || ''}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if selectedRuns.length > 0}
          <div class="detail-section">
            <h3>Recent Runs</h3>
            {#each selectedRuns as r}
              <button class="run-row" on:click={() => toggleRunSteps(r.id)}>
                <div class="run-indicator" style="background:{statusColor(r.status)}"></div>
                <span style="color:var(--text-2)">{r.trigger_type}</span>
                <span style="color:var(--text-3);font-size:10px">{r.steps_count}st / {r.tokens_used}tk</span>
                <span style="color:var(--text-3);font-size:10px;margin-left:auto">{timeAgo(r.created_at)}</span>
                <span class="run-expand" class:expanded={expandedRunId === r.id}>&#9656;</span>
              </button>
              {#if expandedRunId === r.id}
                <div class="run-steps">
                  {#if !loadingSteps}
                    <div class="run-steps-toolbar">
                      <button
                        class="copy-steps-btn"
                        class:copied={copyStatus[r.id] === 'copied'}
                        class:error={copyStatus[r.id] === 'error'}
                        on:click={(e) => copyRunSteps(r, e)}
                        title="Copy run + steps as text (paste-ready for Claude Code)"
                      >
                        {#if copyStatus[r.id] === 'copied'}
                          ✓ Copied
                        {:else if copyStatus[r.id] === 'error'}
                          ✗ Error
                        {:else}
                          📋 Copy run + steps
                        {/if}
                      </button>
                    </div>
                  {/if}
                  {#if runDetail && !loadingSteps}
                    <div class="run-summary">
                      <div class="rs-block">
                        <span class="rs-cap">🎯 Objetivo</span>
                        <div class="rs-goal">{runDetail.goal}</div>
                      </div>
                      {#if runDetail.result}
                        <div class="rs-block">
                          <span class="rs-cap rs-cap-ok">📤 Resultado</span>
                          <div class="rs-result">{runDetail.result}</div>
                        </div>
                      {/if}
                      {#if runDetail.error}
                        <div class="rs-block">
                          <span class="rs-cap rs-cap-err">⚠️ Error</span>
                          <div class="rs-error">{runDetail.error}</div>
                        </div>
                      {/if}
                      <div class="rs-meta">
                        <span class="rs-chip rs-status rs-{runDetail.status}">{statusLabel(runDetail.status)}</span>
                        {#if runDuration(runDetail)}<span class="rs-chip">⏱ {runDuration(runDetail)}</span>{/if}
                        <span class="rs-chip">{runDetail.steps_count} pasos</span>
                        <span class="rs-chip">{runDetail.tokens_used} tokens</span>
                        {#if runEval(runEvents)}
                          {@const ev = runEval(runEvents)}
                          <span class="rs-chip rs-eval" title="{ev.outcome} · confianza {(ev.confidence*100).toFixed(0)}%">{stars(ev.score)}</span>
                        {/if}
                      </div>
                    </div>
                  {/if}
                  {#if loadingSteps}
                    <div class="step-loading">Loading steps...</div>
                  {:else if runSteps.length === 0}
                    <div class="step-loading">No steps recorded</div>
                  {:else}
                    <div class="tl">
                      {#each groupSteps(runSteps) as step (step.id)}
                        {@const info = stepInfo(step)}
                        {@const sub = stepSub(step)}
                        {@const detail = hasDetail(step)}
                        <div class="tl-step tl-{info.tone}">
                          <span class="tl-dot" style="--tc:{info.color}">{info.icon}</span>
                          <div class="tl-main">
                            <button
                              class="tl-head"
                              class:tl-clickable={detail}
                              on:click={() => detail && toggleStep(step.id)}
                            >
                              <span class="tl-label">{info.label}</span>
                              {#if step.tool_name && info.tone === 'tool' && !step.__searchGroup}
                                <span class="tl-tool">{step.tool_name}</span>
                              {/if}
                              {#if sub}<span class="tl-sub" class:tl-count={step.__searchGroup}>{sub}</span>{/if}
                              {#if detail}
                                <span class="tl-caret" class:open={expandedSteps.has(step.id)}>&#9656;</span>
                              {/if}
                            </button>
                            {#if detail && expandedSteps.has(step.id)}
                              <div class="tl-detail copy-wrap">
                                <CopyTextBtn text={stepDetail(step)} title="Copy" />
                                <pre>{truncate(stepDetail(step), 2000)}</pre>
                              </div>
                            {/if}
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      {/if}
    </div>
    {/if}
  </div>

  <!-- Message Stream Panel -->
  <MessageStream
    bind:open={streamOpen}
    bind:height={streamHeight}
    bind:streamTypeFilter
    bind:streamAgentFilter
    bind:streamSearch
    bind:streamAutoScroll
    bind:showPersisted
    {flowEvents}
    {filteredFlowEvents}
    {streamAgentNames}
    {streamTokenTotal}
    {streamRunDurations}
    {agentColors}
    {liveRunningAgents}
    {persistedEvents}
    {persistedTotal}
    {persistedLoading}
    on:clear={() => agentFlowEvents.set([])}
    on:togglePersisted={() => { if (showPersisted) loadPersistedEvents(); }}
    on:clearPersisted={clearPersistedEvents}
    on:selectAgent={e => { selectedAgentId = e.detail; }}
  />
</div>

<style>
  :global(.copy-wrap){position:relative}
  /* ── Shell: fills the full-bleed slot ── */
  .flow-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  /* ── Stat bar ───────────────────────── */
  .flow-stats {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    flex-shrink: 0;
  }
  .stat-pill {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 16px;
    background: var(--surface-2); border: 1px solid var(--border);
    font-size: 11px; color: var(--text-2);
  }
  .stat-pill .num { font-weight: 700; color: var(--text-1); font-size: 13px; }
  .stat-pill .dot { width: 6px; height: 6px; border-radius: 50%; }
  .live-indicator { margin-left: auto; }
  .live-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--green);
    animation: livePulse 2s ease-in-out infinite;
  }
  @keyframes livePulse {
    0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(61,214,140,0.5); }
    50% { opacity: 0.6; box-shadow: 0 0 0 6px rgba(61,214,140,0); }
  }

  /* ── View toggle (floating) ─────────── */
  .view-toggle {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 20;
    display: flex; border-radius: 8px; overflow: hidden;
    border: 1px solid var(--border);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }
  .view-btn {
    padding: 6px 14px; font-size: 11px; font-weight: 700;
    font-family: var(--font-mono, 'Fira Code', monospace);
    background: var(--surface-1, #0e1018); color: var(--text-3);
    border: none; cursor: pointer; transition: all 0.15s;
    letter-spacing: 0.5px;
  }
  .view-btn:first-child { border-right: 1px solid var(--border); }
  .view-btn:hover { color: var(--text-1); background: var(--surface-3); }
  .view-btn.active {
    background: var(--purple, #6366f1); color: #fff;
  }

  /* ── 3D World wrapper ──────────────── */
  .world3d-wrapper {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  /* ── Body: canvas + detail side by side ── */
  .flow-body {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
    overflow: hidden;
  }

  /* ── Canvas ─────────────────────────── */
  .canvas {
    flex: 1;
    overflow: auto;
    transition: margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .canvas.detail-open {
    margin-right: 520px;
  }
  .canvas-inner { position: relative; min-width: 100%; min-height: 100%; }
  .connections-svg {
    position: absolute; top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none; z-index: 1;
  }

  /* ── Agent Cards ────────────────────── */
  .agent-card {
    position: absolute; z-index: 10; width: 220px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 10px 12px; cursor: grab;
    transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    animation: cardAppear 0.5s ease-out backwards;
  }
  .agent-card::before {
    content: ''; position: absolute; left: 0; top: 8px; bottom: 8px;
    width: 3px; border-radius: 0 3px 3px 0;
    background: var(--agent-color);
  }
  .agent-card:hover {
    transform: translateY(-3px);
    border-color: var(--border-h);
    box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 20px var(--agent-glow);
  }
  .agent-card.selected { border-color: var(--agent-color); box-shadow: 0 0 30px var(--agent-glow); }
  .agent-card.dragging { z-index: 20; cursor: grabbing; box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 24px var(--agent-glow); transform: scale(1.03); transition: none; }
  .agent-card.inactive { opacity: 0.35; filter: saturate(0.3); }
  .agent-card.running {
    border-color: var(--agent-color);
    animation: cardAppear 0.5s ease-out backwards, runPulse 2s ease-in-out infinite;
  }
  @keyframes cardAppear { from { opacity: 0; transform: translateY(20px) scale(0.95); } }
  @keyframes runPulse {
    0%,100% { box-shadow: 0 0 8px var(--agent-glow); }
    50% { box-shadow: 0 0 24px var(--agent-glow), 0 0 48px rgba(91,155,247,0.08); }
  }
  .card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .card-status { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .card-status.active { background: var(--green); box-shadow: 0 0 8px rgba(61,214,140,0.5); }
  .card-status.inactive-dot { background: var(--text-3); }
  .card-status.running-dot { background: var(--blue); animation: livePulse 1s ease-in-out infinite; }
  .card-name { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; color: var(--text-1); }
  .card-desc { font-size: 10px; color: var(--text-2); line-height: 1.3; max-height: 26px; overflow: hidden; margin-bottom: 6px; }
  .card-badges { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 6px; }
  .flow-badge {
    display: inline-flex; align-items: center; gap: 2px;
    padding: 1px 5px; border-radius: 3px;
    font-size: 9px; font-weight: 500;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2);
  }
  .badge-provider { color: var(--teal); border-color: rgba(61,214,200,0.2); }
  .badge-trigger { color: var(--purple); border-color: rgba(139,124,246,0.2); }
  .badge-schedule { color: var(--gold); border-color: rgba(212,168,75,0.2); }
  .badge-chain { color: var(--red); border-color: rgba(240,71,112,0.2); }
  .card-stats { display: flex; gap: 8px; }
  .card-stat { font-size: 9px; color: var(--text-3); }
  .card-stat span { font-weight: 700; color: var(--text-2); }
  .card-run-dots { display: flex; gap: 2px; margin-top: 5px; }
  .run-dot { width: 5px; height: 5px; border-radius: 50%; transition: transform 0.2s; }
  .run-dot:hover { transform: scale(1.8); }
  :global(.run-dot.completed) { background: var(--green); }
  :global(.run-dot.failed) { background: var(--red); }

  .card-actions { display: flex; gap: 4px; margin-top: 6px; }
  .card-act {
    flex: 1; padding: 3px 0; border-radius: 5px;
    font-size: 9px; font-weight: 600; font-family: var(--font-body);
    cursor: pointer; border: 1px solid var(--border);
    background: none; transition: all 0.15s;
    display: flex; align-items: center; justify-content: center; gap: 4px;
  }
  .card-act-run { color: var(--teal); }
  .card-act-run:hover { border-color: var(--teal); background: rgba(61,214,200,0.1); }
  .card-act-stop { color: var(--red); }
  .card-act-stop:hover { border-color: var(--red); background: rgba(240,71,112,0.1); }
  .card-act-stop:disabled { opacity: 0.4; cursor: default; }
  :global(.run-dot.running) { background: var(--blue); animation: livePulse 1s infinite; }
  :global(.run-dot.cancelled) { background: var(--text-3); }
  :global(.run-dot.pending) { background: var(--gold); }

  /* ── SVG Connections ────────────────── */
  /* Idle chain: static dashed line, muted */
  .chain-path { fill: none; stroke-width: 1.5; stroke-linecap: round; opacity: 0.3; transition: all 0.4s ease; }
  .chain-path.chain-idle { stroke-dasharray: 6 8; }
  /* Glow: hidden by default, visible only when active */
  .chain-path-glow { fill: none; stroke-width: 8; stroke-linecap: round; opacity: 0; filter: blur(4px); transition: opacity 0.4s ease; }
  .chain-path-glow.chain-active { opacity: 0.2; stroke-width: 12; animation: chainGlowPulse 1.5s ease-in-out infinite; }
  @keyframes chainGlowPulse {
    0%,100% { opacity: 0.15; }
    50% { opacity: 0.3; }
  }
  /* Active chain: animated dashes, full opacity, thicker */
  @keyframes dashFlow { to { stroke-dashoffset: -24; } }
  .chain-path-animated {
    stroke-dasharray: 8 4; stroke-width: 2.5; opacity: 0.9;
    animation: dashFlow 0.6s linear infinite;
  }
  /* Particles: only exist when chain is active */
  .chain-particle { opacity: 0; }
  .chain-particle-active { opacity: 0.9; filter: drop-shadow(0 0 3px currentColor); }
  /* Arrow */
  .chain-arrow { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: 0.4; transition: opacity 0.3s; }
  .chain-arrow-active { opacity: 1; stroke-width: 2.5; }
  /* Labels */
  .chain-label-bg { fill: var(--surface-1); rx: 4; ry: 4; stroke: var(--border); stroke-width: 1; transition: all 0.3s; }
  .chain-label-active { stroke: var(--text-2); fill: var(--surface-2); }
  .chain-label-text { font-family: inherit; font-size: 10px; fill: var(--text-3); text-anchor: middle; dominant-baseline: central; transition: fill 0.3s; }
  .chain-label-text-active { fill: var(--text-1); font-weight: 600; }
  /* Port dots */
  .port-dot { transition: r 0.3s, opacity 0.3s; }
  .port-dot:hover { r: 6; opacity: 1; }
  .port-dot-active { animation: portPulse 1.2s ease-in-out infinite; }
  @keyframes portPulse {
    0%,100% { opacity: 0.8; }
    50% { opacity: 1; }
  }

  /* ── Detail Panel ───────────────────── */
  .detail-panel {
    position: absolute; top: 0; right: 0; bottom: 0; width: 640px;
    background: var(--surface-1); border-left: 1px solid var(--border);
    z-index: 50; transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow-y: auto; padding: 20px;
  }
  .detail-panel.open { transform: translateX(0); }
  .detail-close {
    width: 28px; height: 28px; border-radius: 6px; flex-shrink: 0;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); font-size: 14px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.2s;
  }
  .detail-close:hover { background: var(--surface-3); color: var(--text-1); }
  .detail-top-row { display: flex; align-items: center; gap: 8px; }
  .detail-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; flex: 1; }
  .edit-btn {
    width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--border);
    background: none; color: var(--text-2); cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center; transition: all 0.15s;
    flex-shrink: 0;
  }
  .edit-btn:hover { border-color: var(--teal); color: var(--teal); background: rgba(61,214,200,0.1); }
  .detail-id { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); margin-bottom: 16px; }

  /* ── Edit mode ─────────────────────── */
  .edit-label {
    display: block; font-size: 10px; font-weight: 600; color: var(--text-3);
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;
  }
  .edit-input {
    display: block; width: 100%; margin-top: 3px; padding: 6px 8px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text-1); font-size: 12px; font-family: var(--font-body);
    transition: border-color 0.15s; box-sizing: border-box;
  }
  .edit-input:focus { border-color: var(--teal); outline: none; }
  .edit-textarea {
    display: block; width: 100%; padding: 8px 10px; resize: vertical;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text-1); font-size: 11px; font-family: var(--font-mono);
    line-height: 1.5; transition: border-color 0.15s; box-sizing: border-box;
    min-height: 60px;
  }
  .edit-textarea:focus { border-color: var(--teal); outline: none; }
  .edit-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .edit-toggle {
    display: flex !important; align-items: center; gap: 6px; flex-direction: row !important;
    font-size: 11px; cursor: pointer; padding-top: 6px;
  }
  .edit-toggle input[type="checkbox"] {
    width: 14px; height: 14px; accent-color: var(--teal); cursor: pointer;
  }
  .edit-error { font-size: 11px; color: var(--red); margin-bottom: 8px; }
  .edit-actions { display: flex; gap: 8px; margin-top: 4px; }
  .edit-cancel, .edit-save {
    flex: 1; padding: 6px 0; border-radius: 6px; font-size: 11px; font-weight: 600;
    font-family: var(--font-body); cursor: pointer; border: 1px solid var(--border);
    transition: all 0.15s;
  }
  .edit-cancel { background: none; color: var(--text-2); }
  .edit-cancel:hover { background: var(--surface-3); color: var(--text-1); }
  .edit-save { background: var(--teal); border-color: var(--teal); color: var(--bg); }
  .edit-save:hover { opacity: 0.85; }
  .edit-save:disabled { opacity: 0.5; cursor: default; }

  /* ── Variables editor ────────────── */
  .vars-hint { font-size: 9px; font-weight: 400; color: var(--text-3); text-transform: none; letter-spacing: 0; }
  .var-row { display: flex; gap: 4px; margin-bottom: 4px; align-items: center; }
  .var-key { flex: 0 0 35%; }
  .var-val { flex: 1; }
  .var-del {
    width: 22px; height: 22px; border: 1px solid var(--border); border-radius: 4px;
    background: none; color: var(--text-3); cursor: pointer; font-size: 13px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    transition: all 0.15s;
  }
  .var-del:hover { color: var(--red); border-color: var(--red); }
  .var-add {
    font-size: 10px; color: var(--teal); cursor: pointer; background: none;
    border: 1px dashed var(--border); border-radius: 6px; padding: 4px 10px;
    width: 100%; margin-top: 4px; transition: all 0.15s; font-family: var(--font-body);
  }
  .var-add:hover { border-color: var(--teal); background: rgba(61,214,200,0.05); }
  .detail-section { margin-bottom: 16px; }
  .detail-section h3 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
    color: var(--text-3); margin-bottom: 8px;
  }
  .detail-field { font-size: 12px; color: var(--text-2); margin-bottom: 4px; line-height: 1.5; }
  .detail-field strong { color: var(--text-1); }
  .detail-prompt {
    font-size: 11px; color: var(--text-2); background: var(--surface-2);
    padding: 10px 12px; border-radius: 6px; font-family: var(--font-mono);
    white-space: pre-wrap; word-break: break-word;
    max-height: 300px; overflow-y: auto; line-height: 1.5;
    scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  }
  .run-row {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 8px 6px; border: none; background: var(--surface-2);
    border-bottom: 1px solid var(--border); font-size: 11px;
    cursor: pointer; transition: background 0.15s; border-radius: 4px;
    margin-bottom: 2px; font-family: inherit; color: var(--text-1);
  }
  .run-row:hover { background: var(--surface-3); }
  .run-indicator { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .run-expand {
    font-size: 10px; color: var(--text-3); transition: transform 0.2s; flex-shrink: 0;
  }
  .run-expand.expanded { transform: rotate(90deg); }

  /* ── Run Steps ──────────────────────── */
  .run-steps {
    margin: 0 0 12px 0; padding: 8px;
    background: var(--surface-2); border-radius: 8px;
    border: 1px solid var(--border);
    animation: stepsAppear 0.25s ease-out;
  }
  @keyframes stepsAppear { from { opacity: 0; max-height: 0; } to { opacity: 1; max-height: 2000px; } }
  .step-loading { font-size: 11px; color: var(--text-3); padding: 8px; text-align: center; }
  .run-steps-toolbar { display: flex; justify-content: flex-end; padding: 0 0 6px 0; }
  .copy-steps-btn {
    font-size: 11px; padding: 4px 10px; border-radius: 6px;
    background: var(--surface-3); color: var(--text-2);
    border: 1px solid var(--border); cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .copy-steps-btn:hover { background: var(--surface-4); color: var(--text-1); }
  .copy-steps-btn.copied { background: rgba(61,214,140,0.15); color: var(--green); border-color: var(--green); }
  .copy-steps-btn.error { background: rgba(240,71,112,0.15); color: var(--red); border-color: var(--red); }
  .step-item {
    padding: 6px 8px; margin-bottom: 4px; border-radius: 6px;
    border-left: 3px solid var(--border);
  }
  .step-thought { border-left-color: var(--purple); }
  .step-tool_call { border-left-color: var(--teal); }
  .step-tool_result { border-left-color: var(--green); }
  .step-error { border-left-color: var(--red); background: rgba(240,71,112,0.05); }
  .step-final { border-left-color: var(--gold); background: rgba(212,168,75,0.05); }
  .step-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .step-badge {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    padding: 1px 6px; border-radius: 3px; letter-spacing: 0.5px;
  }
  .step-badge-thought { background: rgba(139,124,246,0.15); color: var(--purple); }
  .step-badge-tool_call { background: rgba(61,214,200,0.15); color: var(--teal); }
  .step-badge-tool_result { background: rgba(61,214,140,0.15); color: var(--green); }
  .step-badge-error { background: rgba(240,71,112,0.15); color: var(--red); }
  .step-badge-final { background: rgba(212,168,75,0.15); color: var(--gold); }
  .step-tool {
    font-size: 10px; font-family: var(--font-mono); color: var(--teal);
    background: rgba(61,214,200,0.08); padding: 1px 5px; border-radius: 3px;
  }
  .step-num { font-size: 9px; color: var(--text-3); margin-left: auto; }
  .step-content {
    margin-top: 4px; border-radius: 4px; padding: 6px 8px;
    background: var(--bg); overflow: hidden;
  }
  .step-content pre {
    font-size: 10px; line-height: 1.4; white-space: pre-wrap;
    word-break: break-word; margin: 0; font-family: var(--font-mono);
    color: var(--text-2);
  }
  .step-label {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    color: var(--text-3); letter-spacing: 0.5px;
    display: block; margin-bottom: 3px;
  }
  .step-input pre { color: var(--teal); }
  .step-output pre { color: var(--green); }
  .step-text pre { color: var(--text-1); }

  /* ── Timeline narrativo del run ─────────────────────────── */
  .tl { padding: 4px 2px; }
  .tl-step { position: relative; display: flex; gap: 9px; padding: 2px 0; }
  .tl-step::before { content: ''; position: absolute; left: 9px; top: 0; bottom: 0; width: 1px; background: var(--border); }
  .tl-step:first-child::before { top: 10px; }
  .tl-step:last-child::before { bottom: calc(100% - 20px); }
  .tl-dot {
    position: relative; z-index: 1; flex-shrink: 0; width: 19px; height: 19px;
    display: grid; place-items: center; font-size: 10px; line-height: 1; border-radius: 50%;
    background: var(--surface-1); border: 1px solid var(--tc); box-shadow: 0 0 0 3px var(--surface-2);
  }
  .tl-main { flex: 1; min-width: 0; }
  .tl-head {
    display: flex; align-items: center; gap: 7px; width: 100%; padding: 3px 5px; min-height: 22px;
    background: none; border: none; color: var(--text-1); font-family: inherit; font-size: 11.5px;
    text-align: left; border-radius: 5px; cursor: default; transition: background .12s;
  }
  .tl-head.tl-clickable { cursor: pointer; }
  .tl-head.tl-clickable:hover { background: var(--surface-3); }
  .tl-label { font-weight: 600; white-space: nowrap; flex-shrink: 0; }
  .tl-thought .tl-label { color: var(--text-2); font-weight: 500; }
  .tl-final .tl-label { color: var(--gold); }
  .tl-error .tl-label { color: var(--red); }
  .tl-result .tl-label { color: var(--green); font-weight: 500; }
  .tl-tool { font-family: var(--font-mono); font-size: 9px; color: var(--teal); background: rgba(61,214,200,.1); padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }
  .tl-sub { color: var(--text-2); font-family: var(--font-mono); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .tl-thought .tl-sub { color: var(--text-3); font-style: italic; font-family: var(--font-body); }
  .tl-count { flex: none; color: var(--teal); background: rgba(61,214,200,.12); padding: 0 6px; border-radius: 9px; font-weight: 600; font-size: 10px; }
  .tl-caret { margin-left: auto; flex-shrink: 0; color: var(--text-3); font-size: 9px; transition: transform .2s ease; }
  .tl-caret.open { transform: rotate(90deg); }
  .tl-detail { margin: 3px 0 4px 5px; padding: 7px 9px; background: var(--bg); border-radius: 5px; border-left: 2px solid var(--border-h); animation: stepsAppear .2s ease-out; position: relative; }
  .tl-detail pre { font-size: 10px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; margin: 0; font-family: var(--font-mono); color: var(--text-2); }
  .tl-final .tl-detail { border-left-color: var(--gold); }
  .tl-final .tl-detail pre { color: var(--text-1); }
  .tl-result .tl-detail { border-left-color: var(--green); }

  /* ── Panel de resumen del run ───────────────────────────── */
  .run-summary { padding: 11px 12px; margin: 0 0 9px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; }
  .rs-block { margin-bottom: 9px; }
  .rs-block:last-of-type { margin-bottom: 0; }
  .rs-cap { display: block; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: var(--text-3); margin-bottom: 3px; }
  .rs-cap-ok { color: var(--gold); }
  .rs-cap-err { color: var(--red); }
  .rs-goal { font-size: 12px; line-height: 1.45; color: var(--text-1); }
  .rs-result { font-size: 12px; line-height: 1.45; color: var(--text-1); background: rgba(212,168,75,.07); border-left: 2px solid var(--gold); padding: 6px 9px; border-radius: 5px; white-space: pre-wrap; word-break: break-word; }
  .rs-error { font-size: 11px; line-height: 1.4; color: var(--red); background: rgba(240,71,112,.06); border-left: 2px solid var(--red); padding: 6px 9px; border-radius: 5px; font-family: var(--font-mono); white-space: pre-wrap; word-break: break-word; }
  .rs-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
  .rs-chip { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: var(--surface-3); color: var(--text-2); }
  .rs-status.rs-completed { background: rgba(61,214,140,.14); color: var(--green); }
  .rs-status.rs-failed { background: rgba(240,71,112,.14); color: var(--red); }
  .rs-status.rs-running { background: rgba(91,155,247,.14); color: var(--blue); }
  .rs-eval { background: rgba(212,168,75,.14); color: var(--gold); letter-spacing: 1px; }

  /* ── Live states ─────────────────────── */
  .agent-card.live-running {
    border-color: var(--agent-color);
    animation: cardAppear 0.5s ease-out backwards, liveGlow 1.8s ease-in-out infinite;
  }
  @keyframes liveGlow {
    0%,100% { box-shadow: 0 0 12px var(--agent-glow), inset 0 0 0 1px var(--agent-color); }
    50% { box-shadow: 0 0 36px var(--agent-glow), 0 0 60px var(--agent-glow), inset 0 0 0 1px var(--agent-color); }
  }
  .live-steps {
    color: var(--blue) !important; font-weight: 600;
    display: flex; align-items: center; gap: 4px;
  }
  .live-dot-mini {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--blue);
    animation: livePulse 1.5s ease-in-out infinite;
    display: inline-block;
  }

  /* Active chain: states already handled in base chain styles above */

  /* Live badge */
  .live-badge {
    font-size: 8px; padding: 1px 5px; border-radius: 3px;
    background: rgba(240,71,112,0.15); color: var(--red);
    animation: livePulse 1.5s ease-in-out infinite;
    margin-left: 6px; font-weight: 700; letter-spacing: 0.5px;
  }

  /* Live feed in detail panel */
  .live-feed {
    max-height: 200px; overflow-y: auto;
    display: flex; flex-direction: column; gap: 3px;
  }
  .live-event {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 6px; border-radius: 4px;
    font-size: 10px; border-left: 2px solid var(--border);
    animation: stepsAppear 0.2s ease-out;
  }
  .live-event-run_started { border-left-color: var(--blue); }
  .live-event-step { border-left-color: var(--teal); }
  .live-event-chain_triggered { border-left-color: var(--purple); }
  .live-event-run_completed { border-left-color: var(--green); }
  .live-event-type {
    font-size: 8px; font-weight: 600; text-transform: uppercase;
    padding: 1px 4px; border-radius: 2px;
    background: var(--surface-2); color: var(--text-2);
    flex-shrink: 0;
  }
  .live-event-preview {
    color: var(--text-2); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; flex: 1; min-width: 0;
  }

  /* Live activity items */
  .live-activity { border-color: rgba(91,155,247,0.2); }

  /* ── Empty State ────────────────────── */
  .empty-state {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    text-align: center; color: var(--text-2);
  }
  .empty-state h2 { font-size: 20px; font-weight: 300; margin-bottom: 8px; color: var(--text-3); }
  .empty-state p { font-size: 13px; max-width: 400px; line-height: 1.6; }

  /* ── Flow Tabs ────────────────────── */
  .flow-tabs {
    display: flex; align-items: center; gap: 4px;
    overflow-x: auto; flex-shrink: 0;
    scrollbar-width: none;
  }
  .flow-tabs::-webkit-scrollbar { display: none; }

  /* ── Flow filter dropdown (2D mode) ── */
  .flow-filter {
    display: flex; align-items: center; gap: 4px;
    flex-shrink: 0;
  }
  .flow-select {
    padding: 5px 10px; border-radius: 8px;
    font-size: 11px; font-weight: 500; font-family: inherit;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); cursor: pointer;
    outline: none; transition: all 0.15s;
    min-width: 160px;
  }
  .flow-select:hover { border-color: var(--purple); }
  .flow-select:focus { border-color: var(--purple); }
  .flow-filter-del, .flow-filter-add {
    width: 22px; height: 22px;
    border-radius: 6px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer;
    font-family: inherit; font-size: 14px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
  }
  .flow-filter-del:hover { color: #ef4444; border-color: #ef4444; }
  .flow-filter-add:hover { color: var(--teal); border-color: var(--teal); }
  .flow-tab {
    display: flex; align-items: center; gap: 5px;
    padding: 4px 12px; border-radius: 8px;
    font-size: 11px; font-weight: 500;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer;
    white-space: nowrap; transition: all 0.2s;
    font-family: inherit;
  }
  .flow-tab:hover { background: var(--surface-3); color: var(--text-1); }
  .flow-tab.active {
    background: var(--flow-tab-color, var(--purple));
    color: #fff; border-color: transparent;
    font-weight: 600;
  }
  .flow-tab-dot {
    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  }
  .flow-tab-del {
    background: none; border: none; color: rgba(255,255,255,0.6);
    font-size: 13px; cursor: pointer; padding: 0 0 0 4px;
    line-height: 1; font-family: inherit;
  }
  .flow-tab-del:hover { color: #fff; }
  .flow-tab-add {
    font-size: 14px; font-weight: 700; padding: 4px 10px;
    color: var(--text-3);
  }
  .flow-tab-add:hover { color: var(--purple); border-color: var(--purple); }
  .stats-sep {
    width: 1px; height: 20px; background: var(--border); flex-shrink: 0;
  }

  /* ── Modal ────────────────────────── */
  .modal-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    animation: fadeIn 0.15s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } }
  .modal-content {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 16px; padding: 24px; width: 380px; max-width: 90vw;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    animation: modalSlide 0.2s ease-out;
  }
  @keyframes modalSlide { from { transform: translateY(10px); opacity: 0; } }
  .modal-content h3 {
    font-size: 16px; font-weight: 600; color: var(--text-1);
    margin: 0 0 16px 0;
  }
  .modal-label {
    display: block; font-size: 11px; font-weight: 500;
    color: var(--text-3); margin-bottom: 12px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .modal-input {
    display: block; width: 100%; margin-top: 6px;
    padding: 8px 12px; border-radius: 8px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); font-size: 13px; font-family: inherit;
    outline: none; transition: border-color 0.2s;
    box-sizing: border-box;
  }
  .modal-input:focus { border-color: var(--purple); }
  .modal-desc {
    font-size: 12px; color: var(--text-2); margin: 0 0 12px 0; line-height: 1.5;
  }
  .color-picker {
    display: flex; gap: 8px; margin-top: 8px;
  }
  .color-swatch {
    width: 28px; height: 28px; border-radius: 8px;
    border: 2px solid transparent; cursor: pointer;
    transition: all 0.15s;
  }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.selected { border-color: #fff; box-shadow: 0 0 8px rgba(255,255,255,0.3); }
  .modal-actions {
    display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;
  }
  .modal-btn {
    padding: 8px 20px; border-radius: 8px; font-size: 12px;
    font-weight: 600; cursor: pointer; transition: all 0.15s;
    border: 1px solid var(--border); font-family: inherit;
  }
  .modal-cancel {
    background: var(--surface-2); color: var(--text-2);
  }
  .modal-cancel:hover { background: var(--surface-3); }
  .modal-confirm {
    background: var(--purple); color: #fff; border-color: transparent;
  }
  .modal-confirm:hover { filter: brightness(1.1); }
  .modal-confirm:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Flow Picker in Assign Modal ─── */
  .flow-pick-list {
    display: flex; flex-direction: column; gap: 4px;
    max-height: 200px; overflow-y: auto;
  }
  .flow-pick-item {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 8px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer; font-size: 12px;
    transition: all 0.15s; font-family: inherit; text-align: left;
  }
  .flow-pick-item:hover { background: var(--surface-3); }
  .flow-pick-item.selected {
    border-color: var(--purple); background: rgba(99,102,241,0.1);
    color: var(--text-1);
  }

  /* ── Assign Button in Detail ─────── */
  .assign-flow-btn {
    margin-top: 8px; padding: 5px 12px; border-radius: 6px;
    font-size: 10px; font-weight: 500;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer;
    transition: all 0.15s; font-family: inherit;
  }
  .assign-flow-btn:hover { background: var(--surface-3); color: var(--purple); border-color: var(--purple); }

  /* ── Node type icon in card header ── */
  .card-type-icon { font-size: 12px; font-weight: 800; font-family: var(--font-mono); min-width: 14px; text-align: center; }

  /* ── Override left border with node type color ── */
  .agent-card::before { background: var(--node-type-color, var(--agent-color)); }

  /* ── Connection ports on cards ────── */
  .card-port {
    position: absolute; width: 12px; height: 12px; border-radius: 50%;
    background: var(--surface-3); border: 2px solid var(--border);
    cursor: crosshair; opacity: 0; transition: opacity 0.15s;
    z-index: 5;
  }
  .agent-card:hover .card-port { opacity: 1; }
  .card-port-out { right: -6px; top: 50%; transform: translateY(-50%); }
  .card-port-in { left: -6px; top: 50%; transform: translateY(-50%); }
  .card-port:hover { background: var(--teal); border-color: var(--teal); transform: translateY(-50%) scale(1.3); }

  /* ── Add Node button ─────────────── */
  .flow-tab-add-node {
    font-size: 10px; font-weight: 600; padding: 4px 10px;
    color: var(--teal); background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 8px;
    cursor: pointer; transition: all 0.15s; font-family: inherit;
    white-space: nowrap;
  }
  .flow-tab-add-node:hover { border-color: var(--teal); background: rgba(61,214,200,0.1); }

  .flow-tab-ai-create {
    font-size: 10px; font-weight: 600; padding: 4px 10px;
    color: #a78bfa; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 8px;
    cursor: pointer; transition: all 0.15s; font-family: inherit;
    white-space: nowrap;
  }
  .flow-tab-ai-create:hover {
    border-color: #a78bfa; background: rgba(167,139,250,0.12); box-shadow: 0 0 8px rgba(167,139,250,0.25);
  }

  /* ── AI Create modal ──────────────── */
  .ai-modal {
    max-width: 560px;
    max-height: 85vh;
    overflow-y: auto;
  }
  .ai-textarea {
    font-family: inherit;
    line-height: 1.45;
    resize: vertical;
  }
  .ai-proposal {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
    max-height: 60vh;
    overflow-y: auto;
    padding-right: 4px;
  }
  .ai-prop-row { display: flex; flex-direction: column; gap: 3px; }
  .ai-prop-row-inline { flex-direction: row; align-items: center; gap: 8px; }
  .ai-prop-row-inline .ai-prop-label { min-width: 140px; margin: 0; }
  .ai-prop-row-inline .modal-input { flex: 1; }
  .ai-prop-label {
    font-size: 10px; font-weight: 700; color: var(--text-3);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .ai-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 0; }
  .ai-chip {
    font: 500 10px 'Fira Code', monospace;
    padding: 2px 8px; border-radius: 10px;
    background: rgba(167,139,250,0.12); color: #a78bfa;
    border: 1px solid rgba(167,139,250,0.3);
  }
  .ai-warn {
    font-size: 11px; color: var(--gold);
    padding: 6px 10px; border-radius: 4px;
    background: rgba(245,158,11,0.1); border-left: 2px solid var(--gold);
  }
  .ai-error {
    font-size: 11px; color: var(--red);
    padding: 8px 12px; border-radius: 4px;
    background: rgba(239,68,68,0.1); border-left: 2px solid var(--red);
    margin-top: 8px;
  }
  .ai-rationale {
    display: flex; flex-direction: column; gap: 3px;
    padding: 8px 10px; border-radius: 4px;
    background: rgba(59,130,246,0.08); border-left: 2px solid var(--blue);
  }
  .ai-rationale-text {
    font-size: 11px; color: var(--text-2); font-style: italic; line-height: 1.4;
  }

  /* ── Add Node modal type picker ──── */
  .add-node-types { display: flex; gap: 6px; margin-bottom: 10px; }
  .add-node-type {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 10px 8px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text-2); font-size: 10px; font-weight: 600; font-family: var(--font-body);
    transition: all 0.15s;
  }
  .add-node-type.active { border-color: var(--teal); background: rgba(61,214,200,0.08); color: var(--text-1); }
  .add-node-type:hover:not(.active) { background: var(--surface-3); }
  .add-node-type-icon { font-size: 18px; font-weight: 800; }

  /* ── Chain delete button ─────────── */
  .chain-row { display: flex; align-items: center; gap: 4px; }
  .chain-del {
    margin-left: auto; background: none; border: none; color: var(--text-3);
    cursor: pointer; font-size: 14px; padding: 0 4px; opacity: 0;
    transition: all 0.15s; line-height: 1;
  }
  .chain-del:hover { color: #ef4444; }
  .chain-row:hover .chain-del { opacity: 1; }

  /* ── Badge type ──────────────────── */
  .badge-type { border: none; font-weight: 600; letter-spacing: 0.3px; }
</style>
