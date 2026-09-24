<script lang="ts">
  // The selected agent's drawer: AgentDrawer plus everything this world feeds
  // into its tabs — the detail fetch, the last result, the run history and its
  // steps, the chat with the agent, the workspace listing, the live stream,
  // and the actions (run, pause, rename, revision, skin).
  //
  // The world still owns the selection and the agent list: `selectedAgent`
  // and `agents` come in through bind:, so closing the drawer or an optimistic
  // edit made here lands back in AgentWorld3D (and rebuilds the scene) the
  // same way it did when this was inline. 'refresh' and 'moveagent' are
  // dispatched from here and forwarded by the world to the page unchanged.
  import { onMount, createEventDispatcher, tick } from 'svelte';
  import type { AgentFlowEvent } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import { agentType, type SkinDefinition } from './office3d/index.js';
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import WorkspaceTab from './WorkspaceTab.svelte';
  import ChatTab from './ChatTab.svelte';
  import HistoryTab from './HistoryTab.svelte';
  import LiveTab from './LiveTab.svelte';
  import AgentDrawer from '$lib/components/agent/AgentDrawer.svelte';
  import SkillsTab from '$lib/components/agent/tabs/SkillsTab.svelte';
  import OverviewTab from '$lib/components/agent/tabs/OverviewTab.svelte';
  // Type only: OverviewTab mounts it now, but `runtimeSectionRef` — the handle
  // the run-failure remedies steer — is still typed and held here.
  import type RuntimeSection from '$lib/components/agent/sections/RuntimeSection.svelte';
  import RunFailureCard from '$lib/components/agent/RunFailureCard.svelte';
  import type { RemedyKind } from '$lib/run-failure.js';
  import { goto } from '$app/navigation';
  import { LLM_SETTINGS_HREF } from '$lib/llm-error.js';
  import { panelTabComponents, tabMatches } from '$lib/panelTabRegistry';
  import { fmtRelTime, fmtTokens, triggerColor } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import { isWorkspacePathHidden } from '$lib/workspace-tree.js';
  import { resolveAgentWorkspace, dependsOnGoogleAuth } from '$lib/agent-helpers.js';
  import { fetchRecentRunSummaries } from './recent-runs.js';
  import type { WorldAgent, WorldChain, WorldFlow, WorldStats } from './world-types.js';

  /** bind: — the drawer's close button clears it. */
  export let selectedAgent: string | null;
  /** bind: — pause, rename, revision, skin and drawer edits patch it optimistically. */
  export let agents: WorldAgent[];
  export let chains: WorldChain[];
  export let flows: WorldFlow[];
  export let stats: WorldStats;
  export let runningAgentIds: Set<string>;
  export let flowEvents: AgentFlowEvent[];
  // Shared with My Office's report modal: one clipboard flash, one handler for
  // the draft chips in any run output, one sent-email viewer.
  export let copiedKey: string | null;
  export let copy: (text: string, key: string) => void;
  export let handleOutputClick: (e: MouseEvent) => void;
  export let openEmail: (id: string) => void;
  /** Speech bubble over the agent's desk in the 3D office. */
  export let showBubble: (aid: string, text: string, dur?: number) => void;

  const dispatch = createEventDispatcher();

  onMount(() => {
    loadContributedTabs();
  });

  /** The selected agent just finished a run: re-read the last result, and the
   *  run list too when HISTORY is the open tab. Called by the live-event
   *  dispatcher (office3d/events.ts) through the world. */
  export function refreshRuns(): void {
    loadLatestRun();
    if (panelTab === 'history') loadAgentRuns();
  }

  // Tabs contribuidos por extensiones (declarados en su manifest, expuestos por
  // /api/manifest). They are filtered by the selected office/agent and the
  // component bound in the registry is rendered. NOTHING is hardcoded by office name.
  let contributedTabs: Array<{ id: string; label: string; match?: { office?: string }; order?: number }> = [];
  async function loadContributedTabs() {
    try {
      const r = await fetch('/api/manifest');
      if (!r.ok) return;
      const m = await r.json();
      contributedTabs = Array.isArray(m?.agentPanelTabs) ? m.agentPanelTabs : [];
    } catch {}
  }
  $: myPanelTabs = contributedTabs
    .filter((t) => panelTabComponents[t.id] && tabMatches(t, selFlow))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  $: selData = selectedAgent ? agents.find(a => a.id === selectedAgent) : null;

  $: selStats = selectedAgent ? stats[selectedAgent] : null;
  $: selChains = selectedAgent ? chains.filter(c => c.source_agent_id === selectedAgent || c.target_agent_id === selectedAgent) : [];
  $: selFlow = selData ? flows.find(f => f.id === selData.flow_id) : null;
  /** Declared chains, with the other end already named — TriggeringSection
   *  prints them and has no agent list of its own to resolve an id with. */
  $: selChainRows = selChains.map((c) => {
    const isOut = c.source_agent_id === selectedAgent;
    const otherId = isOut ? c.target_agent_id : c.source_agent_id;
    return { out: isOut, name: agents.find((a) => a.id === otherId)?.name ?? '?', label: c.label };
  });

  // ── What defines the selected agent ────────────────────────────────────
  // The system prompt for an LLM agent, the builtin handler for a scripted
  // one. Either way it is the answer to "what is this thing", so Overview
  // leads with it instead of burying it under a collapsed section at the end.
  // The graph payload already carries both, so the block renders with the
  // selection instead of flashing a loading line until the detail fetch lands.
  $: selPrompt = String(agentDetail?.agent?.system_prompt ?? selData?.system_prompt ?? '');

  // ── Full agent detail (fetched on demand) ──────────
  let agentDetail: {
    agent?: any;
    runs?: any[];
    triggers?: Array<{ event_name: string; filter?: string; cooldown_ms?: number; active?: number }>;
    schedules?: Array<{ cron_expression: string; interval_ms: number; goal_override?: string; next_run_at?: string; last_run_at?: string; active?: number }>;
    adhocConnections?: {
      invokedBy: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
      invoked: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
    };
  } | null = null;
  let detailLoading = false;

  async function loadAgentDetail(id: string) {
    detailLoading = true;
    try {
      const r = await fetch(`/api/agents/${id}`);
      agentDetail = await r.json();
    } catch { agentDetail = null; }
    detailLoading = false;
  }

  // Fire whenever a new agent is selected
  $: if (selectedAgent) loadAgentDetail(selectedAgent); else agentDetail = null;

  // The row the drawer's store is seeded with.
  //
  // `selData` is the world's list row and it is the one that refreshes — a
  // Pause writes into it optimistically — so it wins every key it has. What it
  // does not carry are the three limits that only GET /api/agents/:id returns
  // (max_iterations, max_tokens, max_errors), and RuntimeSection edits those.
  // Layering the detail underneath fills them in without letting a stale
  // detail row overwrite anything the list already knows.
  $: selRow = selData
    ? (agentDetail?.agent?.id === selData.id
        ? { ...agentDetail.agent, ...selData }
        : selData)
    : null;

  /**
   * A write from inside the drawer, reflected in the world's own list.
   *
   * Without this the node keeps its old colour and the header its old model
   * chip until the parent's next refetch pushes `agents` back down. Only the
   * keys the world's rows actually carry are copied — the drawer's agent is a
   * superset and the extra columns have no meaning out here.
   */
  function patchWorldAgent(next: Record<string, any> | null | undefined) {
    if (!next?.id) return;
    const keys = [
      'name', 'description', 'provider', 'model', 'model_chain', 'executor_type',
      'active', 'timeout_ms', 'role', 'rank_id', 'flow_id', 'system_prompt',
      'allowed_tools', 'consecutive_failures', 'auto_paused_at', 'auto_pause_reason',
      // Sin esta clave el attach del tab Skills se descartaba acá en silencio:
      // la escritura llegaba a la base, pero la fila del mundo (y con ella el
      // badge del tab) seguía mostrando la lista vieja hasta el próximo fetch.
      'skills_json',
    ];
    agents = agents.map((a) => {
      if (a.id !== next.id) return a;
      const merged: Record<string, any> = { ...a };
      for (const k of keys) if (next[k] !== undefined) merged[k] = next[k];
      return merged as typeof a;
    });
    // Keep the panel's own detail row in step too, so the limits it owns do
    // not snap back to their pre-edit values on the next reactive pass.
    const detail = agentDetail;
    if (detail && detail.agent && detail.agent.id === next.id) {
      agentDetail = { ...detail, agent: { ...detail.agent, ...next } };
    }
    // And ask the parent for server truth, exactly as the rename does.
    //
    // The optimistic update above only lives until the parent's 60s poll
    // re-pushes `graphData.agents` — and that poll compares `id + active`
    // only, so a changed model chain is "no structural diff" and it hands
    // back the very array this function just edited around. Observed: a
    // removed fallback reappeared about five seconds after it was removed,
    // with the database already correct. Debounced because autosave on the
    // numeric fields would otherwise refetch the whole graph per edit.
    clearTimeout(worldRefreshTimer);
    worldRefreshTimer = setTimeout(() => dispatch('refresh'), 1200);
  }
  let worldRefreshTimer: ReturnType<typeof setTimeout>;

  // Collapsible section state. It lives here and not inside each section so
  // that closing and reopening the drawer does not forget it.
  let collapsed = { tools: true, variables: false, mandate: true };

  // ── Talk to agent ──────────────────────────────
  let chatInput = '';
  let chatSending = false;
  let starting = false;
  let startMsg = '';
  let togglingPause = false;
  let revisionBusy = false;
  let editingName = false;
  let editNameValue = '';
  let savingName = false;
  let chatHistory: Array<{ role: 'you' | 'agent'; text: string; ts: number }> = [];
  let chatHistoryLoading = false;
  let chatError = '';
  /** The run was accepted and the agent is working. Replaces the old trick of
   *  pushing a literal "Working on it..." bubble and later deleting whatever
   *  message happened to carry that exact text. */
  let chatPending = false;
  let chatScrollEl: HTMLDivElement | null = null;

  /** Can this agent read what you write?
   *
   *  No, if it is backed by a builtin handler. `AgentExecutor.execute` (see
   *  services/kernel/src/modules/agents/executor.ts) short-circuits on
   *  `agent.builtin_handler` and calls `await handler()` — no arguments. The
   *  whole conversational goal this panel builds is discarded, the script runs
   *  as if you had pressed Run now, and its output comes back looking like a
   *  reply to a message nothing ever read. 31 of the agents on this floor are
   *  in that shape, so the tab says so instead of pretending. */
  $: chatCanConverse = !!selData && !selData.builtin_handler;

  /** Openers built from this agent, not from whatever product the placeholder
   *  was copied out of. The old one advertised a prospecting syntax
   *  ("Prospect city=Valencia…") on every agent in the office. */
  $: chatSuggestions = (() => {
    if (!selData || !chatCanConverse) return [] as string[];
    const out: string[] = [];
    const goal = String(agentDetail?.agent?.goal_template ?? '').trim();
    if (goal) out.push(goal.length > 90 ? goal.slice(0, 88) + '…' : goal);
    if (selData.description) out.push(`What did you do about ${selData.description.toLowerCase()} this week?`);
    out.push('What are you working on right now?');
    if (selStats?.failed) out.push('Why did your last runs fail?');
    return out.slice(0, 3);
  })();

  function beginEditName() {
    if (!selData) return;
    editNameValue = selData.name;
    editingName = true;
  }
  function cancelEditName() {
    editingName = false;
    editNameValue = '';
  }
  // Skin picker — list of installed skins for the dropdown. The world
  // snapshots it once the skin registry has been initialised (buildScene).
  export let availableSkins: SkinDefinition[];
  let savingSkin = false;

  /** Persist a new skin choice for the currently-selected agent. The kernel
   *  saves it; the dashboard's reactive scene rebuild renders the new look on
   *  the next fingerprint diff. */
  async function changeSkin(skinId: string): Promise<void> {
    if (!selectedAgent || savingSkin) return;
    savingSkin = true;
    try {
      const r = await fetch(`/api/agents/${selectedAgent}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skin_id: skinId }),
      });
      const data = await r.json();
      if (data?.success) {
        agents = agents.map(a => a.id === selectedAgent ? { ...a, skin_id: skinId } : a);
        dispatch('refresh');
      }
    } catch (e: any) {
      // Best-effort — fall through, will retry on next interaction.
      // eslint-disable-next-line no-console
      console.error('changeSkin failed', e);
    } finally {
      savingSkin = false;
    }
  }

  async function saveEditName() {
    if (!selectedAgent || !selData || savingName) return;
    const next = editNameValue.trim();
    if (!next || next === selData.name) { cancelEditName(); return; }
    savingName = true;
    try {
      const r = await fetch(`/api/agents/${selectedAgent}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      const data = await r.json();
      if (data?.success) {
        agents = agents.map(a => a.id === selectedAgent ? { ...a, name: next } : a);
        loadAgentDetail(selectedAgent);
        editingName = false;
        // Ask the parent to re-fetch so its own `agents` (the source of truth
        // that gets re-pushed back as our prop) reflects the new name. Without
        // this, the next prop update overwrites our optimistic rename.
        dispatch('refresh');
      } else {
        startMsg = `✗ ${data?.error || 'could not rename'}`;
      }
    } catch (e: any) {
      startMsg = `✗ ${e?.message || 'network error'}`;
    } finally {
      savingName = false;
      setTimeout(() => { if (startMsg.startsWith('✗')) startMsg = ''; }, 4000);
    }
  }

  // ── Agent panel tabs ───────────────────────────
  // Core ids are literals; extension-contributed tabs use dynamic ids.
  let panelTab: 'info' | 'live' | 'history' | 'memory' | 'chat' | 'workspace' | 'skills' | (string & {}) = 'info';
  let agentRuns: Array<{ id: string; status: string; steps_count: number; tokens_used: number; trigger_type: string; created_at: string; result?: string; error?: string }> = [];
  let workspaceFiles: Array<{ path: string; type: string; size: number }> = [];
  let workspaceFileContent: { path: string; content: string } | null = null;
  let workspaceLoading = false;
  let workspacePreviewUrl: string | null = null;

  $: visibleWorkspaceFiles = workspaceFiles.filter(f => !isWorkspacePathHidden(f.path));

  // ── Workspace tree ─────────────────────────────────────────────────
  // Row building moved to WorkspaceTab.svelte with the markup. Only the
  // collapse set stays, because loadWorkspaceFiles() resets it on reload.
  let wsCollapsed: Set<string> = new Set();

  let runsLoading = false;
  let expandedRunId: string | null = null;
  let runSteps: Array<{ step_number: number; type: string; content: string; tool_name: string; tool_output?: string; is_event?: boolean }> = [];

  // Track loading + error separately from `runSteps`. Without these, an empty
  // result (e.g. a meeting event, or a run that errored before producing any
  // steps) leaves the UI stuck on "Loading steps…" forever because
  // `runSteps.length === 0` is also the initial state.
  let runStepsLoading = false;
  let runStepsError: string | null = null;

  async function loadAgentRuns() {
    if (!selectedAgent || runsLoading) return;
    runsLoading = true;
    try {
      const data: any = await rpcOrCall('agents.runs.list', { agent_id: selectedAgent, limit: 20 }, async () => {
        const r = await fetch(`/api/agents/${selectedAgent}/runs?limit=20`);
        return r.json();
      });
      agentRuns = data?.runs ?? [];
    } catch { agentRuns = []; }
    runsLoading = false;
  }

  async function loadChatFromMemory() {
    if (!selectedAgent) return;
    chatHistoryLoading = true;
    chatError = '';
    try {
      const res = await fetch(`/api/agents/${selectedAgent}/memory?limit=30`);
      const data: any = await res.json();
      const items = ((data?.memory ?? []) as Array<{ role: string; content: string; created_at: string }>)
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .reverse(); // chronological
      chatHistory = items.map(m => ({
        role: m.role === 'user' ? 'you' as const : 'agent' as const,
        text: m.content,
        ts: new Date(m.created_at).getTime(),
      }));
    } catch (e: any) {
      // Was swallowed silently, which made a failed fetch and a genuinely empty
      // thread look identical — and the empty one invites you to write.
      chatError = e?.message ?? String(e);
    } finally {
      chatHistoryLoading = false;
      scrollChatToEnd();
    }
  }

  /** Keep the newest message in view after loads, sends and replies. */
  async function scrollChatToEnd() {
    await tick();
    if (chatScrollEl) chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
  }

  $: selWorkspaceInfo = selData ? resolveAgentWorkspace(selData, flows) : null;

  async function loadWorkspaceFiles() {
    if (!selectedAgent || workspaceLoading) return;
    const agent = agents.find(a => a.id === selectedAgent);
    if (!agent) return;
    const info = resolveAgentWorkspace(agent, flows);
    workspaceLoading = true;
    workspaceFileContent = null;
    workspacePreviewUrl = null;
    wsCollapsed = new Set();
    try {
      if (info.cwdPath) {
        // External __cwd_path__ repo — listed via the agent-scoped cwd endpoint.
        const res = await fetch(`/api/agents/${agent.id}/cwd-files`);
        const data: any = await res.json();
        workspaceFiles = data?.files ?? [];
        workspacePreviewUrl = typeof data?.preview_url === 'string' ? data.preview_url : null;
      } else if (info.wsId) {
        const res = await fetch(`/api/agents/workspace/${info.wsId}`);
        const data: any = await res.json();
        workspaceFiles = data?.files ?? [];
      } else {
        workspaceFiles = [];
      }
    } catch { workspaceFiles = []; }
    workspaceLoading = false;
  }

  async function loadWorkspaceFile(path: string) {
    const agent = agents.find(a => a.id === selectedAgent);
    if (!agent) return;
    const info = resolveAgentWorkspace(agent, flows);
    try {
      const url = info.cwdPath
        ? `/api/agents/${agent.id}/cwd-file?path=${encodeURIComponent(path)}`
        : `/api/agents/workspace/${info.wsId}/file?path=${encodeURIComponent(path)}`;
      const res = await fetch(url);
      const data: any = await res.json();
      workspaceFileContent = { path, content: data?.content ?? '' };
    } catch { workspaceFileContent = { path, content: 'Error loading file' }; }
  }

  async function loadRunSteps(runId: string) {
    if (expandedRunId === runId) {
      expandedRunId = null;
      runSteps = [];
      runStepsLoading = false;
      runStepsError = null;
      return;
    }
    expandedRunId = runId;
    runSteps = [];
    runStepsError = null;
    runStepsLoading = true;
    try {
      const data: any = await rpcOrCall('agents.runs.detail', { id: runId }, async () => {
        const r = await fetch(`/api/agents/runs/${runId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      // The user may have collapsed or switched runs while we awaited.
      if (expandedRunId !== runId) return;
      if (data?.error) throw new Error(String(data.error));
      const steps: any[] = data?.steps ?? [];
      const events: any[] = data?.events ?? [];
      // Merge event_log entries (auto_eval, learning, etc.) that aren't already
      // represented by a step into the timeline. We filter out "step" event_types
      // since those are duplicates of agent_run_steps.
      const eventSteps = events
        .filter((ev: any) => ev.event_subtype && ev.event_subtype !== 'step' && ev.event_type !== 'step')
        .map((ev: any, i: number) => {
          const sub = String(ev.event_subtype || ev.event_type || 'event');
          let rawData: Record<string, unknown> = {};
          try { rawData = JSON.parse(ev.raw_data || '{}'); } catch {}
          let detail = String(ev.detail || '');
          if (sub === 'auto_eval') {
            const score = Number(rawData.score ?? 0);
            const outcome = String(rawData.outcome ?? '');
            const stars = '★'.repeat(score) + '☆'.repeat(Math.max(0, 5 - score));
            const lesson = rawData.lesson ? `\n**Lesson**: ${rawData.lesson}` : '';
            detail = `${stars}  **${outcome.toUpperCase()}** — confidence ${Number(rawData.confidence ?? 0).toFixed(2)}${lesson}`;
          } else if (sub === 'learning_created' || sub === 'learning_deactivated') {
            const icon = sub === 'learning_created'
              ? (rawData.learning_type === 'avoid' ? '🚫' : rawData.learning_type === 'prefer' ? '⭐' : '💡')
              : '🗑️';
            detail = `${icon} ${detail}`;
          }
          return {
            step_number: 9000 + i,
            type: sub,
            content: detail,
            tool_name: '',
            is_event: true,
            _ts: ev.created_at || '',
          };
        });
      // Assign step_numbers that interleave with real steps by timestamp
      const merged = [...steps.map((s: any) => ({ ...s, is_event: false, _ts: '' })), ...eventSteps];
      // Real steps already ordered by step_number; events go at the end
      // (they happen post-run during auto-eval). Renumber for display.
      let num = 0;
      for (const m of merged) {
        num++;
        m.step_number = num;
      }
      runSteps = merged;
    } catch (err) {
      if (expandedRunId === runId) {
        runSteps = [];
        runStepsError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (expandedRunId === runId) runStepsLoading = false;
    }
  }

  function selectPanelTab(tab: typeof panelTab) {
    panelTab = tab;
    if (tab === 'history') loadAgentRuns();
    if (tab === 'info') loadLatestRun();
    if (tab === 'workspace') loadWorkspaceFiles();
    // Re-read the thread from the server every time the tab is opened, not
    // only when the selected agent changes. The reply is persisted by the
    // executor the moment the run ends, so this is what makes an answer
    // recoverable after the page-side poll is interrupted — switching tabs,
    // closing the panel, a re-render — instead of lost with it.
    if (tab === 'chat' && !chatSending) loadChatFromMemory();
  }

  // ── Latest run result (shown prominently in Overview) ──
  let latestRun: { id: string; status: string; result?: string; error?: string; tokens_used: number; steps_count: number; trigger_type: string; created_at: string; duration_ms?: number } | null = null;
  let latestRunLoading = false;

  async function loadLatestRun() {
    if (!selectedAgent || latestRunLoading) return;
    latestRunLoading = true;
    try {
      const data: any = await rpcOrCall('agents.runs.list', { agent_id: selectedAgent, limit: 5 }, async () => {
        const r = await fetch(`/api/agents/${selectedAgent}/runs?limit=5`);
        return r.json();
      });
      const runs: any[] = data?.runs ?? [];
      // prefer most recent completed/failed run with a result or error
      latestRun = runs.find((r: any) => r.status === 'completed' || r.status === 'failed') ?? runs[0] ?? null;
    } catch { latestRun = null; }
    latestRunLoading = false;
  }

  // Agents whose builtin_handler starts with `gsync:` (contacts/gmail/calendar/
  // graph-enrich) speak to Google APIs. Surface a permanent inline Re-login
  // button in their description so the user can fix expired auth proactively —
  // without waiting for the next failed run to surface the LAST RESULT button.

  // ── RunFailureCard wiring (Task 10) ─────────────────────
  // The card only renders and dispatches a `kind`; it does not know how to
  // fix anything. This is where each of the five remedies actually lands —
  // `runtimeSectionRef` and `startAgent`/`startReauth` only exist in this
  // component's scope, so the mapping has to live here rather than inside
  // the card.
  let runtimeSectionRef: RuntimeSection | null = null;
  function handleRunFailureRemedy(kind: RemedyKind): void {
    switch (kind) {
      case 'pick-tool-capable-provider':
        void runtimeSectionRef?.focusPrimaryPicker({ requireTools: true });
        break;
      case 'switch-executor-claude-code':
        // Routed through RuntimeSection's own `setExecutor`, not
        // `store.patch()` directly. Both send the same write, but only
        // RuntimeSection's wrapper reads the reconciled result back into the
        // field that shows it (`.rt-err` under Executor) — a direct
        // `store.patch()` here would set the store's `error` and nothing
        // would ever render it, silently losing exactly the drift this
        // remedy exists to report.
        void runtimeSectionRef?.setExecutor('claude_code');
        break;
      case 'configure-provider':
        void goto(LLM_SETTINGS_HREF);
        break;
      case 'reauth-google':
        void startReauth('google');
        break;
      case 'retry':
        void startAgent();
        break;
    }
  }

  let reauthLoading = false;
  async function startReauth(provider: 'google'): Promise<void> {
    if (reauthLoading) return;
    reauthLoading = true;
    try {
      if (provider === 'google') {
        // Direct authenticated HTTP — skip the WS race. Re-login is a one-shot
        // user action; predictability beats latency. `?force=1` bypasses the
        // backend's "already authenticated" shortcut, which would otherwise
        // trip on a stale-but-revoked token row in google_tokens. The bearer
        // token comes from the layout's window.fetch interceptor.
        const r = await fetch('/api/google/auth/start?force=1', { method: 'POST' });
        const d: any = await r.json().catch(() => ({ error: `HTTP ${r.status} ${r.statusText}` }));
        if (!r.ok) { alert(d?.error ?? `HTTP ${r.status}`); return; }
        if (d?.error) { alert(d.error); return; }
        if (d?.authUrl) { window.location.href = d.authUrl; return; }
        alert('No auth URL returned by /api/google/auth/start (response: ' + JSON.stringify(d).slice(0, 200) + ')');
      }
    } catch (e: any) {
      alert(e?.message ?? String(e));
    } finally {
      reauthLoading = false;
    }
  }

  // ── LIVE stream for the selected agent ────────
  $: liveIsRunning = !!selectedAgent && runningAgentIds.has(selectedAgent);
  $: liveEvents = selectedAgent
    ? flowEvents.filter(e => e.data.agent_id === selectedAgent).slice(0, 60)
    : [];
  // derive current run id (from most recent event)
  $: liveRunId = (liveEvents.find(e => e.data.run_id) as any)?.data?.run_id ?? null;
  // only show events from the current run (so we don't leak prior runs' noise)
  $: liveCurrentRunEvents = liveRunId
    ? liveEvents.filter(e => e.data.run_id === liveRunId)
    : liveEvents;

  // Auto-switch to LIVE tab when an agent starts working (but don't hijack if user navigated)
  let lastRunningFor: string | null = null;
  $: if (liveIsRunning && selectedAgent && selectedAgent !== lastRunningFor) {
    lastRunningFor = selectedAgent;
    if (panelTab === 'info') panelTab = 'live';
  }
  $: if (!liveIsRunning) lastRunningFor = null;

  // Reset tab when agent changes. Default to LIVE if the agent is currently
  // running (anything streaming is more interesting than stats), otherwise
  // fall back to OVERVIEW.
  let lastSelectedAgent: string | null = null;
  // ?tab=<panelTab> deep-link — consumed once, on the first agent selection.
  let _deepLinkTab: typeof panelTab | null = (() => {
    try {
      const t = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null;
      return t && ['info', 'live', 'history', 'memory', 'chat', 'workspace', 'skills'].includes(t) ? (t as typeof panelTab) : null;
    } catch { return null; }
  })();
  $: if (selectedAgent && selectedAgent !== lastSelectedAgent) {
    lastSelectedAgent = selectedAgent;
    if (_deepLinkTab) {
      panelTab = _deepLinkTab;
      if (_deepLinkTab === 'workspace') loadWorkspaceFiles();
      _deepLinkTab = null;
    } else {
      panelTab = runningAgentIds.has(selectedAgent) ? 'live' : 'info';
    }
    agentRuns = []; expandedRunId = null; chatHistory = []; latestRun = null;
    loadLatestRun(); loadChatFromMemory();
  }
  $: if (!selectedAgent) lastSelectedAgent = null;

  async function togglePause() {
    if (!selectedAgent || !selData || togglingPause) return;
    togglingPause = true;
    const wasActive = selData.active === 1;
    const nextActive = !wasActive;
    try {
      const r = await fetch(`/api/agents/${selectedAgent}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: nextActive }),
      });
      const data = await r.json();
      if (data?.success) {
        // Optimistically reflect in the local list; parent will push truth soon.
        agents = agents.map(a => a.id === selectedAgent ? { ...a, active: nextActive ? 1 : 0 } : a);
        // Refresh full detail so schedule next_run / etc. update too.
        loadAgentDetail(selectedAgent);
        startMsg = nextActive ? '✓ resumed — scheduler re-enabled' : '⏸ paused — scheduler + triggers off';
      } else {
        startMsg = `✗ ${data?.error || 'could not toggle'}`;
      }
    } catch (e: any) {
      startMsg = `✗ ${e?.message || 'network error'}`;
    } finally {
      togglingPause = false;
      setTimeout(() => { if (startMsg.includes('paused') || startMsg.includes('resumed') || startMsg.startsWith('✗')) startMsg = ''; }, 4000);
    }
  }

  // REVISION resolution from the 3D detail panel.
  //   accept = clear under_revision, keep agent running
  //   reject = clear under_revision AND deactivate (active=0)
  async function resolveRevision(mode: 'accept' | 'reject') {
    if (!selectedAgent || !selData || revisionBusy) return;
    const name = selData.name || 'this agent';
    const msg = mode === 'accept'
      ? `Keep "${name}"? Clears the REVISION flag and leaves the agent running.`
      : `Reject "${name}"? It will be DEACTIVATED. Row stays in the DB — re-enable any time.`;
    if (!confirm(msg)) return;
    revisionBusy = true;
    const body = mode === 'accept'
      ? { under_revision: false }
      : { under_revision: false, active: false };
    try {
      const r = await fetch(`/api/agents/${selectedAgent}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data?.success) {
        agents = agents.map(a => a.id === selectedAgent
          ? { ...a, under_revision: 0, ...(mode === 'reject' ? { active: 0 } : {}) }
          : a);
        loadAgentDetail(selectedAgent);
        startMsg = mode === 'accept' ? '✓ accepted — flag cleared' : '✗ rejected — agent deactivated';
      } else {
        startMsg = `✗ ${data?.error || 'could not update'}`;
      }
    } catch (e: any) {
      startMsg = `✗ ${e?.message || 'network error'}`;
    } finally {
      revisionBusy = false;
      setTimeout(() => { if (startMsg.includes('accepted') || startMsg.includes('rejected') || startMsg.startsWith('✗')) startMsg = ''; }, 4000);
    }
  }

  async function startAgent() {
    if (!selectedAgent || starting) return;
    starting = true;
    startMsg = '';
    showBubble(selectedAgent, '▶ starting…', 1200);
    try {
      const res: any = await rpcOrCall('agents.run', { agent_id: selectedAgent }, async () => {
        const r = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: selectedAgent }),
        });
        return r.json();
      });
      if (res?.success || res?.run_id) {
        startMsg = `✓ started · run ${String(res.run_id || '').slice(0, 8)}`;
        if (panelTab === 'history') loadAgentRuns();
      } else {
        startMsg = `✗ ${res?.error || 'failed to start'}`;
      }
    } catch (e: any) {
      startMsg = `✗ ${e?.message || 'network error'}`;
    } finally {
      starting = false;
      setTimeout(() => { startMsg = ''; }, 5000);
    }
  }

  async function talkToAgent(text?: string) {
    const msg = (text ?? chatInput).trim();
    if (!selectedAgent || !msg || chatSending) return;
    chatInput = '';
    chatSending = true;
    chatError = '';

    chatHistory = [...chatHistory, { role: 'you', text: msg, ts: Date.now() }];
    scrollChatToEnd();
    showBubble(selectedAgent, msg, 400);

    // Persist user message to agent memory
    fetch(`/api/agents/${selectedAgent}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: msg }),
    }).catch(() => {});

    try {
      const recentWork = await fetchRecentRunSummaries(selectedAgent, 5);
      const agentName = selData?.name ?? 'Agent';
      const agentDesc = selData?.description ?? '';

      // Build conversation context from recent chat history
      const recentChat = chatHistory.slice(-10).map(m =>
        m.role === 'you' ? `Boss: ${m.text}` : `${agentName}: ${m.text}`
      ).join('\n');

      const conversationalGoal = `The boss is talking to you directly. You are ${agentName}: ${agentDesc}.

## CONVERSATION HISTORY (this is your ongoing conversation with the boss)
${recentChat || '(first message)'}

## YOUR RECENT WORK (what you actually did — cite it when relevant)
${recentWork}

## RULES
1. This is a CONVERSATION. Read the history above and respond in context.
2. If the boss asked something before and you answered, don't repeat — build on it.
3. If asked about data, USE YOUR TOOLS to get real numbers. Never answer from memory.
4. If asked to do something, DO IT with tools. Don't promise — execute.
5. Write detailed, structured responses with markdown formatting.
6. FORBIDDEN: "I will work on it", "the team is focused", "strategic initiatives". Use tools instead.
7. If you genuinely don't know, say "I don't know" — do not invent.

Boss says: "${msg}"`;
      const res: any = await rpcOrCall('agents.run', { agent_id: selectedAgent, goal: conversationalGoal }, async () => {
        const r = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: selectedAgent, goal: conversationalGoal }),
        });
        return r.json();
      });

      if (res?.run_id) {
        // The run is queued; the agent is now working. A typing indicator in the
        // thread carries that, so no fake message has to be pushed and later
        // matched by its text to be removed.
        chatPending = true;
        scrollChatToEnd();

        // Poll until the agent's own timeout, plus a grace period. The old
        // budget was a hardcoded 60 × 3s = 3 min while agents are configured
        // for 5 (timeout_ms defaults to 300000), so a slow-but-successful run
        // reported "Timed out waiting for response" and its real answer was
        // never shown.
        const askedAgent = selectedAgent;
        // How many replies the thread held before this run. The check below
        // used to ask whether the thread had ANY agent message, which is true
        // the moment an agent has ever answered — so from the second exchange
        // onward a failed run fell through it and vanished, leaving the
        // operator with their own message and silence.
        const repliesBefore = chatHistory.filter((m) => m.role === 'agent').length;
        const budgetMs = Number(agentDetail?.agent?.timeout_ms ?? selData?.timeout_ms ?? 300000) + 30000;
        const attempts = Math.ceil(budgetMs / 3000);
        let answered = false;

        for (let i = 0; i < attempts && !answered; i++) {
          await new Promise(r => setTimeout(r, 3000));
          // The panel moved on. The run keeps going and the executor still
          // persists the reply, so it is waiting in memory the next time this
          // agent's thread is opened — but writing it into whatever thread is
          // on screen now would put one agent's answer under another's name.
          if (selectedAgent !== askedAgent) return;
          try {
            const detail: any = await rpcOrCall('agents.runs.detail', { id: res.run_id }, async () => {
              const r2 = await fetch(`/api/agents/runs/${res.run_id}`);
              return r2.json();
            });
            if (detail?.run?.status === 'completed' || detail?.run?.status === 'failed') {
              const ok = detail.run.status === 'completed';
              showBubble(askedAgent, ok ? 'Done!' : 'Failed', 200);
              answered = true;
              // Re-read the thread instead of appending the run result.
              // The executor writes the reply to the agent's memory, which is
              // the same source the tab loads from — building the thread by
              // hand here meant the two could disagree, and the reply existed
              // on the server while the pane showed a spinner.
              chatPending = false;
              await loadChatFromMemory();
              const gotReply = chatHistory.filter((m) => m.role === 'agent').length > repliesBefore;
              if (!gotReply) {
                // Memory gained nothing for THIS run — an executor that does
                // not persist, or a failure that wrote no answer. Fall back to
                // what the run itself reported, so the exchange never ends in
                // silence.
                const result = detail.run.result || detail.run.error || detail.run.status;
                const fullText = typeof result === 'string' ? result : JSON.stringify(result);
                chatHistory = [...chatHistory, {
                  role: 'agent',
                  text: ok ? fullText : `Failed: ${fullText}`,
                  ts: Date.now(),
                }];
              }
            }
          } catch { /* keep polling — a blip shouldn't end the wait */ }
        }

        if (!answered) {
          chatError =
            `No reply after ${Math.round(budgetMs / 60000)} min. The run may still be going — ` +
            `check History, and reopen this tab afterwards: the answer is saved with the agent ` +
            `whether or not this window was watching.`;
        }
      } else {
        chatError = 'The kernel did not start a run for this message.';
      }
    } catch (e: any) {
      chatError = e?.message ?? String(e);
    } finally {
      // Both flags clear only now. `chatSending` used to be reset here while the
      // polling ran unawaited in the background, so the field re-enabled and the
      // send button dropped its progress state seconds into a minutes-long run.
      chatPending = false;
      chatSending = false;
      scrollChatToEnd();
    }
  }
</script>

{#if selData}
  <AgentDrawer
    agentId={selData.id}
    listRow={selRow}
    flow={selFlow ?? null}
    offices={flows}
    on:move={(e) => dispatch('moveagent', { agentId: selData.id, flowId: e.detail.flowId })}
    extraTabs={myPanelTabs}
    running={liveIsRunning}
    historyCount={agentRuns.length}
    workspaceCount={visibleWorkspaceFiles.length}
    {starting}
    {startMsg}
    {togglingPause}
    {revisionBusy}
    {savingName}
    bind:editingName
    bind:editNameValue
    bind:panelTab
    on:close={() => { selectedAgent = null; }}
    on:tab={(e) => selectPanelTab(e.detail.tab)}
    on:run={startAgent}
    on:resume={togglePause}
    on:revision={(e) => resolveRevision(e.detail.mode)}
    on:rename-begin={beginEditName}
    on:rename-cancel={cancelEditName}
    on:rename-save={saveEditName}
    on:changed={(e) => patchWorldAgent(e.detail.agent)}
  >

    <!-- ──────────────── OVERVIEW TAB ────────────────
         `let:store` is the read-only handle AgentDrawer publishes over the
         store it owns. Every section below reads the agent from it; what
         this component still passes down is what only it has — its own
         detail fetch, the chain rows resolved against the world's agent
         list, the skin registry, and the three blocks that call back into
         this scope, which go in as slots so they keep their place in the
         order instead of being pushed to the end. -->
    <svelte:fragment slot="overview" let:store>
      <OverviewTab
        {store}
        stats={selStats}
        lastRun={latestRun}
        prompt={selPrompt}
        loading={detailLoading}
        chains={selChainRows}
        triggers={agentDetail?.triggers ?? null}
        schedules={agentDetail?.schedules ?? null}
        connections={agentDetail?.adhocConnections ?? null}
        running={liveIsRunning}
        skins={availableSkins}
        {savingSkin}
        ready={!!agentDetail?.agent}
        bind:collapsed
        bind:runtimeSection={runtimeSectionRef}
        on:skin={(e) => changeSkin(e.detail.skinId)}
      >
        <!-- ─── Latest result hero card ───
             The failure card lives in here, so it only appears when the last
             run failed — and the same card carries the output when it did
             not. Everything it calls (`formatRunOutput`, the remedy handler,
             the jump to HISTORY) is this component's. -->
        <svelte:fragment slot="result">
          {#if latestRun && (latestRun.result || latestRun.error)}
            <div class="result-hero" class:result-ok={latestRun.status === 'completed'} class:result-fail={latestRun.status === 'failed'}>
              <div class="result-hero-top">
                <div class="result-hero-badge">
                  <span class="result-hero-icon">{latestRun.status === 'completed' ? '✓' : latestRun.status === 'failed' ? '✗' : '●'}</span>
                  <span class="result-hero-lbl">Last result</span>
                </div>
                <div class="result-hero-date">
                  {fmtRelTime(latestRun.created_at)}
                  {#if latestRun.created_at}
                    <span class="result-hero-date-full">{String(latestRun.created_at).slice(0,16).replace('T',' ')}</span>
                  {/if}
                </div>
                <div class="result-hero-meta">
                  <span class="result-hero-trigger" style="--c:{triggerColor(latestRun.trigger_type)}">{latestRun.trigger_type}</span>
                  <span class="result-hero-dot">·</span>
                  <span>{latestRun.steps_count} steps</span>
                  <span class="result-hero-dot">·</span>
                  <span>{fmtTokens(latestRun.tokens_used)} tok</span>
                </div>
              </div>
              {#if latestRun.error}
                <div class="result-hero-body result-hero-err copy-wrap">
                  <CopyTextBtn text={latestRun.error} title="Copy error" />
                  <RunFailureCard
                    error={latestRun.error}
                    agentType={agentType(selData)}
                    on:remedy={(e) => handleRunFailureRemedy(e.detail.kind)}
                  />
                </div>
              {:else if latestRun.result}
                <div class="result-hero-body ip-out-md copy-wrap" on:click={handleOutputClick} role="presentation">
                  <CopyTextBtn text={latestRun.result} title="Copy result" />
                  {@html formatRunOutput(latestRun.result)}
                </div>
              {/if}
              <div class="result-hero-actions">
                <button class="result-hero-action" on:click={() => latestRun && copy(latestRun.result ?? latestRun.error ?? '', 'hero-' + latestRun.id)}>
                  {copiedKey === 'hero-' + latestRun.id ? '✓ copied' : '⧉ copy'}
                </button>
                <button class="result-hero-action" on:click={() => { selectPanelTab('history'); }}>See all runs →</button>
              </div>
            </div>
          {:else if latestRunLoading}
            <div class="result-hero result-hero-loading">Loading last result…</div>
          {/if}
        </svelte:fragment>

        <svelte:fragment slot="auth">
          {#if dependsOnGoogleAuth(selData)}
            <div class="ip-auth-cta" title="This agent talks to Google — re-login any time tokens expire.">
              <span class="ip-auth-hint">Depends on Google auth</span>
              <button
                class="ip-auth-btn"
                disabled={reauthLoading}
                on:click={() => startReauth('google')}
              >
                <span class="ip-auth-ico">🔑</span>
                <span>{reauthLoading ? '… opening Google' : 'Re-login Google'}</span>
              </button>
            </div>
          {/if}
        </svelte:fragment>

        <svelte:fragment slot="footer">
          {#if detailLoading && !agentDetail}
            <div class="ip-loading">Loading full details…</div>
          {/if}
        </svelte:fragment>
      </OverviewTab>
    </svelte:fragment>

    <!-- ──────────────── SKILLS TAB ────────────────
         `selRow` and not `selData`: the drawer's own store is seeded from
         the same row, so both read one `skills_json`. The change event goes
         through patchWorldAgent like every other write in here, which is
         what keeps the tab's badge and the world's list in step without a
         refetch. -->
    <svelte:fragment slot="skills">
      <div class="ip-body">
        <SkillsTab
          agent={selRow}
          on:change={(e) => patchWorldAgent({ id: selData.id, skills_json: JSON.stringify(e.detail.skills) })}
        />
      </div>
    </svelte:fragment>

    <!-- ──────────────── LIVE TAB ──────────────── -->
    <svelte:fragment slot="live">
      <LiveTab
        agentName={selData.name}
        events={liveCurrentRunEvents}
        onOutputClick={handleOutputClick}
        onOpenEmail={(id) => openEmail(id)}
      />
    </svelte:fragment>

    <!-- ──────────────── HISTORY TAB ──────────────── -->
    <svelte:fragment slot="history">
      <HistoryTab
        stats={selStats}
        runs={agentRuns}
        {runsLoading}
        {expandedRunId}
        steps={runSteps}
        stepsLoading={runStepsLoading}
        stepsError={runStepsError}
        {copiedKey}
        onToggleRun={loadRunSteps}
        onRetryRun={(id) => { expandedRunId = null; loadRunSteps(id); }}
        onCopy={copy}
        onOutputClick={handleOutputClick}
        onOpenEmail={(id) => openEmail(id)}
      />
    </svelte:fragment>

    <!-- ──────────────── TABS CONTRIBUIDOS POR EXTENSIONES ──────────────── -->
    <svelte:fragment slot="extra" let:tabId>
      <div class="ip-body ip-ext-body">
        <svelte:component this={panelTabComponents[tabId]} />
      </div>
    </svelte:fragment>

    <!-- ──────────────── CHAT TAB ──────────────── -->
    <svelte:fragment slot="chat">
      <ChatTab
        agent={selData}
        canConverse={chatCanConverse}
        history={chatHistory}
        historyLoading={chatHistoryLoading}
        error={chatError}
        pending={chatPending}
        bind:input={chatInput}
        sending={chatSending}
        suggestions={chatSuggestions}
        bind:scrollEl={chatScrollEl}
        {starting}
        onSend={(text) => talkToAgent(text)}
        onStart={startAgent}
        onSeeHistory={() => selectPanelTab('history')}
        onOutputClick={handleOutputClick}
      />
    </svelte:fragment>

    <!-- ──────────────── WORKSPACE TAB ──────────────── -->
    <svelte:fragment slot="workspace">
      <WorkspaceTab
        info={selWorkspaceInfo}
        variables={selData?.variables}
        previewUrl={workspacePreviewUrl}
        loading={workspaceLoading}
        files={visibleWorkspaceFiles}
        bind:collapsed={wsCollapsed}
        bind:fileContent={workspaceFileContent}
        onOpenFile={loadWorkspaceFile}
      />
    </svelte:fragment>
  </AgentDrawer>
{/if}

<style>
  /* ── Body (scrollable) ────────── */
  .ip-body{
    flex:1;overflow-y:auto;overflow-x:hidden;
    padding:16px 18px 24px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .ip-body::-webkit-scrollbar{width:6px}
  .ip-body::-webkit-scrollbar-thumb{background:rgba(120,130,160,.2);border-radius:3px}
  .ip-body::-webkit-scrollbar-thumb:hover{background:rgba(120,130,160,.35)}

  /* Misc */
  .ip-loading{
    font:500 11px 'Manrope',sans-serif;color:#6a6f82;
    text-align:center;padding:24px 12px;
  }

  /* ── Markdown output (run.result / step.content) ── */
  .ip-out-md{
    font:400 12.5px/1.6 'Manrope',sans-serif;color:#d0d4e0;
    padding:14px 18px;border-radius:6px;background:rgba(0,0,0,.22);
    word-break:break-word;overflow-wrap:anywhere;max-height:380px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }

  /* ── Latest result hero card (Overview) ── */
  .result-hero{
    position:relative;margin:0 0 14px;padding:14px 16px 10px;
    border-radius:12px;
    background:
      linear-gradient(180deg, rgba(120,220,140,.08) 0%, rgba(120,220,140,.02) 60%, rgba(0,0,0,0) 100%),
      #0f121c;
    border:1px solid rgba(120,220,140,.28);
    box-shadow:0 4px 18px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.02);
    overflow:hidden;
  }
  .result-hero::before{
    content:'';position:absolute;top:0;left:0;right:0;height:2px;
    background:linear-gradient(90deg, transparent, #78dc8c, transparent);
    opacity:.6;
  }
  .result-hero.result-fail{
    background:linear-gradient(180deg, rgba(239,93,110,.08) 0%, rgba(239,93,110,.02) 60%, rgba(0,0,0,0) 100%), #0f121c;
    border-color:rgba(239,93,110,.32);
  }
  .result-hero.result-fail::before{background:linear-gradient(90deg, transparent, #ef5d6e, transparent)}
  .result-hero-loading{padding:14px;color:#6a6f82;font:500 11px 'Manrope',sans-serif;text-align:center}
  .result-hero-top{
    display:flex;justify-content:space-between;align-items:center;gap:10px;
    margin-bottom:10px;flex-wrap:wrap;
  }
  .result-hero-badge{display:flex;align-items:center;gap:8px}
  .result-hero-icon{
    width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;
    border-radius:50%;font:700 12px 'JetBrains Mono',monospace;
    background:rgba(120,220,140,.18);color:#78dc8c;border:1px solid rgba(120,220,140,.4);
  }
  .result-hero.result-fail .result-hero-icon{background:rgba(239,93,110,.18);color:#ef5d6e;border-color:rgba(239,93,110,.4)}
  .result-hero-lbl{
    font:700 10px 'Syne',sans-serif;color:#d0d4e0;
    letter-spacing:1.2px;text-transform:uppercase;
  }
  .result-hero-date{
    font:700 13px 'Manrope',sans-serif;color:#e0e2ea;margin-bottom:2px;
  }
  .result-hero-date-full{
    font:400 10px 'JetBrains Mono',monospace;color:#6a6f82;margin-left:8px;
  }
  .result-hero-meta{
    display:flex;align-items:center;gap:5px;flex-wrap:wrap;
    font:500 9px 'JetBrains Mono',monospace;color:#8a8fa8;
  }
  .result-hero-dot{color:#4a4f6a}
  .result-hero-trigger{
    padding:2px 7px;border-radius:4px;
    background:color-mix(in srgb, var(--c, #6366f1) 15%, transparent);
    border:1px solid color-mix(in srgb, var(--c, #6366f1) 35%, transparent);
    color:var(--c, #6366f1);
    font:600 9px 'JetBrains Mono',monospace;letter-spacing:.4px;
  }
  .result-hero-body{
    padding:2px 0;max-height:260px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .result-hero-err{padding:10px 12px;border-radius:8px;background:rgba(239,93,110,.08);border:1px solid rgba(239,93,110,.22)}
  .result-hero-actions{
    display:flex;justify-content:flex-end;gap:8px;margin-top:10px;
    padding-top:8px;border-top:1px dashed rgba(120,130,160,.12);
  }
  .result-hero-action{
    padding:5px 10px;border-radius:6px;
    font:600 9px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(120,130,160,.08);border:1px solid rgba(120,130,160,.22);
    color:#c0c5d8;cursor:pointer;transition:all .12s;
  }
  .result-hero-action:hover{background:rgba(120,130,160,.16);border-color:rgba(120,130,160,.38);color:#fff}

  /* ── Inline "Re-login Google" CTA in the description area ── */
  /* Always visible for gsync:* agents, regardless of last-run status. */
  .ip-auth-cta{
    display:flex;align-items:center;gap:10px;
    padding:8px 12px;margin:0 0 14px;
    background:linear-gradient(180deg, rgba(245,158,11,.10), rgba(245,158,11,.03));
    border:1px solid rgba(245,158,11,.30);border-radius:10px;
  }
  .ip-auth-hint{
    flex:1;min-width:0;
    font:600 10.5px 'JetBrains Mono',monospace;letter-spacing:.4px;text-transform:uppercase;
    color:#ffd175;
  }
  .ip-auth-btn{
    display:inline-flex;align-items:center;gap:6px;
    padding:6px 12px;border-radius:7px;
    font:700 11px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:linear-gradient(180deg, rgba(245,158,11,.28), rgba(245,158,11,.10));
    border:1px solid rgba(245,158,11,.65);color:#fff;cursor:pointer;
    transition:all .12s;
  }
  .ip-auth-btn:hover:not(:disabled){
    background:linear-gradient(180deg, rgba(245,158,11,.42), rgba(245,158,11,.16));
    border-color:rgba(245,158,11,.95);
  }
  .ip-auth-btn:disabled{opacity:.55;cursor:wait}
  .ip-auth-ico{font-size:13px;line-height:1}
</style>
