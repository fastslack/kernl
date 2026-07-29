<script lang="ts">
  import { planner, systemAgenda } from '$lib/stores.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import DayModal from '$lib/components/DayModal.svelte';
  import { TL_COLORS, TL_MONTHS, FREQ_COLORS, FREQ_ORDER } from '$lib/constants.js';
  import { freqLabel, freqDisplay } from '$lib/utils.js';

  // Use planner data (same as Planner page) - it has calendar grid + systemProcesses
  $: cal = ($planner as any);
  $: sysAgenda = ($systemAgenda as any);
  // Prefer systemAgenda.processes, fallback to cal.systemProcesses
  $: procs = sysAgenda?.processes ?? cal?.systemProcesses ?? [];

  let selectedDay = '';
  let modalOpen = false;
  const todayStr = new Date().toISOString().split('T')[0];

  // Filter out regular tasks - Automations only shows scheduled jobs, not user tasks
  function filterEvents(events: any[]): any[] {
    if (!Array.isArray(events)) return [];
    return events.filter((ev: any) => ev.type !== 'task');
  }

  $: selectedEvents = filterEvents(cal?.days?.[selectedDay] ?? []);

  function openDayModal(date: string) {
    const events = filterEvents(cal?.days?.[date] ?? []);
    if (events.length > 0) {
      selectedDay = date;
      modalOpen = true;
    }
  }

  // Group procs by frequency
  $: procGroups = (() => {
    const g: Record<string, any[]> = {};
    procs.forEach((p: any) => {
      const fk = freqLabel(p.intervalMs);
      if (!g[fk]) g[fk] = [];
      g[fk].push(p);
    });
    return g;
  })();

  // Count total events (excluding tasks) across all days
  $: totalEvents = (() => {
    if (!cal?.days || typeof cal.days !== 'object') return 0;
    return Object.values(cal.days).reduce((s: number, ev: any) => s + filterEvents(ev).length, 0);
  })();

  // Filter overdue to only show automation-related items (not regular tasks)
  $: filteredOverdue = filterEvents(cal?.overdue ?? []);

  // Build calendar grid (same logic as Planner)
  $: gridData = cal ? buildGrid(cal) : null;

  function buildGrid(c: any) {
    if (!c.start || !c.dayCount) return null;
    const firstDate = new Date(c.start + 'T12:00:00Z');
    const endD = new Date(firstDate);
    endD.setUTCDate(endD.getUTCDate() + c.dayCount);
    const endDateStr = endD.toISOString().split('T')[0];
    const gridStart = new Date(firstDate);
    const fDow = gridStart.getUTCDay();
    gridStart.setUTCDate(gridStart.getUTCDate() - (fDow === 0 ? 6 : fDow - 1));
    const lastDate = new Date(firstDate);
    lastDate.setUTCDate(lastDate.getUTCDate() + c.dayCount - 1);
    const gridEnd = new Date(lastDate);
    const lDow = gridEnd.getUTCDay();
    gridEnd.setUTCDate(gridEnd.getUTCDate() + (lDow === 0 ? 0 : 7 - lDow));

    const dates: any[] = [];
    const gd = new Date(gridStart);
    while (gd <= gridEnd) {
      const gs = gd.toISOString().split('T')[0];
      dates.push({
        date: gs,
        dow: gd.getUTCDay(),
        day: gd.getUTCDate(),
        month: gd.getUTCMonth(),
        year: gd.getUTCFullYear(),
        outside: gs < c.start || gs >= endDateStr
      });
      gd.setUTCDate(gd.getUTCDate() + 1);
    }
    // Build month header spans
    const totalWeeks = dates.length / 7;
    const months: { label: string; width: number }[] = [];
    let curMonth = -1, curCount = 0, curMonthKey = -1;
    for (let w = 0; w < totalWeeks; w++) {
      const md = dates[w * 7];
      const mKey = md.year * 100 + md.month;
      if (mKey !== curMonthKey) {
        if (curMonth >= 0) months.push({ label: TL_MONTHS[curMonth] + ' ' + dates[(months.length > 0 ? months.reduce((s,m_)=>s+Math.round(m_.width/52),0) : 0)*7]?.year, width: curCount * 52 });
        curMonth = md.month;
        curMonthKey = mKey;
        curCount = 0;
      }
      curCount++;
      if (w === totalWeeks - 1) months.push({ label: TL_MONTHS[md.month] + ' ' + md.year, width: curCount * 52 });
    }
    return { dates, totalWeeks, months, startStr: c.start, endDateStr };
  }
</script>

<ViewHeader title="Automations" sub="System processes & scheduled jobs" />

{#if !cal}
  <div class="loading-view">Loading automations...</div>
{:else if !gridData}
  <Panel cls="anim"><Empty message="Calendar data not available." /></Panel>
{:else}
  <!-- Process Monitor Strip -->
  {#if procs.length}
    <div class="pm-strip anim d1">
      <div class="pm-header">
        <div class="pm-header-dot"></div>
        Active Processes
        <span class="pm-header-count">{procs.length} running</span>
      </div>
      {#each FREQ_ORDER as fk}
        {#if procGroups[fk]?.length}
          <div class="pm-lane">
            <div class="pm-freq">
              <div class="pm-freq-pip" style="background:{FREQ_COLORS[fk] ?? 'var(--text-3)'}"></div>
              {freqDisplay(fk)}
            </div>
            <div class="pm-chips">
              {#each procGroups[fk] as p}
                <div class="pm-chip" title="{p.description || p.name}\nModule: {p.module}{p.runCount ? '\nRuns: ' + p.runCount : ''}">
                  <div class="pm-chip-dot" style="background:{FREQ_COLORS[fk] ?? 'var(--text-3)'}"></div>
                  {p.name}
                  {#if p.module}<span class="pm-chip-module">{p.module}</span>{/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- Overdue (excluding regular tasks - those belong in Tasks view) -->
  {#if filteredOverdue.length}
    <Panel title="Overdue ({filteredOverdue.length})" dotColor="var(--red)" cls="anim d2" style="border-color:var(--red)">
      {#each filteredOverdue as ev}
        <div class="tl-ev">
          <div class="tl-ev-dot" style="background:{ev.color ?? TL_COLORS[ev.type] ?? 'var(--text-3)'}"></div>
          <div class="tl-ev-info">
            <span class="tl-ev-title">{ev.title}</span>
            <span class="tl-ev-meta" style="margin-left:8px">{[ev.type, ev.time, ev.extra].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}

  <!-- Legend -->
  <div class="tl-header">
    <div class="tl-legend">
      {#each [['Research','#8B7CF6'],['Interval','#3DD6C8'],['Cache','#6E738A']] as [l, c]}
        <div class="tl-legend-item"><div class="tl-legend-dot" style="background:{c}"></div>{l}</div>
      {/each}
    </div>
    {#if totalEvents > 0}
      <span class="tl-hint">Click a day to see details</span>
    {:else}
      <span class="tl-hint" style="color:var(--text-3)">No scheduled automation events</span>
    {/if}
  </div>

  <!-- Grid (always show for visual context) -->
  <div class="tl-layout anim d3" style="overflow:hidden;margin-bottom:16px">
    <div class="tl-row-labels">
      <div class="tl-month-bar"></div>
      {#each ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] as d, i}
        <div class="tl-row-lbl {i >= 5 ? 'weekend' : ''}">{d}</div>
      {/each}
    </div>
    <div class="tl-scroll">
      <div class="tl-month-row">
        {#each gridData.months as m}
          <div class="tl-month-lbl" style="width:{m.width}px">{m.label}</div>
        {/each}
      </div>
      <div class="tl-grid">
        {#each gridData.dates as dd}
          {@const events = filterEvents(cal?.days?.[dd.date] ?? [])}
          {@const hasEvents = events.length > 0}
          {@const cls = ['tl-cell', dd.outside ? 'outside' : '', dd.date === todayStr ? 'today' : '', hasEvents ? 'has-events' : '', (dd.dow === 0 || dd.dow === 6) ? 'weekend' : ''].filter(Boolean).join(' ')}
          <div class={cls} on:click={() => !dd.outside && openDayModal(dd.date)} role="button" tabindex={dd.outside ? -1 : 0} on:keypress={() => {}}>
            <div class="tl-cell-num">{dd.day}</div>
            {#if hasEvents}
              <div class="tl-cell-dots">
                {#each events.slice(0, 4) as ev}
                  <div class="tl-dot" style="background:{ev.color ?? TL_COLORS[ev.type] ?? 'var(--text-3)'}"></div>
                {/each}
                {#if events.length > 4}<div class="tl-more">+{events.length - 4}</div>{/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<DayModal open={modalOpen} date={selectedDay} events={selectedEvents} onClose={() => modalOpen = false} />

<style>
  .tl-hint {
    font-size: 11px;
    color: var(--text-3);
    font-style: italic;
  }
  .tl-cell.has-events {
    cursor: pointer;
  }
  .tl-cell.has-events:hover {
    background: var(--bg-3);
  }
</style>
