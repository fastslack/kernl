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
  import { sortByWaiting } from '$lib/office/question-age.js';
  import { quintOut } from 'svelte/easing';
  import { rpcOrCall } from '$lib/ws.js';
  import { isLlmConfigError, LLM_SETTINGS_HREF } from '$lib/llm-error.js';
  import { fmtRelTime } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import { extractChoices } from '$lib/chat-choices.js';
  import { pendingChatReply } from '$lib/chat-handoff.js';
  import { urlForOption, buildFixerGoal } from '$lib/agent-helpers.js';
  import { t } from '$lib/i18n/index.js';
  import { confirm as confirmDialog } from '$shared/feedback';
  import { groupReports, reportKey, plainPreview, type ReportGroup } from '$lib/office/report-groups.js';
  import OfficeQuestionCard from './OfficeQuestionCard.svelte';
  import QuestionAgeGroups from './QuestionAgeGroups.svelte';
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
  /** Questions the operator took on: chosen, the work still theirs. */
  export let owedQuestions: PendingQuestion[] = [];
  /** Bumped by every local answer/dismiss; the poll in AgentWorld3D drops a result that started before it changed. */
  export let questionsRev = 0;
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
  async function answerQuestion(q: PendingQuestion, idx: number, opt: { label: string; value?: string; url?: string }): Promise<boolean> {
    if (questionSubmitting[q.id]) return true;
    // Open the linked URL FIRST (synchronously, inside the user's click event)
    // — popup blockers reject window.open() when it's behind an async await.
    const target = urlForOption(q, opt);
    if (target) {
      window.open(target, '_blank', 'noopener,noreferrer');
    }
    return sendChoice(q, { kind: 'option', index: idx });
  }

  // One write path for every way of answering. The kernel says where the
  // question went: 'owed' (the chosen option leaves work to the operator) moves
  // it to "Te toca"; anything else closes it. 409 = already answered elsewhere,
  // so it leaves the list too. Resolves true when it left the list.
  async function sendChoice(q: PendingQuestion, choice: Record<string, unknown>): Promise<boolean> {
    questionSubmitting = { ...questionSubmitting, [q.id]: true };
    questionsRev++;
    try {
      const res = await fetch(`/api/agents/questions/${q.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kernl-Via': 'dashboard' },
        body: JSON.stringify({ choice }),
      });
      if (!res.ok && res.status !== 409) return false;
      const body = await res.json().catch(() => null);
      pendingQuestions = pendingQuestions.filter(x => x.id !== q.id);
      owedQuestions = owedQuestions.filter(x => x.id !== q.id);
      if (res.ok && body?.status === 'owed') {
        const chosen = choice.kind === 'task'
          ? $t('office.chief.take_it')
          : q.options[Number(choice.index)]?.label ?? '';
        owedQuestions = [{ ...q, status: 'owed', owed_at: new Date().toISOString(), selected_option: chosen }, ...owedQuestions];
      }
      return true;
    } catch {
      return false;
    } finally {
      questionsRev++;
      questionSubmitting = { ...questionSubmitting, [q.id]: false };
    }
  }
  const takeIt = (q: PendingQuestion) => sendChoice(q, { kind: 'task' });
  /** The opinion's "also settles": each checked question with its own choice, one after the other. */
  async function sendAlso(items: Array<{ q: PendingQuestion; choice: Record<string, unknown> }>) {
    for (const it of items) await sendChoice(it.q, it.choice);
  }
  $: openQuestions = [...owedQuestions, ...pendingQuestions];

  /** The overview strip shows the two newest, not the two the kernel listed first. */
  $: pendingNewest = sortByWaiting(pendingQuestions);
  const markDone = (q: PendingQuestion, note: string) =>
    sendChoice(q, { kind: 'done', ...(note.trim() ? { note: note.trim() } : {}) });
  async function dismissQuestion(q: PendingQuestion) {
    if (questionSubmitting[q.id]) return;
    questionSubmitting = { ...questionSubmitting, [q.id]: true };
    questionsRev++;
    try {
      const res = await fetch(`/api/agents/questions/${q.id}/dismiss`, { method: 'POST', headers: { 'X-Kernl-Via': 'dashboard' } });
      // Gone for good (done, or already closed elsewhere): drop it. Anything else keeps the card.
      if (res.ok || res.status === 404 || res.status === 409) {
        pendingQuestions = pendingQuestions.filter(x => x.id !== q.id);
        owedQuestions = owedQuestions.filter(x => x.id !== q.id);
      }
    } catch { /* network: the card stays */ }
    finally {
      questionsRev++;
      questionSubmitting = { ...questionSubmitting, [q.id]: false };
    }
  }

  // Free-text answers — for when none of the chief's options fit.
  // Resolves true when it landed, so the card can clear its input.
  async function answerFree(q: PendingQuestion, text: string): Promise<boolean> {
    if (!text || questionSubmitting[q.id]) return false;
    return sendChoice(q, { kind: 'free', text });
  }

  // Bulk actions for the My Office panel.
  let bulkBusy = false;
  async function dismissAllQuestions(ask = true) {
    if (bulkBusy || pendingQuestions.length === 0) return;
    if (ask && !(await confirmDialog({ title: $t('office.chief.confirm_dismiss_questions', { n: String(pendingQuestions.length) }), danger: true }))) return;
    bulkBusy = true;
    const snapshot = [...pendingQuestions];
    questionsRev++;
    try {
      // Fire all dismissals in parallel — server-side they're independent.
      await Promise.all(snapshot.map(q =>
        fetch(`/api/agents/questions/${q.id}/dismiss`, { method: 'POST', headers: { 'X-Kernl-Via': 'dashboard' } }).catch(() => null)
      ));
      pendingQuestions = [];
    } finally {
      questionsRev++;
      bulkBusy = false;
    }
  }
  function clearErrors() {
    removeReports(officeReports.filter(r => r.status === 'failed'));
  }
  function clearActivity() {
    removeReports(officeReports.filter(r => r.status !== 'failed'));
  }
  async function clearAllOfficeData() {
    if (!(await confirmDialog({ title: $t('office.chief.confirm_clear_everything'), danger: true }))) return;
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
  // A reply that ends in a ```choices block asks the operator to pick: the pop-up
  // shows the buttons instead of the raw JSON, and a pick goes to the agent's chat.
  $: reportParts = extractChoices(displayReportText);
  function answerReportChoice(option: string) {
    if (!openReport) return;
    pendingChatReply.set({ agentId: openReport.agentId, text: option });
    selectAgent(openReport.agentId);
    showMyOfficePanel = false;
    openReport = null;
  }
</script>

<!-- The chief's office -->
{#if showMyOfficePanel}
  {@const errorReports = officeReports.filter(r => r.status === 'failed')}
  {@const activityReports = officeReports.filter(r => r.status !== 'failed')}
  {@const errorGroups = groupReports(errorReports)}
  {@const chief = topAgent()}
  {@const needsYou = pendingQuestions.length + owedQuestions.length + errorGroups.length}
  <div class="info-panel office-reports-panel">
    <!-- Header: whose office, what the chief is doing, and the two ways to
         reach the chief itself. Echoes the directory's gold ◆ Dirección button. -->
    <div class="mo-head">
      <div class="ol-mhead">
        <span class="ol-mark lg mo-mark" aria-hidden="true">◆</span>
        <div class="ol-ttl">
          <p class="ol-eyebrow">{$t('office.rail.headquarters')}</p>
          <h2 class="ol-title">{$t('office.chief.title')}</h2>
          <div class="mo-status">
            {#if chiefRunning}
              <span class="ol-chip soft mo-chip-run" style="--c:#7cc4ff"><i aria-hidden="true"></i>{$t('office.chief.status_running', { name: chief?.name ?? 'Chief' })}</span>
            {:else}
              <span class="ol-chip soft" style="--c:#94A3B8"><i aria-hidden="true"></i>{$t('office.chief.status_idle', { name: chief?.name ?? 'Chief' })}</span>
            {/if}
            {#if triageCount > 0}
              <span class="ol-chip soft" style="--c:#f0b874"><i aria-hidden="true"></i>{$t('office.chief.status_triage', { n: String(triageCount) })}</span>
            {/if}
          </div>
        </div>
        <div class="mo-head-actions">
          {#if chief}
            <button class="ol-btn ghost mo-sm" type="button" on:click={openChiefChat} title={$t('office.chief.talk_title')}>
              {$t('office.chief.talk')}
            </button>
            <button class="ol-btn mo-sm" type="button" title={$t('office.chief.open_agent_title')}
                    on:click={() => { selectAgent(chief.id); showMyOfficePanel = false; }}>
              {$t('office.chief.open_agent')} →
            </button>
          {/if}
          <button class="ol-btn ghost mo-sm mo-x" on:click={() => showMyOfficePanel = false} aria-label={$t('office.chief.close')}>×</button>
        </div>
      </div>

      <!-- The counts, as filters: each one opens the tab that lists it. -->
      <div class="ol-kpis mo-kpis">
        <button class="ol-kpi" class:on={myOfficeTab === 'questions'} class:alert={pendingQuestions.length > 0}
                style="--c: {pendingQuestions.length ? '#FBBF24' : '#34D399'}" aria-pressed={myOfficeTab === 'questions'}
                on:click={() => myOfficeTab = 'questions'}
                title={$t('office.chief.waiting_you', { n: String(pendingQuestions.length + owedQuestions.length) })}>
          <b>{pendingQuestions.length}</b><small>{$t('office.chief.tab_questions')}</small>
        </button>
        <button class="ol-kpi" class:on={myOfficeTab === 'questions' && owedQuestions.length > 0}
                style="--c: #F472B6" aria-pressed={myOfficeTab === 'questions' && owedQuestions.length > 0}
                on:click={() => myOfficeTab = 'questions'} title={$t('office.q_age.owed_hint')}>
          <b>{owedQuestions.length}</b><small>{$t('office.q_age.owed_badge')}</small>
        </button>
        <button class="ol-kpi" class:on={myOfficeTab === 'errors'}
                style="--c: {errorGroups.length ? '#FB7185' : '#94A3B8'}" aria-pressed={myOfficeTab === 'errors'}
                on:click={() => myOfficeTab = 'errors'}>
          <b>{errorGroups.length}</b><small>{$t('office.chief.tab_errors')}</small>
        </button>
        <button class="ol-kpi" class:on={myOfficeTab === 'activity'} class:live={chiefRunning}
                style="--c: #22D3EE" aria-pressed={myOfficeTab === 'activity'}
                on:click={() => myOfficeTab = 'activity'}>
          <b>{activityReports.length}</b><small>{$t('office.chief.tab_activity')}</small>
        </button>
      </div>

      <div class="ol-seg mo-tabs" role="tablist">
        <button role="tab" aria-selected={myOfficeTab === 'overview'} class:on={myOfficeTab === 'overview'}
                on:click={() => myOfficeTab = 'overview'}>
          {$t('office.chief.tab_now')}
          {#if needsYou > 0}<em class="mo-em-q">{needsYou}</em>{/if}
        </button>
        <button role="tab" aria-selected={myOfficeTab === 'questions'} class:on={myOfficeTab === 'questions'}
                on:click={() => myOfficeTab = 'questions'}>
          {$t('office.chief.tab_questions')}
          {#if pendingQuestions.length + owedQuestions.length > 0}<em class="mo-em-q" title={$t('office.chief.waiting_you', { n: String(pendingQuestions.length + owedQuestions.length) })}>{pendingQuestions.length + owedQuestions.length}</em>{/if}
        </button>
        <button role="tab" aria-selected={myOfficeTab === 'errors'} class:on={myOfficeTab === 'errors'} style="--c:#FB7185"
                on:click={() => myOfficeTab = 'errors'}>
          {$t('office.chief.tab_errors')}
          {#if errorGroups.length > 0}<em class="mo-em-err">{errorGroups.length}</em>{/if}
        </button>
        <button role="tab" aria-selected={myOfficeTab === 'activity'} class:on={myOfficeTab === 'activity'} style="--c:#22D3EE"
                on:click={() => myOfficeTab = 'activity'}>
          {$t('office.chief.tab_activity')}
          {#if activityReports.length > 0}<em>{activityReports.length}</em>{/if}
        </button>
        <button role="tab" aria-selected={myOfficeTab === 'kernl'} class:on={myOfficeTab === 'kernl'} style="--c:#A78BFA"
                on:click={() => myOfficeTab = 'kernl'} title={$t('office.kernl.tab_title')}>
          {$t('office.kernl.tab')}
          {#if kernlCount > 0}<em class="mo-em-q">{kernlCount}</em>{/if}
        </button>
      </div>
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
          <div class="ol-card mo-allgood" style="--oc:#34D399">
            <span class="mo-allgood-ico" aria-hidden="true">✓</span>
            <div>
              <div class="mo-allgood-t">{$t('office.chief.all_good')}</div>
              <div class="mo-allgood-s">{$t('office.chief.all_good_sub')}</div>
            </div>
          </div>
        {/if}

        {#if owedQuestions.length > 0}
          <div class="ol-h mo-sec mo-sec-q">
            <span class="mo-sec-t">{$t('office.chief.owed_title', { n: String(owedQuestions.length) })}</span>
          </div>
          <div class="bq-list">
            {#each owedQuestions as q (q.id)}
              <OfficeQuestionCard {q} agentName={agentNameOf(q.from_agent_id)} color={flowColor(q.from_agent_id)}
                                  busy={!!questionSubmitting[q.id]}
                                  onAnswer={answerQuestion} onDismiss={dismissQuestion} onFree={answerFree}
                                  onTake={takeIt} onDone={markDone}
                                  others={openQuestions} nameOf={agentNameOf} onAlso={sendAlso} />
            {/each}
          </div>
        {/if}

        {#if pendingQuestions.length > 0}
          <div class="ol-h mo-sec mo-sec-q">
            <span class="mo-sec-t">{$t('office.chief.needs_answer', { n: String(pendingQuestions.length) })}</span>
            {#if pendingQuestions.length > 2}
              <button class="ol-clear mo-more-link" on:click={() => myOfficeTab = 'questions'}>{$t('office.chief.see_all')} →</button>
            {/if}
          </div>
          <div class="bq-list">
            {#each pendingNewest.slice(0, 2) as q (q.id)}
              <OfficeQuestionCard {q} agentName={agentNameOf(q.from_agent_id)} color={flowColor(q.from_agent_id)}
                                  busy={!!questionSubmitting[q.id]}
                                  onAnswer={answerQuestion} onDismiss={dismissQuestion} onFree={answerFree}
                                  onTake={takeIt} onDone={markDone}
                                  others={openQuestions} nameOf={agentNameOf} onAlso={sendAlso} />
            {/each}
          </div>
        {/if}

        {#if errorGroups.length > 0}
          <div class="ol-h mo-sec mo-sec-fail">
            <span class="mo-sec-t">{$t('office.chief.needs_fix', { n: String(errorGroups.length) })}</span>
            {#if errorGroups.length > 3}
              <button class="ol-clear mo-more-link" on:click={() => myOfficeTab = 'errors'}>{$t('office.chief.see_all')} →</button>
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
          <div class="ol-h mo-sec">
            <span class="mo-sec-t">{$t('office.chief.latest_activity')}</span>
            <button class="ol-clear mo-more-link" on:click={() => myOfficeTab = 'activity'}>{$t('office.chief.see_all')} →</button>
          </div>
          <ul class="ol-list mo-list">
            {#each activityReports.slice(0, 3) as report (reportKey(report))}
              <li>
                <button class="ol-row mo-row" style:--oc={report.color} on:click={() => openReport = report}>
                  <span class="ol-mark" aria-hidden="true">{report.agentName.slice(0, 2).toUpperCase()}</span>
                  <span class="ol-row-txt">
                    <b>{report.agentName}</b>
                    <small>{plainPreview(report.text, 140)}</small>
                  </span>
                  <span class="or-status" class:status-ok={report.status === 'completed'} class:status-handoff={report.status === 'handoff'}>
                    {report.status === 'completed' ? '✓' : '→'}
                  </span>
                  <span class="or-time">{fmtRelTime(new Date(report.ts).toISOString())}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}

      {:else if myOfficeTab === 'questions'}
        <!-- ═══ QUESTIONS, newest first, grouped by how long they have waited ═══ -->
        {#if loading && openQuestions.length === 0}
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
        {:else if openQuestions.length === 0}
          <div class="ol-empty">{$t('office.chief.no_questions')}</div>
          {#if triageCount > 0}
            <div class="mo-hint mo-center">{$t('office.chief.status_triage', { n: String(triageCount) })}</div>
          {/if}
        {:else}
          <div class="ol-h mo-sec mo-sec-q">
            <span class="mo-sec-t">{$t('office.chief.needs_answer', { n: String(openQuestions.length) })}</span>
            {#if owedQuestions.length > 0}
              <span class="ol-chip mo-owed-chip" style="--c:#F472B6" title={$t('office.q_age.owed_hint')}><i aria-hidden="true"></i>{$t('office.chief.owed_title', { n: String(owedQuestions.length) })}</span>
            {/if}
            {#if pendingQuestions.length > 0}
              <button class="ol-btn ghost mo-sm mo-bulk" on:click={() => dismissAllQuestions()} disabled={bulkBusy}>
                {bulkBusy ? '…' : $t('office.chief.dismiss_all', { n: String(pendingQuestions.length) })}
              </button>
            {/if}
          </div>
          {#if triageCount > 0}
            <div class="mo-hint mo-age-triage">{$t('office.chief.status_triage', { n: String(triageCount) })}</div>
          {/if}
          <div class="mo-age-groups">
            <QuestionAgeGroups questions={openQuestions} open={openQuestions} nameOf={agentNameOf} colorOf={flowColor}
                               busy={questionSubmitting} send={sendChoice}
                               onAnswer={answerQuestion} onDismiss={dismissQuestion} onFree={answerFree}
                               onTake={takeIt} onDone={markDone} />
          </div>
        {/if}
        {#if chiefAnswered.length > 0}
          <details class="bq-chief-history">
            <summary class="ol-h">{$t('office.chief.resolved_by_chief', { n: String(chiefAnswered.length) })}</summary>
            <div class="ol-list">
            {#each chiefAnswered as q (q.id)}
              <div class="ol-row bq-chief-row" style:--oc={flowColor(q.from_agent_id)}>
                <span class="ol-mark" aria-hidden="true">{agentNameOf(q.from_agent_id).slice(0, 2).toUpperCase()}</span>
                <span class="ol-row-txt">
                  <b>{agentNameOf(q.from_agent_id)}</b>
                  <small class="bq-chief-q">{q.question}</small>
                </span>
                <span class="bq-chief-a">→ {q.selected_option}</span>
              </div>
            {/each}
            </div>
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
          <div class="ol-empty">{$t('office.chief.no_errors')}</div>
        {:else}
          <div class="ol-h mo-sec mo-sec-fail">
            <span class="mo-sec-t">
              {$t('office.chief.errors_summary', { groups: String(errorGroups.length), n: String(errorReports.length) })}
            </span>
            <button class="ol-btn danger mo-sm mo-bulk" on:click={clearErrors}>{$t('office.chief.dismiss_all_errors')}</button>
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
          <div class="ol-empty">{$t('office.chief.no_activity')}</div>
        {:else}
          {@const byAgent = [...new Map(activityReports.map(r => [r.agentId, r])).values()]}
          <div class="ol-seg mo-filters" role="group" aria-label={$t('office.chief.filter_aria')}>
            <button class:on={!activityAgent} on:click={() => activityAgent = null}>
              {$t('office.chief.filter_all')} <em>{activityReports.length}</em>
            </button>
            {#each byAgent as a (a.agentId)}
              <button class:on={activityAgent === a.agentId} style="--c:{a.color}"
                      on:click={() => activityAgent = activityAgent === a.agentId ? null : a.agentId}>
                <span class="mo-filter-dot" aria-hidden="true"></span>{a.agentName}
                <em>{activityReports.filter(r => r.agentId === a.agentId).length}</em>
              </button>
            {/each}
          </div>
          <ul class="ol-list mo-list">
            {#each activityReports.filter(r => !activityAgent || r.agentId === activityAgent) as report (reportKey(report))}
              {@const k = reportKey(report)}
              <li class="mo-act" class:mo-act-open={expandedKey === k} style:--oc={report.color}
                   out:slide|local={{ duration: 280, easing: quintOut }}>
                <button class="ol-row mo-row" class:on={expandedKey === k} type="button" aria-expanded={expandedKey === k}
                        on:click={() => expandedKey = expandedKey === k ? null : k}>
                  <span class="ol-mark" aria-hidden="true">{report.agentName.slice(0, 2).toUpperCase()}</span>
                  <span class="ol-row-txt">
                    <b>{report.agentName}</b>
                    {#if expandedKey !== k}
                      <small>{plainPreview(report.text, 160)}</small>
                    {/if}
                  </span>
                  <span class="or-status" class:status-ok={report.status === 'completed'} class:status-handoff={report.status === 'handoff'}>
                    {report.status === 'completed' ? '✓' : '→'}
                  </span>
                  <span class="or-time">{fmtRelTime(new Date(report.ts).toISOString())}</span>
                  <span class="mo-caret" aria-hidden="true">{expandedKey === k ? '▾' : '▸'}</span>
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
              </li>
            {/each}
          </ul>
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
            <button class="ol-btn ghost mo-sm" on:click={clearActivity}>{$t('office.chief.mark_activity_read')}</button>
          {/if}
        {:else if myOfficeTab === 'errors' && errorReports.length > 0}
          <button class="ol-btn ghost mo-sm" on:click={clearErrors}>{$t('office.chief.dismiss_all_errors')}</button>
        {/if}
        <div class="mo-more">
          <button class="ol-btn ghost mo-sm" type="button" aria-haspopup="menu" aria-expanded={moreOpen}
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
    <div class="report-modal" style:--oc={openReport.color} on:click|stopPropagation role="presentation">
      <div class="rm-head">
        <div class="ol-mhead rm-head-left">
          <span class="ol-mark" aria-hidden="true">{openReport.agentName.slice(0, 2).toUpperCase()}</span>
          <span class="rm-name">{openReport.agentName}</span>
          <span class="ol-chip rm-status"
            class:status-ok={openReport.status === 'completed'}
            class:status-fail={openReport.status === 'failed'}
            class:status-handoff={openReport.status === 'handoff'}>
            <i aria-hidden="true"></i>{openReport.status === 'completed' ? $t('office.chief.st_completed') : openReport.status === 'failed' ? $t('office.chief.st_failed') : $t('office.chief.st_handoff')}
          </span>
        </div>
        <div class="rm-head-right">
          <span class="rm-time">{new Date(openReport.ts).toLocaleString()}</span>
          <button class="ol-btn ghost mo-sm mo-x" on:click={() => openReport = null} aria-label={$t('office.chief.close')}>×</button>
        </div>
      </div>
      <div class="rm-body ip-out-md" on:click={onOutputClick} role="presentation">
        {#if fullReportLoading && !fullReportText}
          <div class="rm-loading">{$t('office.chief.loading_report')}</div>
        {/if}
        {@html formatRunOutput(reportParts.body)}
        {#if reportParts.choices}
          <div class="rm-choices">
            {#if reportParts.choices.question}<div class="rm-choices-q">{reportParts.choices.question}</div>{/if}
            <div class="rm-choices-opts">
              {#each reportParts.choices.options as opt, j (j)}
                <button class="ol-btn ghost rm-choice" on:click|stopPropagation={() => answerReportChoice(opt)}>
                  <span class="rm-choice-idx">{j + 1}</span><span class="rm-choice-lbl">{opt}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      <div class="rm-actions">
        <!-- Desestimar: drops this report (and its repeats, for a failure)
             from the office without acting on it. -->
        <button class="ol-btn ghost mo-sm rm-action-dismiss" on:click={() => openReport && dismissOpenReport(openReport)}>
          {openReportGroupSize > 1 ? $t('office.chief.dismiss_n', { n: String(openReportGroupSize) }) : $t('office.chief.dismiss')}
        </button>
        <span class="rm-spacer"></span>
        <button class="ol-btn ghost mo-sm" on:click={() => openReport && copy(displayReportText, 'report-' + openReport.ts)}>
          {copiedKey === 'report-' + openReport?.ts ? '✓ ' + $t('office.chief.copied') : '⧉ ' + $t('office.chief.copy')}
        </button>
        {#if isLlmConfigError(displayReportText)}
          <a class="ol-btn ghost mo-sm rm-action-fix" href={LLM_SETTINGS_HREF}>⚙ {$t('office.chief.configure_llm')} →</a>
        {/if}
        <button class="ol-btn ghost mo-sm" on:click={() => {
          if (openReport) {
            selectAgent(openReport.agentId);
            showMyOfficePanel = false;
            openReport = null;
          }
        }}>
          {$t('office.chief.go_to_agent')} →
        </button>
        {#if activeFixer}
          <div class="rm-fixer-wrap">
            <button class="ol-btn mo-sm rm-fixer-primary" class:rm-split={fixerCandidates.length > 1} on:click={sendReportToFixer} disabled={sendingToFixer}
                    title={$t('office.chief.send_to_title', { name: activeFixer.name })}>
              {sendingToFixer ? '⏳ …' : `🛠 ${$t('office.chief.send_to', { name: activeFixer.name })}`}
            </button>
            {#if fixerCandidates.length > 1}
              <button class="ol-btn mo-sm rm-fixer-dropdown" on:click|stopPropagation={() => fixerPickerOpen = !fixerPickerOpen}
                      disabled={sendingToFixer} title={$t('office.chief.pick_fixer')} aria-haspopup="true" aria-expanded={fixerPickerOpen}>▾</button>
            {/if}
            {#if fixerPickerOpen}
              <!-- svelte-ignore a11y-interactive-supports-focus a11y-click-events-have-key-events -->
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
  /* The office look (ol-mhead, ol-kpi, ol-seg, ol-card, ol-row, ol-btn, ol-chip) draws the parts;
     what stays here is the drawer frame, its scroll, and the pieces with no global class. */
  .info-panel{
    /* Flush with the 3D's top, right and bottom edges: a gutter there only
       took width from the world. The container's rounded corners clip it. */
    position:absolute;top:0;right:0;bottom:0;
    width:min(720px, 55vw); min-width:560px;
    overflow:hidden;
    backdrop-filter:blur(16px) saturate(1.1);
    border-left:1px solid color-mix(in srgb, var(--gold) 30%, var(--border));
    box-shadow:-20px 0 60px -20px rgba(0,0,0,.6);
    z-index:10;
    animation:slide .25s cubic-bezier(.2,.9,.25,1);
    display:flex;flex-direction:column;
    color:var(--text-1);
  }
  .info-panel::before{
    content:'';position:absolute;top:0;left:0;bottom:0;width:2px;
    background:linear-gradient(180deg, #FBBF24, #F472B6 40%, transparent 75%);
    opacity:.75;pointer-events:none;
  }
  @keyframes slide{from{transform:translateX(20px);opacity:0}}
  .office-reports-panel{
    background:radial-gradient(120% 50% at 0% 0%, color-mix(in srgb, var(--gold) 9%, transparent), transparent 60%), linear-gradient(180deg, rgba(16,18,28,.97), rgba(11,13,20,.98));
  }

  /* ── Head: mark + Dirección + gradient title, KPI filters, tabs ── */
  .mo-head{display:flex;flex-direction:column;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--border);flex-shrink:0}
  .mo-mark{--oc:var(--gold);color:var(--gold);font-size:18px;text-shadow:0 0 12px var(--gold)}
  .mo-status{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:4px}
  .mo-chip-run i{animation:mo-pulse 1.4s ease-in-out infinite}
  @keyframes mo-pulse{50%{opacity:.35;transform:scale(.8)}}
  .mo-head-actions{display:flex;align-items:center;gap:6px;flex:none;align-self:flex-start}
  .mo-sm{height:30px;padding:0 11px;font-size:12px}
  .mo-x{width:30px;padding:0;justify-content:center;font-size:17px;line-height:1}
  .mo-x:hover:not(:disabled){color:#ef5d6e;border-color:rgba(239,93,110,.45)}
  .mo-kpis{grid-template-columns:repeat(4, minmax(0, 1fr));gap:8px}
  .mo-kpis .ol-kpi{padding:5px 10px}
  .mo-kpis .ol-kpi b{font-size:18px}
  .mo-tabs{align-self:flex-start;max-width:100%;overflow-x:auto;scrollbar-width:none}
  .mo-tabs em{font-variant-numeric:tabular-nums}
  .mo-tabs .mo-em-q{color:#f0b874}
  .mo-tabs .mo-em-err{color:#fb7185}

  /* ── Body ── */
  /* Single scrollable body: the question cards AND the report lists share one
     scrollbar instead of each fighting for height inside the flex column. */
  .or-scroll{
    flex:1;min-height:0;overflow-y:auto;padding-bottom:8px;
    scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--gold) 30%, transparent) transparent;
  }
  .mo-sec{padding:12px 16px 6px}
  .mo-sec-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mo-sec-q{color:#f0b874}
  .mo-sec-fail{color:#fb7185}
  .mo-more-link{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:600}
  .mo-bulk{margin-left:auto;height:26px;font-size:11px;text-transform:none;letter-spacing:0}
  .mo-owed-chip{text-transform:none;letter-spacing:0}
  .mo-hint{font-size:11px;color:var(--text-3)}
  .mo-center{text-align:center;padding:0 16px 16px}
  .mo-age-triage{padding:0 16px 4px}
  .mo-age-groups{padding:0 16px 12px}
  .bq-list{display:flex;flex-direction:column;gap:8px;padding:0 16px 8px}
  .office-reports-list{padding:0 16px 8px;display:flex;flex-direction:column;gap:6px}
  .mo-list{padding:0 16px 8px}
  .mo-row{padding:6px 10px}
  .mo-row .ol-row-txt small{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical}
  .or-status{
    font:800 10px var(--font-body);
    width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;
    border-radius:50%;flex-shrink:0;
  }
  .or-status.status-ok{background:rgba(120,220,140,.15);color:#78dc8c;box-shadow:0 0 8px -2px #78dc8c}
  .or-status.status-handoff{background:rgba(61,214,200,.15);color:#3dd6c8;box-shadow:0 0 8px -2px #3dd6c8}
  .or-time{flex-shrink:0;font-size:10.5px;color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums}

  .mo-allgood{flex-direction:row;align-items:center;gap:12px;margin:12px 16px}
  .mo-allgood-ico{
    width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;
    color:#0a0e14;background:#34D399;box-shadow:0 0 14px -2px #34D399;font:800 15px var(--font-body);
  }
  .mo-allgood-t{font:700 13.5px var(--font-display);color:var(--text-1)}
  .mo-allgood-s{font-size:11.5px;color:var(--text-2)}

  /* Resolved by the chief: a read-only fold of rows. */
  .bq-chief-history{margin:10px 16px}
  .bq-chief-history summary{cursor:pointer;padding:4px 0 6px;list-style:none}
  .bq-chief-history summary::-webkit-details-marker{display:none}
  .bq-chief-row .ol-row-txt small{white-space:nowrap}
  .bq-chief-a{flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:700;color:#8fd6a8}

  /* Activity: an agent filter, rows that open in place. */
  .mo-filters{margin:12px 16px 8px;flex-wrap:wrap;max-width:calc(100% - 32px)}
  .mo-filter-dot{width:7px;height:7px;border-radius:50%;background:var(--c);box-shadow:0 0 6px var(--c)}
  .mo-act{display:flex;flex-direction:column;gap:4px}
  .mo-caret{color:var(--text-3);font-size:10px}
  .mo-act-body{margin:0 4px 2px;max-height:420px}
  .mo-group-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0 6px 6px}
  .mo-link{background:none;border:none;padding:0;cursor:pointer;font:600 11.5px var(--font-body);color:#9fb4e8}
  .mo-link:hover{color:#c4d3f7;text-decoration:underline;text-underline-offset:2px}
  .mo-link-dim{color:var(--text-3)}
  .mo-link-dim:hover{color:var(--text-1)}

  /* ── Markdown output (run.result / step.content) ── */
  .ip-out-md{
    font:400 12.5px/1.6 var(--font-body);color:var(--text-1);
    padding:12px 16px;border-radius:10px;background:rgba(0,0,0,.22);border:1px solid color-mix(in srgb, var(--oc, var(--gold)) 16%, var(--border));
    word-break:break-word;overflow-wrap:anywhere;max-height:380px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }

  /* ── Footer: the everyday action in sight, the destructive one behind ⋯ ── */
  .or-footer{
    padding:8px 16px;border-top:1px solid var(--border);
    display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;
  }
  .mo-more{position:relative;margin-left:auto}
  .mo-more-menu{
    position:absolute;right:0;bottom:calc(100% + 6px);min-width:200px;padding:5px;border-radius:10px;z-index:5;
    background:var(--surface-1);border:1px solid var(--border-h);box-shadow:0 14px 30px -10px rgba(0,0,0,.7);
  }
  .mo-more-item{
    display:block;width:100%;padding:7px 10px;border-radius:7px;border:none;background:none;cursor:pointer;text-align:left;
    font:600 12px var(--font-body);color:var(--text-1);
  }
  .mo-more-item:hover{background:rgba(255,255,255,.06)}
  .mo-more-danger{color:#ef5d6e}
  .mo-more-danger:hover{background:rgba(239,93,110,.12)}

  /* ── Loading skeleton ── */
  .mo-skel{padding:12px 16px;display:flex;flex-direction:column;gap:8px}
  .mo-skel-h{display:flex;align-items:center;gap:8px;font:600 11.5px var(--font-body);color:var(--text-2);margin-bottom:2px}
  .mo-spin{
    width:12px;height:12px;border-radius:50%;flex:none;
    border:2px solid color-mix(in srgb, var(--gold) 25%, transparent);border-top-color:var(--gold);
    animation:mo-spin .8s linear infinite;
  }
  @keyframes mo-spin{to{transform:rotate(360deg)}}
  .mo-skel-card{
    display:flex;flex-direction:column;gap:7px;padding:12px;border-radius:14px;
    background:var(--surface-1);border:1px solid var(--border);
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

  /* ── Report detail modal ── */
  .modal-overlay{position:fixed;inset:0;z-index:var(--z-modal);background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}
  .report-modal{
    --oc:var(--gold);
    width:min(700px, 90vw);max-height:85vh;
    background:radial-gradient(120% 60% at 0% 0%, color-mix(in srgb, var(--oc) 10%, transparent), transparent 55%), var(--surface-1);
    border:1px solid color-mix(in srgb, var(--oc) 35%, var(--border));border-radius:14px;
    display:flex;flex-direction:column;overflow:hidden;
    box-shadow:0 20px 60px rgba(0,0,0,.7), 0 0 40px -20px var(--oc);
  }
  .rm-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:12px 16px;border-bottom:1px solid var(--border);
    gap:12px;flex-wrap:wrap;
  }
  .rm-head-left{flex:1;gap:10px}
  .rm-head-right{display:flex;align-items:center;gap:10px}
  .rm-status.status-ok{--c:#78dc8c}
  .rm-status.status-fail{--c:#fb7185}
  .rm-status.status-handoff{--c:#3dd6c8}
  .rm-name{min-width:0;font:700 15px var(--font-display);color:color-mix(in srgb, var(--oc) 60%, white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rm-time{font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums}
  .rm-loading{color:var(--text-3);font-size:11.5px}
  .rm-body{
    flex:1;min-height:0;overflow-y:auto;padding:16px 20px;max-height:none;border:0;border-radius:0;background:none;
    scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--gold) 20%, transparent) transparent;
    white-space:pre-wrap;
  }
  .rm-actions{
    display:flex;justify-content:flex-end;gap:6px;align-items:center;flex-wrap:wrap;
    padding:10px 16px;border-top:1px solid var(--border);
  }
  .rm-spacer{flex:1}
  .rm-action-dismiss:hover:not(:disabled){color:#ef5d6e;border-color:rgba(239,93,110,.45)}
  /* A link, and the one action that fixes the cause rather than routing the symptom. */
  .rm-action-fix{text-decoration:none;color:var(--gold);border-color:color-mix(in srgb, var(--gold) 45%, var(--border-h))}
  /* Send-to-fixer split button + dropdown */
  .rm-fixer-wrap{position:relative;display:inline-flex;align-items:stretch}
  .rm-fixer-primary.rm-split{border-top-right-radius:0;border-bottom-right-radius:0}
  .rm-fixer-dropdown{padding:0 9px;border-top-left-radius:0;border-bottom-left-radius:0;border-left-color:rgba(0,0,0,.25)}
  .rm-fixer-menu{
    position:absolute;right:0;bottom:calc(100% + 4px);z-index:var(--z-toast);
    min-width:240px;max-width:340px;padding:4px;
    background:var(--surface-1);border:1px solid color-mix(in srgb, var(--gold) 35%, var(--border));border-radius:10px;
    box-shadow:0 8px 28px rgba(0,0,0,.55),0 0 18px -6px var(--gold);
    overflow:hidden;
  }
  .rm-fixer-menu-item{
    display:flex;flex-direction:column;align-items:flex-start;gap:2px;
    width:100%;padding:7px 10px;border:none;border-radius:7px;background:transparent;cursor:pointer;text-align:left;
    transition:background .1s;
  }
  .rm-fixer-menu-item:hover{background:color-mix(in srgb, var(--gold) 10%, transparent)}
  .rm-fixer-menu-active{background:color-mix(in srgb, var(--gold) 16%, transparent)}
  .rm-fixer-menu-name{font:700 12px var(--font-display);color:var(--gold)}
  .rm-fixer-menu-hint{font-size:10.5px;color:var(--text-3)}
  .rm-fixer-status{font-size:11px;font-weight:600;color:var(--text-2);margin-right:auto;padding-left:4px}
  /* Same look as the chat's choice buttons (ChatTab .chat-choices). */
  .rm-choices{
    margin-top:10px;padding:10px 12px;border-radius:12px;white-space:normal;
    background:linear-gradient(160deg, color-mix(in srgb, var(--gold) 10%, transparent), transparent 70%);
    border:1px solid color-mix(in srgb, var(--gold) 28%, var(--border));
  }
  .rm-choices-q{font:600 13px/1.45 var(--font-body);color:var(--text-1);margin:0 0 8px}
  .rm-choices-opts{display:grid;grid-template-columns:1fr 1fr;gap:5px}
  .rm-choice{height:auto;min-height:34px;padding:6px 10px;white-space:normal;text-align:left;font-size:11.5px;line-height:1.35}
  .rm-choice-idx{
    flex-shrink:0;width:20px;height:20px;border-radius:6px;background:color-mix(in srgb, var(--surface-1) 55%, #000);
    display:inline-flex;align-items:center;justify-content:center;
    font:800 10px var(--font-display);color:var(--gold);
  }
  .rm-choice-lbl{flex:1;word-break:break-word}

  .mo-link:focus-visible, .bq-chief-history summary:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
  @media (max-width: 760px){ .mo-kpis{grid-template-columns:repeat(2, minmax(0, 1fr))} }
  @media (prefers-reduced-motion: reduce){ .mo-chip-run i, .mo-spin, .mo-skel-line, .mo-skel-card{animation:none} }
</style>
