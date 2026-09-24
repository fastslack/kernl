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
  import { firstUrlIn, urlForOption, buildFixerGoal } from '$lib/agent-helpers.js';
  import type { OfficeReport, PendingQuestion, WorldAgent } from './world-types.js';

  /** bind: — the 3D office's My Office hitbox toggles it too. */
  export let showMyOfficePanel: boolean;
  /** bind: — the inbox shortcut opens straight on Questions. */
  export let myOfficeTab: 'overview' | 'questions' | 'errors';
  /** bind: — appended to by live events, trimmed by the actions here. */
  export let officeReports: OfficeReport[];
  /** bind: — the backlog fetch runs again once the list is cleared. */
  export let officeReportsLoaded: boolean;
  /** bind: — polled by the world, which also lights the top agent's halo from it. */
  export let pendingQuestions: PendingQuestion[];
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

  // Bulk actions for the My Office panel.
  let bulkBusy = false;
  async function dismissAllQuestions() {
    if (bulkBusy || pendingQuestions.length === 0) return;
    if (!confirm(`Dismiss all ${pendingQuestions.length} pending questions?`)) return;
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
    if (officeReports.filter(r => r.status === 'failed').length === 0) return;
    officeReports = officeReports.filter(r => r.status !== 'failed');
  }
  function clearActivity() {
    if (officeReports.filter(r => r.status !== 'failed').length === 0) return;
    officeReports = officeReports.filter(r => r.status === 'failed');
  }
  function clearAllOfficeData() {
    if (!confirm('Clear ALL reports and dismiss ALL pending questions?')) return;
    void dismissAllQuestions();
    officeReports = [];
    officeReportsLoaded = false;
  }
  let openReport: OfficeReport | null = null;

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
        officeReports = officeReports.filter(r => (r.runId ?? `${r.agentId}-${r.ts}`) !== targetKey);
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

<!-- My Office Reports Panel -->
{#if showMyOfficePanel}
  {@const errorReports = officeReports.filter(r => r.status === 'failed')}
  {@const activityReports = officeReports.filter(r => r.status !== 'failed')}
  <div class="info-panel office-reports-panel">
    <div class="ip-head">
      <div class="ip-head-left">
        <div class="ip-glyph" style="color:#c9a84c">&#9733;</div>
        <div class="ip-head-txt">
          <div class="ip-name">My Office</div>
          <div class="ip-sub">
            <span style="color:#f0b874">{pendingQuestions.length} questions</span>
            <span class="ip-dot"></span>
            <span style="color:#ef5d6e">{errorReports.length} errors</span>
            <span class="ip-dot"></span>
            <span style="color:#8a8fa8">{activityReports.length} activity</span>
          </div>
        </div>
      </div>
      <button class="ip-close" on:click={() => showMyOfficePanel = false} aria-label="close">×</button>
    </div>

    <!-- Tabs: Overview · Questions · Errors -->
    <div class="ip-tabs mo-tabs">
      <button class="ip-tab" class:active={myOfficeTab === 'overview'}
              on:click={() => myOfficeTab = 'overview'}>Overview</button>
      <button class="ip-tab" class:active={myOfficeTab === 'questions'}
              on:click={() => myOfficeTab = 'questions'}>
        Questions
        {#if pendingQuestions.length > 0}<span class="mo-tab-badge mo-tab-badge-q">{pendingQuestions.length}</span>{/if}
      </button>
      <button class="ip-tab" class:active={myOfficeTab === 'errors'}
              on:click={() => myOfficeTab = 'errors'}>
        Errors
        {#if errorReports.length > 0}<span class="mo-tab-badge mo-tab-badge-err">{errorReports.length}</span>{/if}
      </button>
    </div>

    <div class="or-scroll">
      {#if myOfficeTab === 'overview'}
        <!-- ═══ OVERVIEW ═══ at-a-glance summary -->
        {#if officeReports.length === 0 && pendingQuestions.length === 0}
          <div class="or-empty">No reports yet. Agents will come here when they finish tasks.</div>
        {:else}
          <div class="mo-overview">
            <!-- KPI strip -->
            <div class="mo-kpis">
              <button class="mo-kpi mo-kpi-q" disabled={pendingQuestions.length === 0}
                      on:click={() => myOfficeTab = 'questions'}>
                <span class="mo-kpi-num">{pendingQuestions.length}</span>
                <span class="mo-kpi-lbl">Pending Q</span>
              </button>
              <button class="mo-kpi mo-kpi-err" disabled={errorReports.length === 0}
                      on:click={() => myOfficeTab = 'errors'}>
                <span class="mo-kpi-num">{errorReports.length}</span>
                <span class="mo-kpi-lbl">Errors</span>
              </button>
              <div class="mo-kpi mo-kpi-act">
                <span class="mo-kpi-num">{activityReports.length}</span>
                <span class="mo-kpi-lbl">Activity</span>
              </div>
            </div>

            <!-- Latest question (1) -->
            {#if pendingQuestions.length > 0}
              {@const q = pendingQuestions[0]}
              {@const agent = agents.find(a => a.id === q.from_agent_id)}
              <div class="or-section">
                <span class="or-section-title or-section-q">❓ Latest question</span>
                {#if pendingQuestions.length > 1}
                  <button class="or-section-more" on:click={() => myOfficeTab = 'questions'}>
                    +{pendingQuestions.length - 1} more →
                  </button>
                {/if}
              </div>
              <div class="bq-card mo-overview-q" on:click={() => myOfficeTab = 'questions'} role="button" tabindex="0"
                   on:keydown={e => e.key === 'Enter' && (myOfficeTab = 'questions')}>
                <div class="bq-head">
                  <span class="bq-from-dot" style="background:{flowColor(q.from_agent_id)}"></span>
                  <span class="bq-from">{agent?.name ?? q.from_agent_id.slice(0, 8)}</span>
                  <span class="bq-time">{fmtRelTime(q.created_at)}</span>
                </div>
                <div class="bq-question">{q.question}</div>
              </div>
            {/if}

            <!-- Latest error (1) -->
            {#if errorReports.length > 0}
              {@const r = errorReports[0]}
              <div class="or-section">
                <span class="or-section-title or-section-fail">⚠ Latest error</span>
                {#if errorReports.length > 1}
                  <button class="or-section-more" on:click={() => myOfficeTab = 'errors'}>
                    +{errorReports.length - 1} more →
                  </button>
                {/if}
              </div>
              <button class="or-card or-fail" on:click={() => openReport = r}>
                <div class="or-card-header">
                  <span class="or-dot" style="background:{r.color}"></span>
                  <span class="or-status status-fail">!</span>
                  <span class="or-name" style="color:{r.color}">{r.agentName}</span>
                  <span class="or-time">{fmtRelTime(new Date(r.ts).toISOString())}</span>
                </div>
                <div class="or-card-body">{r.text.replace(/[#*`]/g, '').replace(/\|/g, ' ').replace(/\{[^}]*\}/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 140)}{r.text.length > 140 ? '...' : ''}</div>
              </button>
              <!-- The 140-char preview cuts exactly where the kernel says how
                   to fix it, so the fix travels as a chip instead of prose.
                   Outside the card: an <a> inside a <button> is invalid. -->
              {#if isLlmConfigError(r.text)}
                <a class="llm-fix llm-fix-row" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
              {/if}
            {/if}

            <!-- Recent activity (handoff + completed, last 5) -->
            {#if activityReports.length > 0}
              <div class="or-section">
                <span class="or-section-title">Recent activity</span>
                {#if activityReports.length > 5}
                  <span class="or-section-hint">showing 5 of {activityReports.length}</span>
                {/if}
              </div>
              <div class="office-reports-list">
                {#each activityReports.slice(0, 5) as report (report.runId ?? `${report.agentId}-${report.ts}`)}
                  <button class="or-card" class:or-handoff={report.status === 'handoff'}
                          out:slide|local={{ duration: 320, easing: quintOut }}
                          on:click={() => openReport = report}>
                    <div class="or-card-header">
                      <span class="or-dot" style="background:{report.color}"></span>
                      <span class="or-status"
                            class:status-ok={report.status === 'completed'}
                            class:status-handoff={report.status === 'handoff'}>
                        {report.status === 'completed' ? '✓' : '→'}
                      </span>
                      <span class="or-name" style="color:{report.color}">{report.agentName}</span>
                      <span class="or-time">{fmtRelTime(new Date(report.ts).toISOString())}</span>
                    </div>
                    <div class="or-card-body">{report.text.replace(/[#*`]/g, '').replace(/\|/g, ' ').replace(/\{[^}]*\}/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 140)}{report.text.length > 140 ? '...' : ''}</div>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {:else if myOfficeTab === 'questions'}
        <!-- ═══ QUESTIONS ═══ -->
        {#if pendingQuestions.length === 0}
          <div class="or-empty">No pending questions. Agents will pin them here when stuck.</div>
        {:else}
          <div class="or-section">
            <span class="or-section-title or-section-q">❓ Pending questions · {pendingQuestions.length}</span>
            <span class="or-section-hint">agents waiting for your call</span>
            <button class="mo-bulk-btn mo-bulk-dismiss" on:click={dismissAllQuestions} disabled={bulkBusy}>
              {bulkBusy ? '…' : `Dismiss all (${pendingQuestions.length})`}
            </button>
          </div>
          <div class="bq-list">
            {#each pendingQuestions as q (q.id)}
              {@const agent = agents.find(a => a.id === q.from_agent_id)}
              {@const ctxUrl = firstUrlIn(q.context)}
              <div class="bq-card">
                <div class="bq-head">
                  <span class="bq-from-dot" style="background:{flowColor(q.from_agent_id)}"></span>
                  <span class="bq-from">{agent?.name ?? q.from_agent_id.slice(0, 8)}</span>
                  <span class="bq-time">{fmtRelTime(q.created_at)}</span>
                  <button class="bq-dismiss" title="Dismiss without answering"
                          on:click={() => dismissQuestion(q)}
                          disabled={!!questionSubmitting[q.id]}>×</button>
                </div>
                <div class="bq-question">{q.question}</div>
                {#if q.context}
                  <details class="bq-context">
                    <summary>ver contexto</summary>
                    <div class="bq-context-body">{q.context}</div>
                  </details>
                {/if}
                {#if ctxUrl}
                  <a class="bq-direct-link" href={ctxUrl} target="_blank" rel="noopener noreferrer" title={ctxUrl}>
                    🔗 {new URL(ctxUrl).host}
                  </a>
                {/if}
                <div class="bq-options">
                  {#each q.options as opt, i}
                    {@const optUrl = urlForOption(q, opt)}
                    <button class="bq-option" class:bq-option-link={!!optUrl}
                            on:click={() => answerQuestion(q, i, opt)}
                            disabled={!!questionSubmitting[q.id]}
                            title={optUrl ? `Opens ${optUrl}` : opt.label}>
                      <span class="bq-option-idx">{i + 1}</span>
                      <span class="bq-option-lbl">{opt.label}</span>
                      {#if optUrl}<span class="bq-option-linkico" aria-hidden="true">↗</span>{/if}
                    </button>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {:else if myOfficeTab === 'errors'}
        <!-- ═══ ERRORS ═══ -->
        {#if errorReports.length === 0}
          <div class="or-empty">No errors. Failed runs will appear here for triage.</div>
        {:else}
          <div class="or-section">
            <span class="or-section-title or-section-fail">⚠ Errors · {errorReports.length}</span>
            <span class="or-section-hint">routed to Error Auditor for triage</span>
            <button class="mo-bulk-btn mo-bulk-clear" on:click={clearErrors}>
              Mark all as read ({errorReports.length})
            </button>
          </div>
          <div class="office-reports-list">
            {#each errorReports as report (report.runId ?? `${report.agentId}-${report.ts}`)}
              <button class="or-card or-fail"
                      out:slide|local={{ duration: 320, easing: quintOut }}
                      on:click={() => openReport = report}>
                <div class="or-card-header">
                  <span class="or-dot" style="background:{report.color}"></span>
                  <span class="or-status status-fail">!</span>
                  <span class="or-name" style="color:{report.color}">{report.agentName}</span>
                  {#if report.runId && auditedRunIds.has(report.runId)}
                    <span class="or-audited" title="Error Auditor triaged this failure">✓ audited</span>
                  {:else if report.runId}
                    <span class="or-audit-pending" title="Waiting for the Error Auditor to pick this up">● pending</span>
                  {/if}
                  <span class="or-time">{fmtRelTime(new Date(report.ts).toISOString())}</span>
                </div>
                <div class="or-card-body">{report.text.replace(/[#*`]/g, '').replace(/\|/g, ' ').replace(/\{[^}]*\}/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 140)}{report.text.length > 140 ? '...' : ''}</div>
              </button>
              {#if isLlmConfigError(report.text)}
                <a class="llm-fix llm-fix-row" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
              {/if}
            {/each}
          </div>
        {/if}
      {/if}
    </div>  <!-- /or-scroll -->

    {#if myOfficeTab === 'overview' && (officeReports.length > 0 || pendingQuestions.length > 0)}
      <div class="or-footer">
        {#if officeReports.filter(r => r.status !== 'failed').length > 0}
          <button class="office-clear-btn office-clear-btn-soft" on:click={clearActivity}
                  title="Remove handoff + completed cards from this view">
            Mark activity read
          </button>
        {/if}
        <button class="office-clear-btn office-clear-btn-danger" on:click={clearAllOfficeData}
                title="Dismiss every pending question AND clear all reports">
          Clear everything
        </button>
      </div>
    {:else if myOfficeTab === 'errors' && officeReports.length > 0}
      <div class="or-footer">
        <button class="office-clear-btn" on:click={() => { officeReports = []; officeReportsLoaded = false; }}>Clear all reports</button>
      </div>
    {/if}
  </div>
{/if}

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
            {openReport.status === 'completed' ? 'Completed' : openReport.status === 'failed' ? 'Failed' : 'Handoff'}
          </span>
          <span class="rm-name" style="color:{openReport.color}">{openReport.agentName}</span>
        </div>
        <div class="rm-head-right">
          <span class="rm-time">{new Date(openReport.ts).toLocaleString()}</span>
          <button class="rm-close" on:click={() => openReport = null}>×</button>
        </div>
      </div>
      <div class="rm-body ip-out-md" on:click={onOutputClick} role="presentation">
        {#if fullReportLoading && !fullReportText}
          <div style="color:#6a6f82;font:500 11px 'JetBrains Mono',monospace">Loading full report…</div>
        {/if}
        {@html formatRunOutput(displayReportText)}
      </div>
      <div class="rm-actions">
        <button class="rm-action" on:click={() => openReport && copy(displayReportText, 'report-' + openReport.ts)}>
          {copiedKey === 'report-' + openReport?.ts ? '✓ copied' : '⧉ Copy full text'}
        </button>
        {#if isLlmConfigError(displayReportText)}
          <a class="rm-action rm-action-fix" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
        {/if}
        <button class="rm-action" on:click={() => {
          if (openReport) {
            selectAgent(openReport.agentId);
            showMyOfficePanel = false;
            openReport = null;
            focusAgent();
          }
        }}>
          Go to agent desk →
        </button>

        <!-- Send-to-fixer: primary dispatches to the resolved fixer; the ▾
             sibling opens a small picker so the user can override the
             default. Only rendered when at least one fixer agent exists. -->
        {#if activeFixer}
          <div class="rm-fixer-wrap">
            <button class="rm-action rm-fixer-primary" on:click={sendReportToFixer} disabled={sendingToFixer}
                    title="Dispatch the report body to {activeFixer.name} so they can diagnose + fix it">
              {sendingToFixer ? '⏳ sending…' : `🛠 Send to ${activeFixer.name}`}
            </button>
            {#if fixerCandidates.length > 1}
              <button class="rm-fixer-dropdown" on:click|stopPropagation={() => fixerPickerOpen = !fixerPickerOpen}
                      disabled={sendingToFixer} title="Pick a different fixer" aria-haspopup="true" aria-expanded={fixerPickerOpen}>▾</button>
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
    position:absolute;top:12px;right:12px;bottom:12px;
    width:min(720px, 55vw); min-width:560px;
    overflow:hidden;
    background:linear-gradient(180deg, rgba(16,18,28,.96) 0%, rgba(11,13,20,.97) 100%);
    backdrop-filter:blur(16px) saturate(1.1);
    border:1px solid rgba(120,130,160,.15);
    border-radius:14px;
    box-shadow:0 20px 60px -20px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.02) inset;
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
  }
  .ip-head-left{display:flex;gap:12px;align-items:flex-start;min-width:0;flex:1}
  .ip-glyph{
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
  .ip-sub{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:7px;
    font:500 10px 'JetBrains Mono',monospace;
    color:#7a7f92;
  }
  .ip-dot{width:3px;height:3px;border-radius:50%;background:#4a4f66}
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
  .llm-fix{
    flex-shrink:0;align-self:center;
    padding:3px 9px;border-radius:999px;text-decoration:none;white-space:nowrap;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(201,168,76,.10);
    border:1px solid rgba(201,168,76,.45);
    color:#d4a84b;transition:background .12s,border-color .12s;
  }
  .llm-fix:hover{background:rgba(201,168,76,.20);border-color:#d4a84b}
  /* Under a card rather than beside a message: own line, indented to the card. */
  .llm-fix-row{display:inline-block;align-self:flex-start;margin:6px 0 2px 12px}

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
  .mo-overview{padding:8px 4px}
  .mo-kpis{
    display:grid;grid-template-columns:repeat(3,1fr);gap:8px;
    padding:8px 10px 4px;
  }
  .mo-kpi{
    display:flex;flex-direction:column;gap:2px;align-items:flex-start;
    padding:10px 12px;border:1px solid rgba(120,130,160,.18);border-radius:8px;
    background:rgba(120,130,160,.04);
    color:#cbd0e8;cursor:pointer;text-align:left;
    transition:background .12s, border-color .12s;
  }
  .mo-kpi:hover:not(:disabled){background:rgba(120,130,160,.1);border-color:rgba(120,130,160,.35)}
  .mo-kpi:disabled{cursor:default;opacity:.55}
  .mo-kpi-num{font:800 22px 'Syne',sans-serif;line-height:1}
  .mo-kpi-lbl{font:600 9px 'JetBrains Mono',monospace;letter-spacing:.6px;text-transform:uppercase;color:#8a8fa8}
  .mo-kpi-q .mo-kpi-num{color:#f0b874}
  .mo-kpi-q{border-color:rgba(240,184,116,.25)}
  .mo-kpi-err .mo-kpi-num{color:#ef5d6e}
  .mo-kpi-err{border-color:rgba(239,93,110,.25)}
  .mo-kpi-act .mo-kpi-num{color:#7a9aff}
  .mo-kpi-act{border-color:rgba(122,154,255,.25)}

  /* Compact overview question preview — clickable card hint */
  .mo-overview-q{cursor:pointer;transition:background .12s}
  .mo-overview-q:hover{background:linear-gradient(180deg, rgba(240,184,116,.16) 0%, rgba(240,184,116,.04) 100%)}
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
  .office-clear-btn-soft:hover{background:rgba(120,130,160,.16);border-color:rgba(120,130,160,.5);color:#cbd0e8}
  .office-clear-btn-danger{
    background:rgba(239,93,110,.08);border-color:rgba(239,93,110,.3);color:#ef5d6e;
    margin-left:auto;
  }
  .office-clear-btn-danger:hover{background:rgba(239,93,110,.18);border-color:rgba(239,93,110,.5)}
  .or-card{
    display:flex;flex-direction:column;gap:4px;width:100%;
    padding:10px 12px;border:none;border-radius:8px;
    background:rgba(120,130,160,.04);color:#c0c5d8;cursor:pointer;
    text-align:left;transition:background .12s;
    border-left:3px solid transparent;
  }
  .or-card:hover{background:rgba(201,168,76,.08)}
  .or-card.or-fail{border-left-color:rgba(239,93,110,.5);background:rgba(239,93,110,.04)}
  .or-card.or-handoff{border-left-color:rgba(61,214,200,.4);background:rgba(61,214,200,.03)}
  .or-section{
    display:flex;align-items:baseline;gap:8px;
    padding:6px 4px 2px 4px;margin-top:4px;
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
  .bq-list{ display:flex; flex-direction:column; gap:10px; padding:0 14px 12px; }
  .bq-card{
    background:linear-gradient(180deg, rgba(240,184,116,.08) 0%, rgba(240,184,116,.02) 100%);
    border:1px solid rgba(240,184,116,.25); border-left:3px solid #f0b874;
    border-radius:8px; padding:10px 12px;
  }
  .bq-head{ display:flex; align-items:center; gap:8px; margin-bottom:6px; font:600 10px 'JetBrains Mono',monospace; color:#cbd0e8; }
  .bq-from-dot{ width:7px; height:7px; border-radius:50%; }
  .bq-from{ color:#e7e9f4; }
  .bq-time{ margin-left:auto; color:#6b7090; font-size:9px; }
  .bq-dismiss{
    background:transparent; border:none; color:#6b7090; font-size:16px;
    cursor:pointer; padding:0 3px; line-height:1;
  }
  .bq-dismiss:hover{ color:#ef5d6e; }
  .bq-question{
    font:600 13px/1.45 'Manrope',sans-serif; color:#e7e9f4;
    margin:0 0 8px; word-break:break-word;
  }
  .bq-context{ margin:0 0 8px; }
  .bq-context summary{
    cursor:pointer; color:#8b90af; font:500 10px 'JetBrains Mono',monospace;
    list-style:none;
  }
  .bq-context summary::-webkit-details-marker{ display:none; }
  .bq-context summary::before{ content:'▸ '; color:#6b7090; }
  .bq-context[open] summary::before{ content:'▾ '; }
  .bq-context-body{
    margin-top:6px; padding:8px 10px; background:#0a0b14; border:1px solid #1f2236;
    border-radius:4px; font:500 11px/1.5 'JetBrains Mono',monospace; color:#8b90af;
    white-space:pre-wrap; word-break:break-word; max-height:160px; overflow-y:auto;
  }
  .bq-options{ display:flex; flex-direction:column; gap:5px; }
  .bq-option{
    display:flex; align-items:center; gap:8px;
    padding:8px 10px; background:#161827; color:#cbd0e8;
    border:1px solid #2a2f4a; border-radius:5px;
    font:600 11px 'Manrope',sans-serif;
    cursor:pointer; transition:all .12s; text-align:left;
  }
  .bq-option:hover:not(:disabled){
    background:#252840; border-color:#f0b874; color:#f4e1a3;
    transform:translateY(-1px);
  }
  .bq-option:disabled{ opacity:.5; cursor:not-allowed; }
  .bq-option-idx{
    flex-shrink:0; width:20px; height:20px; border-radius:3px;
    background:#0a0b14; display:inline-flex; align-items:center; justify-content:center;
    font:700 10px 'JetBrains Mono',monospace; color:#f0b874;
  }
  .bq-option-lbl{ flex:1; word-break:break-word; }
  /* Options that open a URL — make them visually distinct (subtle teal tint
     + arrow chevron). */
  .bq-option-link{
    border-color:rgba(61,214,200,.35);
    background:linear-gradient(180deg, #161827 0%, #15212a 100%);
  }
  .bq-option-link:hover:not(:disabled){
    border-color:#3dd6c8;
    background:linear-gradient(180deg, #1a2f33 0%, #142329 100%);
    color:#a8e4dc;
  }
  .bq-option-link .bq-option-idx{ color:#3dd6c8; }
  .bq-option-linkico{
    flex-shrink:0; color:#3dd6c8; font:700 11px 'JetBrains Mono',monospace;
    opacity:.7; transition:opacity .12s, transform .12s;
  }
  .bq-option-link:hover:not(:disabled) .bq-option-linkico{
    opacity:1; transform:translate(2px,-2px);
  }
  /* Direct link chip — surfaces the URL from `context` above the options
     so the user can preview the link without having to commit to an answer. */
  .bq-direct-link{
    display:inline-flex; align-items:center; gap:5px;
    margin:6px 0 2px;
    padding:4px 9px;
    border:1px solid rgba(61,214,200,.3);
    background:rgba(61,214,200,.08);
    border-radius:14px;
    color:#88e0d6; text-decoration:none;
    font:600 10.5px 'JetBrains Mono',monospace;
    letter-spacing:.2px;
    transition:all .12s;
    max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .bq-direct-link:hover{
    background:rgba(61,214,200,.16);
    border-color:rgba(61,214,200,.5);
    color:#c8f0ea;
  }
  .or-audited{
    font:700 8px 'JetBrains Mono',monospace;letter-spacing:.4px;
    padding:2px 6px;border-radius:4px;
    background:rgba(120,220,140,.13);color:#78dc8c;
    border:1px solid rgba(120,220,140,.3);
  }
  .or-audit-pending{
    font:700 8px 'JetBrains Mono',monospace;letter-spacing:.4px;
    padding:2px 6px;border-radius:4px;
    background:rgba(201,168,76,.08);color:#c9a84c;
    border:1px dashed rgba(201,168,76,.3);
  }
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
  }
  .or-card.or-fail .or-card-body{color:#cf7080}
  .or-footer{
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
</style>
