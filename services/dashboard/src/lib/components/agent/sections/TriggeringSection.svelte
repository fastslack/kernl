<!--
  TriggeringSection — what makes this agent run.

  Three sections in the old overview: Connections, Schedule, Event triggers.
  They were three because they come from three tables — `agent_chains`,
  `agent_schedules`, `agent_triggers` — and for no other reason. The reader
  never asks any of those three questions on its own; the question is "what
  starts this thing", and it used to be answered in three places separated by
  whatever happened to sit between them.

  Merged here with nothing dropped: every row, badge and count the three
  printed still prints, under a label that says which table it came from.
  Outgoing chains are the one thing here that is not a trigger — they are what
  this agent starts — and they stay, in the same list and marked the same way,
  because "who calls whom" reads as one graph.
-->
<script lang="ts">
  import type { Readable } from 'svelte/store';
  import { fmtRelTime } from '$lib/display-format.js';

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any>;
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;

  /**
   * Declared chains, already resolved to a direction and a name.
   *
   * Resolving them needs the whole agent list, which is the 3D world's, not
   * the drawer's — so the caller hands over rows that are ready to print.
   */
  export let chains: Array<{ out: boolean; name: string; label?: string }> = [];

  /**
   * The three detail collections.
   *
   * The store carries all three, but nothing calls `reload()` on it yet (see
   * AgentDrawer): the 3D world does its own `GET /api/agents/:id` and holds
   * the result. So the caller passes what it already fetched, and a null means
   * "ask the store" — which is what the embedded mount on /agents will do.
   */
  export let triggers: any[] | null = null;
  export let schedules: any[] | null = null;
  export let connections: { invokedBy?: any[]; invoked?: any[] } | null = null;

  $: state = $store ?? {};
  $: trg = (triggers ?? state.triggers ?? []) as any[];
  $: sch = (schedules ?? state.schedules ?? []) as any[];
  $: conn = (connections ?? state.connections ?? null) as { invokedBy?: any[]; invoked?: any[] } | null;

  $: invokedBy = conn?.invokedBy ?? [];
  $: invoked = conn?.invoked ?? [];
  $: adhocCount = invokedBy.length + invoked.length;
  $: hasConnections = chains.length > 0 || adhocCount > 0;
  // Same as before the merge: with nothing to show, nothing is shown. An empty
  // heading would be new, and the spec asked for a merge, not for a new line.
  $: hasAny = hasConnections || sch.length > 0 || trg.length > 0;

  function fmtDuration(ms?: number): string {
    if (!ms) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
    return Math.round(ms / 60_000) + 'm ' + Math.round((ms % 60_000) / 1000) + 's';
  }
</script>

{#if hasAny}
  <section class="ip-sec" class:sec-compact={compact}>
    <h3 class="ip-sec-h">Triggering</h3>

    {#if sch.length}
      <div class="ip-trg-group">
        <h4 class="ip-trg-h">Schedule</h4>
        {#each sch as s}
          <div class="ip-sched">
            <div class="ip-sched-row">
              <span class="ip-sched-lbl">cron</span>
              <code class="ip-code">{s.cron_expression || `every ${Math.round((s.interval_ms ?? 0) / 1000)}s`}</code>
            </div>
            {#if s.next_run_at}
              <div class="ip-sched-row">
                <span class="ip-sched-lbl">next</span>
                <span class="ip-sched-v">{fmtRelTime(s.next_run_at)}</span>
                <span class="ip-sched-abs">{s.next_run_at.slice(5, 16).replace('T', ' ')}</span>
              </div>
            {/if}
            {#if s.last_run_at}
              <div class="ip-sched-row">
                <span class="ip-sched-lbl">last</span>
                <span class="ip-sched-v">{fmtRelTime(s.last_run_at)}</span>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if trg.length}
      <div class="ip-trg-group">
        <h4 class="ip-trg-h">Event triggers <span class="ip-sec-c">{trg.length}</span></h4>
        <div class="ip-trig-list">
          {#each trg as t}
            <div class="ip-trig">
              <span class="ip-trig-evt">{t.event_name}</span>
              {#if t.cooldown_ms && t.cooldown_ms > 0}<span class="ip-trig-cd">cooldown {fmtDuration(t.cooldown_ms)}</span>{/if}
              <span class="ip-trig-st" class:on={t.active}>{t.active ? 'on' : 'off'}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if hasConnections}
      <div class="ip-trg-group">
        <h4 class="ip-trg-h">Connections <span class="ip-sec-c">{chains.length}{#if adhocCount > 0} + {adhocCount} ad-hoc{/if}</span></h4>
        <div class="ip-chain-list">
          {#each chains as c}
            <div class="ip-chain" class:out={c.out}>
              <span class="ip-chain-dir">{c.out ? '↗ out' : '↙ in'}</span>
              <span class="ip-chain-name">{c.name}</span>
              {#if c.label}<span class="ip-chain-label">{c.label}</span>{/if}
            </div>
          {/each}
          {#each invokedBy as inv}
            <div class="ip-chain ip-chain-adhoc">
              <span class="ip-chain-dir ip-chain-dir-adhoc">↙ called by</span>
              <span class="ip-chain-name">{inv.agent_name}</span>
              <span class="ip-chain-label">{inv.count}× · {fmtRelTime(inv.last_at)}</span>
            </div>
          {/each}
          {#each invoked as inv}
            <div class="ip-chain ip-chain-adhoc out">
              <span class="ip-chain-dir ip-chain-dir-adhoc">↗ called</span>
              <span class="ip-chain-name">{inv.agent_name}</span>
              <span class="ip-chain-label">{inv.count}× · {fmtRelTime(inv.last_at)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  /* Copies of the rules AgentWorld3D.svelte applied to this markup while it
     lived there — Svelte scopes CSS per component, so a rule left behind in
     the parent would not reach it here. */
  .ip-sec{margin-bottom:18px}
  .sec-compact{margin-bottom:12px}
  .ip-sec-h{
    font:600 10px 'Syne',sans-serif;
    color:#8a8fa8;text-transform:uppercase;letter-spacing:1.5px;
    margin:0 0 8px;display:inline-flex;align-items:center;gap:6px;
  }
  .ip-sec-c{
    font:600 9px 'JetBrains Mono',monospace;
    padding:1px 6px;border-radius:4px;
    background:rgba(120,130,160,.15);color:#a0a5b8;
    letter-spacing:0;text-transform:none;
  }
  .ip-code{
    font:500 11px 'JetBrains Mono',monospace;
    background:rgba(0,0,0,.3);color:#d8dae3;
    padding:2px 7px;border-radius:4px;
    border:1px solid rgba(120,130,160,.12);
  }

  /* The merge's own cost: three groups under one heading need a label each,
     one step quieter than the section's. */
  .ip-trg-group{margin-bottom:12px}
  .ip-trg-group:last-child{margin-bottom:0}
  .ip-trg-h{
    font:600 9px 'Syne',sans-serif;
    color:#6a6f82;text-transform:uppercase;letter-spacing:1.2px;
    margin:0 0 6px;display:flex;align-items:center;gap:6px;
  }

  /* ── Chains (connections) ────── */
  .ip-chain-list{display:flex;flex-direction:column;gap:4px}
  .ip-chain{
    display:grid;grid-template-columns:48px 1fr auto;gap:10px;
    padding:8px 10px;border-radius:6px;
    background:rgba(120,130,160,.04);
    border:1px solid rgba(120,130,160,.08);
    align-items:center;
  }
  .ip-chain.out{border-left:2px solid var(--flow-color)}
  .ip-chain:not(.out){border-left:2px solid #a78bfa}
  .ip-chain-dir{font:600 9px 'JetBrains Mono',monospace;color:#6a6f82}
  .ip-chain.out .ip-chain-dir{color:var(--flow-color)}
  .ip-chain:not(.out) .ip-chain-dir{color:#a78bfa}
  .ip-chain-name{font:500 12px 'Manrope',sans-serif;color:#d8dae3}
  .ip-chain-label{
    font:500 9px 'JetBrains Mono',monospace;color:#8a8fa8;
    padding:2px 6px;border-radius:4px;background:rgba(120,130,160,.1);
  }
  .ip-chain-adhoc{border-left-style:dashed !important;opacity:.85}
  .ip-chain-adhoc.out{border-left-color:#f59e0b !important}
  .ip-chain-adhoc:not(.out){border-left-color:#f59e0b !important}
  .ip-chain-dir-adhoc{color:#f59e0b !important;font-style:italic}

  /* ── Schedule ────────────────── */
  .ip-sched{
    padding:10px 12px;border-radius:8px;
    background:rgba(251,191,36,.04);
    border:1px solid rgba(251,191,36,.15);
    border-left:3px solid #fbbf24;
  }
  .ip-sched-row{display:flex;align-items:baseline;gap:10px;padding:3px 0}
  .ip-sched-lbl{font:600 9px 'JetBrains Mono',monospace;color:#fbbf24;text-transform:uppercase;letter-spacing:.5px;min-width:38px}
  .ip-sched-v{font:500 12px 'Manrope',sans-serif;color:#d8dae3}
  .ip-sched-abs{font:500 10px 'JetBrains Mono',monospace;color:#6a6f82;margin-left:auto}

  /* ── Triggers ────────────────── */
  .ip-trig-list{display:flex;flex-direction:column;gap:4px}
  .ip-trig{
    display:flex;align-items:center;gap:10px;
    padding:7px 10px;border-radius:6px;
    background:rgba(244,114,182,.04);
    border:1px solid rgba(244,114,182,.12);
    border-left:2px solid #f472b6;
  }
  .ip-trig-evt{font:500 11px 'JetBrains Mono',monospace;color:#f0f2f7;flex:1}
  .ip-trig-cd{font:500 9px 'JetBrains Mono',monospace;color:#6a6f82}
  .ip-trig-st{font:600 9px 'JetBrains Mono',monospace;color:#6a6f82;text-transform:uppercase}
  .ip-trig-st.on{color:#78dc8c}
</style>
