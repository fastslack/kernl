<!--
  VerdictLine — one line answering "is this agent OK?".

  It replaces the four KPI tiles (Total runs / Completed / Failed / Success)
  that used to lead the overview. Those numbers are usually zeros — most
  agents here have run a handful of times, if that — and four tiles is a
  whole band of the panel to say little. The question people actually open
  the drawer with is answered in one line:

    ● Paused · 2 runs, none successful · failed 3d ago

  The tiles are not gone — Task 10 moves them into the HISTORY tab, where a
  series belongs. This line stays in the overview and leads it.
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  export let agent: Record<string, any> | null = null;
  export let stats: { total_runs: number; completed: number; failed: number; success_rate: number } | null = null;
  export let lastRun: { status: string; created_at: string } | null = null;

  // Same distinction AgentDrawer's own state chip makes: `active === 0` alone
  // cannot tell an operator's Pause from the kernel's circuit breaker, and the
  // breaker tripping is the one case that means something is actually broken.
  $: autoPaused = !!agent && agent.active !== 1 && !!(agent?.auto_paused_at || '');
  $: statusWord = !agent ? '' : agent.active === 1 ? $t('agent.verdict.active') : autoPaused ? $t('agent.verdict.auto_paused') : $t('agent.verdict.paused');

  $: lastFailed = lastRun?.status === 'failed';
  // Worst signal wins: a tripped breaker or a failed last run reads as red
  // even if the operator's own pause is what shows in the word next to it.
  $: dotClass = autoPaused || lastFailed ? 'vl-dot-red' : !agent || agent.active !== 1 ? 'vl-dot-yellow' : 'vl-dot-green';

  function runsClause(s: typeof stats, tr: (k: string, p?: Record<string, string | number>) => string): string {
    // No stats at all is not the same as zero runs. /agents has no per-agent
    // run counters to hand over (its WS payload only carries dashboard-wide
    // aggregates), and answering "no runs yet" there would state something
    // this line has no way to know. Nothing is said instead; the last-run
    // clause still carries the signal that matters.
    if (!s) return '';
    if (!s.total_runs) return tr('agent.verdict.no_runs');
    const n = s.total_runs;
    const c = s.completed ?? 0;
    const runsWord = n === 1 ? tr('agent.verdict.runs_one') : tr('agent.verdict.runs_other', { n });
    if (c === 0) return tr('agent.verdict.none_successful', { runs: runsWord });
    if (c >= n) return tr('agent.verdict.all_successful', { runs: runsWord });
    return tr('agent.verdict.some_successful', { runs: runsWord, c });
  }

  /** Coarse relative time — the exact stamp lives in the run itself. */
  function rel(iso: string | undefined, tr: (k: string, p?: Record<string, string | number>) => string): string {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const d = Math.max(0, Date.now() - t);
    if (d < 60_000) return tr('agent.verdict.just_now');
    if (d < 3_600_000) return tr('agent.verdict.minutes_ago', { n: Math.round(d / 60_000) });
    if (d < 86_400_000) return tr('agent.verdict.hours_ago', { n: Math.round(d / 3_600_000) });
    return tr('agent.verdict.days_ago', { n: Math.round(d / 86_400_000) });
  }

  function lastRunClause(r: typeof lastRun, tr: (k: string, p?: Record<string, string | number>) => string): string {
    if (!r) return '';
    const when = rel(r.created_at, tr);
    if (r.status === 'failed') return tr('agent.verdict.failed_when', { when });
    if (r.status === 'running') return tr('agent.verdict.running_now');
    if (r.status === 'completed') return tr('agent.verdict.ok_when', { when });
    return `${r.status} ${when}`.trim();
  }

  $: parts = [statusWord, runsClause(stats, $t), lastRunClause(lastRun, $t)].filter(Boolean);
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
