<script lang="ts">
  /**
   * LIVE tab of the agent drawer — what the agent is doing right now: a hero
   * card for the newest event and a timeline of the current run below it.
   *
   * The event buffer belongs to AgentWorld3D (the world feeds it from the
   * stream and slices it to the current run), so it arrives as `events`.
   * Everything derived from that slice moved here with the markup — the head
   * event, the expand state, the delta/token chips and the run totals had no
   * reader anywhere else.
   */
  import type { AgentFlowEvent } from '$lib/stores.js';
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import { fmtClock } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import { emailCommId } from '$lib/agent-helpers.js';
  import {
    liveStepIcon, liveStepLabel, liveEventType, liveEventSummary,
    liveStepSummary, liveStepCategory, liveFmtDelta, liveFmtTokens,
    liveStepTokens, runElapsedMs, runTokensTotal,
    liveStepDeltaMs as liveStepDeltaMsOf,
    liveStepTokensTotal as liveStepTokensTotalOf,
  } from '$lib/live-steps.js';

  /** Name of the selected agent, for the hero header. */
  export let agentName = '';

  /** Events of the current run only — the world filters prior runs out. */
  export let events: AgentFlowEvent[] = [];

  /** UUID chips inside an expanded step open the entity preview. */
  export let onOutputClick: (e: MouseEvent) => void = () => {};
  /** A tool_result carrying an email id offers a link to the real message. */
  export let onOpenEmail: (commId: string) => void = () => {};

  $: liveHeadEvent = events[0] ?? null;

  // Set of step keys (`${ts}-${idx}`) that the user has expanded — controls
  // whether the detail panel renders below the summary line. Defaults to
  // collapsed for everything so the timeline stays scannable.
  let expandedLiveSteps = new Set<string>();
  function toggleLiveStep(key: string): void {
    if (expandedLiveSteps.has(key)) expandedLiveSteps.delete(key);
    else expandedLiveSteps.add(key);
    // Trigger Svelte reactivity (Set mutation isn't tracked otherwise).
    expandedLiveSteps = new Set(expandedLiveSteps);
  }

  // Delta and token chips read the live buffer; the maths lives in $lib/live-steps.
  function liveStepDeltaMs(i: number): number | null {
    return liveStepDeltaMsOf(events, i);
  }
  function liveStepTokensTotal(i: number): number {
    return liveStepTokensTotalOf(events, i);
  }
  $: liveRunElapsedMs = runElapsedMs(events);
  $: liveRunTokensTotal = runTokensTotal(events);
</script>

<div class="ip-body live-body">
  <div class="live-hero">
    <div class="live-hero-head">
      <span class="live-badge"><span class="live-dot-big"></span>LIVE</span>
      <span class="live-hero-name">{agentName}</span>
    </div>
    {#if liveHeadEvent}
      {@const hType = liveEventType(liveHeadEvent)}
      {@const hCat = liveStepCategory(liveHeadEvent)}
      <div class="live-now live-cat-{hCat}">
        <div class="live-now-icon-wrap">
          <span class="live-now-icon">{liveStepIcon(hType)}</span>
          <span class="live-now-halo"></span>
        </div>
        <div class="live-now-body copy-wrap">
          <CopyTextBtn text={String(liveHeadEvent.data.content_preview ?? '') || liveEventSummary(liveHeadEvent)} title="Copy event content" />
          <div class="live-now-lbl">{liveStepLabel(hType)}</div>
          {#if hType === 'tool_call' && liveHeadEvent.data.tool_name}
            <code class="live-tool">{liveHeadEvent.data.tool_name}</code>
          {/if}
          <div class="live-now-summary">{liveStepSummary(liveHeadEvent)}</div>
        </div>
        <div class="live-now-clock">{fmtClock(liveHeadEvent.ts)}</div>
      </div>
    {:else}
      <div class="live-now live-waiting">
        <div class="live-now-icon-wrap">
          <span class="live-now-icon">✨</span>
          <span class="live-now-halo"></span>
        </div>
        <div class="live-now-body">
          <div class="live-now-lbl">warming up</div>
          <div class="live-now-txt">Agent just started — waiting for the first step…</div>
        </div>
      </div>
    {/if}
  </div>

  <div class="live-timeline-head">
    <span class="live-timeline-h">Activity</span>
    <span class="ip-sec-c">{events.length}</span>
    {#if liveRunElapsedMs > 0 || liveRunTokensTotal > 0}
      <span class="live-totals">
        {#if liveRunElapsedMs > 0}<span class="live-totals-chip live-totals-time" title="Wall-clock elapsed since the first event in this run">⏱ {liveFmtDelta(liveRunElapsedMs)}</span>{/if}
        {#if liveRunTokensTotal > 0}<span class="live-totals-chip live-totals-tok" title="Cumulative tokens reported by the model so far">◉ {liveFmtTokens(liveRunTokensTotal)} tok</span>{/if}
      </span>
    {/if}
  </div>

  {#if events.length === 0}
    <div class="ip-empty">No events yet — stay tuned.</div>
  {:else}
    <ol class="live-timeline">
      {#each events as e, i (e.ts + '-' + i)}
        {@const etype = liveEventType(e)}
        {@const ecat = liveStepCategory(e)}
        {@const stepKey = e.ts + '-' + i}
        {@const isOpen = expandedLiveSteps.has(stepKey)}
        {@const hasDetail = etype === 'tool_call' || etype === 'tool_result' || etype === 'thought' || etype === 'final' || etype === 'error'}
        {@const dt = liveStepDeltaMs(i)}
        {@const stepTok = liveStepTokens(e)}
        {@const cumTok = liveStepTokensTotal(i)}
        <li class="live-step live-step-{etype} live-cat-{ecat}" class:live-step-head={i === 0} class:live-step-open={isOpen}>
          <span class="live-step-dot"></span>
          <button
            type="button"
            class="live-step-summary"
            disabled={!hasDetail}
            on:click={() => hasDetail && toggleLiveStep(stepKey)}
            title={hasDetail ? (isOpen ? 'Hide details' : 'Show details') : ''}
          >
            <span class="live-step-icon">{liveStepIcon(etype)}</span>
            <span class="live-step-type">{liveStepLabel(etype)}</span>
            {#if e.data.tool_name}<code class="live-step-tool">{e.data.tool_name}</code>{/if}
            <span class="live-step-text">{liveStepSummary(e)}</span>
            <span class="live-step-clock">{fmtClock(e.ts)}</span>
            {#if hasDetail}
              <span class="live-step-chev" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            {/if}
          </button>
          {#if etype === 'tool_result'}
            {@const _cid = emailCommId(e.data.tool_name, String(e.data.content_preview ?? e.data.result ?? ''))}
            {#if _cid}
              <button class="email-view-link" on:click|stopPropagation={() => onOpenEmail(_cid)} title="Ver el email enviado (de/para/asunto/cuerpo)">📧 Ver email</button>
            {/if}
          {/if}
          {#if dt !== null || stepTok > 0 || cumTok > 0}
            <div class="live-step-meta">
              {#if dt !== null && dt > 50}
                <span class="live-meta-chip live-meta-time" title="Time since the previous event">+{liveFmtDelta(dt)}</span>
              {/if}
              {#if stepTok > 0}
                <span class="live-meta-chip live-meta-tok" title="Tokens reported by the model for this step">◉ {liveFmtTokens(stepTok)} tok</span>
              {/if}
              {#if cumTok > 0 && cumTok !== stepTok}
                <span class="live-meta-chip live-meta-cum" title="Cumulative tokens for this run up to this step">Σ {liveFmtTokens(cumTok)}</span>
              {/if}
            </div>
          {/if}
          {#if hasDetail && isOpen}
            <div class="live-step-detail copy-wrap">
              <CopyTextBtn text={String(e.data.content_preview ?? '') || liveEventSummary(e)} title="Copy event content" />
              <div class="live-step-txt ip-out-md" on:click={onOutputClick} role="presentation">
                {@html formatRunOutput(liveEventSummary(e))}
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  /* Moved from AgentWorld3D: the whole `.live-*` stylesheet with its four
     keyframes, plus three rules whose last consumer was this tab —
     `.ip-sec-c`, `.email-view-link` and the `.ip-empty` half of the parent's
     `.ip-loading,.ip-empty` pair (the parent keeps `.ip-loading` alone).

     Copied, because the parent still needs its own: `.ip-body` (the SKILLS
     and extension tabs use it) and the base `.ip-out-md` (its `:global`
     children stay there and reach the rendered markdown from there).
     `.copy-wrap` is `:global` in the parent and arrives on its own. */

  .ip-body{
    flex:1;overflow-y:auto;overflow-x:hidden;
    padding:16px 18px 24px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .ip-body::-webkit-scrollbar{width:6px}
  .ip-body::-webkit-scrollbar-thumb{background:rgba(120,130,160,.2);border-radius:3px}
  .ip-body::-webkit-scrollbar-thumb:hover{background:rgba(120,130,160,.35)}

  .ip-empty{
    font:500 11px 'Manrope',sans-serif;color:#6a6f82;
    text-align:center;padding:24px 12px;
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

  /* ── Sent-email link ── */
  .email-view-link{
    display:inline-flex; align-items:center; gap:3px; margin-left:6px;
    padding:1px 7px; font:600 10px 'Manrope',sans-serif; cursor:pointer;
    color:#9fd0ff; background:rgba(91,141,239,.12); border:1px solid rgba(91,141,239,.45);
    border-radius:999px; white-space:nowrap;
  }
  .email-view-link:hover{ background:rgba(91,141,239,.28); color:#fff; }

  /* ── LIVE tab ── */
  @keyframes live-pulse{
    0%,100%{opacity:1;transform:scale(1)}
    50%{opacity:.45;transform:scale(.82)}
  }

  .live-body{padding-top:4px}
  .live-hero{
    margin:0 0 14px;padding:14px 16px;border-radius:12px;
    background:
      radial-gradient(600px 200px at 50% -80%, rgba(239,93,110,.18), transparent 70%),
      linear-gradient(180deg, #161a28 0%, #0d1020 100%);
    border:1px solid rgba(239,93,110,.25);
    box-shadow:0 4px 22px rgba(239,93,110,.12);
    position:relative;overflow:hidden;
  }
  .live-hero::before{
    content:'';position:absolute;inset:0;pointer-events:none;
    background:linear-gradient(90deg, transparent 0%, rgba(239,93,110,.08) 50%, transparent 100%);
    animation:live-sheen 3s ease-in-out infinite;
  }
  @keyframes live-sheen{
    0%{transform:translateX(-100%)}100%{transform:translateX(100%)}
  }
  .live-hero-head{
    display:flex;align-items:center;gap:10px;margin-bottom:12px;position:relative;z-index:1;
  }
  .live-badge{
    display:inline-flex;align-items:center;gap:6px;
    padding:3px 9px;border-radius:5px;
    background:rgba(239,93,110,.22);
    border:1px solid rgba(239,93,110,.5);
    font:700 9px 'Syne',sans-serif;letter-spacing:2px;color:#ff7a8a;
  }
  .live-dot-big{
    width:8px;height:8px;border-radius:50%;background:#ff3b4f;
    box-shadow:0 0 10px #ff3b4f, 0 0 18px rgba(255,59,79,.5);
    animation:live-pulse 1s ease-in-out infinite;
  }
  .live-hero-name{font:600 13px 'Manrope',sans-serif;color:#e0e2ea}

  .live-now{
    display:flex;align-items:flex-start;gap:14px;position:relative;z-index:1;
    padding:10px 12px;border-radius:10px;
    background:rgba(255,255,255,.02);border:1px solid rgba(120,130,160,.12);
  }
  .live-waiting{opacity:.75}
  .live-now-icon-wrap{position:relative;width:40px;height:40px;flex-shrink:0}
  .live-now-icon{
    position:relative;z-index:2;
    width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg, rgba(239,93,110,.25), rgba(239,93,110,.1));
    border:1px solid rgba(239,93,110,.4);
    border-radius:50%;font-size:18px;
  }
  .live-now-halo{
    position:absolute;inset:-4px;border-radius:50%;
    border:2px solid rgba(239,93,110,.45);
    animation:live-halo 1.6s ease-out infinite;
  }
  @keyframes live-halo{
    0%{transform:scale(.9);opacity:.8}
    100%{transform:scale(1.7);opacity:0}
  }
  .live-now-body{flex:1;min-width:0}
  .live-now-lbl{
    font:700 9px 'Syne',sans-serif;letter-spacing:1.2px;text-transform:uppercase;
    color:#ff7a8a;margin-bottom:3px;
  }
  .live-now-txt{
    font:500 12px/1.5 'Manrope',sans-serif;color:#e5e8f0;
    word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap;
    max-height:480px;overflow-y:auto;padding-right:4px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .live-tool{
    font:600 10px 'JetBrains Mono',monospace;
    background:rgba(251,191,36,.14);color:#fbbf24;
    padding:1px 6px;border-radius:3px;margin-right:6px;
  }
  .live-now-clock{
    flex-shrink:0;font:500 9px 'JetBrains Mono',monospace;color:#6a6f82;
  }

  .live-timeline-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:0 2px 6px;margin-bottom:4px;
    border-bottom:1px solid rgba(120,130,160,.12);
  }
  .live-timeline-h{
    font:700 9px 'Syne',sans-serif;letter-spacing:1.2px;
    text-transform:uppercase;color:#8a8fa8;
  }

  .live-timeline{
    list-style:none;margin:0;padding:0 0 0 20px;position:relative;
    display:flex;flex-direction:column;gap:2px;
  }
  .live-timeline::before{
    content:'';position:absolute;left:7px;top:10px;bottom:10px;width:1px;
    background:linear-gradient(180deg, rgba(239,93,110,.35) 0%, rgba(120,130,160,.08) 100%);
  }
  .live-step{
    position:relative;padding:4px 0 4px 6px;border-radius:7px;
    transition:background .12s;
  }
  .live-step-dot{
    position:absolute;left:-18px;top:11px;
    width:9px;height:9px;border-radius:50%;
    background:#3a3f52;border:2px solid #0d1020;
    z-index:1;
  }
  /* Category-driven dot color — replaces the old per-event-type overrides
     so kernel_* tools, MCP tools, web fetches all get their own hue. */
  .live-cat-shell  .live-step-dot{background:#fbbf24}
  .live-cat-fs     .live-step-dot{background:#6aa0ff}
  .live-cat-web    .live-step-dot{background:#4dd6e0}
  .live-cat-kernel .live-step-dot{background:#5fdba0}
  .live-cat-mcp    .live-step-dot{background:#c693ff}
  .live-cat-think  .live-step-dot{background:#a78bfa}
  .live-cat-final  .live-step-dot{background:#78dc8c;box-shadow:0 0 8px rgba(120,220,140,.55)}
  .live-cat-error  .live-step-dot{background:#ef5d6e}
  .live-cat-meta   .live-step-dot{background:#9aa3c0}
  .live-cat-tool   .live-step-dot{background:#d0b87a}
  .live-step-run_started .live-step-dot{background:#3dd68c}
  .live-step-run_completed .live-step-dot{background:#78dc8c}
  .live-step-head .live-step-dot{
    box-shadow:0 0 0 4px rgba(239,93,110,.18), 0 0 14px rgba(239,93,110,.55);
    animation:live-pulse 1.2s ease-in-out infinite;
  }

  /* ── Summary row — one line of plain-language action description.
     Whole row is a button: click to expand the JSON payload below. */
  .live-step-summary{
    width:100%;display:flex;align-items:center;gap:8px;flex-wrap:nowrap;
    padding:6px 10px;border-radius:7px;border:1px solid transparent;
    background:transparent;color:inherit;text-align:left;cursor:pointer;
    font:500 10.5px 'JetBrains Mono',monospace;
    transition:background .12s, border-color .12s;
    min-width:0;
  }
  .live-step-summary:disabled{cursor:default}
  .live-step-summary:hover:not(:disabled){
    background:rgba(255,255,255,.025);
    border-color:rgba(120,130,160,.15);
  }
  .live-step-open .live-step-summary{
    background:rgba(255,255,255,.03);
    border-color:rgba(120,130,160,.18);
    border-bottom-left-radius:0;border-bottom-right-radius:0;
  }
  .live-step-icon{font-size:11px;flex-shrink:0}
  .live-step-type{
    text-transform:uppercase;letter-spacing:.6px;font-size:9px;font-weight:700;
    padding:1px 6px;border-radius:3px;background:rgba(120,130,160,.12);color:#a0a5b8;
    flex-shrink:0;
  }
  .live-cat-shell  .live-step-type{background:rgba(251,191,36,.14);color:#fbbf24}
  .live-cat-fs     .live-step-type{background:rgba(106,160,255,.14);color:#6aa0ff}
  .live-cat-web    .live-step-type{background:rgba(77,214,224,.14);color:#4dd6e0}
  .live-cat-kernel .live-step-type{background:rgba(95,219,160,.14);color:#5fdba0}
  .live-cat-mcp    .live-step-type{background:rgba(198,147,255,.14);color:#c693ff}
  .live-cat-think  .live-step-type{background:rgba(167,139,250,.14);color:#a78bfa}
  .live-cat-final  .live-step-type{background:rgba(120,220,140,.14);color:#78dc8c}
  .live-cat-error  .live-step-type{background:rgba(239,93,110,.16);color:#ef8090}
  .live-cat-meta   .live-step-type{background:rgba(154,163,192,.14);color:#9aa3c0}
  .live-cat-tool   .live-step-type{background:rgba(208,184,122,.14);color:#d0b87a}
  .live-step-tool{
    font:600 10px 'JetBrains Mono',monospace;color:#d0b87a;flex-shrink:0;
    padding:1px 5px;border-radius:3px;background:rgba(208,184,122,.10);
  }
  .live-cat-shell  .live-step-tool{color:#fbbf24;background:rgba(251,191,36,.10)}
  .live-cat-fs     .live-step-tool{color:#6aa0ff;background:rgba(106,160,255,.10)}
  .live-cat-web    .live-step-tool{color:#4dd6e0;background:rgba(77,214,224,.10)}
  .live-cat-kernel .live-step-tool{color:#5fdba0;background:rgba(95,219,160,.10)}
  .live-cat-mcp    .live-step-tool{color:#c693ff;background:rgba(198,147,255,.10)}
  /* The human-readable summary — takes the rest of the row and truncates
     gracefully when the description is long. */
  .live-step-text{
    flex:1;min-width:0;
    color:#d6dae8;font:400 11.5px/1.4 'Manrope',sans-serif;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .live-step-open .live-step-text{white-space:normal}
  .live-step-clock{color:#4a4f6a;font-size:9px;flex-shrink:0}
  .live-step-chev{
    color:#6a6f82;font-size:11px;width:14px;text-align:center;flex-shrink:0;
    transition:transform .14s;
  }
  .live-step-open .live-step-chev{color:#a0a5b8}

  /* Expanded detail panel — the full JSON payload that used to live
     inline. Renders inside a card connected to the summary row above. */
  .live-step-detail{
    position:relative;
    margin:0 0 4px 0;padding:10px 12px;
    border:1px solid rgba(120,130,160,.18);border-top:none;
    border-radius:0 0 7px 7px;
    background:rgba(8,10,18,.7);
    animation:live-step-detail-in .14s ease-out;
  }
  @keyframes live-step-detail-in{
    from{opacity:0;transform:translateY(-3px)}
    to{opacity:1;transform:translateY(0)}
  }
  /* Subtle left border colored by category so the expand visually anchors
     to the same accent as the dot above. */
  .live-cat-shell  .live-step-detail{border-left-color:rgba(251,191,36,.35)}
  .live-cat-fs     .live-step-detail{border-left-color:rgba(106,160,255,.35)}
  .live-cat-web    .live-step-detail{border-left-color:rgba(77,214,224,.35)}
  .live-cat-kernel .live-step-detail{border-left-color:rgba(95,219,160,.35)}
  .live-cat-mcp    .live-step-detail{border-left-color:rgba(198,147,255,.35)}
  .live-cat-think  .live-step-detail{border-left-color:rgba(167,139,250,.35)}
  .live-cat-error  .live-step-detail{border-left-color:rgba(239,93,110,.45)}
  .live-step-txt{
    margin-top:0;padding:5px 8px;border-radius:5px;
    background:rgba(0,0,0,.25);
    font:400 10.5px/1.5 'Manrope',sans-serif;color:#c0c5d8;
    word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap;
    max-height:420px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  /* Plain-language summary line under the LIVE hero icon — same idea as
     .live-step-text but bigger because it's the headline action. */
  .live-now-summary{
    margin-top:4px;color:#e0e3ee;
    font:500 13px/1.45 'Manrope',sans-serif;
    word-break:break-word;
  }

  /* ── Per-step meta chips (Δt + tokens). Sit just under the summary row,
     small enough not to compete with the description but always visible
     so the user gets a feel for cost without opening the step. */
  .live-step-meta{
    display:flex;flex-wrap:wrap;gap:5px;
    padding:1px 0 3px 30px;
    font:500 9px 'JetBrains Mono',monospace;
  }
  .live-meta-chip{
    display:inline-flex;align-items:center;gap:3px;
    padding:1px 5px;border-radius:3px;
    background:rgba(120,130,160,.08);color:#7a83a0;
    border:1px solid rgba(120,130,160,.10);
    letter-spacing:.3px;
  }
  .live-meta-time{color:#9ec0ef;background:rgba(106,160,255,.07);border-color:rgba(106,160,255,.15)}
  .live-meta-tok {color:#c4e8a8;background:rgba(120,220,140,.07);border-color:rgba(120,220,140,.18)}
  .live-meta-cum {color:#8e8fa8;background:rgba(120,130,160,.05);border-color:rgba(120,130,160,.10)}

  /* ── Totals row inside the timeline header — current run elapsed + tok */
  .live-totals{display:inline-flex;gap:6px;margin-left:auto}
  .live-totals-chip{
    display:inline-flex;align-items:center;gap:3px;
    padding:2px 7px;border-radius:4px;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.4px;
    background:rgba(120,130,160,.10);color:#a8b0c8;
    border:1px solid rgba(120,130,160,.15);
  }
  .live-totals-time{color:#9ec0ef;background:rgba(106,160,255,.10);border-color:rgba(106,160,255,.22)}
  .live-totals-tok {color:#bee2a3;background:rgba(120,220,140,.10);border-color:rgba(120,220,140,.22)}
</style>
