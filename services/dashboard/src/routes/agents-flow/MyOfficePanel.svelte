<script lang="ts">
  // My Office — the top agent's inbox: the reports office leaders file, the
  // failures that bubble up, and the questions agents pin when they are stuck
  // — plus the full-report modal and its "send to fixer" dispatch.
  //
  // The lists are the world's: live events append to them and the 3D scene
  // opens this panel, so they come in through bind: and every write made here
  // lands back in AgentWorld3D. What only this panel uses (the open report,
  // its full text, the fixer picker, the per-question busy flags) lives here.
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { rpcOrCall } from '$lib/ws.js';
  import { isLlmConfigError, LLM_SETTINGS_HREF } from '$lib/llm-error.js';
  import { fmtRelTime } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import { urlForOption, buildFixerGoal } from '$lib/agent-helpers.js';
  import { t } from '$lib/i18n/index.js';
  import { groupReports, reportKey, plainPreview, type ReportGroup } from '$lib/office/report-groups.js';
  import OfficeQuestionCard from './OfficeQuestionCard.svelte';
  import FailureGroupCard from './FailureGroupCard.svelte';
  import KernlBugsTab from './KernlBugsTab.svelte';
  import { bugsApi } from '$lib/kernl-bugs.js';
  import { summarizeRunContext, explainFailure, type RunContext } from '$lib/office/failure-explain.js';
  import { planFix, fmtLimit, type FixPlan, type AgentLimits, type RecentRun } from '$lib/office/failure-fix.js';
  import { updateAgent } from '$lib/api.js';
  import type { OfficeReport, PendingQuestion, WorldAgent } from './world-types.js';

  /** bind: — the 3D office's My Office hitbox toggles it too. */
  export let showMyOfficePanel: boolean;
  /** bind: — the inbox shortcut opens straight on Questions. */
  export let myOfficeTab: 'overview' | 'questions' | 'errors' | 'activity' | 'kernl';
  /** Kernl bug reports waiting for a decision — the Kernl tab's badge. */
  let kernlCount = 0;
  /** Runs filed as Kernl bugs from this panel — the card shows "Reported". */
  let reportedRuns = new Set<string>();
  async function reportToKernl(g: ReportGroup, askChief: boolean): Promise<void> {
    const runId = g.reports[0].runId;
    if (!runId) return;
    await bugsApi.reportRun(runId, { askChief });
    reportedRuns = new Set([...reportedRuns, runId]);
    void refreshKernlCount();
  }
  // The badge has to show what the chief filed while the tab was closed, so
  // the panel asks on its own instead of relying on the tab being mounted.
  async function refreshKernlCount(): Promise<void> {
    try { kernlCount = (await bugsApi.list()).filter((b) => b.status === 'new').length; }
    catch { /* an older kernel has no /api/kernl/bugs: no badge */ }
  }
  $: if (showMyOfficePanel) void refreshKernlCount();
  /** bind: — appended to by live events, trimmed by the actions here. */
  export let officeReports: OfficeReport[];
  /** bind: — polled by the world, which also lights the top agent's halo from it. */
  export let pendingQuestions: PendingQuestion[];
  /** Questions the chief is still triaging (count only). */
  export let triageCount = 0;
  /** Recent questions the chief resolved on its own — read-only audit. */
  export let chiefAnswered: PendingQuestion[] = [];
  export let auditedRunIds: Set<string>;
  export let agents: WorldAgent[];
  export let flowColor: (aid: string) => string;
  export let topAgent: () => { id: string; name: string } | null;
  // Shared with the agent drawer: one clipboard flash, one draft-chip handler.
  export let copiedKey: string | null;
  export let copy: (text: string, key: string) => void;
  export let onOutputClick: (e: MouseEvent) => void;
  /** "Go to agent desk": select the agent, then fly the camera to it. */
  export let selectAgent: (id: string) => void;
  export let focusAgent: () => void;
  /** The backlog or the questions are still loading: show a skeleton, never
   *  "all clear" — an empty list before the data arrives is not good news. */
  export let loading = false;
  /** Is the chief itself running right now? Shown in the header. */
  export let chiefRunning = false;
  /** "Hablar": open the chief's chat (the world owns it). */
  export let openChiefChat: () => void = () => {};
  /** Open an agent's drawer on its Settings tab — the fix for limit failures. */
  export let openAgentSettings: (agentId: string) => void = () => {};

  // ── Failure context: what each failing run was doing ──
  // One fetch per run (GET /api/agents/runs/:id), for the newest run of each
  // problem on screen. undefined = loading, null = could not load.
  let runCtx: Record<string, RunContext | null> = {};
  const ctxRequested = new Set<string>();
  function ensureCtx(runId: string | undefined): void {
    if (!runId || ctxRequested.has(runId)) return;
    ctxRequested.add(runId);
    fetch(`/api/agents/runs/${encodeURIComponent(runId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { runCtx = { ...runCtx, [runId]: b?.run ? summarizeRunContext(b.run, b.steps ?? []) : null }; })
      .catch(() => { runCtx = { ...runCtx, [runId]: null }; });
  }
  $: groupsOnScreen = groupReports(officeReports.filter(r => r.status === 'failed')).slice(0, 20);
  $: groupsOnScreen.forEach(g => ensureCtx(g.reports[0].runId));
  const ctxOf = (g: ReportGroup, _dep: unknown): RunContext | null | undefined => {
    const id = g.reports[0].runId;
    return id ? (id in runCtx ? runCtx[id] : undefined) : null;
  };

  // ── What fixes each failure, from the agent as it is NOW ──
  // GET /api/agents/:id once per failing agent: its current limits and its
  // recent runs say whether the problem is already gone (the limit was raised,
  // a later run completed), being retried, or still needs the fix.
  let agentNow: Record<string, { limits: AgentLimits; runs: RecentRun[] } | null> = {};
  const agentRequested = new Set<string>();
  function loadAgentNow(agentId: string, force = false): void {
    if (!agentId || (!force && agentRequested.has(agentId))) return;
    agentRequested.add(agentId);
    fetch(`/api/agents/${encodeURIComponent(agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        agentNow = { ...agentNow, [agentId]: b?.agent ? { limits: b.agent, runs: Array.isArray(b.runs) ? b.runs : [] } : null };
      })
      .catch(() => { agentNow = { ...agentNow, [agentId]: null }; });
  }
  $: groupsOnScreen.forEach(g => loadAgentNow(g.agentId));
  /** The error the card explains — the report's, or its run's when the report only said "failed". */
  function errorTextOf(g: ReportGroup): string {
    const c = ctxOf(g, runCtx);
    return !g.text.trim() || /^failed\.?$/i.test(g.text.trim()) ? (c?.error || g.text) : g.text;
  }
  const planOf = (g: ReportGroup, _a: unknown, _c: unknown): FixPlan | undefined => {
    if (!(g.agentId in agentNow)) return undefined;
    const now = agentNow[g.agentId];
    return planFix(explainFailure(errorTextOf(g)), now?.limits, now?.runs ?? [], g.latestTs);
  };

  // "Arreglar": apply the plan's change, then run the agent again.
  let fixing: Record<string, boolean> = {};
  async function autoFix(g: ReportGroup): Promise<void> {
    const plan = planOf(g, agentNow, runCtx);
    if (!plan || fixing[g.agentId] || (plan.kind !== 'raise' && plan.kind !== 'rerun')) return;
    fixing = { ...fixing, [g.agentId]: true };
    const name = agentNameOf(g.agentId);
    try {
      if (plan.kind === 'raise') {
        const res: any = await updateAgent(g.agentId, { [plan.field]: plan.to });
        if (res?.success === false || res?.error) throw new Error(String(res.error ?? 'update failed'));
      }
      await retryAgent(g.agentId);
      fixerStatus = plan.kind === 'raise'
        ? $t('office.fix.fixed', { name, what: `${fmtLimit(plan.field, plan.from)} → ${fmtLimit(plan.field, plan.to)}` })
        : $t('office.fix.fixed_rerun', { name });
    } catch (e) {
      fixerStatus = $t('office.fix.failed', { name, error: (e as Error).message });
    } finally {
      fixing = { ...fixing, [g.agentId]: false };
      // The new run shows up in the agent's runs: the card moves to "running".
      setTimeout(() => loadAgentNow(g.agentId, true), 1500);
    }
  }

  // "Que lo resuelva el Chief": the same brief as the report's fixer, sent to
  // whoever holds the top rank. Handed over, the failure leaves the board.
  async function askChief(g: ReportGroup): Promise<void> {
    const chief = topAgent();
    if (!chief || chiefRunning) return;
    const report = g.reports[0];
    const c = ctxOf(g, runCtx);
    const body = [
      errorTextOf(g),
      g.count > 1 ? `(failed ${g.count} times with this error)` : '',
      c?.goal ? `Goal of the failing run: ${c.goal}` : '',
      c?.lastStep ? `Last step before it stopped: ${c.lastStep}` : '',
    ].filter(Boolean).join('\n');
    const goal = buildFixerGoal(report, body);
    try {
      const res: any = await rpcOrCall('agents.run', { agent_id: chief.id, goal }, async () => {
        const r = await fetch('/api/agents/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: chief.id, goal }),
        });
        return r.json();
      });
      if (!(res?.success || res?.run_id)) throw new Error(String(res?.error ?? 'run failed'));
      removeReports(g.reports);
      fixerStatus = $t('office.fix.chief_sent', { name: g.agentName });
    } catch (e) {
      fixerStatus = $t('office.fix.failed', { name: g.agentName, error: (e as Error).message });
    }
  }

  // "Volver a correr": run the agent again with its default goal.
  let retrying: Record<string, boolean> = {};
  async function retryAgent(agentId: string): Promise<void> {
    if (retrying[agentId]) return;
    retrying = { ...retrying, [agentId]: true };
    try {
      await rpcOrCall('agents.run', { agent_id: agentId }, async () => {
        const r = await fetch('/api/agents/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId }),
        });
        return r.json();
      });
      fixerStatus = $t('office.fail.retried', { name: agentNameOf(agentId) });
      setTimeout(() => { fixerStatus = ''; }, 5000);
    } finally {
      retrying = { ...retrying, [agentId]: false };
    }
  }

  const agentNameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id.slice(0, 8);

  let questionSubmitting: Record<string, boolean> = {};
  async function answerQuestion(q: PendingQuestion, idx: number, opt: { label: string; value?: string; url?: string }) {
    if (questionSubmitting[q.id]) return;
    // Open the linked URL FIRST (synchronously, inside the user's click event)
    // — popup blockers reject window.open() when it's behind an async await.
    const target = urlForOption(q, opt);
    if (target) {
      window.open(target, '_blank', 'noopener,noreferrer');
    }
    questionSubmitting = { ...questionSubmitting, [q.id]: true };
    try {
      await fetch(`/api/agents/questions/${q.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_index: idx, selected_option: opt.label }),
      });
      pendingQuestions = pendingQuestions.filter(x => x.id !== q.id);
    } finally {
      questionSubmitting = { ...questionSubmitting, [q.id]: false };
    }
  }
  async function dismissQuestion(q: PendingQuestion) {
    if (questionSubmitting[q.id]) return;
    questionSubmitting = { ...questionSubmitting, [q.id]: true };
    try {
      await fetch(`/api/agents/questions/${q.id}/dismiss`, { method: 'POST' });
      pendingQuestions = pendingQuestions.filter(x => x.id !== q.id);
    } finally {
      questionSubmitting = { ...questionSubmitting, [q.id]: false };
    }
  }

  // Free-text answers — for when none of the chief's options fit. Sent as
  // selected_index -1 so the kernel knows it's not one of the fixed options.
  // Resolves true when it landed, so the card can clear its input.
  async function answerFree(q: PendingQuestion, text: string): Promise<boolean> {
    if (!text || questionSubmitting[q.id]) return false;
    questionSubmitting = { ...questionSubmitting, [q.id]: true };
    try {
      const res = await fetch(`/api/agents/questions/${q.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_index: -1, selected_option: text, note: text }),
      });
      if (res.ok) pendingQuestions = pendingQuestions.filter(x => x.id !== q.id);
      return res.ok;
    } finally {
      questionSubmitting = { ...questionSubmitting, [q.id]: false };
    }
  }

  // Bulk actions for the My Office panel.
  let bulkBusy = false;
  async function dismissAllQuestions(ask = true) {
    if (bulkBusy || pendingQuestions.length === 0) return;
    if (ask && !confirm($t('office.chief.confirm_dismiss_questions', { n: String(pendingQuestions.length) }))) return;
    bulkBusy = true;
    const snapshot = [...pendingQuestions];
    try {
      // Fire all dismissals in parallel — server-side they're independent.
      await Promise.all(snapshot.map(q =>
        fetch(`/api/agents/questions/${q.id}/dismiss`, { method: 'POST' }).catch(() => null)
      ));
      pendingQuestions = [];
    } finally {
      bulkBusy = false;
    }
  }
  function clearErrors() {
    removeReports(officeReports.filter(r => r.status === 'failed'));
  }
  function clearActivity() {
    removeReports(officeReports.filter(r => r.status !== 'failed'));
  }
  function clearAllOfficeData() {
    if (!confirm($t('office.chief.confirm_clear_everything'))) return;
    void dismissAllQuestions(false);
    // Not a reload: the list is rebuilt from agent_runs, which would bring
    // back everything this just cleared if it were not recorded.
    removeReports(officeReports);
  }
  let openReport: OfficeReport | null = null;

  // ── Dismiss: drop reports from the office without acting on them ──
  // Every way a report leaves the office goes through here, and is RECORDED
  // (POST /api/agents/office/dismiss): the office rebuilds its list from the
  // agents' runs on each load, and an unrecorded dismissal came straight back.
  // Live-only entries (handoffs) have no run id and are never reloaded anyway.
  function removeReports(reports: OfficeReport[]): void {
    if (reports.length === 0) return;
    const keys = new Set(reports.map(reportKey));
    officeReports = officeReports.filter(r => !keys.has(reportKey(r)));
    const runIds = reports.map(r => r.runId).filter((id): id is string => !!id);
    if (runIds.length) {
      void fetch('/api/agents/office/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_ids: runIds }),
      }).catch(() => { /* the view already dropped them; a retry happens on the next dismissal */ });
    }
  }
  function dropReports(keys: Set<string>): void {
    removeReports(officeReports.filter(r => keys.has(reportKey(r))));
  }
  function dismissGroup(g: ReportGroup): void {
    dropReports(new Set(g.reports.map(reportKey)));
  }
  function dismissReport(r: OfficeReport): void {
    dropReports(new Set([reportKey(r)]));
  }
  /** A failure is dismissed with its repeats — the group it was opened from. */
  function groupOf(r: OfficeReport): ReportGroup | null {
    if (r.status !== 'failed') return null;
    return groupReports(officeReports.filter(x => x.status === 'failed'))
      .find(g => g.reports.some(x => reportKey(x) === reportKey(r))) ?? null;
  }
  $: openReportGroupSize = openReport ? (groupOf(openReport)?.count ?? 1) : 0;
  function dismissOpenReport(r: OfficeReport): void {
    const g = groupOf(r);
    if (g) dismissGroup(g); else dismissReport(r);
    openReport = null;
  }

  // Activity tab: one agent's reports at a time, a card opened in place.
  let activityAgent: string | null = null;
  let expandedKey: string | null = null;
  let moreOpen = false;

  // ── "Send to fixer" — dispatch the open report to a fixing agent ──
  // The list below is a name-matched whitelist of active claude_code agents
  // that can reasonably act on a bug/error/infra report. Order = priority;
  // the first one that exists is the default. The user can override via the
  // ▾ dropdown next to the button.
  interface FixerCandidate { id: string; name: string; hint: string; }
  const FIXER_WHITELIST: Array<{ match: RegExp; hint: string }> = [
    { match: /^director de desarrollo$/i, hint: 'dev manager — fixes code + infra' },
    { match: /^project builder$/i, hint: 'generic dev fixer' },
    { match: /^cloudops$/i, hint: 'infra / MCP / deploy' },
    { match: /^repo coordinator$/i, hint: 'routes work into registered repos' },
    { match: /^security auditor$/i, hint: 'security findings only' },
    { match: /^error auditor$/i, hint: 'triages — does NOT fix' },
  ];
  $: fixerCandidates = (() => {
    const out: FixerCandidate[] = [];
    for (const w of FIXER_WHITELIST) {
      const a = agents.find(x => x.active === 1 && w.match.test(x.name));
      if (a) out.push({ id: a.id, name: a.name, hint: w.hint });
    }
    // Whoever holds the top rank is always a valid last-resort target — looked
    // up by rank, never by name, so renaming the agent or the rank can't
    // silently drop it from the list.
    const top = topAgent();
    if (top && !out.some(c => c.id === top.id)) {
      out.push({ id: top.id, name: top.name, hint: 'top-level coordinator / router' });
    }
    return out;
  })();
  let selectedFixerId: string | null = null;
  let fixerPickerOpen = false;
  let sendingToFixer = false;
  /** bind: — the toast that reports the dispatch is the world's, so it
   *  outlives this modal closing. */
  export let fixerStatus: string;
  // Resolve which agent will receive the report — explicit pick wins, else
  // first candidate, else null (button stays disabled).
  $: activeFixer = (() => {
    if (selectedFixerId) return fixerCandidates.find(c => c.id === selectedFixerId) ?? null;
    return fixerCandidates[0] ?? null;
  })();

  async function sendReportToFixer(): Promise<void> {
    if (!openReport || sendingToFixer) return;
    const fixer = activeFixer;
    if (!fixer) { fixerStatus = '✗ no fixer agent available'; return; }
    sendingToFixer = true;
    fixerStatus = '';
    try {
      const body = (fullReportText ?? openReport.text ?? '').slice(0, 16000);
      const goal = buildFixerGoal(openReport, body);
      const res: any = await rpcOrCall('agents.run', { agent_id: fixer.id, goal }, async () => {
        const r = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: fixer.id, goal }),
        });
        return r.json();
      });
      if (res?.success || res?.run_id) {
        // Drop the dispatched report from the visible list. Same-shape filter
        // also touches the errorReports view (computed from officeReports).
        // The {#each (key)} + out:slide on the cards animates the removal.
        const target = openReport;
        const targetKey = target.runId ?? `${target.agentId}-${target.ts}`;
        // Close the report modal first so its closing animation doesn't fight
        // the list-card slide-out — keeps both transitions clean.
        openReport = null;
        // Force a reactive remove. Filter handles the case where the same
        // report object lives in officeReports under a different reference.
        // Sent is handled: recorded like a dismissal so it does not return.
        removeReports(officeReports.filter(r => reportKey(r) === targetKey));
        fixerStatus = `✓ sent to ${fixer.name} · run ${String(res.run_id || '').slice(0, 8)}`;
      } else {
        fixerStatus = `✗ ${res?.error || 'failed to dispatch'}`;
      }
    } catch (e: any) {
      fixerStatus = `✗ ${e?.message ?? String(e)}`;
    } finally {
      sendingToFixer = false;
      setTimeout(() => { fixerStatus = ''; }, 6000);
    }
  }

  // Full-text cache keyed by runId — events only carry a 200-char preview, so
  // when the modal opens we fetch the full agent_runs.result from the API.
  let fullReportText: string | null = null;
  let fullReportLoading = false;

  async function loadFullReport(runId: string) {
    fullReportText = null;
    if (!runId) return;
    fullReportLoading = true;
    try {
      const res = await fetch(`/api/agents/runs/${runId}`);
      const data: any = await res.json();
      const full = String(data?.run?.result ?? data?.run?.error ?? '');
      if (full) fullReportText = full;
    } catch { /* keep preview */ }
    fullReportLoading = false;
  }

  $: if (openReport?.runId) { loadFullReport(openReport.runId); } else { fullReportText = null; }
  $: displayReportText = (fullReportText ?? openReport?.text ?? '');
</script>

<!-- The chief's office -->
{#if showMyOfficePanel}
  {@const errorReports = officeReports.filter(r => r.status === 'failed')}
  {@const activityReports = officeReports.filter(r => r.status !== 'failed')}
  {@const errorGroups = groupReports(errorReports)}
  {@const chief = topAgent()}
  {@const needsYou = pendingQuestions.length + errorGroups.length}
  <div class="info-panel office-reports-panel">
    <!-- Header: whose office, what the chief is doing, and the two ways to
         reach the chief itself. -->
    <div class="ip-head mo-head">
      <div class="ip-glyph mo-glyph" aria-hidden="true">&#9733;</div>
      <div class="ip-head-txt">
        <div class="ip-name">{$t('office.chief.title')}</div>
        <div class="mo-status">
          {#if chiefRunning}
            <span class="mo-chip mo-chip-run"><span class="mo-pulse"></span>{$t('office.chief.status_running', { name: chief?.name ?? 'Chief' })}</span>
          {:else}
            <span class="mo-chip">{$t('office.chief.status_idle', { name: chief?.name ?? 'Chief' })}</span>
          {/if}
          {#if triageCount > 0}
            <span class="mo-chip mo-chip-q">{$t('office.chief.status_triage', { n: String(triageCount) })}</span>
          {/if}
        </div>
      </div>
      <div class="mo-head-actions">
        {#if chief}
          <button class="mo-btn" type="button" on:click={openChiefChat} title={$t('office.chief.talk_title')}>
            {$t('office.chief.talk')}
          </button>
          <button class="mo-btn mo-btn-primary" type="button" title={$t('office.chief.open_agent_title')}
                  on:click={() => { selectAgent(chief.id); showMyOfficePanel = false; focusAgent(); }}>
            {$t('office.chief.open_agent')} →
          </button>
        {/if}
        <button class="ip-close" on:click={() => showMyOfficePanel = false} aria-label={$t('office.chief.close')}>×</button>
      </div>
    </div>

    <div class="ip-tabs mo-tabs" role="tablist">
      <button class="ip-tab" role="tab" aria-selected={myOfficeTab === 'overview'} class:active={myOfficeTab === 'overview'}
              on:click={() => myOfficeTab = 'overview'}>
        {$t('office.chief.tab_now')}
        {#if needsYou > 0}<span class="mo-tab-badge mo-tab-badge-q">{needsYou}</span>{/if}
      </button>
      <button class="ip-tab" role="tab" aria-selected={myOfficeTab === 'questions'} class:active={myOfficeTab === 'questions'}
              on:click={() => myOfficeTab = 'questions'}>
        {$t('office.chief.tab_questions')}
        {#if pendingQuestions.length > 0}<span class="mo-tab-badge mo-tab-badge-q">{pendingQuestions.length}</span>{/if}
      </button>
      <button class="ip-tab" role="tab" aria-selected={myOfficeTab === 'errors'} class:active={myOfficeTab === 'errors'}
              on:click={() => myOfficeTab = 'errors'}>
        {$t('office.chief.tab_errors')}
        {#if errorGroups.length > 0}<span class="mo-tab-badge mo-tab-badge-err">{errorGroups.length}</span>{/if}
      </button>
      <button class="ip-tab" role="tab" aria-selected={myOfficeTab === 'activity'} class:active={myOfficeTab === 'activity'}
              on:click={() => myOfficeTab = 'activity'}>
        {$t('office.chief.tab_activity')}
        {#if activityReports.length > 0}<span class="mo-tab-badge">{activityReports.length}</span>{/if}
      </button>
      <button class="ip-tab" role="tab" aria-selected={myOfficeTab === 'kernl'} class:active={myOfficeTab === 'kernl'}
              on:click={() => myOfficeTab = 'kernl'} title={$t('office.kernl.tab_title')}>
        {$t('office.kernl.tab')}
        {#if kernlCount > 0}<span class="mo-tab-badge mo-tab-badge-q">{kernlCount}</span>{/if}
      </button>
    </div>

    <div class="or-scroll">
      {#if myOfficeTab === 'overview'}
        <!-- ═══ NOW: what needs the operator ═══ -->
        {#if loading && needsYou === 0}
          <div class="mo-skel" role="status" aria-live="polite" aria-label={$t('office.chief.loading')}>
            <div class="mo-skel-h"><span class="mo-spin" aria-hidden="true"></span>{$t('office.chief.loading')}</div>
            {#each [0, 1, 2] as n (n)}
              <div class="mo-skel-card" style="animation-delay:{n * 120}ms">
                <span class="mo-skel-line mo-skel-w30"></span>
                <span class="mo-skel-line mo-skel-w90"></span>
                <span class="mo-skel-line mo-skel-w60"></span>
              </div>
            {/each}
          </div>
        {:else if needsYou === 0}
          <div class="mo-allgood">
            <span class="mo-allgood-ico" aria-hidden="true">✓</span>
            <div>
              <div class="mo-allgood-t">{$t('office.chief.all_good')}</div>
              <div class="mo-allgood-s">{$t('office.chief.all_good_sub')}</div>
            </div>
          </div>
        {/if}

        {#if pendingQuestions.length > 0}
          <div class="or-section">
            <span class="or-section-title or-section-q">{$t('office.chief.needs_answer', { n: String(pendingQuestions.length) })}</span>
            {#if pendingQuestions.length > 2}
              <button class="or-section-more" on:click={() => myOfficeTab = 'questions'}>{$t('office.chief.see_all')} →</button>
            {/if}
          </div>
          <div class="bq-list">
            {#each pendingQuestions.slice(0, 2) as q (q.id)}
              <OfficeQuestionCard {q} agentName={agentNameOf(q.from_agent_id)} color={flowColor(q.from_agent_id)}
                                  busy={!!questionSubmitting[q.id]}
                                  onAnswer={answerQuestion} onDismiss={dismissQuestion} onFree={answerFree} />
            {/each}
          </div>
        {/if}

        {#if errorGroups.length > 0}
          <div class="or-section">
            <span class="or-section-title or-section-fail">{$t('office.chief.needs_fix', { n: String(errorGroups.length) })}</span>
            {#if errorGroups.length > 3}
              <button class="or-section-more" on:click={() => myOfficeTab = 'errors'}>{$t('office.chief.see_all')} →</button>
            {/if}
          </div>
          <div class="office-reports-list">
            {#each errorGroups.slice(0, 3) as g (g.key)}
              <div out:slide|local={{ duration: 280, easing: quintOut }}>
                <FailureGroupCard {g} ctx={ctxOf(g, runCtx)} retrying={!!retrying[g.agentId]}
                                  onOpen={() => openReport = g.reports[0]} onDismiss={() => dismissGroup(g)}
                                  onRetry={() => retryAgent(g.agentId)} onSettings={() => openAgentSettings(g.agentId)}
                                  plan={planOf(g, agentNow, runCtx)} fixing={!!fixing[g.agentId]} chiefBusy={chiefRunning}
                                  onAutoFix={() => autoFix(g)} onAskChief={() => askChief(g)}
                                  onReport={(ask) => reportToKernl(g, ask)} reported={reportedRuns.has(g.reports[0].runId ?? '')}
                                  onOpenKernl={() => myOfficeTab = 'kernl'} />
              </div>
            {/each}
          </div>
        {/if}

        {#if activityReports.length > 0}
          <div class="or-section">
            <span class="or-section-title">{$t('office.chief.latest_activity')}</span>
            <button class="or-section-more" on:click={() => myOfficeTab = 'activity'}>{$t('office.chief.see_all')} →</button>
          </div>
          <div class="office-reports-list">
            {#each activityReports.slice(0, 3) as report (reportKey(report))}
              <button class="or-card" class:or-handoff={report.status === 'handoff'} on:click={() => openReport = report}>
                <div class="or-card-header">
                  <span class="or-dot" style="background:{report.color}"></span>
                  <span class="or-status" class:status-ok={report.status === 'completed'} class:status-handoff={report.status === 'handoff'}>
                    {report.status === 'completed' ? '✓' : '→'}
                  </span>
                  <span class="or-name" style="color:{report.color}">{report.agentName}</span>
                  <span class="or-time">{fmtRelTime(new Date(report.ts).toISOString())}</span>
                </div>
                <div class="or-card-body">{plainPreview(report.text, 140)}</div>
              </button>
            {/each}
          </div>
        {/if}

      {:else if myOfficeTab === 'questions'}
        <!-- ═══ QUESTIONS ═══ -->
        {#if loading && pendingQuestions.length === 0}
          <div class="mo-skel" role="status" aria-live="polite" aria-label={$t('office.chief.loading')}>
            <div class="mo-skel-h"><span class="mo-spin" aria-hidden="true"></span>{$t('office.chief.loading')}</div>
            {#each [0, 1, 2] as n (n)}
              <div class="mo-skel-card" style="animation-delay:{n * 120}ms">
                <span class="mo-skel-line mo-skel-w30"></span>
                <span class="mo-skel-line mo-skel-w90"></span>
                <span class="mo-skel-line mo-skel-w60"></span>
              </div>
            {/each}
          </div>
        {:else if pendingQuestions.length === 0}
          <div class="or-empty">{$t('office.chief.no_questions')}</div>
          {#if triageCount > 0}
            <div class="or-section-hint mo-center">{$t('office.chief.status_triage', { n: String(triageCount) })}</div>
          {/if}
        {:else}
          <div class="or-section">
            <span class="or-section-title or-section-q">{$t('office.chief.needs_answer', { n: String(pendingQuestions.length) })}</span>
            <button class="mo-bulk-btn mo-bulk-dismiss" on:click={() => dismissAllQuestions()} disabled={bulkBusy}>
              {bulkBusy ? '…' : $t('office.chief.dismiss_all', { n: String(pendingQuestions.length) })}
            </button>
          </div>
          <div class="bq-list">
            {#each pendingQuestions as q (q.id)}
              <OfficeQuestionCard {q} agentName={agentNameOf(q.from_agent_id)} color={flowColor(q.from_agent_id)}
                                  busy={!!questionSubmitting[q.id]}
                                  onAnswer={answerQuestion} onDismiss={dismissQuestion} onFree={answerFree} />
            {/each}
          </div>
        {/if}
        {#if chiefAnswered.length > 0}
          <details class="bq-chief-history">
            <summary>{$t('office.chief.resolved_by_chief', { n: String(chiefAnswered.length) })}</summary>
            {#each chiefAnswered as q (q.id)}
              <div class="bq-chief-row">
                <span class="bq-from-dot" style="background:{flowColor(q.from_agent_id)}"></span>
                <span class="bq-from">{agentNameOf(q.from_agent_id)}</span>
                <span class="bq-chief-q">{q.question}</span>
                <span class="bq-chief-a">→ {q.selected_option}</span>
              </div>
            {/each}
          </details>
        {/if}

      {:else if myOfficeTab === 'errors'}
        <!-- ═══ ERRORS, grouped ═══ -->
        {#if loading && errorGroups.length === 0}
          <div class="mo-skel" role="status" aria-live="polite" aria-label={$t('office.chief.loading')}>
            <div class="mo-skel-h"><span class="mo-spin" aria-hidden="true"></span>{$t('office.chief.loading')}</div>
            {#each [0, 1, 2] as n (n)}
              <div class="mo-skel-card" style="animation-delay:{n * 120}ms">
                <span class="mo-skel-line mo-skel-w30"></span>
                <span class="mo-skel-line mo-skel-w90"></span>
                <span class="mo-skel-line mo-skel-w60"></span>
              </div>
            {/each}
          </div>
        {:else if errorGroups.length === 0}
          <div class="or-empty">{$t('office.chief.no_errors')}</div>
        {:else}
          <div class="or-section">
            <span class="or-section-title or-section-fail">
              {$t('office.chief.errors_summary', { groups: String(errorGroups.length), n: String(errorReports.length) })}
            </span>
            <button class="mo-bulk-btn mo-bulk-clear" on:click={clearErrors}>{$t('office.chief.dismiss_all_errors')}</button>
          </div>
          <div class="office-reports-list">
            {#each errorGroups as g (g.key)}
              {@const audited = g.reports.filter(r => r.runId && auditedRunIds.has(r.runId)).length}
              <div out:slide|local={{ duration: 280, easing: quintOut }}>
                <FailureGroupCard {g} ctx={ctxOf(g, runCtx)} audited={g.reports.some(r => r.runId) ? audited : null}
                                  retrying={!!retrying[g.agentId]}
                                  onOpen={() => openReport = g.reports[0]} onDismiss={() => dismissGroup(g)}
                                  onRetry={() => retryAgent(g.agentId)} onSettings={() => openAgentSettings(g.agentId)}
                                  plan={planOf(g, agentNow, runCtx)} fixing={!!fixing[g.agentId]} chiefBusy={chiefRunning}
                                  onAutoFix={() => autoFix(g)} onAskChief={() => askChief(g)}
                                  onReport={(ask) => reportToKernl(g, ask)} reported={reportedRuns.has(g.reports[0].runId ?? '')}
                                  onOpenKernl={() => myOfficeTab = 'kernl'} />
              </div>
            {/each}
          </div>
        {/if}

      {:else if myOfficeTab === 'activity'}
        <!-- ═══ ACTIVITY, filterable, expandable in place ═══ -->
        {#if loading && activityReports.length === 0}
          <div class="mo-skel" role="status" aria-live="polite" aria-label={$t('office.chief.loading')}>
            <div class="mo-skel-h"><span class="mo-spin" aria-hidden="true"></span>{$t('office.chief.loading')}</div>
            {#each [0, 1, 2] as n (n)}
              <div class="mo-skel-card" style="animation-delay:{n * 120}ms">
                <span class="mo-skel-line mo-skel-w30"></span>
                <span class="mo-skel-line mo-skel-w90"></span>
                <span class="mo-skel-line mo-skel-w60"></span>
              </div>
            {/each}
          </div>
        {:else if activityReports.length === 0}
          <div class="or-empty">{$t('office.chief.no_activity')}</div>
        {:else}
          {@const byAgent = [...new Map(activityReports.map(r => [r.agentId, r])).values()]}
          <div class="mo-filters" role="group" aria-label={$t('office.chief.filter_aria')}>
            <button class="mo-filter" class:on={!activityAgent} on:click={() => activityAgent = null}>
              {$t('office.chief.filter_all')} <span>{activityReports.length}</span>
            </button>
            {#each byAgent as a (a.agentId)}
              <button class="mo-filter" class:on={activityAgent === a.agentId} style="--c:{a.color}"
                      on:click={() => activityAgent = activityAgent === a.agentId ? null : a.agentId}>
                <span class="mo-filter-dot"></span>{a.agentName}
                <span>{activityReports.filter(r => r.agentId === a.agentId).length}</span>
              </button>
            {/each}
          </div>
          <div class="office-reports-list">
            {#each activityReports.filter(r => !activityAgent || r.agentId === activityAgent) as report (reportKey(report))}
              {@const k = reportKey(report)}
              <div class="or-card mo-act" class:or-handoff={report.status === 'handoff'} class:mo-act-open={expandedKey === k}
                   out:slide|local={{ duration: 280, easing: quintOut }}>
                <button class="mo-act-head" type="button" aria-expanded={expandedKey === k}
                        on:click={() => expandedKey = expandedKey === k ? null : k}>
                  <div class="or-card-header">
                    <span class="or-dot" style="background:{report.color}"></span>
                    <span class="or-status" class:status-ok={report.status === 'completed'} class:status-handoff={report.status === 'handoff'}>
                      {report.status === 'completed' ? '✓' : '→'}
                    </span>
                    <span class="or-name" style="color:{report.color}">{report.agentName}</span>
                    <span class="or-time">{fmtRelTime(new Date(report.ts).toISOString())}</span>
                    <span class="mo-caret" aria-hidden="true">{expandedKey === k ? '▾' : '▸'}</span>
                  </div>
                  {#if expandedKey !== k}
                    <div class="or-card-body">{plainPreview(report.text, 160)}</div>
                  {/if}
                </button>
                {#if expandedKey === k}
                  <div class="mo-act-body ip-out-md" on:click={onOutputClick} role="presentation" transition:slide|local={{ duration: 200 }}>
                    {@html formatRunOutput(report.text)}
                  </div>
                  <div class="mo-group-actions">
                    <button class="mo-link" type="button" on:click={() => openReport = report}>{$t('office.chief.see_full_report')}</button>
                    <button class="mo-link mo-link-dim" type="button" on:click={() => dismissReport(report)}>{$t('office.chief.dismiss')}</button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else if myOfficeTab === 'kernl'}
        <KernlBugsTab bind:count={kernlCount} {onOutputClick} />
      {/if}
    </div>  <!-- /or-scroll -->

    <!-- Footer: the everyday action in sight, the destructive one behind ⋯. -->
    {#if myOfficeTab !== 'kernl' && (officeReports.length > 0 || pendingQuestions.length > 0)}
      <div class="or-footer">
        {#if myOfficeTab === 'activity' || myOfficeTab === 'overview'}
          {#if activityReports.length > 0}
            <button class="office-clear-btn office-clear-btn-soft" on:click={clearActivity}>{$t('office.chief.mark_activity_read')}</button>
          {/if}
        {:else if myOfficeTab === 'errors' && errorReports.length > 0}
          <button class="office-clear-btn office-clear-btn-soft" on:click={clearErrors}>{$t('office.chief.dismiss_all_errors')}</button>
        {/if}
        <div class="mo-more">
          <button class="office-clear-btn" type="button" aria-haspopup="menu" aria-expanded={moreOpen}
                  on:click|stopPropagation={() => moreOpen = !moreOpen} title={$t('office.chief.more')}>⋯</button>
          {#if moreOpen}
            <div class="mo-more-menu" role="menu">
              <button class="mo-more-item mo-more-danger" role="menuitem" on:click={() => { moreOpen = false; clearAllOfficeData(); }}>
                {$t('office.chief.clear_everything')}
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<svelte:window on:click={() => (moreOpen = false)} />

<!-- Report Detail Modal -->
{#if openReport}
  <div class="modal-overlay" on:click={() => openReport = null} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && (openReport = null)}>
    <div class="report-modal" on:click|stopPropagation role="presentation">
      <div class="rm-head">
        <div class="rm-head-left">
          <span class="rm-dot" style="background:{openReport.color}"></span>
          <span class="rm-status"
            class:status-ok={openReport.status === 'completed'}
            class:status-fail={openReport.status === 'failed'}
            class:status-handoff={openReport.status === 'handoff'}>
            {openReport.status === 'completed' ? $t('office.chief.st_completed') : openReport.status === 'failed' ? $t('office.chief.st_failed') : $t('office.chief.st_handoff')}
          </span>
          <span class="rm-name" style="color:{openReport.color}">{openReport.agentName}</span>
        </div>
        <div class="rm-head-right">
          <span class="rm-time">{new Date(openReport.ts).toLocaleString()}</span>
          <button class="rm-close" on:click={() => openReport = null} aria-label={$t('office.chief.close')}>×</button>
        </div>
      </div>
      <div class="rm-body ip-out-md" on:click={onOutputClick} role="presentation">
        {#if fullReportLoading && !fullReportText}
          <div style="color:#6a6f82;font:500 11px 'JetBrains Mono',monospace">{$t('office.chief.loading_report')}</div>
        {/if}
        {@html formatRunOutput(displayReportText)}
      </div>
      <div class="rm-actions">
        <!-- Desestimar: drops this report (and its repeats, for a failure)
             from the office without acting on it. -->
        <button class="rm-action rm-action-dismiss" on:click={() => openReport && dismissOpenReport(openReport)}>
          {openReportGroupSize > 1 ? $t('office.chief.dismiss_n', { n: String(openReportGroupSize) }) : $t('office.chief.dismiss')}
        </button>
        <span class="rm-spacer"></span>
        <button class="rm-action" on:click={() => openReport && copy(displayReportText, 'report-' + openReport.ts)}>
          {copiedKey === 'report-' + openReport?.ts ? '✓ ' + $t('office.chief.copied') : '⧉ ' + $t('office.chief.copy')}
        </button>
        {#if isLlmConfigError(displayReportText)}
          <a class="rm-action rm-action-fix" href={LLM_SETTINGS_HREF}>⚙ {$t('office.chief.configure_llm')} →</a>
        {/if}
        <button class="rm-action" on:click={() => {
          if (openReport) {
            selectAgent(openReport.agentId);
            showMyOfficePanel = false;
            openReport = null;
            focusAgent();
          }
        }}>
          {$t('office.chief.go_to_agent')} →
        </button>
        {#if activeFixer}
          <div class="rm-fixer-wrap">
            <button class="rm-action rm-fixer-primary" on:click={sendReportToFixer} disabled={sendingToFixer}
                    title={$t('office.chief.send_to_title', { name: activeFixer.name })}>
              {sendingToFixer ? '⏳ …' : `🛠 ${$t('office.chief.send_to', { name: activeFixer.name })}`}
            </button>
            {#if fixerCandidates.length > 1}
              <button class="rm-fixer-dropdown" on:click|stopPropagation={() => fixerPickerOpen = !fixerPickerOpen}
                      disabled={sendingToFixer} title={$t('office.chief.pick_fixer')} aria-haspopup="true" aria-expanded={fixerPickerOpen}>▾</button>
            {/if}
            {#if fixerPickerOpen}
              <div class="rm-fixer-menu" role="menu" on:click|stopPropagation>
                {#each fixerCandidates as cand}
                  <button class="rm-fixer-menu-item" class:rm-fixer-menu-active={cand.id === activeFixer.id}
                          on:click={() => { selectedFixerId = cand.id; fixerPickerOpen = false; }}>
                    <span class="rm-fixer-menu-name">{cand.name}</span>
                    <span class="rm-fixer-menu-hint">{cand.hint}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        {#if fixerStatus}
          <span class="rm-fixer-status">{fixerStatus}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* ═══════════════════════════════════════════════════════════════
     INFO PANEL — editorial/technical console, refined & data-dense
     ═══════════════════════════════════════════════════════════════ */
  .info-panel{
    /* Flush with the 3D's top, right and bottom edges: a gutter there only
       took width from the world. The container's rounded corners clip it. */
    position:absolute;top:0;right:0;bottom:0;
    width:min(720px, 55vw); min-width:560px;
    overflow:hidden;
    background:linear-gradient(180deg, rgba(16,18,28,.96) 0%, rgba(11,13,20,.97) 100%);
    backdrop-filter:blur(16px) saturate(1.1);
    border-left:1px solid rgba(120,130,160,.15);
    box-shadow:-20px 0 60px -20px rgba(0,0,0,.6);
    z-index:10;
    animation:slide .25s cubic-bezier(.2,.9,.25,1);
    display:flex;flex-direction:column;
    color:#d8dae3;
    --flow-color:#3dd6c8;
  }
  .info-panel::before{
    content:'';position:absolute;top:0;left:0;bottom:0;width:2px;
    background:linear-gradient(180deg, var(--flow-color) 0%, transparent 70%);
    opacity:.75;pointer-events:none;
  }
  @keyframes slide{from{transform:translateX(20px);opacity:0}}

  /* ── Header ───────────────────── */
  .ip-head{
    display:flex;justify-content:space-between;align-items:flex-start;gap:12px;
    padding:18px 18px 12px;
    border-bottom:1px solid rgba(120,130,160,.08);
    flex-shrink:0;
  }  .ip-glyph{
    width:32px;height:32px;border-radius:8px;
    display:grid;place-items:center;
    font:500 15px 'JetBrains Mono',monospace;
    color:var(--flow-color);
    background:color-mix(in srgb, var(--flow-color) 8%, transparent);
    border:1px solid color-mix(in srgb, var(--flow-color) 30%, transparent);
    flex-shrink:0;
  }
  /* One rhythm for the whole header. The name, the identity row and the tag
     row used ad-hoc 4px/5px margins, so nothing lined up with anything. */
  .ip-head-txt{min-width:0;flex:1;display:flex;flex-direction:column;gap:7px}
  .ip-name{
    font:600 17px/1.1 'Syne',sans-serif;
    color:#f0f2f7;
    letter-spacing:-.01em;
    word-break:break-word;
    display:inline-flex;align-items:center;gap:8px;
  }
  /* Wraps instead of overflowing: a long flow name plus an id used to push the
     row past the panel edge. */
  .ip-close{
    background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.12);
    color:#8a8fa8;
    width:28px;height:28px;
    border-radius:8px;
    font:400 18px/1 'Syne',sans-serif;
    cursor:pointer;transition:all .15s;
    display:grid;place-items:center;
    flex-shrink:0;
  }
  .ip-close:hover{background:rgba(239,93,110,.12);border-color:rgba(239,93,110,.3);color:#ef5d6e}

  /* ── Tabs ─────────────────────── */
  .ip-tabs{
    display:flex;gap:2px;
    padding:0 18px;
    border-bottom:1px solid rgba(120,130,160,.08);
    flex-shrink:0;
  }
  .ip-tab{
    position:relative;
    padding:12px 16px;
    font:600 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;
    background:none;border:none;
    color:#6a6f82;cursor:pointer;transition:color .15s;
    display:inline-flex;align-items:center;gap:6px;
  }
  .ip-tab:hover{color:#b0b5c8}
  .ip-tab.active{color:#f0f2f7}
  .ip-tab.active::after{
    content:'';position:absolute;bottom:-1px;left:12px;right:12px;height:2px;
    background:var(--flow-color);border-radius:2px 2px 0 0;
  }

  /* ── "Configure LLM" chip ──
     A run that dies with no provider configured is not a report, it is a task.
     The kernel already names the screen in prose ("Settings → AI"); this is
     that sentence as something you can click, wherever the failure surfaces:
     the chat error banner, the failed reply, and the office error card. */
    /* Under a card rather than beside a message: own line, indented to the card. */

  /* ── Modal ──────────────────── */
  .modal-overlay{position:fixed;inset:0;z-index:var(--z-modal);background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}

  /* ── Markdown output (run.result / step.content) ── */
  .ip-out-md{
    font:400 12.5px/1.6 'Manrope',sans-serif;color:#d0d4e0;
    padding:14px 18px;border-radius:6px;background:rgba(0,0,0,.22);
    word-break:break-word;overflow-wrap:anywhere;max-height:380px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }

  /* ── My Office reports panel ── */
  .office-reports-panel{
    border-color:rgba(201,168,76,.35);
    background:linear-gradient(180deg, rgba(201,168,76,.06) 0%, #0d1020 40%);
  }
  .or-empty{padding:24px 16px;text-align:center;color:#6a6f82;font:500 12px 'Manrope',sans-serif}
  /* Single scrollable body for the My Office panel — wraps the pending
   * question cards AND the report list so they share one scrollbar instead
   * of each fighting for height inside the flex column. */
  .or-scroll{
    flex:1;min-height:0;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(201,168,76,.25) transparent;
  }
  .office-reports-list{
    padding:8px 10px;
    display:flex;flex-direction:column;gap:6px;
  }

  /* ── My Office tabs ────────────────────────────── */
  .mo-tabs{
    padding:0 14px;
    border-bottom:1px solid rgba(120,130,160,.1);
    flex-shrink:0;
  }
  .mo-tab-badge{
    display:inline-flex;align-items:center;justify-content:center;
    min-width:18px;height:16px;padding:0 5px;margin-left:6px;
    border-radius:8px;
    font:700 9px 'JetBrains Mono',monospace;
    background:rgba(120,130,160,.18);color:#cbd0e8;
  }
  .mo-tab-badge-q{background:rgba(240,184,116,.22);color:#f0b874}
  .mo-tab-badge-err{background:rgba(239,93,110,.22);color:#ef5d6e}

  /* ── My Office overview (KPIs + previews) ──────── */

  /* Compact overview question preview — clickable card hint */
  .or-section-more{
    margin-left:auto;background:none;border:none;cursor:pointer;
    font:600 10px 'JetBrains Mono',monospace;color:#7a9aff;padding:2px 4px;
  }
  .or-section-more:hover{color:#a0b7ff;text-decoration:underline}

  /* ── Bulk action buttons (tab toolbars) ────────── */
  .mo-bulk-btn{
    margin-left:auto;
    padding:3px 10px;border-radius:6px;cursor:pointer;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    border:1px solid transparent;transition:all .12s;
  }
  .mo-bulk-btn:disabled{opacity:.5;cursor:wait}
  .mo-bulk-dismiss{
    background:rgba(240,184,116,.08);border-color:rgba(240,184,116,.3);color:#f0b874;
  }
  .mo-bulk-dismiss:hover:not(:disabled){background:rgba(240,184,116,.18);border-color:rgba(240,184,116,.5)}
  .mo-bulk-clear{
    background:rgba(239,93,110,.08);border-color:rgba(239,93,110,.3);color:#ef5d6e;
  }
  .mo-bulk-clear:hover:not(:disabled){background:rgba(239,93,110,.18);border-color:rgba(239,93,110,.5)}

  /* Footer bulk action variants */
  .office-clear-btn-soft{
    background:rgba(120,130,160,.08);border-color:rgba(120,130,160,.3);color:#8a8fa8;
  }
  .office-clear-btn-soft:hover{background:rgba(120,130,160,.16);border-color:rgba(120,130,160,.5);color:#cbd0e8}  .or-card{
    display:flex;flex-direction:column;gap:4px;width:100%;
    padding:10px 12px;border:none;border-radius:8px;
    background:rgba(120,130,160,.04);color:#c0c5d8;cursor:pointer;
    text-align:left;transition:background .12s;
    border-left:3px solid transparent;
  }
  .or-card:hover{background:rgba(201,168,76,.08)}  .or-card.or-handoff{border-left-color:rgba(61,214,200,.4);background:rgba(61,214,200,.03)}
  .or-section{
    display:flex;align-items:baseline;gap:8px;
    padding:10px 14px 2px;margin-top:4px;
  }
  .or-section:first-child{margin-top:0}
  .or-section-title{
    font:700 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;
    color:#8a8fa8;
  }
  .or-section-title.or-section-fail{color:#ef5d6e}
  .or-section-title.or-section-q{color:#f0b874}
  .or-section-hint{font:500 9px 'JetBrains Mono',monospace;color:#5a5f7a}

  /* ── Top-agent question cards ─────────────────────── */
  .bq-list{ display:flex; flex-direction:column; gap:10px; padding:0 14px 12px; }  .bq-from-dot{ width:7px; height:7px; border-radius:50%; }
  .bq-from{ color:#e7e9f4; }  /* Options that open a URL — make them visually distinct (subtle teal tint
     + arrow chevron). */
  .bq-chief-history{ margin:12px 14px; font:500 11px 'Manrope',sans-serif; color:#9aa0bd; }
  .bq-chief-history summary{ cursor:pointer; padding:4px 0; }
  .bq-chief-row{ display:flex; align-items:baseline; gap:6px; padding:4px 0; border-top:1px solid #1e2236; }
  .bq-chief-q{ flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bq-chief-a{ color:#8fd6a8; white-space:nowrap; }
  /* Direct link chip — surfaces the URL from `context` above the options
     so the user can preview the link without having to commit to an answer. */
    .or-card-header{
    display:flex;align-items:center;gap:6px;
  }
  .or-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .or-status{
    font:700 9px 'JetBrains Mono',monospace;
    width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;
    border-radius:4px;flex-shrink:0;
  }
  .status-ok{background:rgba(120,220,140,.15);color:#78dc8c}
  .status-fail{background:rgba(239,93,110,.15);color:#ef5d6e}
  .status-handoff{background:rgba(61,214,200,.15);color:#3dd6c8}
  .or-name{font:600 11px 'Manrope',sans-serif;flex-shrink:0;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .or-time{margin-left:auto;flex-shrink:0;font:500 9px 'JetBrains Mono',monospace;color:#4a4f6a}
  .or-card-body{
    font:400 11px/1.4 'Manrope',sans-serif;color:#8a8fa8;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
    overflow:hidden;word-break:break-word;padding-left:29px;
  }  .or-footer{
    padding:8px 12px;border-top:1px solid rgba(120,130,160,.1);
    display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;
  }
  .office-clear-btn{
    padding:5px 12px;border-radius:6px;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(120,130,160,.06);border:1px solid rgba(120,130,160,.18);
    color:#8a8fa8;cursor:pointer;transition:all .12s;
  }
  .office-clear-btn:hover{background:rgba(120,130,160,.16);color:#fff}

  /* ── Report detail modal ── */
  .report-modal{
    width:min(700px, 90vw);max-height:85vh;
    background:#0d1020;border:1px solid rgba(201,168,76,.35);border-radius:14px;
    display:flex;flex-direction:column;overflow:hidden;
    box-shadow:0 20px 60px rgba(0,0,0,.7), 0 0 40px rgba(201,168,76,.08);
  }
  .rm-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:16px 20px;border-bottom:1px solid rgba(120,130,160,.12);
    gap:12px;flex-wrap:wrap;
  }
  .rm-head-left{display:flex;align-items:center;gap:10px}
  .rm-head-right{display:flex;align-items:center;gap:12px}
  .rm-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .rm-status{
    font:700 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;
    padding:3px 10px;border-radius:5px;
  }
  .rm-status.status-ok{background:rgba(120,220,140,.15);color:#78dc8c;border:1px solid rgba(120,220,140,.35)}
  .rm-status.status-fail{background:rgba(239,93,110,.15);color:#ef5d6e;border:1px solid rgba(239,93,110,.35)}
  .rm-status.status-handoff{background:rgba(61,214,200,.15);color:#3dd6c8;border:1px solid rgba(61,214,200,.35)}
  .rm-name{font:600 14px 'Manrope',sans-serif}
  .rm-time{font:500 10px 'JetBrains Mono',monospace;color:#6a6f82}
  .rm-close{
    background:transparent;border:none;color:#8a8fa8;font:400 22px/1 'Manrope',sans-serif;
    cursor:pointer;padding:0 4px;transition:color .12s;
  }
  .rm-close:hover{color:#fff}
  .rm-body{
    flex:1;min-height:0;overflow-y:auto;padding:20px 24px;
    scrollbar-width:thin;scrollbar-color:rgba(201,168,76,.2) transparent;
    word-break:break-word;white-space:pre-wrap;
    font:400 12px/1.6 'Manrope',sans-serif;color:#c0c5d8;
  }
  .rm-actions{
    display:flex;justify-content:flex-end;gap:8px;align-items:center;flex-wrap:wrap;
    padding:12px 20px;border-top:1px solid rgba(120,130,160,.12);
  }
  .rm-action{
    padding:7px 14px;border-radius:7px;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(120,130,160,.08);border:1px solid rgba(120,130,160,.22);
    color:#c0c5d8;cursor:pointer;transition:all .12s;
  }
  .rm-action:hover{background:rgba(120,130,160,.16);border-color:rgba(120,130,160,.4);color:#fff}
  /* Same row, same shape — but it is a link, and it is the one action that
     fixes the cause rather than routing the symptom somewhere. */
  .rm-action-fix{
    display:inline-flex;align-items:center;text-decoration:none;
    background:rgba(201,168,76,.10);border-color:rgba(201,168,76,.45);color:#d4a84b;
  }
  .rm-action-fix:hover{background:rgba(201,168,76,.20);border-color:#d4a84b;color:#f0d9a0}
  .rm-action:disabled{opacity:.5;cursor:not-allowed}

  /* Send-to-fixer split button + dropdown */
  .rm-fixer-wrap{position:relative;display:inline-flex;align-items:stretch}
  .rm-fixer-primary{
    border-color:#ffb84a55;background:rgba(255,184,74,.08);color:#ffb84a;
    border-top-right-radius:0;border-bottom-right-radius:0;
  }
  .rm-fixer-primary:hover{background:rgba(255,184,74,.18);border-color:#ffb84a;color:#ffd28a}
  .rm-fixer-primary:disabled{color:#7a6a3a}
  .rm-fixer-dropdown{
    padding:7px 9px;border-radius:7px;
    border-top-left-radius:0;border-bottom-left-radius:0;border-left:none;
    font:600 11px 'JetBrains Mono',monospace;line-height:1;
    background:rgba(255,184,74,.08);border:1px solid #ffb84a55;color:#ffb84a;cursor:pointer;
  }
  .rm-fixer-dropdown:hover{background:rgba(255,184,74,.18);color:#ffd28a}
  .rm-fixer-dropdown:disabled{opacity:.5;cursor:not-allowed}
  .rm-fixer-menu{
    position:absolute;right:0;bottom:calc(100% + 4px);z-index:var(--z-toast);
    min-width:240px;max-width:340px;
    background:rgba(8,6,2,.96);border:1px solid #ffb84a55;border-radius:8px;
    box-shadow:0 8px 28px rgba(0,0,0,.55),0 0 18px rgba(255,184,74,.15);
    overflow:hidden;
  }
  .rm-fixer-menu-item{
    display:flex;flex-direction:column;align-items:flex-start;gap:2px;
    width:100%;padding:8px 12px;border:none;background:transparent;cursor:pointer;
    border-bottom:1px solid rgba(255,184,74,.08);text-align:left;
    transition:background .1s;
  }
  .rm-fixer-menu-item:last-child{border-bottom:none}
  .rm-fixer-menu-item:hover{background:rgba(255,184,74,.1)}
  .rm-fixer-menu-active{background:rgba(255,184,74,.16)}
  .rm-fixer-menu-name{font:700 11px 'Syne',sans-serif;color:#ffb84a;letter-spacing:.5px}
  .rm-fixer-menu-hint{font:400 10px 'Manrope',sans-serif;color:#8a7a5a;letter-spacing:.2px}
  .rm-fixer-status{
    font:600 10px 'JetBrains Mono',monospace;color:#9aa5b8;
    margin-right:auto;padding-left:4px;
  }

  /* ═══ Chief's office — header, "needs you", groups, activity ═══ */
  .mo-head{align-items:center}
  .mo-glyph{color:#c9a84c;--flow-color:#c9a84c}
  .mo-status{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}
  .mo-chip{
    display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border-radius:999px;
    font:600 10.5px 'Manrope',sans-serif;color:#a0a5b8;
    background:rgba(120,130,160,.1);border:1px solid rgba(120,130,160,.22);
  }
  .mo-chip-run{color:#7cc4ff;background:rgba(124,196,255,.1);border-color:rgba(124,196,255,.32)}
  .mo-chip-q{color:#f0b874;background:rgba(240,184,116,.1);border-color:rgba(240,184,116,.3)}
  .mo-pulse{width:6px;height:6px;border-radius:50%;background:currentColor;animation:mo-pulse 1.4s ease-in-out infinite}
  @keyframes mo-pulse{50%{opacity:.35;transform:scale(.8)}}
  .mo-head-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}
  .mo-btn{
    height:32px;padding:0 12px;border-radius:8px;cursor:pointer;
    font:600 12px 'Manrope',sans-serif;color:#dde0ea;
    background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.22);
    transition:background .15s, border-color .15s;
  }
  .mo-btn:hover{background:rgba(255,255,255,.07);border-color:rgba(120,130,160,.4)}
  .mo-btn-primary{color:#0a0e14;background:#c9a84c;border-color:#c9a84c}
  .mo-btn-primary:hover{background:#d8b85a;border-color:#d8b85a}
  .mo-btn:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}
  .ip-close{width:32px;height:32px}

  .mo-allgood{
    display:flex;align-items:center;gap:12px;margin:14px;padding:14px 16px;border-radius:10px;
    background:rgba(120,220,140,.06);border:1px solid rgba(120,220,140,.22);
  }
  .mo-allgood-ico{
    width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;
    color:#0a0e14;background:#78dc8c;font:700 15px 'Manrope',sans-serif;
  }
  .mo-allgood-t{font:700 13px 'Manrope',sans-serif;color:#dfe2ec}
  .mo-allgood-s{font:500 11.5px 'Manrope',sans-serif;color:#8a8fa8}
  .mo-center{text-align:center;padding:0 16px 16px}  .mo-group-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:2px 12px 9px}
  .mo-link{
    background:none;border:none;padding:0;cursor:pointer;
    font:600 11px 'Manrope',sans-serif;color:#9fb4e8;
  }
  .mo-link:hover{color:#c4d3f7;text-decoration:underline;text-underline-offset:2px}
  .mo-link-dim{color:#8a8fa8}
  .mo-link-dim:hover{color:#dde0ea}

  .mo-filters{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px 4px}
  .mo-filter{
    display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;cursor:pointer;
    font:600 11px 'Manrope',sans-serif;color:#c4c8d6;
    background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.22);
  }
  .mo-filter span:last-child{font:600 10px 'JetBrains Mono',monospace;color:#7a7f92}
  .mo-filter-dot{width:7px;height:7px;border-radius:2px;background:var(--c, #8a8fa8)}
  .mo-filter.on{color:#0a0e14;background:#dde0ea;border-color:#dde0ea}
  .mo-filter.on span:last-child{color:#3a3f52}
  .mo-act{padding:0;display:block}
  .mo-act-head{display:block;width:100%;padding:9px 12px;background:none;border:none;cursor:pointer;text-align:left;color:inherit}
  .mo-caret{color:#6a6f82;font-size:10px;margin-left:4px}
  .mo-act-body{margin:0 12px 8px;max-height:420px}
  .mo-act-open{border-color:rgba(120,130,160,.35)}

  .mo-tab-badge{
    margin-left:6px;font:700 9px 'JetBrains Mono',monospace;padding:1px 6px;border-radius:999px;
    color:#a0a5b8;background:rgba(120,130,160,.16);
  }
  .mo-more{position:relative;margin-left:auto}
  .mo-more-menu{
    position:absolute;right:0;bottom:calc(100% + 6px);min-width:200px;padding:5px;border-radius:8px;z-index:5;
    background:#11131d;border:1px solid rgba(120,130,160,.28);box-shadow:0 14px 30px -10px rgba(0,0,0,.7);
  }
  .mo-more-item{
    display:block;width:100%;padding:7px 10px;border-radius:6px;border:none;background:none;cursor:pointer;text-align:left;
    font:600 12px 'Manrope',sans-serif;color:#dde0ea;
  }
  .mo-more-item:hover{background:rgba(255,255,255,.06)}
  .mo-more-danger{color:#ef5d6e}
  .mo-more-danger:hover{background:rgba(239,93,110,.12)}

  .rm-spacer{flex:1}
  .rm-action-dismiss{color:#c4c8d6}
  .rm-action-dismiss:hover{color:#ef5d6e;border-color:rgba(239,93,110,.45)}
  @media (prefers-reduced-motion: reduce){ .mo-pulse{animation:none} }

  /* ── Loading skeleton ── */
  .mo-skel{padding:12px 14px;display:flex;flex-direction:column;gap:8px}
  .mo-skel-h{display:flex;align-items:center;gap:8px;font:600 11px 'Manrope',sans-serif;color:#8a8fa8;margin-bottom:2px}
  .mo-spin{
    width:12px;height:12px;border-radius:50%;flex:none;
    border:2px solid rgba(201,168,76,.25);border-top-color:#c9a84c;
    animation:mo-spin .8s linear infinite;
  }
  @keyframes mo-spin{to{transform:rotate(360deg)}}
  .mo-skel-card{
    display:flex;flex-direction:column;gap:7px;padding:12px;border-radius:8px;
    background:rgba(255,255,255,.02);border:1px solid rgba(120,130,160,.12);
    animation:mo-skel-in .3s ease-out both;
  }
  @keyframes mo-skel-in{from{opacity:0;transform:translateY(4px)}}
  .mo-skel-line{
    height:9px;border-radius:4px;
    background:linear-gradient(90deg, rgba(120,130,160,.10) 0%, rgba(120,130,160,.24) 50%, rgba(120,130,160,.10) 100%);
    background-size:200% 100%;animation:mo-shimmer 1.3s ease-in-out infinite;
  }
  @keyframes mo-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
  .mo-skel-w30{width:30%}.mo-skel-w60{width:60%}.mo-skel-w90{width:90%}
  @media (prefers-reduced-motion: reduce){ .mo-spin, .mo-skel-line, .mo-skel-card{animation:none} }
</style>
