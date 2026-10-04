<script lang="ts">
  /**
   * HISTORY tab of the agent drawer — lifetime KPIs over a list of run cards,
   * each expanding into its error, its output and its step timeline.
   *
   * The fetches stay in AgentWorld3D: they key off `selectedAgent` and the
   * world resets them when the selection changes. So everything arrives as a
   * prop and every action is a callback — this component holds no state of
   * its own, which is why expanding a run is `onToggleRun` rather than a
   * local flag.
   */
  import { triggerColor, fmtTokens, fmtRelTime } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import { emailCommId } from '$lib/agent-helpers.js';
  import {
    liveStepIcon, liveStepLabel, liveStepSummary, liveStepCategory, liveEventType,
    summarizeToolCall, summarizeToolResult, plainStepText,
  } from '$lib/live-steps.js';
  import { liveEventDetail } from '$lib/live-event-detail.js';
  import {
    stepAsFlowEvent, historyStepDetail, groupHistoryRows, shortToolName, toolChips,
    type HistoryStep, type HistoryRow, type ToolChip,
  } from '$lib/history-steps.js';
  import LiveEventDetail from './LiveEventDetail.svelte';
  import AgentActionBody from './AgentActionBody.svelte';
  import { agentActionOf } from '$lib/agent-actions.js';
  import StepPayload from './StepPayload.svelte';

  /** Lifetime counters for the selected agent, or null while unknown. */
  export let stats: {
    total_runs: number; completed: number; failed: number; success_rate: number;
  } | null = null;

  export let runs: Array<{
    id: string; status: string; steps_count: number; tokens_used: number;
    trigger_type: string; created_at: string; result?: string; error?: string;
  }> = [];
  export let runsLoading = false;

  /** Which card is open. The parent owns it: loadRunSteps() sets it. */
  export let expandedRunId: string | null = null;

  /** Stored steps plus event-log entries (carried as flow events). */
  export let steps: HistoryStep[] = [];
  export let stepsLoading = false;
  export let stepsError: string | null = null;

  /** Which copy button most recently fired, so it can show its tick. */
  export let copiedKey: string | null = null;

  /** Expand or collapse a run — the parent fetches the steps. */
  export let onToggleRun: (runId: string) => void = () => {};
  /** Re-fetch after a step load failed. */
  export let onRetryRun: (runId: string) => void = () => {};
  export let onCopy: (text: string, key: string) => void = () => {};
  /** UUID chips inside an output open the entity preview. */
  export let onOutputClick: (e: MouseEvent) => void = () => {};
  /** An email-send step offers a link to the real message. */
  export let onOpenEmail: (commId: string) => void = () => {};
  /** Agent id → name, so an action on another agent names it instead of a short id. */
  export let nameOf: (id: string) => string | undefined = () => undefined;

  // Which step rows are open. Purely visual, so it lives here rather than in
  // the parent; keyed by run so two runs never share a row's state.
  let openSteps = new Set<string>();
  function stepKey(runId: string, s: HistoryStep): string {
    return `${runId}:${s.step_number}`;
  }
  function toggleStep(key: string): void {
    if (openSteps.has(key)) openSteps.delete(key); else openSteps.add(key);
    openSteps = new Set(openSteps);
  }
  function rowKey(runId: string, r: HistoryRow): string {
    if (r.kind === 'tools') return `${runId}:tools:${r.range}`;
    if (r.kind === 'action') return `${runId}:action:${(r.use.call ?? r.use.result)?.step_number ?? 0}`;
    return stepKey(runId, r.step);
  }
  function setAll(runId: string, rows: HistoryRow[], open: boolean): void {
    const next = new Set([...openSteps].filter(k => !k.startsWith(runId + ':')));
    if (open) for (const r of rows) next.add(rowKey(runId, r));
    openSteps = next;
  }
  /** "mcp__kernel__kernel_career_liveness — 25 calls, 2 failed". */
  function chipTitle(c: ToolChip): string {
    const parts = [c.count === 1 ? '1 call' : `${c.count} calls`];
    if (c.failed > 0) parts.push(`${c.failed} failed`);
    if (c.pending > 0) parts.push(`${c.pending} without result`);
    return `${c.fullName} — ${parts.join(', ')}`;
  }
  function stepCopyText(s: HistoryStep): string {
    if (s.type === 'tool_call') return s.tool_input ?? '';
    if (s.type === 'tool_result') return s.tool_output ?? '';
    return s.content ?? '';
  }
</script>

<div class="ip-body">
  <!-- KPIs — moved here from Overview. A count over the agent's whole
       run history belongs next to the series it summarizes, not
       leading a panel that otherwise talks about right now. -->
  {#if stats}
    <div class="ip-kpis">
      <div class="ip-kpi">
        <div class="ip-kpi-v">{stats.total_runs}</div>
        <div class="ip-kpi-l">Total runs</div>
      </div>
      <div class="ip-kpi">
        <div class="ip-kpi-v" style="color:#78dc8c">{stats.completed}</div>
        <div class="ip-kpi-l">Completed</div>
      </div>
      <div class="ip-kpi">
        <div class="ip-kpi-v" style="color:#ef5d6e">{stats.failed}</div>
        <div class="ip-kpi-l">Failed</div>
      </div>
      <div class="ip-kpi">
        <div class="ip-kpi-v">{Math.round(stats.success_rate)}<span class="ip-kpi-unit">%</span></div>
        <div class="ip-kpi-l">Success</div>
      </div>
    </div>
  {/if}

  {#if runsLoading}
    <div class="ip-loading">Loading runs…</div>
  {:else if runs.length === 0}
    <div class="ip-empty">No runs yet. Hit <b>Run now</b> to start one.</div>
  {:else}
    <div class="ip-runs">
      {#each runs as run (run.id)}
        <div class="ip-run-card" class:expanded={expandedRunId === run.id} class:run-fail={run.status === 'failed'} class:run-ok={run.status === 'completed'} class:run-live={run.status === 'running'}>
          <button class="ip-run-head" on:click={() => onToggleRun(run.id)}>
            <span class="ip-run-status" class:ok={run.status === 'completed'} class:fail={run.status === 'failed'} class:running={run.status === 'running'}>
              {run.status === 'completed' ? '✓' : run.status === 'failed' ? '✗' : '●'}
            </span>
            <span class="ip-run-trigger" style="--c:{triggerColor(run.trigger_type)}">{run.trigger_type}</span>
            <span class="ip-run-steps">{run.steps_count} steps</span>
            <span class="ip-run-tokens">{fmtTokens(run.tokens_used)} tok</span>
            <span class="ip-run-time" title={run.created_at}>{fmtRelTime(run.created_at)}</span>
            <span class="ip-run-caret" class:open={expandedRunId === run.id}>▾</span>
          </button>

          {#if run.error && expandedRunId !== run.id}
            <div class="ip-run-err-pre">
              <span class="ip-run-err-lbl">error</span>
              <span class="ip-run-err-txt">{run.error.slice(0, 160)}{run.error.length > 160 ? '…' : ''}</span>
            </div>
          {/if}
          {#if run.result && expandedRunId !== run.id}
            {@const prev = plainStepText(run.result)}
            <div class="ip-run-prev">{prev.slice(0, 200)}{prev.length > 200 ? '…' : ''}</div>
          {/if}

          {#if expandedRunId === run.id}
            <div class="ip-run-body">
              <div class="ip-run-meta-row">
                <span class="ip-run-meta-item">run <code>{run.id.slice(0, 8)}</code>
                  <button class="ip-copy-inline" title="copy run id" on:click={() => onCopy(run.id, 'run-' + run.id)}>{copiedKey === 'run-' + run.id ? '✓' : '⧉'}</button>
                </span>
                <span class="ip-run-meta-item">{new Date(run.created_at).toLocaleString()}</span>
              </div>

              {#if run.error}
                <div class="ip-err-box">
                  <div class="ip-err-head">
                    <span class="ip-err-lbl">⚠ error</span>
                    <button class="ip-icon-btn ip-icon-btn-err" title="copy error" on:click={() => onCopy(run.error ?? '', 'err-' + run.id)}>{copiedKey === 'err-' + run.id ? '✓ copied' : '⧉ copy'}</button>
                  </div>
                  <pre class="ip-err-txt">{run.error}</pre>
                </div>
              {/if}

              {#if run.result}
                <div class="ip-out-box">
                  <div class="ip-out-head">
                    <span class="ip-out-lbl">📤 agent output (handoff)</span>
                    <button class="ip-icon-btn" title="copy output" on:click={() => onCopy(run.result ?? '', 'out-' + run.id)}>{copiedKey === 'out-' + run.id ? '✓ copied' : '⧉ copy'}</button>
                  </div>
                  <div class="ip-out-md" on:click={onOutputClick} role="presentation">
                    {@html formatRunOutput(run.result)}
                  </div>
                </div>
              {/if}

              {#if stepsLoading}
                <div class="ip-loading">Loading steps…</div>
              {:else if stepsError}
                <div class="ip-loading ip-error">
                  ⚠ Failed to load steps: {stepsError}
                  <button class="ip-retry" on:click={() => onRetryRun(run.id)}>retry</button>
                </div>
              {:else if steps.length > 0}
                {@const regularSteps = steps.filter(s => !s.is_event)}
                {@const eventEntries = steps.filter(s => s.is_event)}
                {@const rows = groupHistoryRows(steps)}
                {@const allOpen = rows.every(r => openSteps.has(rowKey(run.id, r)))}
                <div class="ip-steps-h">
                  Steps <span class="ip-sec-c">{regularSteps.length}</span>
                  {#if eventEntries.length}<span class="ip-sec-c ip-sec-c-ev">+ {eventEntries.length} events</span>{/if}
                  <button type="button" class="hs-toggle-all" on:click={() => setAll(run.id, rows, !allOpen)}>
                    {allOpen ? 'Collapse all' : 'Expand all'}
                  </button>
                </div>
                <ol class="hs-steps">
                  {#each rows as row (rowKey(run.id, row))}
                  {#if row.kind === 'tools'}
                    {@const gkey = rowKey(run.id, row)}
                    {@const gOpen = openSteps.has(gkey)}
                    {@const failed = row.uses.filter(u => !u.ok).length}
                    <li class="hs-step hs-group live-cat-tool" class:hs-open={gOpen} class:hs-group-fail={failed > 0}>
                      <span class="hs-dot"></span>
                      <button type="button" class="hs-row hs-group-row" aria-expanded={gOpen}
                              title={gOpen ? 'Hide tool calls' : 'Show every tool call with its input and output'}
                              on:click={() => toggleStep(gkey)}>
                        <span class="hs-num">{row.range}</span>
                        <span class="hs-icon" aria-hidden="true">🔧</span>
                        <span class="hs-type">{row.uses.length === 1 ? 'tool' : `${row.uses.length} tools`}</span>
                        <span class="hs-chips">
                          {#each toolChips(row.uses) as c, ci (ci)}
                            {#if ci > 0}<span class="hs-chip-sep" aria-hidden="true">→</span>{/if}
                            <span class="hs-chip" class:bad={c.failed > 0 && c.pending === 0} class:pending={c.pending > 0}
                                  title={chipTitle(c)}>
                              <span class="hs-chip-st" aria-label={c.pending > 0 ? 'no result' : c.failed > 0 ? 'failed' : 'succeeded'}>{c.pending > 0 ? '…' : c.failed > 0 ? '✗' : '✓'}</span>
                              <span class="hs-chip-name">{c.name}</span>
                              {#if c.count > 1}
                                <span class="hs-chip-count">×{c.count}{#if c.failed > 0}<span class="hs-chip-count-bad"> · {c.failed} ✗</span>{/if}</span>
                              {/if}
                            </span>
                          {/each}
                        </span>
                        {#if failed > 0}<span class="hs-fail-count">{failed} failed</span>{/if}
                        <span class="hs-chev" aria-hidden="true">{gOpen ? '▾' : '▸'}</span>
                      </button>
                      {#if gOpen}
                        <ol class="hs-uses">
                          {#each row.uses as u, ui (ui)}
                            {@const callTxt = u.call ? summarizeToolCall(u.fullName, u.call.tool_input ?? '') : ''}
                            {@const resTxt = u.result ? summarizeToolResult(u.fullName, u.result.tool_output ?? '') : ''}
                            {@const mail = u.result ? emailCommId(u.fullName, u.result.tool_output ?? '') : null}
                            <li class="hs-use" class:bad={!u.ok}>
                              <div class="hs-use-head">
                                <span class="hs-chip-st">{!u.result ? '…' : u.ok ? '✓' : '✗'}</span>
                                <code class="hs-tool" title={u.fullName}>{u.name}</code>
                                <span class="hs-use-sum">{resTxt || callTxt || (u.result ? 'No output' : 'No result recorded')}</span>
                                {#if mail}<button class="email-view-link" on:click|stopPropagation={() => onOpenEmail(mail)}>📧 Ver email</button>{/if}
                              </div>
                              <div class="hs-use-body">
                                {#if u.call}
                                  <StepPayload detail={historyStepDetail(u.call)} copyText={u.call.tool_input ?? ''} {onOutputClick} />
                                {/if}
                                {#if u.result}
                                  <StepPayload detail={historyStepDetail(u.result)} copyText={u.result.tool_output ?? ''} {onOutputClick} />
                                {:else}
                                  <p class="hs-pending-note">No result was recorded — the run ended before this call returned.</p>
                                {/if}
                              </div>
                            </li>
                          {/each}
                        </ol>
                      {/if}
                    </li>
                  {:else if row.kind === 'action'}
                    {@const u = row.use}
                    {@const akey = rowKey(run.id, row)}
                    {@const aOpen = openSteps.has(akey)}
                    {@const act = agentActionOf(u.fullName, u.call?.tool_input ?? '', u.result ? { preview: String(u.result.tool_output ?? ''), failed: !u.ok } : undefined, nameOf)}
                    {#if act}
                    <li class="hs-step hs-action hs-action-{act.outcome}" class:hs-open={aOpen}>
                      <span class="hs-dot"></span>
                      <button type="button" class="hs-row hs-action-row" aria-expanded={aOpen}
                              title={aOpen ? 'Hide details' : 'Show details'} on:click={() => toggleStep(akey)}>
                        <span class="hs-num">{(u.call ?? u.result)?.step_number ?? ''}</span>
                        <AgentActionBody action={act} />
                        <span class="hs-chev" aria-hidden="true">{aOpen ? '▾' : '▸'}</span>
                      </button>
                      {#if aOpen}
                        <div class="hs-use-body">
                          {#if u.call}
                            <StepPayload detail={historyStepDetail(u.call)} copyText={u.call.tool_input ?? ''} {onOutputClick} />
                          {/if}
                          {#if u.result}
                            <StepPayload detail={historyStepDetail(u.result)} copyText={u.result.tool_output ?? ''} {onOutputClick} />
                          {:else}
                            <p class="hs-pending-note">No result was recorded — the run ended before this call returned.</p>
                          {/if}
                        </div>
                      {/if}
                    </li>
                    {/if}
                  {:else}
                    {@const step = row.step}
                    {@const fe = step.event ?? stepAsFlowEvent(step)}
                    {@const etype = liveEventType(fe)}
                    {@const cat = liveStepCategory(fe)}
                    {@const key = stepKey(run.id, step)}
                    {@const isOpen = openSteps.has(key)}
                    {@const detail = step.event ? liveEventDetail(step.event) : null}
                    {@const hasDetail = step.event ? detail !== null : true}
                    {@const mailId = emailCommId(step.tool_name, step.tool_output ?? step.content)}
                    <li class="hs-step live-cat-{cat} hs-type-{etype}" class:hs-open={isOpen} class:hs-event={step.is_event}>
                      <span class="hs-dot"></span>
                      <button
                        type="button"
                        class="hs-row"
                        disabled={!hasDetail}
                        aria-expanded={hasDetail ? isOpen : undefined}
                        title={hasDetail ? (isOpen ? 'Hide details' : 'Show details') : ''}
                        on:click={() => hasDetail && toggleStep(key)}
                      >
                        <span class="hs-num">{step.step_number}</span>
                        <span class="hs-icon" aria-hidden="true">{liveStepIcon(etype)}</span>
                        <span class="hs-type">{liveStepLabel(etype)}</span>
                        {#if step.tool_name}<code class="hs-tool" title={step.tool_name}>{shortToolName(step.tool_name)}</code>{/if}
                        <span class="hs-text">{liveStepSummary(fe)}</span>
                        {#if hasDetail}<span class="hs-chev" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>{/if}
                      </button>
                      {#if mailId}
                        <button class="email-view-link" on:click|stopPropagation={() => onOpenEmail(mailId)} title="Ver el email enviado (de/para/asunto/cuerpo)">📧 Ver email</button>
                      {/if}
                      {#if isOpen && detail}
                        <LiveEventDetail {detail} {onOutputClick} />
                      {:else if isOpen && !step.event}
                        <div class="hs-detail">
                          <StepPayload detail={historyStepDetail(step)} copyText={stepCopyText(step)} {onOutputClick} />
                        </div>
                      {/if}
                    </li>
                  {/if}
                  {/each}
                </ol>
              {:else}
                <div class="ip-loading ip-empty-steps">
                  No steps recorded for this run.
                  {#if run.status === 'failed'}<br/><span class="ip-loading-dim">The run errored before producing any steps.</span>{/if}
                  {#if run.status === 'running'}<br/><span class="ip-loading-dim">Still running — refresh in a moment.</span>{/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Moved from AgentWorld3D — the run cards, the step timeline, the KPI grid,
     the icon buttons and `@keyframes led-pulse` had no reader outside this tab.

     Copied, because the parent still needs its own: `.ip-body` (the LIVE,
     SKILLS and extension tabs use it), `.ip-loading` / `.ip-empty` / `.ip-empty b`,
     the base `.ip-out-md` (its `:global` children stay in the parent and reach
     the rendered markdown from there), `.ip-sec-c` (the LIVE tab prints it too)
     and `.email-view-link` (the LIVE tab has the same chip). */

  /* ── Body (scrollable) ────────── */
  .ip-body{
    flex:1;overflow-y:auto;overflow-x:hidden;
    padding:16px 18px 24px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .ip-body::-webkit-scrollbar{width:6px}
  .ip-body::-webkit-scrollbar-thumb{background:rgba(120,130,160,.2);border-radius:3px}
  .ip-body::-webkit-scrollbar-thumb:hover{background:rgba(120,130,160,.35)}

  @keyframes led-pulse{50%{opacity:.55}}

  /* ── KPI grid ────────────────── */
  .ip-kpis{
    display:grid;grid-template-columns:repeat(4,1fr);gap:1px;
    background:rgba(120,130,160,.1);border:1px solid rgba(120,130,160,.12);
    border-radius:10px;overflow:hidden;
    margin-bottom:18px;
  }
  .ip-kpi{
    padding:12px 8px;background:#0f1219;
    display:flex;flex-direction:column;align-items:center;gap:4px;
  }
  .ip-kpi-v{
    font:600 22px/1 'Syne',sans-serif;color:#f0f2f7;
    font-variant-numeric:tabular-nums;
  }
  .ip-kpi-unit{font-size:13px;color:#8a8fa8;font-weight:500;margin-left:1px}
  .ip-kpi-l{
    font:500 9px 'JetBrains Mono',monospace;
    color:#6a6f82;text-transform:uppercase;letter-spacing:.5px;
  }

  .ip-sec-c{
    font:600 9px 'JetBrains Mono',monospace;
    padding:1px 6px;border-radius:4px;
    background:rgba(120,130,160,.15);color:#a0a5b8;
    letter-spacing:0;text-transform:none;
  }

  .ip-out-md{
    font:400 12.5px/1.6 'Manrope',sans-serif;color:#d0d4e0;
    padding:14px 18px;border-radius:6px;background:rgba(0,0,0,.22);
    word-break:break-word;overflow-wrap:anywhere;max-height:380px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }

  /* ── Icon buttons ─────────── */
  .ip-icon-btn{
    background:rgba(120,130,160,.08);
    border:1px solid rgba(120,130,160,.15);
    color:#a0a5b8;
    padding:4px 8px;border-radius:5px;
    font:500 9px 'JetBrains Mono',monospace;letter-spacing:.3px;
    cursor:pointer;transition:all .12s;
    display:inline-flex;align-items:center;gap:4px;
    white-space:nowrap;
  }
  .ip-icon-btn:hover{background:rgba(120,130,160,.16);color:#f0f2f7}
  .ip-icon-btn-err{color:#ef5d6e;background:rgba(239,93,110,.08);border-color:rgba(239,93,110,.2)}
  .ip-icon-btn-err:hover{background:rgba(239,93,110,.18);color:#ff7280}
  .ip-copy-inline{
    background:transparent;border:none;
    color:#6a6f82;cursor:pointer;
    font:400 11px monospace;line-height:1;padding:1px 4px;border-radius:3px;
    transition:color .12s;margin-left:4px;
  }
  .ip-copy-inline:hover{color:#d8dae3;background:rgba(120,130,160,.1)}

  /* ═══════════════════════════════════════════════════════════════
     HISTORY TAB — run cards with expandable timeline
     ═══════════════════════════════════════════════════════════════ */
  .ip-runs{display:flex;flex-direction:column;gap:8px}
  .ip-run-card{
    border-radius:10px;
    background:linear-gradient(180deg, rgba(255,255,255,.02) 0%, rgba(255,255,255,0) 100%);
    border:1px solid rgba(120,130,160,.14);
    overflow:hidden;
    transition:border-color .15s;
  }
  .ip-run-card:hover{border-color:rgba(120,130,160,.25)}
  .ip-run-card.expanded{border-color:rgba(61,214,200,.35);background:rgba(61,214,200,.02)}
  .ip-run-card.run-fail{border-left:3px solid #ef5d6e}
  .ip-run-card.run-ok{border-left:3px solid #78dc8c}
  .ip-run-card.run-live{border-left:3px solid #6aa0ff}

  .ip-run-head{
    display:grid;
    grid-template-columns:18px auto auto auto 1fr auto;
    align-items:center;gap:10px;
    padding:10px 12px;
    background:none;border:none;
    color:#b0b5c8;
    cursor:pointer;text-align:left;
    font-family:inherit;width:100%;
    transition:background .1s;
  }
  .ip-run-head:hover{background:rgba(255,255,255,.02)}
  .ip-run-status{font:700 12px 'JetBrains Mono',monospace;width:16px;text-align:center}
  .ip-run-status.ok{color:#78dc8c}
  .ip-run-status.fail{color:#ef5d6e}
  .ip-run-status.running{color:#6aa0ff;animation:led-pulse 1s ease-in-out infinite}
  .ip-run-trigger{
    font:600 9px 'JetBrains Mono',monospace;
    color:var(--c,#8a8fa8);
    background:color-mix(in srgb, var(--c,#8a8fa8) 12%, transparent);
    border:1px solid color-mix(in srgb, var(--c,#8a8fa8) 25%, transparent);
    padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px;
  }
  .ip-run-steps{font:500 10px 'JetBrains Mono',monospace;color:#a0a5b8}
  .ip-run-tokens{font:500 10px 'JetBrains Mono',monospace;color:#8a8fa8}
  .ip-run-time{
    font:500 10px 'Manrope',sans-serif;color:#6a6f82;
    text-align:right;
  }
  .ip-run-caret{
    color:#6a6f82;transition:transform .2s;font-size:11px;
  }
  .ip-run-caret.open{transform:rotate(180deg);color:var(--flow-color)}

  .ip-run-err-pre{
    display:flex;gap:8px;align-items:baseline;
    padding:0 12px 10px;
    font:500 11px 'Manrope',sans-serif;
  }
  .ip-run-err-lbl{
    font:600 9px 'JetBrains Mono',monospace;
    color:#ef5d6e;text-transform:uppercase;letter-spacing:.5px;
    padding:2px 6px;border-radius:4px;
    background:rgba(239,93,110,.12);
  }
  .ip-run-err-txt{color:#ef8090;word-break:break-word;line-height:1.4;flex:1}
  .ip-run-prev{
    padding:0 12px 12px;
    font:400 12px/1.5 'Manrope',sans-serif;
    color:#8a8fa8;word-break:break-word;
  }

  .ip-run-body{
    padding:12px;
    border-top:1px solid rgba(120,130,160,.1);
    background:rgba(0,0,0,.15);
  }
  .ip-run-meta-row{
    display:flex;gap:12px;flex-wrap:wrap;align-items:center;
    padding-bottom:10px;margin-bottom:12px;
    border-bottom:1px dashed rgba(120,130,160,.12);
  }
  .ip-run-meta-item{
    font:500 10px 'JetBrains Mono',monospace;color:#8a8fa8;
    display:inline-flex;align-items:center;gap:4px;
  }
  .ip-run-meta-item code{color:#d8dae3;background:rgba(0,0,0,.3);padding:1px 6px;border-radius:3px}

  /* Error + output blocks */
  .ip-err-box{
    border:1px solid rgba(239,93,110,.3);
    background:rgba(239,93,110,.06);
    border-radius:8px;
    margin-bottom:12px;
    overflow:hidden;
  }
  .ip-err-head{
    display:flex;justify-content:space-between;align-items:center;
    padding:8px 12px;
    background:rgba(239,93,110,.1);
    border-bottom:1px solid rgba(239,93,110,.15);
  }
  .ip-err-lbl{font:600 10px 'JetBrains Mono',monospace;color:#ef5d6e;text-transform:uppercase;letter-spacing:.5px}
  .ip-err-txt{
    margin:0;padding:12px;
    font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#ff9ba8;white-space:pre-wrap;word-break:break-word;
    max-height:240px;overflow-y:auto;
  }

  .ip-out-box{
    border:1px solid rgba(61,214,200,.25);
    background:rgba(61,214,200,.04);
    border-radius:8px;
    margin-bottom:12px;
    overflow:hidden;
  }
  .ip-out-head{
    display:flex;justify-content:space-between;align-items:center;
    padding:8px 12px;
    background:rgba(61,214,200,.08);
    border-bottom:1px solid rgba(61,214,200,.15);
  }
  .ip-out-lbl{font:600 10px 'Syne',sans-serif;color:#3dd6c8;text-transform:uppercase;letter-spacing:.8px}

  /* Steps timeline */
  .ip-steps-h{
    font:600 10px 'Syne',sans-serif;color:#8a8fa8;
    text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;
    display:flex;align-items:center;gap:6px;
  }
  .ip-sec-c-ev{color:#d4a84b;margin-left:2px}
  .hs-toggle-all{
    margin-left:auto;padding:3px 9px;border-radius:4px;cursor:pointer;
    font:600 9.5px 'Manrope',sans-serif;letter-spacing:.3px;text-transform:none;
    color:#a8b0c8;background:rgba(120,130,160,.08);border:1px solid rgba(120,130,160,.18);
    transition:background .12s,color .12s;
  }
  .hs-toggle-all:hover{background:rgba(120,130,160,.16);color:#e0e3ee}
  .hs-toggle-all:focus-visible,.hs-row:focus-visible{outline:2px solid rgba(106,160,255,.7);outline-offset:1px}

  /* Steps timeline — one row per step, same reading as the LIVE tab. */
  .hs-steps{
    list-style:none;margin:0;padding:0 0 0 20px;position:relative;
    display:flex;flex-direction:column;gap:2px;
  }
  .hs-steps::before{
    content:'';position:absolute;left:7px;top:10px;bottom:10px;width:1px;
    background:linear-gradient(180deg, rgba(120,130,160,.3) 0%, rgba(120,130,160,.05) 100%);
  }
  .hs-step{position:relative;padding:2px 0 2px 4px}
  .hs-dot{
    position:absolute;left:-17px;top:11px;width:9px;height:9px;border-radius:50%;
    background:#3a3f52;border:2px solid #0b0d14;z-index:1;
  }
  .hs-row{
    width:100%;display:flex;align-items:center;gap:8px;min-width:0;
    padding:6px 10px;border-radius:7px;border:1px solid transparent;
    background:transparent;color:inherit;text-align:left;cursor:pointer;
    font:500 10.5px 'JetBrains Mono',monospace;
    transition:background .12s,border-color .12s;
  }
  .hs-row:disabled{cursor:default}
  .hs-row:hover:not(:disabled){background:rgba(255,255,255,.025);border-color:rgba(120,130,160,.15)}
  .hs-open .hs-row{
    background:rgba(255,255,255,.03);border-color:rgba(120,130,160,.18);
    border-bottom-left-radius:0;border-bottom-right-radius:0;
  }
  .hs-num{color:#5a5f78;min-width:16px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0}
  .hs-icon{font-size:11px;flex-shrink:0}
  .hs-type{
    text-transform:uppercase;letter-spacing:.6px;font-size:9px;font-weight:700;flex-shrink:0;
    padding:1px 6px;border-radius:3px;background:rgba(120,130,160,.12);color:#a0a5b8;
  }
  .hs-tool{
    font:600 10px 'JetBrains Mono',monospace;color:#d0b87a;flex-shrink:1;min-width:0;
    max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    padding:1px 5px;border-radius:3px;background:rgba(208,184,122,.10);
  }
  .hs-text{
    flex:1;min-width:0;color:#d6dae8;font:400 11.5px/1.45 'Manrope',sans-serif;
    /* Two lines before the ellipsis, as in LIVE. */
    display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;
    overflow:hidden;word-break:break-word;
  }
  .hs-open .hs-text{-webkit-line-clamp:unset;line-clamp:none;display:block}
  .hs-chev{color:#6a6f82;font-size:11px;width:14px;text-align:center;flex-shrink:0}
  .hs-open .hs-chev{color:#a0a5b8}
  .hs-event .hs-row{background:rgba(212,168,75,.03)}

  .hs-detail{
    position:relative;margin:0 0 4px;padding:10px 12px;
    border:1px solid rgba(120,130,160,.18);border-top:none;border-radius:0 0 7px 7px;
    background:rgba(8,10,18,.7);animation:hs-in .16s ease-out;
  }
  @keyframes hs-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){ .hs-detail{animation:none} }

  /* Folded run of tool steps: one row, one chip per tool, opens into each call. */
  .hs-group-row{align-items:center}
  .hs-chips{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px 4px}
  .hs-chip{
    display:inline-flex;align-items:center;gap:4px;max-width:100%;
    padding:2px 7px;border-radius:999px;
    font:600 10px 'JetBrains Mono',monospace;color:#d8dbe8;
    background:rgba(95,219,160,.08);border:1px solid rgba(95,219,160,.22);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .hs-chip.bad{background:rgba(239,93,110,.10);border-color:rgba(239,93,110,.4);color:#f6c3ca}
  .hs-chip.pending{background:rgba(120,130,160,.08);border-color:rgba(120,130,160,.25);color:#a8b0c8}
  .hs-chip-st{font-weight:800;color:#5fdba0}
  .bad .hs-chip-st,.hs-use.bad .hs-chip-st{color:#ef5d6e}
  .pending .hs-chip-st{color:#9aa3c0}
  .hs-chip-sep{color:#4f5570;font-size:10px}
  .hs-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
  /* Run of identical calls: "×25", plus "· 2 ✗" when some of them failed. */
  .hs-chip-count{
    flex-shrink:0;padding:0 5px;border-radius:999px;
    font:700 9px 'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;
    color:#5fdba0;background:rgba(95,219,160,.14);
  }
  .hs-chip.bad .hs-chip-count{color:#f6c3ca;background:rgba(239,93,110,.18)}
  .hs-chip.pending .hs-chip-count{color:#a8b0c8;background:rgba(120,130,160,.16)}
  .hs-chip-count-bad{color:#ef5d6e}
  .hs-fail-count{
    flex-shrink:0;font:700 9px 'Manrope',sans-serif;letter-spacing:.4px;text-transform:uppercase;
    color:#ef8090;padding:1px 6px;border-radius:3px;background:rgba(239,93,110,.12);
  }
  .hs-group-fail .hs-dot{background:#ef5d6e}

  .hs-uses{
    list-style:none;margin:0 0 4px;padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px;
    border:1px solid rgba(120,130,160,.18);border-top:none;border-radius:0 0 7px 7px;
    background:rgba(8,10,18,.7);animation:hs-in .16s ease-out;
  }
  @media (prefers-reduced-motion: reduce){ .hs-uses{animation:none} }
  .hs-use{border-left:2px solid rgba(95,219,160,.35);padding-left:10px}
  .hs-use.bad{border-left-color:rgba(239,93,110,.6)}
  .hs-use-head{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:6px}
  .hs-use-head .hs-tool{max-width:45%}
  .hs-use-sum{flex:1;min-width:0;font:400 11.5px/1.4 'Manrope',sans-serif;color:#c8cde0;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hs-use-body{display:flex;flex-direction:column;gap:6px}
  .hs-pending-note{margin:0;font:italic 400 11.5px 'Manrope',sans-serif;color:#7d839c}

  /* Category colours — the same palette LIVE uses, so a tool reads the same in both tabs. */
  .live-cat-shell  .hs-dot{background:#fbbf24} .live-cat-shell  .hs-type{background:rgba(251,191,36,.14);color:#fbbf24}
  .live-cat-fs     .hs-dot{background:#6aa0ff} .live-cat-fs     .hs-type{background:rgba(106,160,255,.14);color:#6aa0ff}
  .live-cat-web    .hs-dot{background:#4dd6e0} .live-cat-web    .hs-type{background:rgba(77,214,224,.14);color:#4dd6e0}
  .live-cat-kernel .hs-dot{background:#5fdba0} .live-cat-kernel .hs-type{background:rgba(95,219,160,.14);color:#5fdba0}
  .live-cat-mcp    .hs-dot{background:#c693ff} .live-cat-mcp    .hs-type{background:rgba(198,147,255,.14);color:#c693ff}
  .live-cat-think  .hs-dot{background:#a78bfa} .live-cat-think  .hs-type{background:rgba(167,139,250,.14);color:#a78bfa}
  .live-cat-final  .hs-dot{background:#78dc8c} .live-cat-final  .hs-type{background:rgba(120,220,140,.14);color:#78dc8c}
  .live-cat-error  .hs-dot{background:#ef5d6e} .live-cat-error  .hs-type{background:rgba(239,93,110,.16);color:#ef8090}
  .live-cat-tool   .hs-dot{background:#d0b87a} .live-cat-tool   .hs-type{background:rgba(208,184,122,.14);color:#d0b87a}
  .live-cat-meta   .hs-dot{background:#9aa3c0}
  .hs-type-auto_eval .hs-dot{background:#f59e0b} .hs-type-auto_eval .hs-type{color:#f59e0b;background:rgba(245,158,11,.12)}
  .hs-type-learning_created .hs-dot{background:#d4a84b} .hs-type-learning_created .hs-type{color:#d4a84b;background:rgba(212,168,75,.12)}
  .hs-type-run_started .hs-dot{background:#3dd68c}
  .hs-type-run_completed .hs-dot{background:#78dc8c}

  /* Misc */
  .ip-loading,.ip-empty{
    font:500 11px 'Manrope',sans-serif;color:#6a6f82;
    text-align:center;padding:24px 12px;
  }
  .ip-empty b{color:#d8dae3;font-weight:600}
  .ip-error{color:#f47070;display:flex;flex-direction:column;gap:8px;align-items:center}
  .ip-empty-steps{color:#8a8f9e}
  .ip-loading-dim{color:#5a5f70;font-size:10px}
  .ip-retry{
    background:transparent;border:1px solid #5a5f70;color:#aab0c0;
    font:500 10px 'Manrope',sans-serif;padding:3px 10px;border-radius:3px;cursor:pointer;
  }
  .ip-retry:hover{border-color:#aab0c0;color:#fff}

  /* ── Sent-email link ── */
  .email-view-link{
    display:inline-flex; align-items:center; gap:3px; margin-left:6px;
    padding:1px 7px; font:600 10px 'Manrope',sans-serif; cursor:pointer;
    color:#9fd0ff; background:rgba(91,141,239,.12); border:1px solid rgba(91,141,239,.45);
    border-radius:999px; white-space:nowrap;
  }
  .email-view-link:hover{ background:rgba(91,141,239,.28); color:#fff; }

  /* An agent acting on another agent — same card as the LIVE tab
     (AgentActionBody), so a message, an edit or a run stands out of the
     tool noise with its recipient and outcome. */
  .hs-action{--act:#f0b44c}
  .hs-action-failed{--act:#ef5d6e}
  .hs-action .hs-dot{background:var(--act);box-shadow:0 0 0 3px color-mix(in srgb, var(--act) 22%, transparent)}
  .hs-action .hs-action-row{
    align-items:flex-start;gap:10px;margin:3px 0;padding:9px 11px 10px;
    background:color-mix(in srgb, var(--act) 7%, transparent);
    border:1px solid color-mix(in srgb, var(--act) 30%, transparent);
    border-left:3px solid var(--act);
  }
  .hs-action .hs-action-row:hover{
    background:color-mix(in srgb, var(--act) 11%, transparent);
    border-color:color-mix(in srgb, var(--act) 45%, transparent);
    border-left-color:var(--act);
  }
  .hs-action .hs-num{padding-top:2px}
</style>
