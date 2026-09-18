<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { agentFlowEvents, type AgentFlowEvent } from '$lib/stores.js';
  import { runAgent } from '$lib/api.js';
  import { rpcOrCall } from '$lib/ws.js';
  import MessageStream from './MessageStream.svelte';
  import AgentWorld3D from './AgentWorld3D.svelte';
  import OfficeRail from '$lib/components/office/OfficeRail.svelte';
  import CommandBar from '$lib/components/office/CommandBar.svelte';
  import OfficePanel from '$lib/components/office/OfficePanel.svelte';
  import OfficeWizard from '$lib/components/office/OfficeWizard.svelte';
  import MeetingModal, { type MeetingStart } from '$lib/components/office/MeetingModal.svelte';
  import ActivityPanel, { type ActivityTab, type HumanMeetingState, type WaitingCard } from '$lib/components/office/ActivityPanel.svelte';
  import { buildModeratorGoal, resolveAgentMeeting, type AgentMeetingResolution } from '$lib/office/meeting-model.js';
  import type { MeetingInput, MgmtInput } from '$lib/office/activity-model.js';
  import Toast from '$lib/components/ui/Toast.svelte';
  import { t, locale } from '$lib/i18n/index.js';
  import { buildRailModel, latestRunStatus } from '$lib/office/rail-model.js';
  import { shortcutFor } from '$lib/office/shortcuts.js';
  import { fetchOfficeTemplates, fetchLicenseFeatures, moveAgentToOffice, runAgentWithGoal, type OfficeReport, type OfficeTemplatesResponse } from '$lib/office/office-api.js';
  import { environmentLicensed, officeRepoPath } from '$lib/office/team-model.js';
  import { errorMessage } from '$lib/office/office-errors.js';

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
    role?: string;
    rank_id?: string;
  }
  interface ChainData {
    id: string; source_agent_id: string; target_agent_id: string;
    label: string; condition: string; pass_result: number;
    delay_ms: number; active: number;
  }
  interface TriggerData { id: string; agent_id: string; event_name: string; cooldown_ms: number; }
  interface ScheduleData { id: string; agent_id: string; interval_ms: number; cron_expression?: string; active?: number; next_run_at: string; }
  interface RunData {
    id: string; agent_id: string; trigger_type: string;
    status: string; steps_count: number; tokens_used: number; created_at: string;
  }
  interface StatsData { total_runs: number; completed: number; failed: number; success_rate: number; }
  interface FlowData {
    id: string; name: string; description: string;
    color: string; active: number;
    created_at: string; updated_at: string;
    kind?: string | null; repo_isolation?: string; home_repo_path?: string;
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

  // ── State ──────────────────────────────────────
  let graphData: GraphData | null = null;
  // First-fetch lifecycle for the 3D boot loader: it must keep the loader up
  // until the graph data has actually arrived (or definitively failed), instead
  // of revealing an empty office on a blind timer.
  let dataLoaded = false;   // first fetchGraph() has resolved (success or empty)
  let dataError = false;    // first fetchGraph() returned null / threw
  let selectedAgentId: string | null = null;
  let agentColors: Record<string, { color: string; glow: string }> = {};
  let pollTimer: ReturnType<typeof setInterval>;
  let hostTimer: ReturnType<typeof setInterval>;
  let hostCurrent: { repo: string; iid: string } | null = null;  // issue the host engine is resolving
  let hostDeploying = false;  // a deploy is in flight on the host → animate the Deployer
  let streamOpen = false;
  let streamAutoScroll = true;
  let streamHeight = 280;

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

  // Derived
  $: agents = graphData?.agents ?? [];
  $: chains = graphData?.chains ?? [];
  $: triggers = graphData?.triggers ?? [];
  $: schedules = graphData?.schedules ?? [];
  $: runs = graphData?.recentRuns ?? [];
  $: stats = graphData?.stats ?? {};
  $: todayRuns = runs.filter(r => (r.created_at || '').startsWith(new Date().toISOString().slice(0, 10))).length;
  $: runningAgents = new Set(runs.filter(r => r.status === 'running').map(r => r.agent_id));

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

  function assignColors(ag: AgentData[]) {
    const c: typeof agentColors = {};
    ag.forEach((a, i) => { c[a.id] = PALETTE[i % PALETTE.length]; });
    agentColors = c;
  }

  // ── Office shell ────────────────────────────────────────────────
  const RAIL_KEY = 'kernl.offices.railCollapsed';
  type ToastState = { message: string; kind: 'success' | 'error' | 'info'; actionLabel: string; leadId: string };
  const NO_TOAST: ToastState = { message: '', kind: 'success', actionLabel: '', leadId: '' };

  let world: AgentWorld3D | null = null;
  let rail: OfficeRail | null = null;
  let wizardOpen = false;
  let panelOfficeId: string | null = null;
  let inboxCount = 0;
  let templatesResponse: OfficeTemplatesResponse | null = null;
  let templatesError = false;
  let envAvailable: boolean | null = null;
  /** Office whose camera flight could not run yet (scene not built); retried on `sceneready`. */
  let pendingFocusOfficeId: string | null = null;
  let deepLinksApplied = false;
  let toast: ToastState = NO_TOAST;
  let railCollapsed = readRailCollapsed();

  // ── Meetings and activity ─────────────────────────────────────
  type AgentMeetingRequest = Extract<MeetingStart, { moderator: 'agent' }>;
  /**
   * `resolution` latches the terminal "not_opened" outcome: `$agentFlowEvents` is newest-first and
   * capped, so once the moderator's `run_completed` scrolls out of the window `resolveAgentMeeting`
   * would otherwise fall back to "waiting" and the card would revert forever. Retry/dismiss clear
   * the whole entry, which resets the latch.
   */
  type PendingAgentMeeting = { request: AgentMeetingRequest; moderatorName: string; runId: string; firedAt: number; resolution: AgentMeetingResolution | null };
  let meetingOpen = false;
  let meetingBusy = false;
  let meetingError = '';
  let activityOpen = false;
  let activityTab: ActivityTab = 'meetings';
  let meetings: MeetingInput[] = [];
  let mgmtEntries: MgmtInput[] = [];
  let humanMeeting: HumanMeetingState = { active: false, topic: '', attendees: 0 };
  /** The "Un agente" meeting being waited on: its moderator run and when it was fired. */
  let agentMeeting: PendingAgentMeeting | null = null;

  $: agentMeetingResolution = agentMeeting
    ? agentMeeting.resolution ??
      resolveAgentMeeting($agentFlowEvents, {
        moderatorId: agentMeeting.request.moderatorId,
        attendeeIds: agentMeeting.request.attendeeIds,
        runId: agentMeeting.runId,
        firedAt: agentMeeting.firedAt,
      })
    : null;
  $: latchAgentMeetingResolution(agentMeeting, agentMeetingResolution);
  $: handleAgentMeeting(agentMeetingResolution);
  $: waitingCard = waitingCardFor(agentMeeting, agentMeetingResolution);

  /** Freezes a "not_opened" resolution onto the pending entry so it stops being recomputed (see the type comment above). */
  function latchAgentMeetingResolution(pending: PendingAgentMeeting | null, resolution: AgentMeetingResolution | null) {
    if (!pending || pending.resolution || !resolution || resolution.state !== 'not_opened') return;
    agentMeeting = { ...pending, resolution };
  }

  function handleAgentMeeting(resolution: AgentMeetingResolution | null) {
    if (!resolution || resolution.state !== 'opened') return;
    agentMeeting = null;
    // The live transcript is a right-hand panel too; either drawer would cover it.
    activityOpen = false;
    panelOfficeId = null;
    world?.openLiveMeeting(resolution.meetingId);
  }

  function waitingCardFor(pending: PendingAgentMeeting | null, resolution: AgentMeetingResolution | null): WaitingCard | null {
    if (!pending || !resolution) return null;
    if (resolution.state === 'not_opened') {
      return {
        state: 'not_opened',
        moderatorName: pending.moderatorName,
        status: resolution.result.status,
        result: resolution.result.preview,
        error: resolution.result.error,
      };
    }
    return { state: 'waiting', moderatorName: pending.moderatorName };
  }

  function openMeetingModal() {
    meetingError = '';
    meetingOpen = true;
  }

  function openActivity(tab: ActivityTab) {
    world?.closeRightPanels();
    activityTab = tab;
    activityOpen = true;
    panelOfficeId = null;
  }

  function toggleActivity() {
    if (activityOpen) activityOpen = false;
    else openActivity(activityTab);
  }

  async function fireAgentMeeting(request: AgentMeetingRequest) {
    const goal = buildModeratorGoal({
      attendeeIds: request.attendeeIds,
      topic: request.topic,
      context: request.context,
      points: request.points,
      rounds: request.rounds,
      urgency: request.urgency,
    });
    const firedAt = Date.now();
    const { runId } = await runAgentWithGoal(request.moderatorId, goal);
    const moderatorName = agents.find((a) => a.id === request.moderatorId)?.name ?? '';
    agentMeeting = { request, moderatorName, runId, firedAt, resolution: null };
  }

  async function onMeetingStart(e: CustomEvent<MeetingStart>) {
    const start = e.detail;
    if (start.moderator === 'me') {
      meetingOpen = false;
      // The human meeting's own chat panel is a right-hand surface too; either drawer would cover it.
      activityOpen = false;
      panelOfficeId = null;
      const started = world?.startHumanMeeting({
        topic: start.topic,
        description: start.context,
        topics: start.points,
        attendeeIds: start.attendeeIds,
      });
      if (started === false) {
        world?.openHumanMeeting();
        toast = { ...NO_TOAST, kind: 'info', message: $t('meeting.shell.human_busy') };
      }
      return;
    }
    meetingBusy = true;
    meetingError = '';
    try {
      await fireAgentMeeting(start);
      meetingOpen = false;
      openActivity('meetings');
    } catch (err) {
      meetingError = $t('meeting.shell.start_failed', { error: errorMessage(err) });
    } finally {
      meetingBusy = false;
    }
  }

  async function retryAgentMeeting() {
    if (!agentMeeting) return;
    const request = agentMeeting.request;
    agentMeeting = null;
    try {
      await fireAgentMeeting(request);
    } catch (err) {
      toast = { ...NO_TOAST, kind: 'error', message: $t('meeting.shell.start_failed', { error: errorMessage(err) }) };
    }
  }

  function readRailCollapsed(): boolean {
    try {
      const saved = localStorage.getItem(RAIL_KEY);
      if (saved !== null) return saved === '1';
      return typeof window !== 'undefined' && window.innerWidth < 1100;
    } catch {
      return false;
    }
  }

  function toggleRail() {
    railCollapsed = !railCollapsed;
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0'); } catch { /* private mode */ }
  }

  $: activeFlows = flows.filter((f) => f.active === 1);
  $: railModel = buildRailModel({
    agents,
    flows,
    ranks,
    runningIds: effectiveRunning,
    lastRunStatus: latestRunStatus(graphData?.recentRuns ?? []),
  });
  $: panelOffice = panelOfficeId ? (activeFlows.find((f) => f.id === panelOfficeId) ?? null) : null;
  $: panelAgents = panelOfficeId ? (railModel.offices.find((o) => o.id === panelOfficeId)?.agents ?? []) : [];
  $: inactiveAgentIds = agents.filter((a) => a.active !== 1).map((a) => a.id);
  $: panelMoveTargets = railModel.offices
    .filter((o) => o.id !== panelOfficeId)
    .map((o) => ({ id: o.id, name: o.name, color: o.color }));
  // Every agent the backend unassigns on delete — the panel's team list hides the top agent.
  $: panelDeleteCount = panelOfficeId ? agents.filter((a) => a.flow_id === panelOfficeId).length : 0;
  $: panelRepoPath = repoPathFor(panelOffice, agents);
  // A failed template load is retried when the wizard opens (it shows its loading state meanwhile).
  // Only on the opening transition, so a load that fails again doesn't retry in a loop.
  let wizardWasOpen = false;
  $: if (wizardOpen !== wizardWasOpen) {
    wizardWasOpen = wizardOpen;
    if (wizardOpen && templatesError) loadTemplates();
  }

  async function refresh() {
    dataError = false;
    const fresh = await fetchGraph();
    if (fresh) {
      graphData = fresh;
      flows = graphData.flows ?? flows;
      ranks = graphData.ranks ?? ranks;
      assignColors(graphData.agents);
      applyDeepLinksOnce();
    } else {
      dataError = true;
    }
    dataLoaded = true;
  }

  function openPanel(flowId: string) {
    world?.closeRightPanels();
    panelOfficeId = flowId;
    activityOpen = false;
    world?.selectAgent(null);
    pendingFocusOfficeId = world?.focusOfficeById(flowId) ? null : flowId;
    // The license answers once; a failed read (kernel restarting) is retried on the next open.
    if (envAvailable === null) void loadLicense();
  }

  /** The office environment ships with the DevOps extension license (pro:devops), not a 404 probe. */
  async function loadLicense() {
    try {
      envAvailable = environmentLicensed(await fetchLicenseFeatures());
    } catch {
      envAvailable = null;
    }
  }

  function repoPathFor(office: FlowData | null, list: AgentData[]): string {
    if (!office) return '';
    const id = office.id;
    return officeRepoPath(office.home_repo_path, list.filter((a) => a.flow_id === id).map((a) => a.variables));
  }

  function onSceneReady() {
    const id = pendingFocusOfficeId;
    pendingFocusOfficeId = null;
    if (id && id === panelOfficeId) world?.focusOfficeById(id);
  }

  async function moveAgent(agentId: string, flowId: string) {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent || agent.flow_id === flowId) return;
    try {
      await moveAgentToOffice(agentId, flowId);
      await refresh();
    } catch (err) {
      toast = { ...NO_TOAST, kind: 'error', message: $t('office.shell.move_failed', { error: errorMessage(err) }) };
    }
  }

  async function onOfficeCreated(e: CustomEvent<{ report: OfficeReport; name: string; agentCount: number }>) {
    wizardOpen = false;
    await refresh();
    const { report, name, agentCount } = e.detail;
    const lead = agents.find((a) => a.flow_id === report.flowId && a.role === 'manager');
    toast = {
      kind: 'success',
      message: report.warnings.length
        ? `${$t('office.wizard.created', { name, n: agentCount })} · ${$t('office.shell.warning', { warning: report.warnings[0] })}`
        : $t('office.wizard.created', { name, n: agentCount }),
      actionLabel: lead ? $t('office.wizard.run_lead') : '',
      leadId: lead?.id ?? '',
    };
    setTimeout(() => world?.focusOfficeById(report.flowId), 300);
  }

  async function onOfficeDeleted(e: CustomEvent<{ unassigned: number }>) {
    panelOfficeId = null;
    await refresh();
    rail?.expandUnassigned();
    toast = { ...NO_TOAST, kind: 'info', message: $t('office.shell.deleted', { n: e.detail.unassigned }) };
  }

  async function onToastAction() {
    const leadId = toast.leadId;
    toast = NO_TOAST;
    if (!leadId) return;
    // Same call the removed 2D "▶ Run" button made (doRunAgent).
    try {
      await runAgent(leadId);
      world?.focusAgentById(leadId);
    } catch (err) {
      toast = { ...NO_TOAST, kind: 'error', message: errorMessage(err) };
    }
  }

  function onShortcut(e: KeyboardEvent) {
    if (wizardOpen || meetingOpen) return;
    // Any open dialog (shared Modal, the world's own modals, other aria-modal surfaces) owns the keyboard.
    if (document.querySelector('.k-scrim, .modal-overlay, [aria-modal="true"]')) return;
    const action = shortcutFor(e);
    if (!action || action === 'close' || action === 'help') return;
    e.preventDefault();
    if (action === 'new-office') wizardOpen = true;
    else if (action === 'new-meeting') openMeetingModal();
    else if (action === 'search') void rail?.focusSearch();
    else if (action === 'fit') world?.fitAll();
  }

  function applyDeepLinks() {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('new') === 'office') wizardOpen = true;
      const officeId = url.searchParams.get('office');
      if (officeId) void openPanel(officeId);
      if (url.searchParams.has('new') || url.searchParams.has('office')) {
        url.searchParams.delete('new');
        url.searchParams.delete('office');
        window.history.replaceState(null, '', url.toString());
      }
    } catch { /* ignore */ }
  }

  /** Deep links apply once, on the first successful graph load (mount or a later refresh). */
  function applyDeepLinksOnce() {
    if (deepLinksApplied) return;
    deepLinksApplied = true;
    applyDeepLinks();
  }

  /** While loading (and after a failure) the response is null: host availability is unknown. */
  function loadTemplates() {
    templatesResponse = null;
    templatesError = false;
    const language = get(locale) === 'es' ? 'es' : 'en';
    fetchOfficeTemplates(language)
      .then((res) => { templatesResponse = res; templatesError = false; })
      .catch(() => { templatesResponse = null; templatesError = true; });
  }

  // ── Lifecycle ──────────────────────────────────
  onMount(async () => {
    loadTemplates();
    void loadLicense();
    graphData = await fetchGraph();
    if (graphData) {
      flows = graphData.flows ?? [];
      ranks = graphData.ranks ?? [];
      assignColors(graphData.agents);
      applyDeepLinksOnce();
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
      const agentKey = (list: AgentData[]) => JSON.stringify(list.map(a => `${a.id}:${a.active}:${a.flow_id ?? ''}`));
      const flowKey = (list: FlowData[]) => JSON.stringify(list.map(f => `${f.id}:${f.name}:${f.kind ?? ''}:${f.color}:${f.active}`));
      const agentsChanged = agentKey(newData.agents) !== agentKey(graphData?.agents ?? []);
      const chainsChanged = JSON.stringify(newData.chains.map(c => c.id)) !==
                            JSON.stringify((graphData?.chains ?? []).map(c => c.id));
      // Offices created, renamed, recolored or deleted elsewhere (MCP tool,
      // another tab, an extension install) must reach the rail and the world.
      const flowsChanged = flowKey(newData.flows ?? []) !== flowKey(flows);
      // Only reassign graphData when something the UI cares about changed — a
      // fresh array ref would otherwise re-trigger reactive blocks (3D scene
      // fingerprint, derived stats) on every poll with no structural diff.
      if (!graphData || agentsChanged || chainsChanged || flowsChanged) {
        graphData = newData;
        flows = newData.flows ?? flows;
        ranks = newData.ranks ?? ranks;
        assignColors(graphData.agents);
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

<svelte:window on:keydown={onShortcut} />

<div class="flow-shell">
  <div class="office-layout" class:office-layout--collapsed={railCollapsed}>
    <OfficeRail
      bind:this={rail}
      model={railModel}
      selectedOfficeId={panelOfficeId}
      {selectedAgentId}
      collapsed={railCollapsed}
      on:officeselect={(e) => world?.focusOfficeById(e.detail.id)}
      on:officeedit={(e) => openPanel(e.detail.id)}
      on:agentselect={(e) => { panelOfficeId = null; activityOpen = false; selectedAgentId = e.detail.id; world?.focusAgentById(e.detail.id); }}
      on:agentmove={(e) => moveAgent(e.detail.agentId, e.detail.flowId)}
      on:newoffice={() => (wizardOpen = true)}
      on:headquarters={() => world?.openHeadquartersInbox()}
      on:togglecollapse={toggleRail}
    />
    <div class="office-main">
      <CommandBar
        agents={agents.length}
        working={effectiveRunning.size}
        runsToday={todayRuns}
        inbox={inboxCount}
        {railCollapsed}
        on:newoffice={() => (wizardOpen = true)}
        on:meeting={openMeetingModal}
        on:activity={toggleActivity}
        on:fit={() => world?.fitAll()}
        on:turntable={() => world?.toggleRotationMode()}
        on:perf={() => world?.togglePerfHud()}
        on:inbox={() => world?.openHeadquartersInbox()}
        on:showrail={toggleRail}
        on:registerrepo={() => world?.openRegisterRepo()}
      />
      <div class="world3d-wrapper">
        <AgentWorld3D
          bind:this={world}
          {agents}
          {chains}
          {flows}
          {ranks}
          {dataLoaded}
          {dataError}
          flowEvents={$agentFlowEvents}
          runningAgentIds={effectiveRunning}
          {stats}
          on:refresh={refresh}
          on:officeclick={(e) => openPanel(e.detail.flowId)}
          on:inbox={(e) => (inboxCount = e.detail.count)}
          on:moveagent={(e) => moveAgent(e.detail.agentId, e.detail.flowId)}
          on:newoffice={() => (wizardOpen = true)}
          on:agentselect={(e) => { selectedAgentId = e.detail.id; if (e.detail.id) { panelOfficeId = null; activityOpen = false; } }}
          on:sceneready={onSceneReady}
          on:meetings={(e) => (meetings = e.detail.list)}
          on:mgmtlog={(e) => (mgmtEntries = e.detail.entries)}
          on:humanmeeting={(e) => (humanMeeting = e.detail)}
          on:liveopen={() => { activityOpen = false; panelOfficeId = null; }}
        />
        <OfficePanel
          open={!!panelOffice}
          office={panelOffice}
          agents={panelAgents}
          unassigned={railModel.unassigned}
          {chains}
          {schedules}
          inactiveIds={inactiveAgentIds}
          moveTargets={panelMoveTargets}
          repoPath={panelRepoPath}
          hostAllowed={templatesResponse ? templatesResponse.host_allowed : null}
          deleteCount={panelDeleteCount}
          {envAvailable}
          otherOfficeNames={activeFlows.filter((f) => f.id !== panelOfficeId).map((f) => f.name)}
          top="0px"
          on:close={() => (panelOfficeId = null)}
          on:changed={refresh}
          on:agentopen={(e) => { panelOfficeId = null; world?.focusAgentById(e.detail.id); }}
          on:deleted={onOfficeDeleted}
        />
        <ActivityPanel
          open={activityOpen}
          tab={activityTab}
          {meetings}
          entries={mgmtEntries}
          waiting={waitingCard}
          {humanMeeting}
          top="0px"
          on:close={() => (activityOpen = false)}
          on:tab={(e) => (activityTab = e.detail.tab)}
          on:openmeeting={(e) => { activityOpen = false; panelOfficeId = null; world?.openLiveMeeting(e.detail.id); }}
          on:archive={(e) => world?.dismissMeeting(e.detail.id)}
          on:archiveall={() => world?.dismissAllReadMeetings()}
          on:convene={openMeetingModal}
          on:retry={retryAgentMeeting}
          on:dismisswaiting={() => (agentMeeting = null)}
          on:openhuman={() => { activityOpen = false; world?.openHumanMeeting(); }}
        />
        <Toast
          message={toast.message}
          kind={toast.kind}
          actionLabel={toast.actionLabel}
          on:dismiss={() => (toast = NO_TOAST)}
          on:action={onToastAction}
        />
      </div>
    </div>
  </div>

  <OfficeWizard
    open={wizardOpen}
    templates={templatesResponse}
    {templatesError}
    existingNames={activeFlows.map((f) => f.name)}
    on:close={() => (wizardOpen = false)}
    on:created={onOfficeCreated}
  />

  <MeetingModal
    open={meetingOpen}
    {agents}
    flows={activeFlows}
    busy={meetingBusy}
    error={meetingError}
    on:close={() => (meetingOpen = false)}
    on:start={onMeetingStart}
  />

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
  /* ── Shell: fills the full-bleed slot ── */
  .flow-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  .office-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 272px minmax(0, 1fr);
  }
  .office-layout--collapsed { grid-template-columns: 52px minmax(0, 1fr); }
  .office-main {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: 52px minmax(0, 1fr);
  }
  .world3d-wrapper {
    position: relative;
    min-height: 0;
    overflow: hidden;
  }
</style>
