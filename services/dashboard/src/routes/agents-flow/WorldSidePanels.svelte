<script lang="ts">
  /*
    The 3D's right-hand panels, without the 3D: an agent's drawer (AgentPanel),
    the chief's office with the questions waiting on the operator
    (MyOfficePanel), the chat with the chief (OfficeCreatorChat) and an office
    (OfficePanel). A page that lists agents or offices mounts this inside a
    positioned box and opens one with openAgent / openChief / openOffice.

    It reads the same graph payload the 3D does (`/api/agents/graph`), handed
    in by the host page, which polls it anyway. The chief's inbox is fetched
    here, as the world does it.
  */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { goto } from '$app/navigation';
  import { agentFlowEvents } from '$lib/stores.js';
  import { locale } from '$lib/i18n/index.js';
  import AgentPanel from './AgentPanel.svelte';
  import MyOfficePanel from './MyOfficePanel.svelte';
  import DraftModal from './DraftModal.svelte';
  import EmailModal from './EmailModal.svelte';
  import OfficeCreatorChat from '$lib/components/OfficeCreatorChat.svelte';
  import OfficePanel from '$lib/components/office/OfficePanel.svelte';
  import { resolveFlowColor } from './office3d/types.js';
  import { buildRailModel, latestRunStatus } from '$lib/office/rail-model.js';
  import { fetchOfficeTemplates, fetchLicenseFeatures, moveAgentToOffice, type OfficeTemplatesResponse } from '$lib/office/office-api.js';
  import { environmentLicensed, officeRepoPath } from '$lib/office/team-model.js';
  import type { OfficeReport, PendingQuestion, WorldAgent, WorldChain, WorldFlow, WorldRank, WorldStats } from './world-types.js';
  import './panel-globals.css';

  type GraphRun = { id: string; agent_id: string; status: string; created_at: string };
  type GraphFlow = WorldFlow & { home_repo_path?: string };
  type GraphAgent = WorldAgent & { variables?: string };
  export let graph: {
    agents?: GraphAgent[]; chains?: WorldChain[]; flows?: GraphFlow[]; ranks?: WorldRank[];
    stats?: WorldStats; schedules?: any[]; recentRuns?: GraphRun[]; busy?: Array<{ agent_id: string }>;
  } | null = null;

  const dispatch = createEventDispatcher<{ refresh: void; inbox: { count: number } }>();

  let agents: GraphAgent[] = [];
  $: agents = (graph?.agents ?? []) as GraphAgent[];
  $: chains = graph?.chains ?? [];
  $: flows = graph?.flows ?? [];
  $: ranks = graph?.ranks ?? [];
  $: stats = graph?.stats ?? {};
  $: schedules = graph?.schedules ?? [];
  $: runs = graph?.recentRuns ?? [];
  $: flowEvents = $agentFlowEvents;

  // Who is working: an open run in the poll, a run this tab saw start and not end, or work that is not a run.
  $: runningAgentIds = (() => {
    const out = new Set<string>(runs.filter((r) => r.status === 'running').map((r) => r.agent_id));
    for (const b of graph?.busy ?? []) out.add(b.agent_id);
    const done = new Set(runs.filter((r) => r.status !== 'running' && r.status !== 'pending').map((r) => r.id));
    for (const e of flowEvents) if (e.event === 'agent:flow:run_completed') done.add(String(e.data.run_id));
    for (const e of flowEvents) {
      if (e.event === 'agent:flow:run_started' && !done.has(String(e.data.run_id))) out.add(String(e.data.agent_id));
    }
    return out;
  })();

  // ── What is open: one right-hand panel at a time, as in the 3D ──
  let selectedAgent: string | null = null;
  let showMyOfficePanel = false;
  let showChiefChat = false;
  let officeId: string | null = null;

  export function openAgent(id: string): void {
    showMyOfficePanel = false; showChiefChat = false; officeId = null;
    selectedAgent = id;
  }
  export function openChief(tab: typeof myOfficeTab = 'questions'): void {
    selectedAgent = null; showChiefChat = false; officeId = null;
    myOfficeTab = tab;
    showMyOfficePanel = true;
    void loadPendingQuestions();
    void loadOfficeReports();
  }
  export function openOffice(id: string): void {
    selectedAgent = null; showMyOfficePanel = false; showChiefChat = false;
    officeId = id;
    if (envAvailable === null) void loadLicense();
    if (!templates) void loadTemplates();
  }
  export function close(): void {
    selectedAgent = null; showMyOfficePanel = false; showChiefChat = false; officeId = null;
  }
  /** Escape closes the agent, chief or chat panel (the world does it in the 3D; the office Drawer handles its own). */
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || officeId) return;
    if (!selectedAgent && !showMyOfficePanel && !showChiefChat) return;
    // A modal on top owns Escape.
    if (document.querySelector('.k-scrim, .modal-overlay')) return;
    close();
  }
  export function isOpen(): boolean { return !!selectedAgent || showMyOfficePanel || showChiefChat || !!officeId; }

  // ── Shared plumbing the panels expect from the world ──
  let agentPanel: AgentPanel | null = null;
  let draftModal: DraftModal | null = null;
  let emailModal: EmailModal | null = null;
  let copiedKey: string | null = null;
  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); copiedKey = key; } catch { copiedKey = key + ':err'; }
    setTimeout(() => { if (copiedKey?.startsWith(key)) copiedKey = null; }, 1200);
  }
  function handleOutputClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement | null)?.closest('.ip-uuid-link') as HTMLElement | null;
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const id = btn.getAttribute('data-comm-id');
    if (id) draftModal?.open(id);
  }
  const flowColor = (aid: string) => resolveFlowColor(aid, agents as any, flows as any);
  function highestRank(): WorldRank | null {
    let best: WorldRank | null = null;
    for (const r of ranks) if (!best || r.level > best.level || (r.level === best.level && r.name < best.name)) best = r;
    return best;
  }
  function topAgent(): { id: string; name: string } | null {
    const rk = highestRank();
    const a = rk ? agents.find((x) => x.rank_id === rk.id) : null;
    return a ? { id: a.id, name: a.name } : null;
  }

  // The selected agent's run just ended: the drawer re-reads its last result (the world does this from its live events).
  let lastSeenEnd = '';
  $: {
    const end = selectedAgent ? flowEvents.find((e) => e.event === 'agent:flow:run_completed' && String(e.data.agent_id) === selectedAgent) : null;
    const key = end ? `${end.data.run_id}` : '';
    if (key && key !== lastSeenEnd) { if (lastSeenEnd) agentPanel?.refreshRuns(); lastSeenEnd = key; }
  }

  async function onMoveAgent(e: CustomEvent<{ agentId: string; flowId: string }>) {
    try { await moveAgentToOffice(e.detail.agentId, e.detail.flowId); } catch { /* the drawer shows its own state */ }
    dispatch('refresh');
  }

  // ── The chief's inbox (as AgentWorld3D loads it) ──
  let officeReports: OfficeReport[] = [];
  let pendingQuestions: PendingQuestion[] = [];
  let owedQuestions: PendingQuestion[] = [];
  let triageCount = 0;
  let chiefAnswered: PendingQuestion[] = [];
  let questionsLoaded = false;
  let questionsRev = 0;
  let myOfficeTab: 'overview' | 'questions' | 'errors' | 'activity' | 'kernl' = 'questions';
  let fixerStatus = '';
  let auditedRunIds: Set<string> = new Set();
  let officeLoading = false;
  let reportsLoaded = false;

  export async function loadPendingQuestions(): Promise<void> {
    const rev = questionsRev;
    try {
      const res = await Promise.all([
        fetch('/api/agents/questions?status=pending&limit=50'),
        fetch('/api/agents/questions?status=owed&limit=50'),
        fetch('/api/agents/questions?status=triage&limit=50'),
        fetch('/api/agents/questions?status=answered&answered_by=chief&limit=10'),
      ]);
      const [p, o, tr, c] = await Promise.all(res.map((r) => (r.ok ? r.json().catch(() => null) : null)));
      if (rev !== questionsRev) return;
      if (p) pendingQuestions = p.questions ?? [];
      if (o) owedQuestions = o.questions ?? [];
      if (tr) triageCount = (tr.questions ?? []).length;
      if (c) chiefAnswered = c.questions ?? [];
    } catch { /* best effort */ }
    finally { questionsLoaded = true; }
  }
  $: dispatch('inbox', { count: pendingQuestions.length + owedQuestions.length });
  void loadPendingQuestions();
  const questionsTimer = setInterval(() => { void loadPendingQuestions(); }, 20_000);
  onDestroy(() => clearInterval(questionsTimer));

  /** The office's report backlog: managers' last runs and workers' failures, minus what was dismissed. */
  async function loadOfficeReports(): Promise<void> {
    if (reportsLoaded || !agents.length) return;
    reportsLoaded = true;
    officeLoading = true;
    try {
      const out: OfficeReport[] = [];
      await Promise.all(agents.map(async (a) => {
        const lead = a.role === 'manager';
        try {
          const data: any = await (await fetch(`/api/agents/${a.id}/runs?limit=${lead ? 5 : 10}`)).json();
          const list: any[] = (data?.runs ?? []).filter((r: any) => (lead ? r.status === 'completed' || r.status === 'failed' : r.status === 'failed'));
          for (const r of lead ? list : list.slice(0, 3)) {
            out.push({ agentName: a.name, agentId: a.id, color: flowColor(a.id), ts: new Date(r.created_at).getTime(), status: r.status, runId: r.id,
              text: String((lead ? r.result ?? r.error : r.error ?? r.result) ?? '') || r.status });
          }
        } catch { /* skip agent */ }
      }));
      const dismissed: Set<string> = await fetch('/api/agents/office/dismissed').then((r) => (r.ok ? r.json() : {})).then((b: any) => new Set<string>(b.run_ids ?? [])).catch(() => new Set<string>());
      officeReports = out.filter((r) => !(r.runId && dismissed.has(r.runId))).sort((a, b) => b.ts - a.ts).slice(0, 100);
      officeLoading = false;
      const auditor = agents.find((a) => a.name === 'Error Auditor');
      if (auditor) {
        const data: any = await (await fetch(`/api/agents/${auditor.id}/runs?limit=50`)).json().catch(() => ({}));
        const next = new Set<string>();
        for (const r of data?.runs ?? []) { const m = String(r.goal ?? '').match(/Run ID:\s*([A-Za-z0-9-]+)/); if (m) next.add(m[1]); }
        auditedRunIds = next;
      }
    } catch { /* best effort */ }
    finally { officeLoading = false; }
  }

  // ── An office (as the Oficinas directory opens it) ──
  let templates: OfficeTemplatesResponse | null = null;
  let envAvailable: boolean | null = null;
  async function loadTemplates() { try { templates = await fetchOfficeTemplates($locale === 'es' ? 'es' : 'en'); } catch { templates = null; } }
  async function loadLicense() { try { envAvailable = environmentLicensed(await fetchLicenseFeatures()); } catch { envAvailable = null; } }
  $: activeFlows = flows.filter((f) => f.active === 1);
  $: railModel = buildRailModel({ agents: agents as any, flows: flows as any, ranks: ranks as any, runningIds: runningAgentIds, lastRunStatus: latestRunStatus(runs) });
  $: office = officeId ? (activeFlows.find((f) => f.id === officeId) ?? null) : null;
  $: officeAgents = officeId ? (railModel.offices.find((o) => o.id === officeId)?.agents ?? []) : [];
  $: officeRepo = office ? officeRepoPath(office.home_repo_path, agents.filter((a) => a.flow_id === office?.id).map((a) => a.variables ?? '')) : '';
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Every panel docks to the host's right edge (position:absolute; right:0) at its own width. -->
<div class="wsp">
  <AgentPanel
    bind:this={agentPanel}
    bind:selectedAgent
    bind:agents
    {chains}
    {flows}
    {stats}
    {runningAgentIds}
    {flowEvents}
    availableSkins={[]}
    {copiedKey}
    {copy}
    {handleOutputClick}
    openEmail={(id) => emailModal?.open(id)}
    showBubble={() => {}}
    on:refresh={() => dispatch('refresh')}
    on:moveagent={onMoveAgent}
    on:timemachine={(e) => goto(`/agents-flow?tm-agent=${encodeURIComponent(e.detail?.agentId ?? '')}`)}
  />

  <MyOfficePanel
    bind:showMyOfficePanel
    bind:myOfficeTab
    bind:officeReports
    bind:pendingQuestions
    bind:owedQuestions
    bind:questionsRev
    {triageCount}
    {chiefAnswered}
    bind:fixerStatus
    {auditedRunIds}
    {agents}
    {flowColor}
    {topAgent}
    {copiedKey}
    {copy}
    onOutputClick={handleOutputClick}
    selectAgent={(id) => openAgent(id)}
    loading={officeLoading || !questionsLoaded}
    openAgentSettings={(id) => { openAgent(id); setTimeout(() => agentPanel?.showAgentTab(id, 'config'), 0); }}
    chiefRunning={runningAgentIds.has(topAgent()?.id ?? '')}
    openChiefChat={() => { showMyOfficePanel = false; selectedAgent = null; showChiefChat = true; }}
  />

  {#if showChiefChat}
    <OfficeCreatorChat
      topAgentName={topAgent()?.name ?? highestRank()?.name ?? 'Chief'}
      topAgentInsignia={highestRank()?.insignia ?? '✪'}
      topAgentColor={highestRank()?.color ?? '#c9a84c'}
      topAgentRankLabel={highestRank()?.name ?? ''}
      on:close={() => { showChiefChat = false; }}
      on:refresh={() => dispatch('refresh')}
    />
  {/if}

  <OfficePanel
    open={!!office}
    {office}
    agents={officeAgents}
    unassigned={railModel.unassigned}
    {chains}
    {schedules}
    inactiveIds={agents.filter((a) => a.active !== 1).map((a) => a.id)}
    moveTargets={railModel.offices.filter((o) => o.id !== officeId).map((o) => ({ id: o.id, name: o.name, color: o.color }))}
    repoPath={officeRepo}
    hostAllowed={templates ? templates.host_allowed : null}
    deleteCount={officeId ? agents.filter((a) => a.flow_id === officeId).length : 0}
    {envAvailable}
    otherOfficeNames={activeFlows.filter((f) => f.id !== officeId).map((f) => f.name)}
    top="0px"
    on:close={() => { officeId = null; }}
    on:changed={() => dispatch('refresh')}
    on:agentopen={(e) => openAgent(e.detail.id)}
    on:deleted={() => { officeId = null; dispatch('refresh'); }}
  />
</div>

{#if fixerStatus}
  <div class="fixer-toast" transition:slide|local={{ duration: 220, easing: quintOut }}
       class:ok={fixerStatus.startsWith('✓')} class:err={fixerStatus.startsWith('✗')}>{fixerStatus}</div>
{/if}

<DraftModal bind:this={draftModal} />
<EmailModal bind:this={emailModal} />

<style>
  /* The host's whole box, click-through: each panel docks to its right edge at its own width (the office Drawer caps
     its width at 100% of this box) and takes the clicks itself. */
  .wsp { position: absolute; inset: 0; z-index: 40; pointer-events: none; }
  .wsp > :global(*) { pointer-events: auto; }
  .wsp > :global(.oc-overlay) { pointer-events: none; }
  .fixer-toast { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: var(--z-toast); padding: 10px 18px; border-radius: 999px;
    font: 700 11px 'JetBrains Mono', monospace; letter-spacing: .3px; background: rgba(8, 6, 2, .92); backdrop-filter: blur(6px);
    border: 1px solid #ffb84a55; color: #ffb84a; box-shadow: 0 6px 22px rgba(0, 0, 0, .55); }
  .fixer-toast.ok { border-color: #4cff7a55; color: #4cff7a; }
  .fixer-toast.err { border-color: #ef5d6e55; color: #ef5d6e; }
</style>
