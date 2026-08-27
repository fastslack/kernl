<!--
  VerdictLine — one line answering "is this agent OK?".

  It replaces the four KPI tiles (Total runs / Completed / Failed / Success)
  that used to lead the overview. Those numbers are usually zeros — most
  agents here have run a handful of times, if that — and four tiles is a
  whole band of the panel to say little. The question people actually open
  the drawer with is answered in one line:

    ● Pausado · 2 runs, ninguno exitoso · falló hace 3d

  The tiles are not gone — Task 10 moves them into the HISTORY tab, where a
  series belongs. This line stays in the overview and leads it.
-->
<script lang="ts">
  export let agent: Record<string, any> | null = null;
  export let stats: { total_runs: number; completed: number; failed: number; success_rate: number } | null = null;
  export let lastRun: { status: string; created_at: string } | null = null;

  // Same distinction AgentDrawer's own state chip makes: `active === 0` alone
  // cannot tell an operator's Pause from the kernel's circuit breaker, and the
  // breaker tripping is the one case that means something is actually broken.
  $: autoPaused = !!agent && agent.active !== 1 && !!(agent?.auto_paused_at || '');
  $: statusWord = !agent ? '' : agent.active === 1 ? 'Activo' : autoPaused ? 'Auto-pausado' : 'Pausado';

  $: lastFailed = lastRun?.status === 'failed';
  // Worst signal wins: a tripped breaker or a failed last run reads as red
  // even if the operator's own pause is what shows in the word next to it.
  $: dotClass = autoPaused || lastFailed ? 'vl-dot-red' : !agent || agent.active !== 1 ? 'vl-dot-yellow' : 'vl-dot-green';

  function runsClause(s: typeof stats): string {
    // No stats at all is not the same as zero runs. /agents has no per-agent
    // run counters to hand over (its WS payload only carries dashboard-wide
    // aggregates), and answering "sin runs aún" there would state something
    // this line has no way to know. Nothing is said instead; the last-run
    // clause still carries the signal that matters.
    if (!s) return '';
    if (!s.total_runs) return 'sin runs aún';
    const n = s.total_runs;
    const c = s.completed ?? 0;
    const runsWord = n === 1 ? '1 run' : `${n} runs`;
    if (c === 0) return `${runsWord}, ninguno exitoso`;
    if (c >= n) return `${runsWord}, todos exitosos`;
    return `${runsWord}, ${c} exitoso${c === 1 ? '' : 's'}`;
  }

  /** Coarse Spanish relative time — the exact stamp lives in the run itself. */
  function relEs(iso: string | undefined): string {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const d = Math.max(0, Date.now() - t);
    if (d < 60_000) return 'recién';
    if (d < 3_600_000) return `hace ${Math.round(d / 60_000)}m`;
    if (d < 86_400_000) return `hace ${Math.round(d / 3_600_000)}h`;
    return `hace ${Math.round(d / 86_400_000)}d`;
  }

  function lastRunClause(r: typeof lastRun): string {
    if (!r) return '';
    const rel = relEs(r.created_at);
    if (r.status === 'failed') return `falló ${rel}`;
    if (r.status === 'running') return 'corriendo ahora';
    if (r.status === 'completed') return `ok ${rel}`;
    return `${r.status} ${rel}`.trim();
  }

  $: parts = [statusWord, runsClause(stats), lastRunClause(lastRun)].filter(Boolean);
</script>

{#if agent}
  <div class="vl">
    <span class="vl-dot {dotClass}" aria-hidden="true"></span>
    <span class="vl-text">{parts.join(' · ')}</span>
  </div>
{/if}

<style>
  .vl{
    display:flex;align-items:center;gap:8px;
    padding:9px 12px;border-radius:9px;margin-bottom:14px;
    background:rgba(120,130,160,.06);
    border:1px solid rgba(120,130,160,.16);
  }
  .vl-dot{
    flex:none;width:8px;height:8px;border-radius:50%;
  }
  .vl-dot-green{background:#78dc8c;box-shadow:0 0 6px rgba(120,220,140,.6)}
  .vl-dot-yellow{background:#fbbf24;box-shadow:0 0 6px rgba(251,191,36,.5)}
  .vl-dot-red{background:#ef5d6e;box-shadow:0 0 6px rgba(239,93,110,.55)}
  .vl-text{
    font:600 12px/1.3 'Manrope',sans-serif;color:#d8dae3;
  }
</style>
