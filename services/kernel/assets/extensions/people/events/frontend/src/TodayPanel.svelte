<script lang="ts">
  // Local copy of services/dashboard/src/lib/components/TodayPanel.svelte
  // (Fase 2b) — fetches the agenda-brain "what do I do today" plan via ctx.rpc.
  import { onMount } from 'svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  let plan: any = null;

  async function fetchAgendaToday() {
    try {
      return await ctx.rpc('agendaBrain.today', {}, () => ctx.fetchJson('/api/dashboard/agenda-today'));
    } catch { return null; }
  }

  onMount(async () => { plan = await fetchAgendaToday(); });
</script>

{#if plan && plan.items?.length}
  <div class="pl-board" style="margin-bottom:14px">
    <div class="today-head">☀️ What do I do today
      <span class="today-counts">{plan.counts?.overdue ?? 0} overdue · {plan.counts?.dueToday ?? 0} today</span>
    </div>
    <ol class="today-list">
      {#each plan.items.slice(0, 6) as it}
        <li><span class="today-title">{it.title}</span><span class="today-why">{it.why}</span></li>
      {/each}
    </ol>
  </div>
{/if}

<style>
  .today-head { font-family: var(--font-display); font-weight: 700; color: var(--text-1); display:flex; justify-content:space-between; margin-bottom:10px; }
  .today-counts { font-family: var(--font-mono); font-size: 11px; color: var(--gold); }
  .today-list { list-style: decimal; padding-left: 22px; display:flex; flex-direction:column; gap:6px; }
  .today-title { color: var(--text-1); font-size: 13px; }
  .today-why { display:block; color: var(--text-3); font-size: 11px; }
</style>
