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

  export let steps: Array<{
    step_number: number; type: string; content: string;
    tool_name: string; tool_output?: string; is_event?: boolean;
  }> = [];
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
      {#each runs as run}
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
            <div class="ip-run-prev">{run.result.slice(0, 160)}{run.result.length > 160 ? '…' : ''}</div>
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
                <div class="ip-steps-h">Steps <span class="ip-sec-c">{regularSteps.length}</span>{#if eventEntries.length}<span class="ip-sec-c ip-sec-c-ev">+ {eventEntries.length} events</span>{/if}</div>
                <ol class="ip-steps">
                  {#each steps as step}
                    <li class="ip-step step-{step.type}" class:step-event={step.is_event}>
                      <span class="ip-step-dot"></span>
                      <div class="ip-step-body">
                        <div class="ip-step-head">
                          <span class="ip-step-num">{step.step_number}</span>
                          {#if step.is_event}
                            <span class="ip-step-ev-badge">{step.type === 'auto_eval' ? '📝' : step.type === 'learning_created' ? '💡' : step.type === 'learning_deactivated' ? '🗑️' : '📌'}</span>
                          {/if}
                          <span class="ip-step-type">{step.type.replace(/_/g, ' ')}</span>
                          {#if step.tool_name}<code class="ip-step-tool">{step.tool_name}</code>{/if}
                          {#if emailCommId(step.tool_name, step.tool_output ?? step.content)}
                            <button class="email-view-link" on:click|stopPropagation={() => { const id = emailCommId(step.tool_name, step.tool_output ?? step.content); if (id) onOpenEmail(id); }} title="Ver el email enviado (de/para/asunto/cuerpo)">📧 Ver email</button>
                          {/if}
                          {#if step.content}
                            <button class="ip-copy-inline" title="copy step content" on:click={() => onCopy(step.content, 'step-' + run.id + '-' + step.step_number)}>{copiedKey === 'step-' + run.id + '-' + step.step_number ? '✓' : '⧉'}</button>
                          {/if}
                        </div>
                        {#if step.content}
                          <div class="ip-step-content ip-out-md" on:click={onOutputClick} role="presentation">
                            {@html formatRunOutput(step.content)}
                          </div>
                        {/if}
                      </div>
                    </li>
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
    display:inline-flex;align-items:center;gap:6px;
  }
  .ip-steps{
    list-style:none;margin:0;padding:0;
    display:flex;flex-direction:column;gap:2px;
    position:relative;padding-left:22px;
  }
  .ip-steps::before{
    content:'';position:absolute;left:7px;top:8px;bottom:8px;width:1px;
    background:linear-gradient(180deg, rgba(120,130,160,.3) 0%, rgba(120,130,160,.05) 100%);
  }
  .ip-step{
    position:relative;padding:6px 10px;border-radius:6px;
    transition:background .1s;
  }
  .ip-step:hover{background:rgba(255,255,255,.02)}
  .ip-step-dot{
    position:absolute;left:-18px;top:11px;
    width:9px;height:9px;border-radius:50%;
    background:#3a3f52;border:2px solid #0b0d14;
  }
  .step-tool_call .ip-step-dot{background:#fbbf24}
  .step-tool_result .ip-step-dot{background:#6aa0ff}
  .step-thought .ip-step-dot{background:#8a8fa8}
  .step-final .ip-step-dot{background:#78dc8c;box-shadow:0 0 8px rgba(120,220,140,.5)}
  .step-error .ip-step-dot{background:#ef5d6e}
  .step-auto_eval .ip-step-dot{background:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,.5)}
  .step-learning_created .ip-step-dot{background:#d4a84b;box-shadow:0 0 8px rgba(212,168,75,.5)}
  .step-learning_deactivated .ip-step-dot{background:#8a8fa8}
  .step-chain_triggered .ip-step-dot{background:#a78bfa}

  .ip-step-head{display:flex;align-items:center;gap:8px;font:500 10px 'JetBrains Mono',monospace;flex-wrap:wrap}
  .ip-step-num{color:#6a6f82;min-width:18px}
  .ip-step-ev-badge{font-size:13px;line-height:1}
  .ip-step-type{
    color:#a0a5b8;text-transform:uppercase;letter-spacing:.5px;font-size:9px;font-weight:600;
    padding:1px 6px;border-radius:3px;background:rgba(120,130,160,.1);
  }
  .step-tool_call .ip-step-type{color:#fbbf24;background:rgba(251,191,36,.1)}
  .step-tool_result .ip-step-type{color:#6aa0ff;background:rgba(106,160,255,.1)}
  .step-final .ip-step-type{color:#78dc8c;background:rgba(120,220,140,.1)}
  .step-error .ip-step-type{color:#ef5d6e;background:rgba(239,93,110,.1)}
  .step-auto_eval .ip-step-type{color:#f59e0b;background:rgba(245,158,11,.12)}
  .step-learning_created .ip-step-type{color:#d4a84b;background:rgba(212,168,75,.12)}
  .step-learning_deactivated .ip-step-type{color:#8a8fa8;background:rgba(120,130,160,.1)}
  .step-event{border-left:2px solid rgba(212,168,75,.4);margin-left:-2px}
  .step-event .ip-step-content{background:rgba(212,168,75,.06);border:1px solid rgba(212,168,75,.12)}
  .ip-sec-c-ev{color:#d4a84b;margin-left:6px}
  .ip-step-tool{color:#d8dae3;font-weight:500;word-break:break-all}
  .ip-step-content{
    margin-top:4px;padding:6px 8px;border-radius:4px;
    background:rgba(0,0,0,.2);
    font:400 10px/1.5 'JetBrains Mono',monospace;
    color:#b0b5c8;word-break:break-word;white-space:pre-wrap;
  }

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
</style>
