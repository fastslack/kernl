<script lang="ts">
  // /planner — migrated from services/dashboard/src/routes/planner/+page.svelte
  // (Fase 2b). Lives in the events extension: it owns the `calendar` WS
  // channel + `dashboard.calendar` RPC that hydrate the planner store. All
  // mutations preserve the shell's rpcOrCall / WS-only semantics via ctx.rpc.
  import { onMount } from 'svelte';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import DayModal from '$shared/components/DayModal.svelte';
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
  const TYPE_ES: Record<string, string> = { task: 'tareas', reminder: 'avisos', event: 'eventos' };
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
      countdown = days <= 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
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

  // ── The lists under the calendar ──────────────────────────────────────
  // «Hoy y vencido» is the agenda brain's plan (what to do today, overdue first); «Próximos 7 días» and
  // «Importantes» come from the same calendar payload as the grid. A row opens its day, where it is acted on.
  let plan: any = null;
  let planLoading = true;
  onMount(async () => {
    // The calendar store is filled by the live `calendar` channel, which can take a while to push after the page
    // opens: ask for it now when it is still empty (the kernel answers in well under a second).
    if (!$planner) {
      ctx.rpc('dashboard.calendar', {}, () => ctx.fetchJson('/api/dashboard/calendar'))
        .then((fresh: any) => { if (fresh && !$planner) planner.set(fresh); })
        .catch(() => { /* the live channel still fills it */ });
    }
    try { plan = await ctx.rpc('agendaBrain.today', {}, () => ctx.fetchJson('/api/dashboard/agenda-today')); } catch { plan = null; }
    planLoading = false;
  });

  function dayOffset(n: number): string {
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().split('T')[0];
  }
  const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  function dayLabel(date: string): string {
    if (date === todayStr) return 'Hoy';
    if (date === dayOffset(1)) return 'Mañana';
    const d = new Date(date + 'T12:00:00Z');
    return `${DOW[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  }
  /** The plan's reasons come in English from the agenda brain. */
  function why(s: string): string {
    return String(s ?? '')
      .replace(/(\d+)d overdue/g, 'vencida hace $1 d')
      .replace(/due today/g, 'vence hoy')
      .replace(/due tomorrow/g, 'vence mañana')
      .replace(/due in (\d+)d/g, 'vence en $1 d')
      .replace(/high priority/g, 'prioridad alta')
      .replace(/urgent/g, 'urgente')
      .replace(/not urgent/g, 'sin apuro');
  }

  $: upcoming = cal ? buildUpcoming(cal.days, importantOnly) : [];
  function buildUpcoming(days: any, important: boolean) {
    const out: Array<{ date: string; ev: any }> = [];
    for (let i = 0; i < 7; i++) {
      const date = dayOffset(i);
      for (const ev of visibleEvents(days?.[date] ?? [], important)) out.push({ date, ev });
    }
    return out;
  }
  $: importantList = cal ? buildImportant(cal.days) : [];
  function buildImportant(days: any) {
    const out: Array<{ date: string; ev: any }> = [];
    for (const [date, list] of Object.entries(days ?? {})) {
      for (const ev of (list as any[]) ?? []) if (isImportant(ev)) out.push({ date, ev });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  function openDayModal(date: string) {
    // Open for any in-range day so items can be added even to empty days.
    selectedDay = date;
    modalOpen = true;
  }
</script>

<div class="pl-page">
<ViewHeader title="Agenda" sub="Tu calendario arriba; abajo, lo de hoy, lo que viene y lo importante" />

{#if !cal}
  <div class="pl-loading" role="status" aria-live="polite">
    <span class="pl-spin" aria-hidden="true"></span><span>Cargando la agenda…</span>
  </div>
  <div class="pl-skel-board" aria-hidden="true">
    {#each Array(7) as _, r}
      <div class="pl-skel-row">{#each Array(26) as _, c}<span class="pl-skel-cell" style="--i:{(r + c) % 12}"></span>{/each}</div>
    {/each}
  </div>
  <div class="pl-lists" aria-hidden="true">
    {#each Array(3) as _}
      <div class="pl-list">{#each Array(6) as _, i}<span class="pl-skel-line" style="--i:{i}; width:{90 - (i % 3) * 18}%"></span>{/each}</div>
    {/each}
  </div>
{:else if !gridData}
  <Panel cls="anim"><Empty message="Timeline data not available." /></Panel>
{:else}
  <!-- One bar: what the range holds (the counters double as the legend), the next item, the view toggles -->
  <div class="pl-bar">
    <div class="pl-legend">
      {#each GROUP_ORDER as t}
        <div class="pl-sum-item" title={TYPE_LABEL[t]}>
          <span class="pl-ic" style="color:{TL_COLORS[t]}">{@html ICON[t]}</span>
          <span class="pl-sum-n">{summary?.counts[t] ?? 0}</span>
          <span class="pl-sum-l">{TYPE_ES[t]}</span>
        </div>
      {/each}
      <div class="pl-legend-item"><span class="pl-star">★</span> Importante</div>
    </div>
    {#if summary?.next}
      <div class="pl-sum-next">
        <span class="pl-sum-next-lbl">Próximo</span>
        <span class="pl-ic" style="color:{summary.next.ev.color ?? TL_COLORS[summary.next.ev.type]}">{@html ICON[summary.next.ev.type]}</span>
        <span class="pl-sum-next-title">{summary.next.ev.title}</span>
        <span class="pl-sum-next-cd">{summary.countdown}</span>
      </div>
    {/if}
    <div class="pl-actions">
      <button class="pl-filter {expanded ? 'active' : ''}" on:click={() => (expanded = !expanded)} title="Compacto o con títulos">
        {expanded ? '▤ Ampliado' : '▦ Compacto'}
      </button>
      <button class="pl-filter {importantOnly ? 'active' : ''}" on:click={() => (importantOnly = !importantOnly)} title="Solo tareas importantes (alta o urgente)">
        <span class="pl-filter-star">{importantOnly ? '★' : '☆'}</span> Solo importantes
      </button>
    </div>
  </div>

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
              style="--d:{Math.floor(i / 7) * 4}ms"
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
                  {#if isToday}<span class="pl-today-tag">HOY</span>{/if}
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

  <div class="pl-lists">
    <section class="pl-list">
      <h3>Hoy y vencido {#if plan?.counts}<small>{plan.counts.overdue} vencidas · {plan.counts.dueToday} hoy</small>{/if}</h3>
      <ul>
        {#if planLoading}
          {#each Array(5) as _, i}<li class="pl-skel-li" aria-hidden="true"><span class="pl-skel-line" style="--i:{i}; width:{88 - (i % 3) * 16}%"></span></li>{/each}
        {/if}
        {#each plan?.items ?? [] as it}
          <li><button on:click={() => openDayModal(dayOffset(Math.max(0, it.daysUntilDue ?? 0)))}>
            <span class="pl-li-ic" style="color:{TL_COLORS[it.type ?? 'task']}">{@html ICON[it.type ?? 'task']}</span>
            <span class="pl-li-txt"><span class="pl-li-t">{it.title}</span><small class:late={(it.daysUntilDue ?? 0) < 0}>{why(it.why)}</small></span>
          </button></li>
        {:else}
          {#if !planLoading}<li class="pl-empty">Nada para hoy.</li>{/if}
        {/each}
      </ul>
    </section>
    <section class="pl-list">
      <h3>Próximos 7 días <small>{upcoming.length}</small></h3>
      <ul>
        {#each upcoming as u}
          <li><button on:click={() => openDayModal(u.date)}>
            <span class="pl-li-day">{dayLabel(u.date)}</span>
            <span class="pl-li-ic" style="color:{u.ev.color ?? TL_COLORS[u.ev.type]}">{@html ICON[u.ev.type]}</span>
            <span class="pl-li-txt"><span class="pl-li-t">{u.ev.title}</span>{#if u.ev.time && !String(u.ev.time).startsWith('00:00')}<small>{String(u.ev.time).slice(0, 5)}</small>{/if}</span>
          </button></li>
        {:else}
          <li class="pl-empty">Nada en la semana.</li>
        {/each}
      </ul>
    </section>
    <section class="pl-list">
      <h3>Importantes <small>{importantList.length}</small></h3>
      <ul>
        {#each importantList as u}
          <li><button on:click={() => openDayModal(u.date)}>
            <span class="pl-li-day" class:late={u.date < todayStr}>{dayLabel(u.date)}</span>
            <span class="pl-star">★</span>
            <span class="pl-li-txt"><span class="pl-li-t">{u.ev.title}</span></span>
          </button></li>
        {:else}
          <li class="pl-empty">Ninguna tarea con prioridad alta o urgente.</li>
        {/each}
      </ul>
    </section>
  </div>
{/if}
</div>

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

  /* ── The whole page fits the screen: calendar on top, the lists take what is left ── */
  .pl-page { display: flex; flex-direction: column; gap: 10px; height: calc(100vh - 118px); min-height: 620px; }
  .pl-page > :global(*) { flex: none; }
  .pl-page .pl-bar { margin: 0; flex-wrap: wrap; row-gap: 6px; }
  .pl-page .pl-legend { flex-wrap: wrap; gap: 6px; }
  .pl-page .pl-sum-item { padding: 4px 10px; }
  .pl-page .pl-sum-next { margin-left: auto; }
  .pl-lists { flex: 1 1 auto !important; min-height: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .pl-list { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1); padding: 10px 10px 6px; }
  .pl-list h3 { margin: 0 0 6px; font: 700 13px var(--font-display); color: var(--text-1); display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .pl-list h3 small { font: 500 11px var(--font-mono); color: var(--gold); }
  .pl-list ul { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; min-height: 0; }
  .pl-list li button { width: 100%; display: flex; align-items: flex-start; gap: 8px; padding: 6px 6px; border: 0; border-radius: 8px; background: none; color: var(--text-1); font: inherit; text-align: left; cursor: pointer; }
  .pl-list li button:hover { background: var(--surface-2); }
  .pl-li-ic { width: 14px; height: 14px; flex: none; display: inline-flex; margin-top: 2px; }
  .pl-li-ic :global(svg) { width: 100%; height: 100%; }
  .pl-li-day { flex: none; width: 70px; white-space: nowrap; font: 600 11px var(--font-mono); color: var(--text-2); margin-top: 2px; }
  .pl-li-day.late, .pl-li-txt small.late { color: #fb7185; }
  .pl-li-txt { display: flex; flex-direction: column; min-width: 0; }
  .pl-li-t { font-size: 13px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .pl-li-txt small { font-size: 11px; color: var(--text-3); }
  .pl-empty { padding: 10px 6px; font-size: 12.5px; color: var(--text-3); }

  /* ── Loader: a spinner line plus a shimmering outline of the calendar and the lists ── */
  .pl-loading { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-2); }
  .pl-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--gold) 25%, transparent); border-top-color: var(--gold); animation: plSpin .8s linear infinite; }
  @keyframes plSpin { to { transform: rotate(360deg); } }
  .pl-skel-board { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1); padding: 30px 12px 10px 52px; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
  .pl-skel-row { display: flex; gap: 4px; }
  .pl-skel-cell { flex: none; width: 46px; height: 34px; border-radius: 8px; }
  .pl-skel-cell, .pl-skel-line {
    background: linear-gradient(90deg, var(--surface-2) 0%, color-mix(in srgb, var(--gold) 10%, var(--surface-3)) 50%, var(--surface-2) 100%);
    background-size: 300% 100%;
    animation: plShimmer 1.4s ease-in-out infinite;
    animation-delay: calc(var(--i, 0) * 60ms);
  }
  .pl-skel-line { display: block; height: 12px; border-radius: 6px; margin: 10px 6px; }
  .pl-skel-li { list-style: none; }
  @keyframes plShimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
  @media (prefers-reduced-motion: reduce) {
    .pl-spin, .pl-skel-cell, .pl-skel-line { animation: none; }
  }
  @media (max-width: 1100px) {
    .pl-page { height: auto; }
    .pl-lists { grid-template-columns: 1fr; }
    .pl-list ul { max-height: 260px; }
  }

  /* ── Board container ─────────────────────────────────────────── */
  .pl-board {
    --cw: 50px;
    --ch: 38px;
    position: relative;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background:
      radial-gradient(120% 80% at 0% 0%, rgba(212, 168, 75, .05), transparent 55%),
      linear-gradient(180deg, var(--surface-1), var(--bg));
    padding: 8px 12px 10px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255, 255, 255, .02) inset, 0 12px 30px -18px rgba(0, 0, 0, .6);
    animation: plRise .4s ease both;
  }
  @keyframes plRise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  .pl-layout { display: flex; gap: 0; }

  /* ── Sticky day-of-week rail ─────────────────────────────────── */
  .pl-rowlabels { display: flex; flex-direction: column; flex-shrink: 0; width: 40px; }
  .pl-monthbar { height: 22px; }
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
  .pl-monthrow { display: flex; height: 22px; }
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
    animation: plCell .18s ease-out both;
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
