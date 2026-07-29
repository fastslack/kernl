<script lang="ts">
  // /planner — migrated from services/dashboard/src/routes/planner/+page.svelte
  // (Fase 2b). Lives in the events extension: it owns the `calendar` WS
  // channel + `dashboard.calendar` RPC that hydrate the planner store. All
  // mutations preserve the shell's rpcOrCall / WS-only semantics via ctx.rpc.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import TodayPanel from './TodayPanel.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import DayModal from './DayModal.svelte';
  import { TL_COLORS, TL_MONTHS } from './constants';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const planner = ctx.getStore('planner') as any;

  const post = (url: string, body: unknown) =>
    ctx.fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // Calendar payload (same shape as the `planner` store). HTTP route always
  // exists; WS is tried first.
  const fetchCalendar = (start: string, days: number) =>
    ctx.rpc('dashboard.calendar', { start, days },
      () => ctx.fetchJson(`/api/dashboard/calendar?start=${encodeURIComponent(start)}&days=${days}`));

  // Tasks (rpcOrCall semantics — WS raced against HTTP).
  const updateTaskStatus = (id: string, status: string) =>
    ctx.rpc('tasks.updateStatus', { id, status }, () => post('/api/tasks/update-status', { id, status }));
  const updateTaskField = (id: string, field: string, value: unknown) =>
    ctx.rpc('tasks.updateField', { id, field, value }, () => post('/api/tasks/update-field', { id, field, value }));
  const createTask = (task: { title: string; due_date?: string }) =>
    ctx.rpc('tasks.create', task, () => post('/api/tasks/create', task));
  const deleteTask = (id: string) =>
    ctx.rpc('tasks.delete', { id }, () => post('/api/tasks/delete', { id }));
  const rescheduleTask = (id: string, dueDate: string) => updateTaskField(id, 'due_date', dueDate);
  const completeTask = (id: string) => updateTaskStatus(id, 'done');
  const renameTask = (id: string, title: string) => updateTaskField(id, 'title', title);

  // Reminders (WS RPC — no legacy HTTP route, except dismiss/snooze).
  const createReminder = (r: { title: string; trigger_at: string; repeat?: string; body?: string }) =>
    ctx.rpc('reminders.create', r);
  const rescheduleReminder = (id: string, triggerAt: string) =>
    ctx.rpc('reminders.reschedule', { id, trigger_at: triggerAt });
  const renameReminder = (id: string, title: string) =>
    ctx.rpc('reminders.update', { id, title });
  const dismissReminder = (id: string) =>
    ctx.rpc('reminders.dismiss', { id }, () => post('/api/reminders/dismiss', { id }));

  // Events (WS RPC).
  const createEvent = (e: { title: string; start_at: string; end_at?: string; type?: string }) =>
    ctx.rpc('events.create', e);
  const rescheduleEvent = (id: string, startAt: string) =>
    ctx.rpc('events.reschedule', { id, start_at: startAt });
  const completeEvent = (id: string) =>
    ctx.rpc('events.update', { id, status: 'completed' });
  const renameEvent = (id: string, title: string) =>
    ctx.rpc('events.update', { id, title });
  const cancelEvent = (id: string) =>
    ctx.rpc('events.update', { id, status: 'cancelled' });

  $: cal = ($planner as any);

  let selectedDay = '';
  let modalOpen = false;
  let busy = false;
  let dragType = '';
  let dragId = '';
  let dragTime: string | null = null;
  let dragOverDay = '';
  const todayStr = new Date().toISOString().split('T')[0];

  // Build a full ISO timestamp for a day + optional HH:MM time (defaults 09:00).
  function isoAt(day: string, time: string | null): string {
    const t = time && /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : '09:00';
    return `${day}T${t}:00`;
  }

  // Re-fetch the calendar payload and update the store so the grid + modal
  // reflect the mutation. (WS pushes also reconcile eventually.)
  async function refresh() {
    if (!cal) return;
    try {
      const fresh = await fetchCalendar(cal.start, cal.dayCount);
      if (fresh) planner.set(fresh);
    } catch (e) {
      console.error('[planner] refresh failed', e);
    }
  }

  // Run a mutation with a busy guard, then refresh.
  async function mutate(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      await refresh();
    } catch (e) {
      console.error('[planner] mutation failed', e);
    } finally {
      busy = false;
    }
  }

  function rescheduleChip(ev: any, day: string) {
    if (ev.type === 'task') return mutate(() => rescheduleTask(ev.id, day));
    if (ev.type === 'reminder') return mutate(() => rescheduleReminder(ev.id, isoAt(day, ev.time)));
    if (ev.type === 'event') return mutate(() => rescheduleEvent(ev.id, isoAt(day, ev.time)));
  }
  function completeChip(ev: any) {
    if (ev.type === 'task') return mutate(() => completeTask(ev.id));
    if (ev.type === 'reminder') return mutate(() => dismissReminder(ev.id));
    if (ev.type === 'event') return mutate(() => completeEvent(ev.id));
  }
  function renameChip(ev: any, title: string) {
    if (ev.type === 'task') return mutate(() => renameTask(ev.id, title));
    if (ev.type === 'reminder') return mutate(() => renameReminder(ev.id, title));
    if (ev.type === 'event') return mutate(() => renameEvent(ev.id, title));
  }
  function deleteChip(ev: any) {
    if (ev.type === 'task') return mutate(() => deleteTask(ev.id));
    if (ev.type === 'reminder') return mutate(() => dismissReminder(ev.id));
    if (ev.type === 'event') return mutate(() => cancelEvent(ev.id));
  }
  function createOnDay(payload: { type: string; title: string; time: string }) {
    const { type, title, time } = payload;
    if (type === 'task') return mutate(() => createTask({ title, due_date: selectedDay }));
    if (type === 'reminder') return mutate(() => createReminder({ title, trigger_at: isoAt(selectedDay, time) }));
    if (type === 'event') return mutate(() => createEvent({ title, start_at: isoAt(selectedDay, time) }));
  }

  // ── Drag-to-reschedule across day cells ──
  function onChipDragStart(ev: any, e: DragEvent) {
    dragType = ev.type; dragId = ev.id; dragTime = ev.time ?? null;
    e.dataTransfer?.setData('text/plain', `${ev.type}:${ev.id}`);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function onCellDrop(day: string) {
    if (!dragId || !dragType) return;
    rescheduleChip({ id: dragId, type: dragType, time: dragTime }, day);
    dragType = ''; dragId = ''; dragTime = null; dragOverDay = '';
  }
  const DRAGGABLE = new Set(['task', 'reminder', 'event']);

  // ── Declutter ──
  // The planner shows only the user's own items (tasks + real reminders/events),
  // never the ~10 module feeds (subscriptions, health, meals, research, goals,
  // vehicles, documents…) or the automation/system processes that flood it.
  const PERSONAL = new Set(['task', 'reminder', 'event']);
  let importantOnly = false;
  let expanded = false; // density toggle: compact icon-chips vs. titled rows

  function isImportant(ev: any): boolean {
    return ev.type === 'task' && (ev.extra === 'high' || ev.extra === 'urgent');
  }
  // `important` is passed explicitly so Svelte tracks it as a reactive dep.
  function visibleEvents(list: any[], important: boolean): any[] {
    const base = (list ?? []).filter((ev) => PERSONAL.has(ev.type));
    return important ? base.filter(isImportant) : base;
  }

  // ── Presentation helpers (icons + per-type grouping) ──────────────────
  // Inline stroke icons keyed by item type — tinted via `color: currentColor`.
  const ICON: Record<string, string> = {
    task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5l2.6 2.6L19 6.2"/><path d="M20 12.2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9.2"/></svg>',
    reminder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9"/><path d="M10.2 19a2 2 0 0 0 3.6 0"/></svg>',
    event: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3M16 3v3M4 9h16"/><rect x="4" y="5.5" width="16" height="15" rx="2.4"/></svg>',
  };
  const TYPE_LABEL: Record<string, string> = { task: 'Task', reminder: 'Reminder', event: 'Event' };
  const GROUP_ORDER = ['event', 'reminder', 'task'];

  // Collapse a day's items into one chip per type with a count + importance flag.
  function groupByType(events: any[]): any[] {
    const m = new Map<string, any>();
    for (const ev of events) {
      if (!PERSONAL.has(ev.type)) continue;
      const g = m.get(ev.type) ?? { type: ev.type, count: 0, important: false, color: ev.color ?? TL_COLORS[ev.type] };
      g.count++;
      if (isImportant(ev)) g.important = true;
      m.set(ev.type, g);
    }
    return GROUP_ORDER.filter((t) => m.has(t)).map((t) => m.get(t));
  }

  // Rich multi-line native tooltip for a cell (icon glyph + time + title).
  function dayTooltip(events: any[]): string {
    const glyph: Record<string, string> = { task: '☑', reminder: '⏰', event: '◆' };
    return events
      .map((ev) => {
        const t = ev.time ? ` ${String(ev.time).slice(0, 5)}` : '';
        return `${glyph[ev.type] ?? '•'}${t}  ${ev.title}`;
      })
      .join('\n');
  }

  // Build calendar grid
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

    const dates = [];
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
    const months: { label: string; width: number; weeks: number }[] = [];
    let curMonth = -1, curCount = 0, curMonthKey = -1;
    for (let w = 0; w < totalWeeks; w++) {
      const md = dates[w * 7];
      const mKey = md.year * 100 + md.month;
      if (mKey !== curMonthKey) {
        if (curMonth >= 0) months.push({ label: TL_MONTHS[curMonth] + ' ' + dates[(months.length > 0 ? months.reduce((s,m_)=>s+Math.round(m_.width/52),0) : 0)*7]?.year, width: curCount * 52, weeks: curCount });
        curMonth = md.month;
        curMonthKey = mKey;
        curCount = 0;
      }
      curCount++;
      if (w === totalWeeks - 1) months.push({ label: TL_MONTHS[md.month] + ' ' + md.year, width: curCount * 52, weeks: curCount });
    }
    return { dates, totalWeeks, months, startStr: c.start, endDateStr };
  }

  // ── Summary strip: counts over the visible range + next upcoming item ──
  $: summary = (cal && gridData) ? buildSummary(cal, gridData.dates) : null;

  function buildSummary(c: any, dates: any[]) {
    const counts: Record<string, number> = { task: 0, reminder: 0, event: 0 };
    let next: { ev: any; date: string } | null = null;
    for (const dd of dates) {
      if (dd.outside) continue;
      const items = (c.days?.[dd.date] ?? []).filter((ev: any) => PERSONAL.has(ev.type));
      for (const ev of items) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
      if (!next && dd.date >= todayStr && items.length) {
        next = { ev: items.find((ev: any) => ev.type === 'event') ?? items[0], date: dd.date };
      }
    }
    let countdown = '';
    if (next) {
      const days = Math.round(
        (new Date(next.date + 'T00:00:00Z').getTime() - new Date(todayStr + 'T00:00:00Z').getTime()) / 86400000
      );
      countdown = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    }
    return { counts, next, countdown };
  }

  // Locate today's column so we can highlight the active week + scroll to it.
  $: todayIndex = gridData ? gridData.dates.findIndex((d: any) => d.date === todayStr) : -1;
  $: weekOfToday = todayIndex >= 0 ? Math.floor(todayIndex / 7) : -1;

  // Action: center the horizontal timeline on today when the board mounts.
  function centerToday(node: HTMLElement) {
    setTimeout(() => {
      const el = node.querySelector('.pl-cell.today') as HTMLElement | null;
      el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
    }, 60);
    return {};
  }

  $: selectedEvents = visibleEvents(cal?.days?.[selectedDay] ?? [], importantOnly);

  function openDayModal(date: string) {
    // Open for any in-range day so items can be added even to empty days.
    selectedDay = date;
    modalOpen = true;
  }
</script>

<ViewHeader title="Planner" sub="Your tasks, reminders and events" />
<TodayPanel {ctx} />

{#if !cal}
  <div class="loading-view">Loading planner data...</div>
{:else if !gridData}
  <Panel cls="anim"><Empty message="Timeline data not available." /></Panel>
{:else}
  <!-- Legend + filter -->
  <div class="pl-bar">
    <div class="pl-legend">
      {#each GROUP_ORDER as t}
        <div class="pl-legend-item">
          <span class="pl-ic" style="color:{TL_COLORS[t]}">{@html ICON[t]}</span>
          {TYPE_LABEL[t]}
        </div>
      {/each}
      <div class="pl-legend-sep"></div>
      <div class="pl-legend-item">
        <span class="pl-star">★</span> Importante
      </div>
    </div>
    <div class="pl-actions">
      <button
        class="pl-filter {expanded ? 'active' : ''}"
        on:click={() => (expanded = !expanded)}
        title="Toggle compact / expanded view (with titles)"
      >
        {expanded ? '▤ Ampliado' : '▦ Compacto'}
      </button>
      <button
        class="pl-filter {importantOnly ? 'active' : ''}"
        on:click={() => (importantOnly = !importantOnly)}
        title="Show only important tasks (high/urgent)"
      >
        <span class="pl-filter-star">{importantOnly ? '★' : '☆'}</span> Solo importantes
      </button>
    </div>
  </div>

  <!-- Summary strip -->
  {#if summary}
    <div class="pl-summary">
      {#each GROUP_ORDER as t}
        <div class="pl-sum-item">
          <span class="pl-ic" style="color:{TL_COLORS[t]}">{@html ICON[t]}</span>
          <span class="pl-sum-n">{summary.counts[t]}</span>
          <span class="pl-sum-l">{TYPE_LABEL[t]}{summary.counts[t] === 1 ? '' : 's'}</span>
        </div>
      {/each}
      {#if summary.next}
        <div class="pl-sum-next">
          <span class="pl-sum-next-lbl">Próximo</span>
          <span class="pl-ic" style="color:{summary.next.ev.color ?? TL_COLORS[summary.next.ev.type]}">{@html ICON[summary.next.ev.type]}</span>
          <span class="pl-sum-next-title">{summary.next.ev.title}</span>
          <span class="pl-sum-next-cd">{summary.countdown}</span>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Calendar board -->
  <div class="pl-board {expanded ? 'expanded' : ''}">
    <div class="pl-layout">
      <!-- Row labels Mon-Sun -->
      <div class="pl-rowlabels">
        <div class="pl-monthbar"></div>
        {#each ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'] as d, i}
          <div class="pl-rowlbl {i >= 5 ? 'weekend' : ''}">{d}</div>
        {/each}
      </div>
      <!-- Scrollable grid -->
      <div class="pl-scroll" use:centerToday>
        <!-- Month headers -->
        <div class="pl-monthrow">
          {#each gridData.months as m}
            <div class="pl-monthlbl" style="width:calc(var(--cw) * {m.weeks})">{m.label}</div>
          {/each}
        </div>
        <!-- Day grid -->
        <div class="pl-grid">
          {#each gridData.dates as dd, i}
            {@const events = visibleEvents(cal.days?.[dd.date] ?? [], importantOnly)}
            {@const groups = groupByType(events)}
            {@const isToday = dd.date === todayStr}
            {@const cls = ['pl-cell', dd.outside ? 'outside' : '', isToday ? 'today' : '', events.length ? 'has' : '', (dd.dow === 0 || dd.dow === 6) ? 'weekend' : '', dragOverDay === dd.date ? 'dragover' : '', (weekOfToday >= 0 && Math.floor(i / 7) === weekOfToday) ? 'thisweek' : ''].filter(Boolean).join(' ')}
            <div
              class={cls}
              style="--d:{Math.floor(i / 7) * 20}ms"
              title={events.length ? dayTooltip(events) : ''}
              on:click={() => !dd.outside && openDayModal(dd.date)}
              role="button"
              tabindex={dd.outside ? -1 : 0}
              on:keypress={e => e.key === 'Enter' && !dd.outside && openDayModal(dd.date)}
              on:dragover={e => { if (!dd.outside) { e.preventDefault(); dragOverDay = dd.date; } }}
              on:dragleave={() => { if (dragOverDay === dd.date) dragOverDay = ''; }}
              on:drop={e => { if (!dd.outside) { e.preventDefault(); onCellDrop(dd.date); } }}
            >
              <div class="pl-cell-card">
                <div class="pl-cell-top">
                  <span class="pl-num">{dd.day}</span>
                  {#if isToday}<span class="pl-today-tag">TODAY</span>{/if}
                </div>
                {#if events.length}
                  {#if expanded}
                    <div class="pl-rows">
                      {#each events.slice(0, 3) as ev}
                        <div
                          class="pl-row {isImportant(ev) ? 'imp' : ''}"
                          style="--c:{ev.color ?? TL_COLORS[ev.type]}"
                          draggable={DRAGGABLE.has(ev.type)}
                          on:dragstart={e => onChipDragStart(ev, e)}
                        >
                          <span class="pl-row-ic">{@html ICON[ev.type]}</span>
                          {#if ev.time}<span class="pl-row-tm">{String(ev.time).slice(0, 5)}</span>{/if}
                          <span class="pl-row-title">{ev.title}</span>
                        </div>
                      {/each}
                      {#if events.length > 3}<div class="pl-row-more">+{events.length - 3} more</div>{/if}
                    </div>
                  {:else}
                    <div class="pl-chips">
                      {#each groups as g}
                        <span
                          class="pl-chip {g.important ? 'imp' : ''}"
                          style="color:{g.color}"
                          draggable={DRAGGABLE.has(g.type)}
                          on:dragstart={e => onChipDragStart({ id: (events.find(e2 => e2.type === g.type) ?? {}).id, type: g.type, time: (events.find(e2 => e2.type === g.type) ?? {}).time }, e)}
                        >
                          <span class="pl-chip-ic">{@html ICON[g.type]}</span>
                          {#if g.count > 1}<span class="pl-chip-n">{g.count}</span>{/if}
                        </span>
                      {/each}
                    </div>
                  {/if}
                {/if}
                {#if !groups.length && !dd.outside}
                  <span class="pl-add" aria-hidden="true">+</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

<DayModal
  open={modalOpen}
  date={selectedDay}
  events={selectedEvents}
  {busy}
  onClose={() => modalOpen = false}
  onCreate={createOnDay}
  onComplete={completeChip}
  onReschedule={rescheduleChip}
  onRename={renameChip}
  onDelete={deleteChip}
/>

<style>
  /* ── Legend / filter bar ─────────────────────────────────────── */
  .pl-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .pl-legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    font-size: 12px;
    color: var(--text-2);
    font-family: var(--font-body);
  }
  .pl-legend-item { display: flex; align-items: center; gap: 6px; }
  .pl-legend-sep { width: 1px; height: 16px; background: var(--border); }
  .pl-ic { width: 15px; height: 15px; display: inline-flex; }
  .pl-ic :global(svg) { width: 100%; height: 100%; }
  .pl-star { color: var(--gold); font-size: 13px; line-height: 1; }

  .pl-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-2);
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 12px;
    font-family: var(--font-body);
    cursor: pointer;
    white-space: nowrap;
    transition: all .15s ease;
  }
  .pl-filter:hover { background: var(--surface-2); color: var(--text-1); border-color: var(--border-h); }
  .pl-filter.active {
    background: rgba(212, 168, 75, .12);
    border-color: var(--gold);
    color: var(--gold);
  }
  .pl-filter-star { font-size: 13px; line-height: 1; }

  /* ── Board container ─────────────────────────────────────────── */
  .pl-board {
    --cw: 52px;
    --ch: 58px;
    position: relative;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background:
      radial-gradient(120% 80% at 0% 0%, rgba(212, 168, 75, .05), transparent 55%),
      linear-gradient(180deg, var(--surface-1), var(--bg));
    padding: 14px 14px 16px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255, 255, 255, .02) inset, 0 12px 30px -18px rgba(0, 0, 0, .6);
    animation: plRise .4s ease both;
  }
  @keyframes plRise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  .pl-layout { display: flex; gap: 0; }

  /* ── Sticky day-of-week rail ─────────────────────────────────── */
  .pl-rowlabels { display: flex; flex-direction: column; flex-shrink: 0; width: 40px; }
  .pl-monthbar { height: 30px; }
  .pl-rowlbl {
    height: var(--ch);
    transition: height .22s ease;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 8px;
    font-size: 10px;
    letter-spacing: .04em;
    text-transform: uppercase;
    color: var(--text-3);
    font-family: var(--font-mono);
  }
  .pl-rowlbl.weekend { color: var(--gold); opacity: .5; }

  .pl-scroll { flex: 1; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--border-h) transparent; }
  .pl-scroll::-webkit-scrollbar { height: 8px; }
  .pl-scroll::-webkit-scrollbar-thumb { background: var(--border-h); border-radius: 999px; }
  .pl-scroll::-webkit-scrollbar-track { background: transparent; }

  /* ── Month headers ───────────────────────────────────────────── */
  .pl-monthrow { display: flex; height: 30px; }
  .pl-monthlbl {
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--text-2);
    white-space: nowrap;
    border-left: 1px solid var(--border);
  }
  .pl-monthlbl:first-child { border-left: none; }

  /* ── Day grid (timeline, weeks flow horizontally) ────────────── */
  .pl-grid { display: grid; grid-template-rows: repeat(7, var(--ch)); grid-auto-flow: column; }

  .pl-cell {
    width: var(--cw);
    height: var(--ch);
    padding: 3px;
    outline: none;
    transition: width .22s ease, height .22s ease;
    animation: plCell .32s ease both;
    animation-delay: var(--d);
  }
  @keyframes plCell { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: none; } }

  .pl-cell-card {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    padding: 4px 5px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    transition: transform .14s ease, box-shadow .14s ease, background .14s ease, border-color .14s ease;
  }
  .pl-cell.has { cursor: pointer; }
  .pl-cell.has .pl-cell-card { background: var(--surface-2); }
  .pl-cell.has:hover .pl-cell-card {
    transform: translateY(-3px);
    border-color: var(--border-h);
    background: var(--surface-3);
    box-shadow: 0 10px 22px -12px rgba(0, 0, 0, .7);
  }
  .pl-cell:focus-visible .pl-cell-card { border-color: var(--gold); }

  .pl-cell.weekend .pl-cell-card { background: rgba(212, 168, 75, .035); }
  .pl-cell.weekend.has .pl-cell-card { background: var(--surface-2); }

  .pl-cell.outside { pointer-events: none; }
  .pl-cell.outside .pl-cell-card { opacity: .28; background: transparent; border-color: transparent; }

  /* Today: gold ring + glow + accented number */
  .pl-cell.today .pl-cell-card {
    border-color: var(--gold);
    box-shadow: 0 0 0 1px var(--gold) inset, 0 0 16px -4px rgba(212, 168, 75, .5);
    background: rgba(212, 168, 75, .08);
  }

  .pl-cell.dragover .pl-cell-card {
    border-color: var(--blue);
    border-style: dashed;
    background: rgba(91, 155, 247, .12);
  }

  .pl-cell-top { display: flex; align-items: center; justify-content: space-between; gap: 2px; }
  .pl-num {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
    line-height: 1;
  }
  .pl-cell.has .pl-num { color: var(--text-2); }
  .pl-cell.today .pl-num { color: var(--gold); }
  .pl-today-tag {
    font-family: var(--font-mono);
    font-size: 7px;
    font-weight: 700;
    letter-spacing: .06em;
    color: var(--gold);
    background: rgba(212, 168, 75, .14);
    border-radius: 3px;
    padding: 1px 3px;
    line-height: 1;
  }

  /* ── Per-type icon chips ─────────────────────────────────────── */
  .pl-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; margin-top: auto; }
  .pl-chip {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    border-radius: 5px;
    padding: 1px;
    cursor: grab;
  }
  .pl-chip:active { cursor: grabbing; }
  .pl-chip-ic { width: 12px; height: 12px; display: inline-flex; }
  .pl-chip-ic :global(svg) { width: 100%; height: 100%; filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .35)); }
  .pl-chip-n {
    font-family: var(--font-mono);
    font-size: 8px;
    font-weight: 700;
    color: var(--text-2);
    line-height: 1;
  }
  /* Important tasks: bright halo ring around the chip */
  .pl-chip.imp {
    background: rgba(255, 255, 255, .06);
    box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .85), 0 0 7px 0 rgba(255, 255, 255, .35);
  }
  .pl-chip.imp .pl-chip-n { color: var(--text-1); }

  /* ── Summary strip ───────────────────────────────────────────── */
  .pl-summary {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .pl-sum-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-1);
  }
  .pl-sum-n { font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--text-1); line-height: 1; }
  .pl-sum-l { font-size: 11px; color: var(--text-3); }
  .pl-sum-next {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    padding: 6px 8px 6px 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background:
      linear-gradient(90deg, transparent, rgba(212, 168, 75, .06)),
      var(--surface-1);
    max-width: 100%;
    overflow: hidden;
  }
  .pl-sum-next-lbl {
    font-family: var(--font-mono);
    font-size: 8px;
    font-weight: 700;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .pl-sum-next-title {
    font-size: 12px;
    color: var(--text-1);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 240px;
  }
  .pl-sum-next-cd {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    color: var(--gold);
    background: rgba(212, 168, 75, .12);
    border-radius: 999px;
    padding: 3px 8px;
    white-space: nowrap;
  }

  /* ── Active week column tint ─────────────────────────────────── */
  .pl-cell.thisweek .pl-cell-card { box-shadow: inset 0 0 0 1px rgba(212, 168, 75, .07); }
  .pl-cell.thisweek.has .pl-cell-card { border-color: var(--border-h); }

  /* ── Empty-day add affordance ────────────────────────────────── */
  .pl-add {
    margin: auto;
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 400;
    color: var(--text-3);
    opacity: 0;
    transform: scale(.7);
    transition: opacity .14s ease, transform .14s ease, color .14s ease;
    pointer-events: none;
  }
  .pl-cell:not(.has):not(.outside):hover .pl-add,
  .pl-cell:not(.has):not(.outside):focus-visible .pl-add {
    opacity: 1;
    transform: scale(1);
    color: var(--gold);
  }
  .pl-cell:not(.has):not(.outside):hover .pl-cell-card {
    border-color: var(--border-h);
    background: var(--surface-2);
  }

  /* ── Action toggles (density + importance) ───────────────────── */
  .pl-actions { display: inline-flex; gap: 8px; flex-wrap: wrap; }

  /* ── Expanded (titled) mode ──────────────────────────────────── */
  .pl-board.expanded { --cw: 158px; --ch: 98px; }
  .pl-board.expanded .pl-num { font-size: 12px; }
  .pl-board.expanded .pl-cell-card { padding: 5px 6px; }

  .pl-rows { display: flex; flex-direction: column; gap: 2px; margin-top: 3px; overflow: hidden; }
  .pl-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 5px;
    border-radius: 5px;
    background: var(--surface-1);
    border-left: 2px solid var(--c);
    cursor: grab;
    transition: background .12s ease, transform .12s ease;
  }
  .pl-row:hover { background: var(--surface-3); transform: translateX(1px); }
  .pl-row:active { cursor: grabbing; }
  .pl-row-ic { width: 11px; height: 11px; display: inline-flex; color: var(--c); flex-shrink: 0; }
  .pl-row-ic :global(svg) { width: 100%; height: 100%; }
  .pl-row-tm {
    font-family: var(--font-mono);
    font-size: 8px;
    font-weight: 600;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .pl-row-title {
    font-size: 10px;
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pl-row.imp { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14); }
  .pl-row.imp .pl-row-title { font-weight: 600; }
  .pl-row-more { font-size: 9px; color: var(--text-3); padding: 1px 5px; }

  /* ── Today pulse (subtle, reduced-motion aware) ──────────────── */
  @keyframes todayPulse {
    0%, 100% { box-shadow: 0 0 0 1px var(--gold) inset, 0 0 14px -5px rgba(212, 168, 75, .45); }
    50%      { box-shadow: 0 0 0 1px var(--gold) inset, 0 0 20px -2px rgba(212, 168, 75, .7); }
  }
  .pl-cell.today .pl-cell-card { animation: todayPulse 3s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .pl-cell.today .pl-cell-card { animation: none; }
    .pl-cell { animation: none; }
    .pl-board { animation: none; }
  }
</style>
