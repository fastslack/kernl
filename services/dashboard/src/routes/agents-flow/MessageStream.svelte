<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { AgentFlowEvent } from '$lib/stores.js';
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';

  const dispatch = createEventDispatcher();

  // ── Props ──────────────────────────────────────
  export let open = true;
  export let height = 280;
  export let flowEvents: AgentFlowEvent[] = [];
  export let filteredFlowEvents: AgentFlowEvent[] = [];
  export let streamAgentNames: string[] = [];
  export let streamTokenTotal = 0;
  export let streamRunDurations: Record<string, number> = {};
  export let agentColors: Record<string, { color: string; glow: string }> = {};
  export let liveRunningAgents: Set<string> = new Set();
  export let persistedEvents: any[] = [];
  export let persistedTotal = 0;
  export let persistedLoading = false;

  // Bound two-way props
  export let streamTypeFilter = 'all';
  export let streamAgentFilter = 'all';
  export let streamSearch = '';
  export let streamAutoScroll = true;
  export let showPersisted = false;

  // ── Internal state ─────────────────────────────
  let streamEl: HTMLDivElement;
  let resizing = false;
  let expandedEvents = new Set<number>();
  let copyLabel = 'Copy';

  const PALETTE_DEFAULT = { color: '#6366f1', glow: 'rgba(99,102,241,0.15)' };

  // ── Resize handle ──────────────────────────────
  function onResizeStart(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    const startY = e.clientY;
    const startH = height;
    function onMove(ev: MouseEvent) {
      height = Math.max(120, Math.min(window.innerHeight * 0.7, startH + (startY - ev.clientY)));
    }
    function onUp() {
      resizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ── Expand/collapse events ─────────────────────
  function toggleExpand(idx: number) {
    if (expandedEvents.has(idx)) expandedEvents.delete(idx);
    else expandedEvents.add(idx);
    expandedEvents = new Set(expandedEvents);
  }

  // ── Formatters ─────────────────────────────────
  function fmtDuration(ms: number): string {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }

  function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1) + 'k';
  }

  function eventIcon(evt: AgentFlowEvent): string {
    const t = evt.event.split(':').pop() ?? '';
    if (t === 'run_started') return 'START';
    if (t === 'run_completed') return evt.data.status === 'completed' ? 'DONE' : 'FAIL';
    if (t === 'chain_triggered') return 'CHAIN';
    if (t === 'step') {
      const st = String(evt.data.type ?? '');
      if (st === 'thought') return 'THINK';
      if (st === 'tool_call') return 'CALL';
      if (st === 'tool_result') return 'RESULT';
      if (st === 'final') return 'FINAL';
      if (st === 'error') return 'ERROR';
      if (st === 'rate_limit_wait') return 'WAIT';
      return st.toUpperCase();
    }
    return t.toUpperCase();
  }

  function eventColor(evt: AgentFlowEvent): string {
    const t = evt.event.split(':').pop() ?? '';
    if (t === 'run_started') return 'var(--blue)';
    if (t === 'run_completed') return evt.data.status === 'completed' ? 'var(--green)' : 'var(--red)';
    if (t === 'chain_triggered') return 'var(--purple)';
    if (t === 'step') {
      const st = String(evt.data.type ?? '');
      if (st === 'thought') return 'var(--purple)';
      if (st === 'tool_call') return 'var(--teal)';
      if (st === 'tool_result') return 'var(--green)';
      if (st === 'final') return 'var(--gold)';
      if (st === 'error') return 'var(--red)';
      if (st === 'rate_limit_wait') return 'var(--orange)';
    }
    return 'var(--text-3)';
  }

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

  function eventTime(ts: string): string {
    try { return new Date(ts).toLocaleTimeString('en-GB', { hour12: false }); } catch { return ''; }
  }

  // ── Actions ────────────────────────────────────
  function exportStreamLog() {
    const data = filteredFlowEvents.map(e => ({
      time: e.ts, event: e.event,
      agent: String(e.data.agent_name ?? e.data.source_agent_name ?? ''),
      detail: eventDetail(e),
      data: e.data,
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `agent-stream-${new Date().toISOString().slice(0,19)}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  async function copyStreamToClipboard() {
    const lines = filteredFlowEvents.map(e => {
      const t = eventTime(e.ts);
      const agent = eventAgentName(e);
      const detail = eventDetail(e);
      return `[${t}] ${agent ? agent + ' — ' : ''}${detail}`;
    });
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      copyLabel = 'Copied!';
      setTimeout(() => { copyLabel = 'Copy'; }, 1500);
    } catch { /* clipboard blocked */ }
  }

  // ── Auto-scroll ────────────────────────────────
  $: if (streamAutoScroll && streamEl && flowEvents.length > 0) {
    setTimeout(() => { if (streamEl) streamEl.scrollTop = 0; }, 10);
  }
</script>

<!-- Message Stream Panel -->
<div class="stream-panel" class:stream-closed={!open} style="height:{open ? height : 40}px">
  <!-- Resize handle -->
  {#if open}
    <div class="stream-resize" on:mousedown={onResizeStart} role="separator" aria-orientation="horizontal"></div>
  {/if}
  <div class="stream-header">
    <button class="stream-toggle" on:click={() => { open = !open; }}>
      <span class="stream-toggle-arrow" class:rotated={open}>&#9650;</span>
    </button>
    <span class="stream-title">Message Stream</span>
    <span class="stream-count">{filteredFlowEvents.length}{filteredFlowEvents.length !== flowEvents.length ? '/' + flowEvents.length : ''} events</span>
    {#if streamTokenTotal > 0}
      <span class="stream-token-badge">{fmtTokens(streamTokenTotal)} tokens</span>
    {/if}
    {#if flowEvents.length > 0 && liveRunningAgents.size > 0}
      <span class="stream-live-badge">LIVE</span>
    {/if}
    <div style="flex:1"></div>
    <!-- Filters -->
    <select class="stream-filter" bind:value={streamTypeFilter}>
      <option value="all">All types</option>
      <option value="run">Runs</option>
      <option value="step">Steps</option>
      <option value="chain">Chains</option>
      <option value="error">Errors</option>
      <option value="rate_limit">Rate Limits</option>
    </select>
    {#if streamAgentNames.length > 1}
      <select class="stream-filter" bind:value={streamAgentFilter}>
        <option value="all">All agents</option>
        {#each streamAgentNames as name}
          <option value={name}>{name}</option>
        {/each}
      </select>
    {/if}
    <input class="stream-search" bind:value={streamSearch} placeholder="Search..." />
    <label class="stream-auto-label">
      <input type="checkbox" bind:checked={streamAutoScroll} /> Auto
    </label>
    <button class="stream-btn" on:click={copyStreamToClipboard} title="Copy all to clipboard">{copyLabel}</button>
    <button class="stream-btn" on:click={exportStreamLog} title="Export as JSON">Export</button>
    <button class="stream-btn" on:click={() => { showPersisted = !showPersisted; dispatch('togglePersisted'); }} title="View persisted logs">
      {showPersisted ? 'Live' : 'History'}
    </button>
    <button class="stream-clear" on:click={() => dispatch('clear')}>Clear</button>
  </div>
  {#if open}
    <div class="stream-body" bind:this={streamEl}>
      {#if showPersisted}
        <!-- Persisted events from DB -->
        {#if persistedLoading}
          <div class="stream-empty">Loading event history...</div>
        {:else if persistedEvents.length === 0}
          <div class="stream-empty">No persisted events. Events are saved when agents run.</div>
        {:else}
          <div class="stream-persisted-header">
            <span>{persistedTotal} total events in database</span>
            <button class="stream-clear" on:click={() => dispatch('clearPersisted')}>Clear DB</button>
          </div>
          {#each persistedEvents as evt, i}
            {@const color = evt.event_type === 'run' ? (evt.event_subtype === 'completed' ? 'var(--green)' : evt.event_subtype === 'started' ? 'var(--blue)' : 'var(--red)') : evt.event_type === 'chain' ? 'var(--purple)' : evt.event_subtype === 'tool_call' ? 'var(--teal)' : evt.event_subtype === 'error' ? 'var(--red)' : evt.event_subtype === 'rate_limit_wait' ? 'var(--orange)' : 'var(--text-3)'}
            <div class="stream-event" class:stream-event-expanded={expandedEvents.has(10000 + i)}
              on:click={() => toggleExpand(10000 + i)} role="button" tabindex="0"
              on:keydown={e => e.key === 'Enter' && toggleExpand(10000 + i)}>
              <div class="stream-event-time">{eventTime(evt.created_at)}</div>
              <div class="stream-event-icon" style="background:{color}">{(evt.event_subtype || evt.event_type).toUpperCase().slice(0, 6)}</div>
              <div class="stream-event-agent">{evt.agent_name}</div>
              <div class="stream-event-detail">{evt.detail}</div>
              {#if evt.tokens_used}<div class="stream-event-tokens">{fmtTokens(evt.tokens_used)}</div>{/if}
              {#if evt.duration_ms}<div class="stream-event-duration">{fmtDuration(evt.duration_ms)}</div>{/if}
              <div class="stream-expand-icon">{expandedEvents.has(10000 + i) ? '▾' : '▸'}</div>
            </div>
            {#if expandedEvents.has(10000 + i)}
              {@const raw = JSON.stringify(JSON.parse(evt.raw_data || '{}'), null, 2)}
              <div class="stream-event-raw copy-wrap">
                <CopyTextBtn text={raw} title="Copy raw event" />
                <pre>{raw}</pre>
              </div>
            {/if}
          {/each}
        {/if}
      {:else}
        <!-- Live events -->
        {#if filteredFlowEvents.length === 0}
          <div class="stream-empty">
            {#if flowEvents.length === 0}
              No events yet. Run an agent to see real-time messages.
            {:else}
              No events match the current filters.
            {/if}
          </div>
        {:else}
          {#each filteredFlowEvents as evt, i (evt.ts + i)}
            {@const agentId = String(evt.data.agent_id ?? evt.data.source_agent_id ?? '')}
            {@const pal = agentColors[agentId] ?? PALETTE_DEFAULT}
            {@const icon = eventIcon(evt)}
            {@const color = eventColor(evt)}
            {@const isChain = evt.event.includes('chain_triggered')}
            {@const isStart = evt.event.includes('run_started')}
            {@const isEnd = evt.event.includes('run_completed')}
            {@const isStep = evt.event.includes('step')}
            {@const isRateLimit = String(evt.data.type) === 'rate_limit_wait'}
            {@const runId = String(evt.data.run_id ?? '')}
            {@const runDur = isEnd && runId ? streamRunDurations[runId] : 0}
            <div class="stream-event"
              class:stream-event-chain={isChain}
              class:stream-event-start={isStart}
              class:stream-event-end={isEnd}
              class:stream-event-rate-limit={isRateLimit}
              class:stream-event-expanded={expandedEvents.has(i)}
              on:click={() => toggleExpand(i)}
              role="button" tabindex="0"
              on:keydown={e => e.key === 'Enter' && toggleExpand(i)}
              style="--evt-color:{color}">
              <div class="stream-event-time">{eventTime(evt.ts)}</div>
              <div class="stream-event-icon" style="background:{color}">{icon}</div>
              <div class="stream-event-agent" style="color:{pal.color}"
                on:click|stopPropagation={() => dispatch('selectAgent', agentId)}>
                {eventAgentName(evt)}
              </div>
              <div class="stream-event-detail" class:stream-detail-tool={isStep && String(evt.data.type) === 'tool_call'}>
                {eventDetail(evt)}
              </div>
              {#if evt.data.tokens_used}
                <div class="stream-event-tokens">{fmtTokens(Number(evt.data.tokens_used))}</div>
              {/if}
              {#if runDur}
                <div class="stream-event-duration">{fmtDuration(runDur)}</div>
              {/if}
              {#if isStep && evt.data.step_number}
                <div class="stream-event-step">#{evt.data.step_number}</div>
              {/if}
              <div class="stream-expand-icon">
                {expandedEvents.has(i) ? '▾' : '▸'}
              </div>
            </div>
            {#if expandedEvents.has(i)}
              {@const raw = JSON.stringify(evt.data, null, 2)}
              <div class="stream-event-raw copy-wrap">
                <CopyTextBtn text={raw} title="Copy raw event" />
                <pre>{raw}</pre>
              </div>
            {/if}
          {/each}
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ── Message Stream Panel ─────────────── */
  .stream-panel {
    flex-shrink: 0;
    display: flex; flex-direction: column;
    min-height: 40px;
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    overflow: hidden;
    position: relative;
  }
  .stream-panel.stream-closed { height: 40px !important; }
  .stream-resize {
    position: absolute;
    top: -3px; left: 0; right: 0;
    height: 6px;
    cursor: ns-resize;
    z-index: 10;
    background: transparent;
    transition: background 0.15s;
  }
  .stream-resize:hover,
  .stream-resize:active {
    background: var(--gold);
    opacity: 0.6;
  }
  .stream-header {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 16px; flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }
  .stream-toggle {
    background: none; border: none; color: var(--text-2);
    cursor: pointer; font-size: 11px; padding: 2px 4px;
  }
  .stream-toggle-arrow { display: inline-block; transition: transform 0.2s; }
  .stream-toggle-arrow.rotated { transform: rotate(180deg); }
  .stream-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 1px; color: var(--text-3);
  }
  .stream-count { font-size: 10px; color: var(--text-3); }
  .stream-live-badge {
    font-size: 8px; padding: 2px 6px; border-radius: 3px;
    background: rgba(240,71,112,0.15); color: var(--red);
    animation: livePulse 1.5s ease-in-out infinite;
    font-weight: 700; letter-spacing: 0.5px;
  }
  @keyframes livePulse {
    0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(61,214,140,0.5); }
    50% { opacity: 0.6; box-shadow: 0 0 0 6px rgba(61,214,140,0); }
  }
  .stream-auto-label {
    font-size: 10px; color: var(--text-3);
    display: flex; align-items: center; gap: 4px; cursor: pointer;
  }
  .stream-auto-label input { width: 12px; height: 12px; }
  .stream-clear, .stream-btn {
    font-size: 10px; padding: 2px 8px; border-radius: 4px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-3); cursor: pointer; transition: all 0.15s;
  }
  .stream-clear:hover, .stream-btn:hover { background: var(--surface-3); color: var(--text-1); }
  .stream-filter {
    font-size: 10px; padding: 2px 6px; border-radius: 4px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2); cursor: pointer; max-width: 100px;
  }
  .stream-search {
    font-size: 10px; padding: 2px 8px; border-radius: 4px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1); width: 120px; outline: none;
  }
  .stream-search:focus { border-color: var(--gold); }
  .stream-token-badge {
    font-size: 9px; padding: 1px 6px; border-radius: 3px;
    background: rgba(var(--gold-rgb, 212, 175, 55), 0.15); color: var(--gold);
    font-weight: 600; font-family: var(--font-mono);
  }

  .stream-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 8px;
    font-family: var(--font-mono);
  }
  .stream-body::-webkit-scrollbar { width: 5px; }
  .stream-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .stream-empty {
    text-align: center; padding: 24px;
    font-size: 11px; color: var(--text-3); font-family: inherit;
  }

  .stream-event {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 4px 8px; border-radius: 4px;
    font-size: 11px; line-height: 1.4;
    animation: streamSlide 0.2s ease-out;
    border-left: 2px solid transparent;
    cursor: pointer;
  }
  .stream-event:hover { background: var(--surface-2); }
  .stream-event-chain {
    background: rgba(139,124,246,0.05);
    border-left-color: var(--purple);
    padding: 6px 8px;
  }
  .stream-event-start {
    background: rgba(91,155,247,0.05);
    border-left-color: var(--blue);
    padding: 6px 8px; margin-top: 8px;
    border-top: 1px solid var(--border);
  }
  .stream-event-end {
    background: rgba(61,214,140,0.05);
    border-left-color: var(--evt-color);
    padding: 6px 8px; margin-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  @keyframes streamSlide { from { opacity: 0; transform: translateY(-4px); } }

  .stream-event-time {
    font-size: 9px; color: var(--text-3);
    flex-shrink: 0; width: 55px; padding-top: 1px;
  }
  .stream-event-icon {
    font-size: 8px; font-weight: 700; letter-spacing: 0.3px;
    padding: 1px 5px; border-radius: 3px;
    color: var(--bg); flex-shrink: 0; min-width: 42px;
    text-align: center;
  }
  .stream-event-agent {
    font-size: 10px; font-weight: 600;
    flex-shrink: 0; min-width: 100px; max-width: 140px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    cursor: pointer; padding-top: 1px;
  }
  .stream-event-agent:hover { text-decoration: underline; }
  .stream-event-detail {
    color: var(--text-2); flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stream-event-expanded .stream-event-detail {
    white-space: normal; overflow: visible;
  }
  .stream-detail-tool { color: var(--teal); }
  .stream-event-step {
    font-size: 9px; color: var(--text-3);
    flex-shrink: 0; padding-top: 1px;
  }
  .stream-event-tokens {
    font-size: 9px; color: var(--gold); flex-shrink: 0;
    font-family: var(--font-mono); padding-top: 1px;
  }
  .stream-event-duration {
    font-size: 9px; color: var(--teal); flex-shrink: 0;
    font-family: var(--font-mono); padding-top: 1px;
    background: rgba(61,214,200,0.1); padding: 0 4px; border-radius: 3px;
  }
  .stream-expand-icon {
    font-size: 9px; color: var(--text-3); flex-shrink: 0;
    width: 12px; text-align: center; opacity: 0.5;
  }
  .stream-event:hover .stream-expand-icon { opacity: 1; }

  .stream-event-raw {
    padding: 4px 8px 4px 72px;
    animation: streamSlide 0.15s ease-out;
  }
  :global(.copy-wrap){position:relative}
  .stream-event-raw pre {
    font-size: 10px; line-height: 1.5; color: var(--text-2);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 12px; margin: 0;
    overflow-x: auto; max-height: 300px;
    white-space: pre-wrap; word-break: break-all;
  }

  .stream-event-rate-limit {
    background: rgba(249,115,22,0.08);
    border-left-color: var(--orange);
    padding: 6px 8px;
  }
  .stream-event-rate-limit .stream-event-detail { color: var(--orange); }

  .stream-persisted-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 12px 8px; font-size: 10px; color: var(--text-3);
    border-bottom: 1px solid var(--border); margin-bottom: 4px;
  }
</style>
