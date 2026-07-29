<script lang="ts">
  import { data, life, comms, house, finance, subscriptions, healthData, analytics, ensureStore } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import Panel from '$lib/components/Panel.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import FlowWidget from '$lib/components/FlowWidget.svelte';
  import { fmtTime, fmtDate, timeAgo, formatCents, weatherEmoji, aqLabel, uvLabel } from '$lib/utils.js';
  import { updateTaskStatus, dismissReminder, snoozeReminder, checkShoppingItem, completeShoppingList,
    listEmailSuggestions, approveEmailSuggestion, dismissEmailSuggestion } from '$lib/api.js';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  const flowWidgetsStore = ensureStore('flowWidgets');
  $: rawWidgets = ($flowWidgetsStore as any)?.widgets;
  $: widgets = Array.isArray(rawWidgets) ? rawWidgets.filter((w: any) => w.result && w.status === 'completed') : [];

  // ── Stores ──
  $: d = ($data as any);
  $: kpis = d?.kpis ?? {};
  $: tasks = d?.tasks ?? {};
  $: crm = d?.crm ?? {};
  $: reminders = d?.reminders ?? {};
  $: shopping = d?.shopping ?? {};
  $: agenda = d?.agenda ?? {};

  $: lf = ($life as any);
  $: cm = ($comms as any);
  $: ho = ($house as any);
  $: fi = ($finance as any);
  $: su = ($subscriptions as any);
  $: he = ($healthData as any);
  $: an = ($analytics as any);

  // ── Tasks ──
  $: taskTodo = tasks.byStatus?.todo ?? 0;
  $: taskInProgress = tasks.byStatus?.in_progress ?? tasks.kpis?.inProgress ?? 0;
  $: taskDone = tasks.byStatus?.done ?? 0;
  $: taskBlocked = tasks.byStatus?.blocked ?? 0;
  $: taskOverdueList = (tasks.overdue ?? []) as any[];
  $: taskDueSoon = (tasks.dueSoon ?? tasks.dueToday ?? []) as any[];
  $: taskTotal = taskTodo + taskInProgress + taskDone + taskBlocked;

  // ── Reminders ──
  $: remOverdue = (reminders.overdue ?? []) as any[];
  $: remUpcoming = (reminders.upcoming24h ?? reminders.upcoming ?? []) as any[];

  // ── Weather (nested under .current) ──
  $: weather = lf?.weather;
  $: wCurrent = weather?.current;
  $: wDaily = weather?.daily ?? [];
  $: sunTimes = lf?.sunTimes;
  $: airQuality = lf?.airQuality;
  $: moonPhase = lf?.moonPhase;

  // ── Finance ──
  $: accounts = (fi?.accounts ?? []) as any[];
  $: totalBalance = accounts.reduce((s: number, a: any) => s + (a.balance_cents ?? 0), 0);
  $: monthExpenses = fi?.monthlySpending?.total_cents ?? 0;

  // ── Subscriptions ──
  $: activeSubs = su?.active ?? [];
  $: monthlySubsCost = su?.monthlyCost ?? 0;

  // ── Comms ──
  $: drafts = (cm?.drafts ?? []) as any[];
  $: recentSent = (cm?.recentSent ?? cm?.sent ?? []) as any[];

  // ── House ──
  $: overdueMaintenanceList = (ho?.overdueMaintenance ?? []) as any[];
  $: activeProjects = (ho?.activeProjects ?? []) as any[];
  $: openIncidents = (ho?.openIncidents ?? []) as any[];

  // ── Health ──
  $: lastMetrics = (he?.recentMetrics ?? []) as any[];

  // ── Panel configuration ──
  const ALL_PANELS = [
    { id: 'agenda', label: 'Agenda', icon: '📅' },
    { id: 'tasks', label: 'Tasks', icon: '☑' },
    { id: 'weather', label: 'Weather', icon: '🌤' },
    { id: 'reminders', label: 'Reminders', icon: '⏰' },
    { id: 'finance', label: 'Finance', icon: '💰' },
    { id: 'comms', label: 'Comms', icon: '✉' },
    { id: 'crm', label: 'People', icon: '👥' },
    { id: 'house', label: 'House', icon: '🏠' },
    { id: 'shopping', label: 'Shopping', icon: '🛒' },
    { id: 'health', label: 'Health', icon: '❤' },
    { id: 'agents', label: 'Agents', icon: '🤖' },
    { id: 'suggestions', label: 'AI Suggestions', icon: '✨' },
  ] as const;

  const STORAGE_KEY = 'mtw-home-panels';
  const DEFAULT_PANELS = ['agenda', 'tasks', 'suggestions', 'weather'];

  let selectedPanels: string[] = [];
  let selectorOpen = false;

  function loadPanels() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          selectedPanels = parsed;
          return;
        }
      }
    } catch {}
    selectedPanels = [...DEFAULT_PANELS];
  }

  function savePanels() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedPanels));
  }

  function togglePanel(id: string) {
    if (selectedPanels.includes(id)) {
      selectedPanels = selectedPanels.filter(p => p !== id);
    } else if (selectedPanels.length < 6) {
      selectedPanels = [...selectedPanels, id];
    }
    savePanels();
  }

  loadPanels();

  // ── Time helpers ──
  function greetingText(): string {
    const h = new Date().getHours();
    if (h < 6) return 'Night owl mode';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    if (h < 22) return 'Good evening';
    return 'Night owl mode';
  }

  function todayStr(): string {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // ── Donut chart ──
  function donutPath(pct: number): string {
    const c = Math.PI * 2 * 36;
    const offset = c - (pct / 100) * c;
    return `stroke-dasharray: ${c}; stroke-dashoffset: ${offset};`;
  }

  // ── Actions ──
  let actionLoading: Record<string, boolean> = {};

  async function doAction(key: string, fn: () => Promise<unknown>) {
    actionLoading[key] = true;
    actionLoading = actionLoading;
    try {
      await fn();
      // Refresh data
      const d = await rpcOrCall('dashboard.full', {}, async () => {
        const r = await fetch('/api/dashboard');
        return r.ok ? r.json() : null;
      });
      if (d) data.set(d);
    } catch (e) {
      console.error('Action failed:', e);
    } finally {
      delete actionLoading[key];
      actionLoading = actionLoading;
    }
  }

  async function doTaskStatus(id: string, status: string) {
    await doAction('task-' + id, () => updateTaskStatus(id, status));
  }

  async function doDismissReminder(id: string) {
    await doAction('rem-' + id, () => dismissReminder(id));
  }

  async function doSnoozeReminder(id: string) {
    await doAction('rem-snz-' + id, () => snoozeReminder(id, 30));
  }

  async function doCheckItem(itemId: string, checked: boolean) {
    await doAction('shop-' + itemId, () => checkShoppingItem(itemId, checked));
  }

  // ── AI Email Suggestions panel ──
  // Loads pending suggestions extracted from emails by EmailAnalysisService.
  // Lives in this file (not in stores) because the panel is opt-in — users
  // who don't enable it shouldn't pay the RPC cost on every dashboard tick.
  interface Suggestion {
    id: string;
    type: 'task' | 'reminder' | 'contact' | 'shopping';
    payload: Record<string, unknown>;
    subject?: string;
    from_email?: string;
    created_at: string;
  }
  let suggestionsList: Suggestion[] = [];
  let suggestionsCounts = { task: 0, reminder: 0, contact: 0, shopping: 0 };
  let suggestionsTotal = 0;
  let suggestionsLoading = false;

  async function loadSuggestions() {
    suggestionsLoading = true;
    try {
      const r = await listEmailSuggestions(20) as {
        suggestions?: Suggestion[];
        counts?: typeof suggestionsCounts;
        total?: number;
      };
      suggestionsList = r?.suggestions ?? [];
      suggestionsCounts = r?.counts ?? suggestionsCounts;
      suggestionsTotal = r?.total ?? suggestionsList.length;
    } catch (e) {
      console.warn('loadSuggestions failed:', e);
    } finally {
      suggestionsLoading = false;
    }
  }

  async function doApproveSuggestion(s: Suggestion) {
    actionLoading['sug-' + s.id] = true;
    actionLoading = actionLoading;
    try {
      const r = await approveEmailSuggestion(s.id) as { ok?: boolean; error?: string };
      if (r?.ok) {
        // Optimistic remove + count adjustment so the panel feels snappy
        // without waiting for a full dashboard refresh.
        suggestionsList = suggestionsList.filter((x) => x.id !== s.id);
        if (suggestionsCounts[s.type] > 0) suggestionsCounts[s.type]--;
        if (suggestionsTotal > 0) suggestionsTotal--;
      } else {
        console.warn('approve failed:', r?.error);
      }
    } finally {
      delete actionLoading['sug-' + s.id];
      actionLoading = actionLoading;
    }
  }

  async function doDismissSuggestion(s: Suggestion) {
    actionLoading['sug-' + s.id] = true;
    actionLoading = actionLoading;
    try {
      await dismissEmailSuggestion(s.id);
      suggestionsList = suggestionsList.filter((x) => x.id !== s.id);
      if (suggestionsCounts[s.type] > 0) suggestionsCounts[s.type]--;
      if (suggestionsTotal > 0) suggestionsTotal--;
    } catch (e) {
      console.warn('dismiss failed:', e);
    } finally {
      delete actionLoading['sug-' + s.id];
      actionLoading = actionLoading;
    }
  }

  function suggestionIcon(t: Suggestion['type']): string {
    return t === 'task' ? '✓' : t === 'reminder' ? '⏰' : t === 'contact' ? '👤' : '🛒';
  }

  function suggestionTitle(s: Suggestion): string {
    const p = s.payload as Record<string, string>;
    return (p.title || p.name) ?? '(untitled)';
  }

  // Load on mount only when the panel is selected — skips the RPC for
  // users who never opted in.
  onMount(() => {
    if (selectedPanels.includes('suggestions')) loadSuggestions();
  });
  // Reactive refetch when the user adds the panel mid-session.
  let prevHasSuggestions = false;
  $: {
    const has = selectedPanels.includes('suggestions');
    if (has && !prevHasSuggestions) loadSuggestions();
    prevHasSuggestions = has;
  }

  // ── Urgent count ──
  $: urgentItems = taskOverdueList.length + remOverdue.length + overdueMaintenanceList.length +
    openIncidents.filter((i: any) => i.severity === 'emergency' || i.severity === 'urgent').length;
</script>

{#if !d}
  <div class="loading-view">Loading dashboard...</div>
{:else}
  <!-- Hero strip -->
  <div class="home-hero">
    <div class="hero-left">
      <h1 class="hero-title">{greetingText()}</h1>
      <p class="hero-date">{todayStr()}</p>
    </div>
    <div class="hero-stats">
      {#if urgentItems > 0}
        <div class="hero-stat urgent">
          <span class="hs-val">{urgentItems}</span>
          <span class="hs-label">Urgent</span>
        </div>
      {/if}
      <div class="hero-stat">
        <span class="hs-val">{taskTodo + taskInProgress}</span>
        <span class="hs-label">Open tasks</span>
      </div>
      <div class="hero-stat">
        <span class="hs-val">{remUpcoming.length}</span>
        <span class="hs-label">Reminders 24h</span>
      </div>
      {#if wCurrent}
        <div class="hero-stat">
          <span class="hs-val">{weatherEmoji(wCurrent.weatherCode ?? 0)} {Math.round(wCurrent.temperature ?? 0)}°</span>
          <span class="hs-label">{lf?.city ?? 'Weather'}</span>
        </div>
      {/if}
      {#if agenda?.today?.length}
        <div class="hero-stat">
          <span class="hs-val">{agenda.today.length}</span>
          <span class="hs-label">Events today</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- Panel selector -->
  <div class="panel-selector-bar">
    <button class="ps-toggle" on:click={() => selectorOpen = !selectorOpen}>
      <span class="ps-icon">◫</span>
      Panels ({selectedPanels.length})
      <span class="ps-chevron" class:open={selectorOpen}>›</span>
    </button>
    {#if selectorOpen}
      <div class="ps-dropdown">
        <div class="ps-hint">Select up to 6 panels</div>
        <div class="ps-options">
          {#each ALL_PANELS as panel}
            <button
              class="ps-option"
              class:selected={selectedPanels.includes(panel.id)}
              class:disabled={!selectedPanels.includes(panel.id) && selectedPanels.length >= 6}
              on:click={() => togglePanel(panel.id)}
            >
              <span class="ps-check">{selectedPanels.includes(panel.id) ? '●' : '○'}</span>
              <span>{panel.icon}</span>
              <span>{panel.label}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Dynamic panel grid -->
  <div class="home-panels" style="--cols:{Math.min(selectedPanels.length, 3)}">
    {#each selectedPanels as panelId, i}

      <!-- ═══ AGENDA ═══ -->
      {#if panelId === 'agenda'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--gold)"></span>
            <span class="hp-title">Today's Agenda</span>
            {#if agenda?.today?.length}
              <span class="hp-count">{agenda.today.length}</span>
            {/if}
          </div>
          <div class="hp-body">
            {#if !agenda?.today?.length}
              <div class="hp-empty">Nothing scheduled</div>
            {:else}
              {#each agenda.today.slice(0, 8) as item}
                <div class="hp-row" class:overdue-row={item.overdue}>
                  <span class="hp-time">{item.time ?? fmtTime(item.date)}</span>
                  <span class="hp-text">{item.title}</span>
                  <Badge text={item.type} />
                </div>
              {/each}
            {/if}
          </div>
        </div>

      <!-- ═══ TASKS ═══ -->
      {:else if panelId === 'tasks'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--blue)"></span>
            <span class="hp-title">Tasks</span>
            {#if taskOverdueList.length > 0}
              <span class="hp-alert">{taskOverdueList.length} overdue</span>
            {/if}
          </div>
          <div class="hp-body">
            <div class="task-summary">
              <div class="mini-donut">
                <svg viewBox="0 0 80 80">
                  <circle cx="40" cy="40" r="36" fill="none" stroke="var(--surface-3)" stroke-width="7" />
                  {#if taskTotal > 0}
                    <circle cx="40" cy="40" r="36" fill="none" stroke="var(--green)" stroke-width="7"
                      stroke-linecap="round" transform="rotate(-90 40 40)"
                      style={donutPath(Math.round((taskDone / taskTotal) * 100))} />
                  {/if}
                  <text x="40" y="38" text-anchor="middle" dominant-baseline="middle"
                    class="donut-val">{taskTotal > 0 ? Math.round((taskDone / taskTotal) * 100) : 0}%</text>
                  <text x="40" y="52" text-anchor="middle" class="donut-label">done</text>
                </svg>
              </div>
              <div class="task-breakdown">
                <div class="tb-row"><span class="tb-dot" style="background:var(--blue)"></span><span class="tb-label">Todo</span><span class="tb-val">{taskTodo}</span></div>
                <div class="tb-row"><span class="tb-dot" style="background:var(--gold)"></span><span class="tb-label">In progress</span><span class="tb-val">{taskInProgress}</span></div>
                <div class="tb-row"><span class="tb-dot" style="background:var(--red)"></span><span class="tb-label">Blocked</span><span class="tb-val">{taskBlocked}</span></div>
                <div class="tb-row"><span class="tb-dot" style="background:var(--green)"></span><span class="tb-label">Done</span><span class="tb-val">{taskDone}</span></div>
              </div>
            </div>
            {#if taskOverdueList.length > 0}
              <div class="hp-section-label">Overdue</div>
              {#each taskOverdueList.slice(0, 4) as t}
                <div class="hp-row overdue-row">
                  <span class="hp-text">{t.title}</span>
                  <div class="hp-actions">
                    <button class="action-btn done-btn" title="Mark done"
                      disabled={actionLoading['task-' + t.id]}
                      on:click={() => doTaskStatus(t.id, 'done')}>✓</button>
                    <button class="action-btn" title="Start working"
                      disabled={actionLoading['task-' + t.id]}
                      on:click={() => doTaskStatus(t.id, 'in_progress')}>▶</button>
                  </div>
                </div>
              {/each}
            {/if}
            {#if taskDueSoon.length > 0}
              <div class="hp-section-label" style="margin-top:8px">Due soon</div>
              {#each taskDueSoon.slice(0, 4) as t}
                <div class="hp-row">
                  <span class="hp-time">{fmtTime(t.due_date)}</span>
                  <span class="hp-text">{t.title}</span>
                  <div class="hp-actions">
                    <button class="action-btn done-btn" title="Mark done"
                      disabled={actionLoading['task-' + t.id]}
                      on:click={() => doTaskStatus(t.id, 'done')}>✓</button>
                    <button class="action-btn" title="Start"
                      disabled={actionLoading['task-' + t.id]}
                      on:click={() => doTaskStatus(t.id, 'in_progress')}>▶</button>
                  </div>
                </div>
              {/each}
            {/if}
            {#if tasks.inProgressTasks?.length > 0}
              <div class="hp-section-label" style="margin-top:8px">In progress</div>
              {#each tasks.inProgressTasks.slice(0, 3) as t}
                <div class="hp-row">
                  <span class="hp-text">{t.title}</span>
                  <div class="hp-actions">
                    <button class="action-btn done-btn" title="Mark done"
                      disabled={actionLoading['task-' + t.id]}
                      on:click={() => doTaskStatus(t.id, 'done')}>✓</button>
                    <button class="action-btn block-btn" title="Block"
                      disabled={actionLoading['task-' + t.id]}
                      on:click={() => doTaskStatus(t.id, 'blocked')}>⊘</button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </div>

      <!-- ═══ WEATHER ═══ -->
      {:else if panelId === 'weather'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--teal)"></span>
            <span class="hp-title">{lf?.city ?? 'Weather'}</span>
          </div>
          <div class="hp-body">
            {#if !wCurrent}
              <div class="hp-empty">No weather data</div>
            {:else}
              <div class="weather-hero">
                <span class="wh-emoji">{weatherEmoji(wCurrent.weatherCode ?? 0)}</span>
                <span class="wh-temp">{Math.round(wCurrent.temperature ?? 0)}°C</span>
                <span class="wh-feels">Feels {Math.round(wCurrent.feelsLike ?? 0)}°</span>
              </div>
              <div class="weather-grid">
                <div class="wg-item">
                  <span class="wg-label">Humidity</span>
                  <span class="wg-val">{wCurrent.humidity ?? '—'}%</span>
                </div>
                <div class="wg-item">
                  <span class="wg-label">Wind</span>
                  <span class="wg-val">{Math.round(wCurrent.windSpeed ?? 0)} km/h</span>
                </div>
                {#if airQuality}
                  {@const aq = aqLabel(airQuality.europeanAqi ?? 0)}
                  <div class="wg-item">
                    <span class="wg-label">Air</span>
                    <span class="wg-val" style="color:{aq.c}">{aq.t}</span>
                  </div>
                {/if}
                {#if wCurrent.uvIndex != null}
                  {@const uv = uvLabel(wCurrent.uvIndex)}
                  <div class="wg-item">
                    <span class="wg-label">UV</span>
                    <span class="wg-val" style="color:{uv.c}">{uv.t}</span>
                  </div>
                {/if}
              </div>
              {#if sunTimes}
                <div class="sun-row">
                  <span>☀ {sunTimes.sunrise?.slice(11,16) ?? '—'}</span>
                  <span class="sun-sep">—</span>
                  <span>🌙 {sunTimes.sunset?.slice(11,16) ?? '—'}</span>
                  {#if moonPhase}
                    <span class="moon-phase">{moonPhase.emoji ?? '🌑'} {moonPhase.phase ?? ''}</span>
                  {/if}
                </div>
              {/if}
              {#if wDaily.length > 0}
                <div class="mini-forecast">
                  {#each wDaily.slice(0, 5) as day}
                    <div class="mf-day">
                      <span class="mf-name">{new Date(day.date).toLocaleDateString('en', { weekday: 'short' })}</span>
                      <span class="mf-icon">{weatherEmoji(day.weatherCode ?? 0)}</span>
                      <span class="mf-temps">
                        <span class="mf-hi">{Math.round(day.tempMax ?? 0)}°</span>
                        <span class="mf-lo">{Math.round(day.tempMin ?? 0)}°</span>
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        </div>

      <!-- ═══ REMINDERS ═══ -->
      {:else if panelId === 'reminders'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--orange)"></span>
            <span class="hp-title">Reminders</span>
            {#if remOverdue.length > 0}
              <span class="hp-alert">{remOverdue.length} overdue</span>
            {/if}
          </div>
          <div class="hp-body">
            {#if !remUpcoming.length && !remOverdue.length}
              <div class="hp-empty">All clear</div>
            {:else}
              {#each remOverdue.slice(0, 4) as r}
                <div class="hp-row overdue-row">
                  <span class="hp-time">{fmtTime(r.trigger_at)}</span>
                  <span class="hp-text">{r.title}</span>
                  <div class="hp-actions">
                    <button class="action-btn done-btn" title="Dismiss"
                      disabled={actionLoading['rem-' + r.id]}
                      on:click={() => doDismissReminder(r.id)}>✓</button>
                    <button class="action-btn snooze-btn" title="Snooze 30m"
                      disabled={actionLoading['rem-snz-' + r.id]}
                      on:click={() => doSnoozeReminder(r.id)}>⏳</button>
                  </div>
                </div>
              {/each}
              {#each remUpcoming.slice(0, 6) as r}
                <div class="hp-row">
                  <span class="hp-time">{fmtTime(r.trigger_at)}</span>
                  <span class="hp-text">{r.title}</span>
                  <div class="hp-actions">
                    <button class="action-btn" title="Dismiss"
                      disabled={actionLoading['rem-' + r.id]}
                      on:click={() => doDismissReminder(r.id)}>✕</button>
                    {#if r.repeat && r.repeat !== 'none'}
                      <Badge text={r.repeat} />
                    {/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </div>

      <!-- ═══ FINANCE ═══ -->
      {:else if panelId === 'finance'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--green)"></span>
            <span class="hp-title">Finance</span>
          </div>
          <div class="hp-body">
            {#if !fi}
              <div class="hp-empty">No finance data</div>
            {:else}
              <div class="finance-hero">
                <div class="fh-block">
                  <span class="fh-label">Balance</span>
                  <span class="fh-val" class:positive={totalBalance >= 0} class:negative={totalBalance < 0}>{formatCents(totalBalance)}</span>
                </div>
                {#if monthExpenses}
                  <div class="fh-block">
                    <span class="fh-label">This month</span>
                    <span class="fh-val negative">-{formatCents(monthExpenses)}</span>
                  </div>
                {/if}
              </div>
              {#if accounts.length > 0}
                <div class="hp-section-label">Accounts</div>
                {#each accounts.slice(0, 5) as acc}
                  <div class="hp-row">
                    <span class="hp-text">{acc.name ?? acc.label}</span>
                    <span class="hp-val-right" class:positive={acc.balance_cents >= 0} class:negative={acc.balance_cents < 0}>{formatCents(acc.balance_cents, acc.currency ?? 'EUR')}</span>
                  </div>
                {/each}
              {/if}
              {#if activeSubs.length > 0}
                <div class="hp-section-label" style="margin-top:10px">Subscriptions</div>
                <div class="hp-row">
                  <span class="hp-text">{activeSubs.length} active</span>
                  <span class="hp-val-right">{formatCents(monthlySubsCost)}/mo</span>
                </div>
              {/if}
            {/if}
          </div>
        </div>

      <!-- ═══ COMMS ═══ -->
      {:else if panelId === 'comms'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--purple)"></span>
            <span class="hp-title">Communications</span>
            {#if drafts.length > 0}
              <span class="hp-count">{drafts.length} drafts</span>
            {/if}
          </div>
          <div class="hp-body">
            {#if drafts.length === 0 && recentSent.length === 0}
              <div class="hp-empty">No recent activity</div>
            {:else}
              {#if drafts.length > 0}
                <div class="hp-section-label">Drafts</div>
                {#each drafts.slice(0, 3) as c}
                  <div class="hp-row">
                    <span class="hp-text">{c.subject || '(no subject)'}</span>
                    <Badge text={c.channel ?? 'email'} />
                  </div>
                {/each}
              {/if}
              {#if recentSent.length > 0}
                <div class="hp-section-label" style="margin-top:8px">Recent</div>
                {#each recentSent.slice(0, 4) as c}
                  <div class="hp-row">
                    <span class="hp-time">{timeAgo(c.sent_at ?? c.updated_at)}</span>
                    <span class="hp-text">{c.subject || '(no subject)'}</span>
                    <Badge text="sent" />
                  </div>
                {/each}
              {/if}
            {/if}
          </div>
        </div>

      <!-- ═══ AI SUGGESTIONS (extracted from email) ═══ -->
      {:else if panelId === 'suggestions'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--gold)"></span>
            <span class="hp-title">AI Suggestions</span>
            {#if suggestionsTotal > 0}
              <span class="hp-count">{suggestionsTotal}</span>
            {/if}
            <button class="hp-link" title="Open full view"
              on:click={() => goto('/mail/suggestions')}>↗</button>
          </div>
          <div class="hp-body">
            {#if suggestionsLoading && suggestionsList.length === 0}
              <div class="hp-empty">Loading…</div>
            {:else if suggestionsList.length === 0}
              <div class="hp-empty">No pending suggestions</div>
            {:else}
              <div class="sug-chips">
                {#if suggestionsCounts.task > 0}<span class="sug-chip">✓ {suggestionsCounts.task} tasks</span>{/if}
                {#if suggestionsCounts.reminder > 0}<span class="sug-chip">⏰ {suggestionsCounts.reminder} reminders</span>{/if}
                {#if suggestionsCounts.contact > 0}<span class="sug-chip">👤 {suggestionsCounts.contact} contacts</span>{/if}
                {#if suggestionsCounts.shopping > 0}<span class="sug-chip">🛒 {suggestionsCounts.shopping}</span>{/if}
              </div>
              {#each suggestionsList.slice(0, 5) as s (s.id)}
                <div class="hp-row sug-row" title={s.subject ?? ''}>
                  <span class="sug-icon">{suggestionIcon(s.type)}</span>
                  <span class="hp-text">{suggestionTitle(s)}</span>
                  <div class="hp-actions">
                    <button class="action-btn done-btn" title="Approve"
                      disabled={actionLoading['sug-' + s.id]}
                      on:click={() => doApproveSuggestion(s)}>✓</button>
                    <button class="action-btn" title="Dismiss"
                      disabled={actionLoading['sug-' + s.id]}
                      on:click={() => doDismissSuggestion(s)}>✕</button>
                  </div>
                </div>
              {/each}
              {#if suggestionsTotal > 5}
                <button class="sug-more" on:click={() => goto('/mail/suggestions')}>
                  See all {suggestionsTotal} →
                </button>
              {/if}
            {/if}
          </div>
        </div>

      <!-- ═══ CRM / People ═══ -->
      {:else if panelId === 'crm'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--teal)"></span>
            <span class="hp-title">People</span>
            <span class="hp-count">{crm.total ?? kpis.contacts?.total ?? 0}</span>
          </div>
          <div class="hp-body">
            {#if crm.byRelationship}
              <div class="crm-pills">
                {#each Object.entries(crm.byRelationship) as [rel, count]}
                  <div class="crm-pill">
                    <span class="cp-val">{count}</span>
                    <span class="cp-label">{rel}</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if crm.recentInteractions?.length}
              <div class="hp-section-label" style="margin-top:10px">Recent</div>
              {#each crm.recentInteractions.slice(0, 5) as ix}
                <div class="hp-row">
                  <span class="hp-time">{timeAgo(ix.date)}</span>
                  <span class="hp-text">{ix.contact_name ?? ix.contact_id}</span>
                  <Badge text={ix.type} />
                </div>
              {/each}
            {/if}
          </div>
        </div>

      <!-- ═══ HOUSE ═══ -->
      {:else if panelId === 'house'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--orange)"></span>
            <span class="hp-title">House</span>
            {#if overdueMaintenanceList.length > 0}
              <span class="hp-alert">{overdueMaintenanceList.length} overdue</span>
            {/if}
          </div>
          <div class="hp-body">
            {#if !ho}
              <div class="hp-empty">No house data</div>
            {:else}
              <div class="house-stats">
                <div class="hs-item">
                  <span class="hs-num">{overdueMaintenanceList.length}</span>
                  <span class="hs-lbl">Maintenance</span>
                </div>
                <div class="hs-item">
                  <span class="hs-num">{activeProjects.length}</span>
                  <span class="hs-lbl">Projects</span>
                </div>
                <div class="hs-item">
                  <span class="hs-num" style={openIncidents.length > 0 ? 'color:var(--red)' : ''}>{openIncidents.length}</span>
                  <span class="hs-lbl">Incidents</span>
                </div>
              </div>
              {#if overdueMaintenanceList.length}
                <div class="hp-section-label">Overdue maintenance</div>
                {#each overdueMaintenanceList.slice(0, 4) as m}
                  <div class="hp-row overdue-row">
                    <span class="hp-text">{m.name}</span>
                    <Badge text={m.priority ?? 'medium'} variant={m.priority ?? 'medium'} />
                  </div>
                {/each}
              {/if}
              {#if openIncidents.length}
                <div class="hp-section-label" style="margin-top:8px">Open incidents</div>
                {#each openIncidents.slice(0, 3) as inc}
                  <div class="hp-row {(inc.severity === 'emergency' || inc.severity === 'urgent') ? 'overdue-row' : ''}">
                    <span class="hp-text">{inc.title}</span>
                    <Badge text={inc.severity} variant={inc.severity} />
                  </div>
                {/each}
              {/if}
            {/if}
          </div>
        </div>

      <!-- ═══ SHOPPING ═══ -->
      {:else if panelId === 'shopping'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--gold)"></span>
            <span class="hp-title">Shopping</span>
          </div>
          <div class="hp-body">
            {#if shopping.activeLists?.length}
              <div class="hp-section-label">Active lists</div>
              {#each shopping.activeLists.slice(0, 3) as list}
                <div class="hp-row">
                  <span class="hp-text">{list.name}</span>
                  <span class="hp-val-right">{list.checked ?? 0}/{list.total ?? list.items?.length ?? 0}</span>
                </div>
                {#if list.total > 0}
                  <div class="mini-progress">
                    <div class="mp-fill" style="width:{Math.round(((list.checked ?? 0) / (list.total || 1)) * 100)}%"></div>
                  </div>
                {/if}
                <!-- Shopping list items with checkbox -->
                {#if list.items?.length}
                  {#each list.items.filter(it => !it.checked).slice(0, 4) as item}
                    <div class="hp-row shop-item">
                      <button class="shop-check" title="Check off"
                        disabled={actionLoading['shop-' + item.id]}
                        on:click={() => doCheckItem(item.id, true)}>○</button>
                      <span class="hp-text">{item.name}</span>
                      {#if item.quantity > 1}
                        <span class="hp-val-right">×{item.quantity}</span>
                      {/if}
                    </div>
                  {/each}
                {/if}
              {/each}
            {/if}
            {#if shopping.lowStock?.length}
              <div class="hp-section-label" style="margin-top:10px">Low stock ({shopping.lowStock.length})</div>
              <div class="tag-cloud">
                {#each shopping.lowStock.slice(0, 12) as p}
                  <span class="tag tag-orange">{p.name}</span>
                {/each}
              </div>
            {:else if !shopping.activeLists?.length}
              <div class="hp-empty">All stocked up</div>
            {/if}
          </div>
        </div>

      <!-- ═══ HEALTH ═══ -->
      {:else if panelId === 'health'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--red)"></span>
            <span class="hp-title">Health</span>
          </div>
          <div class="hp-body">
            {#if !he}
              <div class="hp-empty">No health data</div>
            {:else}
              {#if he.todayMetrics?.length || lastMetrics.length}
                <div class="health-metrics">
                  {#each (he.todayMetrics ?? lastMetrics).slice(0, 6) as m}
                    <div class="hm-item">
                      <span class="hm-val">{m.value}{m.unit ? ` ${m.unit}` : ''}</span>
                      <span class="hm-type">{m.type ?? m.metric_type}</span>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="hp-empty">No recent metrics</div>
              {/if}
              {#if he.upcomingAppointments?.length}
                <div class="hp-section-label" style="margin-top:10px">Upcoming</div>
                {#each he.upcomingAppointments.slice(0, 3) as apt}
                  <div class="hp-row">
                    <span class="hp-time">{fmtDate(apt.date ?? apt.appointment_date)}</span>
                    <span class="hp-text">{apt.title ?? apt.doctor ?? apt.description}</span>
                  </div>
                {/each}
              {/if}
            {/if}
          </div>
        </div>

      <!-- ═══ AGENTS ═══ -->
      {:else if panelId === 'agents'}
        <div class="hp anim" style="animation-delay:{i * 60}ms">
          <div class="hp-head">
            <span class="hp-dot" style="background:var(--purple)"></span>
            <span class="hp-title">Agent Results</span>
            {#if widgets.length > 0}
              <span class="hp-count">{widgets.length}</span>
            {/if}
          </div>
          <div class="hp-body">
            {#if widgets.length === 0}
              <div class="hp-empty">No agent results</div>
            {:else}
              <div class="agents-grid">
                {#each widgets.slice(0, 4) as w}
                  <FlowWidget
                    agentName={w.agent_name}
                    result={w.result}
                    completedAt={w.completed_at}
                    status={w.status}
                  />
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* ── Hero Strip ──────────────────────────────── */
  .home-hero {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 20px;
    padding: 24px 28px 20px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--gold) 6%, var(--surface-1)), var(--surface-1));
    border: 1px solid var(--border);
    border-radius: 14px;
  }
  .hero-title {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1.1;
  }
  .hero-date {
    font-size: 13px;
    color: var(--text-3);
    margin-top: 4px;
  }
  .hero-stats {
    display: flex;
    gap: 20px;
    flex-shrink: 0;
  }
  .hero-stat {
    text-align: center;
    min-width: 64px;
  }
  .hero-stat.urgent .hs-val {
    color: var(--red);
    text-shadow: 0 0 12px rgba(240, 71, 112, 0.4);
  }
  .hs-val {
    display: block;
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1.2;
  }
  .hs-label {
    font-size: 10px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  /* ── Panel Selector ──────────────────────────── */
  .panel-selector-bar {
    position: relative;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
  }
  .ps-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 14px;
    font-size: 12px;
    font-family: var(--font-body);
    color: var(--text-2);
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .ps-toggle:hover { border-color: var(--border-h); color: var(--text-1); }
  .ps-icon { font-size: 14px; }
  .ps-chevron { transition: transform 0.2s; display: inline-block; }
  .ps-chevron.open { transform: rotate(90deg); }

  .ps-dropdown {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    z-index: 50;
    min-width: 280px;
  }
  .ps-hint {
    font-size: 11px;
    color: var(--text-3);
    margin-bottom: 8px;
    padding: 0 4px;
  }
  .ps-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
  }
  .ps-option {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: none;
    background: none;
    border-radius: 6px;
    font-size: 12px;
    font-family: var(--font-body);
    color: var(--text-2);
    cursor: pointer;
    transition: background 0.15s;
  }
  .ps-option:hover { background: var(--surface-2); }
  .ps-option.selected { color: var(--gold); background: color-mix(in srgb, var(--gold) 10%, transparent); }
  .ps-option.disabled { opacity: 0.3; pointer-events: none; }
  .ps-check { font-size: 10px; width: 14px; text-align: center; }

  /* ── Panel Grid ──────────────────────────────── */
  .home-panels {
    display: grid;
    grid-template-columns: repeat(var(--cols, 3), 1fr);
    gap: 12px;
  }
  @media (max-width: 1100px) { .home-panels { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 700px) { .home-panels { grid-template-columns: 1fr; } }

  /* ── Home Panel Card ─────────────────────────── */
  .hp {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    transition: border-color 0.2s;
    display: flex;
    flex-direction: column;
  }
  .hp:hover { border-color: var(--border-h); }

  .hp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
  }
  .hp-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .hp-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-1);
    flex: 1;
  }
  .hp-count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: 10px;
  }
  .hp-alert {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--red);
    background: rgba(240, 71, 112, 0.12);
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
  }

  .hp-body {
    padding: 12px 16px 16px;
    flex: 1;
    overflow-y: auto;
    max-height: 380px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .hp-empty {
    text-align: center;
    color: var(--text-3);
    font-size: 12px;
    padding: 24px 0;
  }

  .hp-section-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-3);
    margin-bottom: 6px;
    margin-top: 4px;
  }

  .hp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
    font-size: 12px;
  }
  .hp-row:last-child { border-bottom: none; }

  .overdue-row {
    background: rgba(240, 71, 112, 0.04);
    margin: 0 -16px;
    padding-left: 16px;
    padding-right: 16px;
    border-left: 2px solid var(--red);
  }

  .hp-time {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-3);
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 50px;
  }

  .hp-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-1);
  }

  .hp-val-right {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-2);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ── Action Buttons ──────────────────────────── */
  .hp-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .action-btn {
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text-3);
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    padding: 0;
    line-height: 1;
  }
  .action-btn:hover:not(:disabled) {
    border-color: var(--border-h);
    color: var(--text-1);
    background: var(--surface-3);
  }
  .action-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .action-btn.done-btn:hover:not(:disabled) {
    border-color: var(--green);
    color: var(--green);
    background: rgba(61, 214, 140, 0.1);
  }
  .action-btn.block-btn:hover:not(:disabled) {
    border-color: var(--red);
    color: var(--red);
    background: rgba(240, 71, 112, 0.1);
  }
  .action-btn.snooze-btn:hover:not(:disabled) {
    border-color: var(--gold);
    color: var(--gold);
    background: rgba(212, 168, 75, 0.1);
  }

  /* ── AI Suggestions panel ────────────────────── */
  .hp-link {
    margin-left: 4px;
    background: transparent;
    border: 1px solid var(--surface-3);
    color: var(--text-2);
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 4px;
    cursor: pointer;
    line-height: 1;
  }
  .hp-link:hover {
    border-color: var(--gold);
    color: var(--gold);
  }
  .sug-chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin: 4px 0 8px;
  }
  .sug-chip {
    background: var(--surface-3);
    color: var(--text-2);
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 9px;
    white-space: nowrap;
  }
  .sug-row { gap: 6px; }
  .sug-icon {
    width: 18px;
    text-align: center;
    font-size: 13px;
    color: var(--text-2);
    flex-shrink: 0;
  }
  .sug-more {
    width: 100%;
    margin-top: 6px;
    padding: 4px;
    background: transparent;
    border: 1px dashed var(--surface-3);
    color: var(--text-2);
    font-size: 11px;
    border-radius: 4px;
    cursor: pointer;
  }
  .sug-more:hover {
    border-color: var(--gold);
    color: var(--gold);
  }

  /* ── Shopping check ──────────────────────────── */
  .shop-item { padding-left: 8px; }
  .shop-check {
    width: 20px;
    height: 20px;
    border: 1px solid var(--border-h);
    border-radius: 50%;
    background: none;
    color: var(--text-3);
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .shop-check:hover:not(:disabled) {
    border-color: var(--green);
    color: var(--green);
    background: rgba(61, 214, 140, 0.1);
  }
  .shop-check:disabled { opacity: 0.4; cursor: default; }

  /* ── Task Summary ────────────────────────────── */
  .task-summary {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 12px;
  }
  .mini-donut {
    width: 80px;
    height: 80px;
    flex-shrink: 0;
  }
  .mini-donut svg { width: 100%; height: 100%; }
  .mini-donut circle { transition: stroke-dashoffset 0.8s ease; }
  .donut-val {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    fill: var(--text-1);
  }
  .donut-label {
    font-size: 8px;
    fill: var(--text-3);
    text-transform: uppercase;
  }
  .task-breakdown {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tb-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .tb-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .tb-label { color: var(--text-2); flex: 1; }
  .tb-val {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-1);
    font-weight: 600;
  }

  /* ── Weather ─────────────────────────────────── */
  .weather-hero {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 12px;
  }
  .wh-emoji { font-size: 28px; }
  .wh-temp {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1;
  }
  .wh-feels {
    font-size: 12px;
    color: var(--text-3);
  }
  .weather-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }
  .wg-item { text-align: center; }
  .wg-label { display: block; font-size: 10px; color: var(--text-3); text-transform: uppercase; margin-bottom: 2px; }
  .wg-val { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-1); }

  .sun-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-2);
    padding: 8px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    margin-bottom: 10px;
  }
  .sun-sep { color: var(--text-3); }
  .moon-phase { margin-left: auto; font-size: 11px; color: var(--text-3); }

  .mini-forecast {
    display: flex;
    gap: 6px;
  }
  .mf-day {
    flex: 1;
    text-align: center;
    padding: 6px 2px;
    background: var(--surface-2);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mf-name { font-size: 10px; color: var(--text-3); font-weight: 600; text-transform: uppercase; }
  .mf-icon { font-size: 16px; line-height: 1; }
  .mf-temps { font-family: var(--font-mono); font-size: 10px; }
  .mf-hi { color: var(--text-1); font-weight: 600; }
  .mf-lo { color: var(--text-3); margin-left: 2px; }

  /* ── Finance ─────────────────────────────────── */
  .finance-hero {
    display: flex;
    gap: 20px;
    margin-bottom: 12px;
  }
  .fh-block { flex: 1; }
  .fh-label { display: block; font-size: 10px; color: var(--text-3); text-transform: uppercase; margin-bottom: 4px; }
  .fh-val {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1;
  }
  .positive { color: var(--green) !important; }
  .negative { color: var(--red) !important; }

  /* ── CRM Pills ──────────────────────────────── */
  .crm-pills {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .crm-pill {
    background: var(--surface-2);
    border-radius: 8px;
    padding: 6px 12px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 60px;
  }
  .cp-val {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-1);
  }
  .cp-label { font-size: 9px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.3px; }

  /* ── House Stats ─────────────────────────────── */
  .house-stats {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
  }
  .hs-item {
    flex: 1;
    text-align: center;
    background: var(--surface-2);
    border-radius: 8px;
    padding: 8px 6px;
  }
  .hs-num {
    display: block;
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1.2;
  }
  /* urgent coloring applied via inline style */
  .hs-lbl { font-size: 9px; color: var(--text-3); text-transform: uppercase; }

  /* ── Shopping ─────────────────────────────────── */
  .mini-progress {
    height: 3px;
    background: var(--surface-3);
    border-radius: 2px;
    overflow: hidden;
    margin: 2px 0 6px;
  }
  .mp-fill {
    height: 100%;
    background: var(--green);
    border-radius: 2px;
    transition: width 0.5s ease;
  }
  .tag-cloud { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .tag-orange { background: rgba(240,136,62,.12); color: var(--orange); }

  /* ── Health ──────────────────────────────────── */
  .health-metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .hm-item {
    text-align: center;
    background: var(--surface-2);
    border-radius: 8px;
    padding: 8px 4px;
  }
  .hm-val {
    display: block;
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
  }
  .hm-type { font-size: 9px; color: var(--text-3); text-transform: uppercase; }

  /* ── Agents ──────────────────────────────────── */
  .agents-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .agents-grid :global(.flow-widget) {
    max-width: 100%;
    min-width: 0;
  }

  /* ── Animation ───────────────────────────────── */
  .anim {
    animation: fadeUp 0.35s ease-out both;
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
