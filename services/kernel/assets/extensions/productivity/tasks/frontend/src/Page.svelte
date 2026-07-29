<script lang="ts">
  // /tasks — migrated from services/dashboard/src/routes/tasks/+page.svelte
  // (Fase 2b). The shell keeps hydrating the "data" store (dashboard channel)
  // for this path; mutations go through ctx.rpc with HTTP fallbacks
  // (rpcOrCall semantics preserved).
  import { onMount } from 'svelte';
  import { fmtTime, timeAgo } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const data = ctx.getStore('data') as any;

  const post = (url: string, body: unknown) =>
    ctx.fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const updateTaskStatus = (id: string, status: string) =>
    ctx.rpc('tasks.updateStatus', { id, status }, () => post('/api/tasks/update-status', { id, status }));
  const updateTaskPriority = (id: string, priority: string) =>
    ctx.rpc('tasks.updatePriority', { id, priority }, () => post('/api/tasks/update-priority', { id, priority }));
  const updateTaskField = (id: string, field: string, value: unknown) =>
    ctx.rpc('tasks.updateField', { id, field, value }, () => post('/api/tasks/update-field', { id, field, value }));
  const createTask = (task: { title: string; description?: string; priority?: string; context?: string; tags?: string; due_date?: string; estimated_minutes?: number }) =>
    ctx.rpc('tasks.create', task, () => post('/api/tasks/create', task));
  const deleteTask = (id: string) =>
    ctx.rpc('tasks.delete', { id }, () => post('/api/tasks/delete', { id }));
  async function fetchAllTasks(): Promise<any[]> {
    const r = await ctx.rpc('tasks.list', {}, () => ctx.fetchJson('/api/tasks/all'));
    return (r as any)?.tasks ?? r ?? [];
  }

  // ── Dashboard aggregate data ──
  $: d = ($data as any);
  $: tasks = d?.tasks ?? {};
  $: velocity = (tasks.velocity ?? []) as any[];
  $: completionStats = tasks.completionStats ?? {};
  $: kpis = tasks.kpis ?? {};

  // ── Full task list (from dedicated endpoint) ──
  let allTasks: any[] = [];
  let loading = true;

  async function loadTasks() {
    loading = true;
    allTasks = await fetchAllTasks();
    loading = false;
  }

  onMount(loadTasks);

  // ── Filters ──
  let filter = 'active';
  let priorityFilter = 'all';
  let search = '';
  let sortBy = 'priority';

  const STATUS_OPTIONS = ['todo', 'in_progress', 'done', 'blocked'];
  const PRIORITY_OPTIONS = ['urgent', 'high', 'medium', 'low'];
  const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const STATUS_RANK: Record<string, number> = { in_progress: 0, todo: 1, blocked: 2, done: 3 };

  $: filtered = allTasks
    .filter(t => {
      if (filter === 'active' && (t.status === 'done')) return false;
      if (filter !== 'all' && filter !== 'active' && t.status !== filter) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'priority') return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (sortBy === 'status') return (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (sortBy === 'due') return (a.due_date ?? 'z').localeCompare(b.due_date ?? 'z');
      if (sortBy === 'recent') return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
      return 0;
    });

  // ── Counts by status ──
  $: countByStatus = allTasks.reduce((m, t) => { m[t.status] = (m[t.status] ?? 0) + 1; return m; }, {} as Record<string, number>);
  $: totalActive = (countByStatus.todo ?? 0) + (countByStatus.in_progress ?? 0) + (countByStatus.blocked ?? 0);

  // ── Inline editing state ──
  let editingId: string | null = null;
  let expandedId: string | null = null;
  let actionLoading: Record<string, boolean> = {};

  // ── New task form ──
  let showNewForm = false;
  let newTitle = '';
  let newPriority = 'medium';
  let newContext = '';
  let newDueDate = '';

  // ── Actions ──
  async function doAction(key: string, fn: () => Promise<unknown>) {
    actionLoading[key] = true;
    actionLoading = actionLoading;
    try { await fn(); } catch (e) { console.error(e); }
    finally { delete actionLoading[key]; actionLoading = actionLoading; }
  }

  async function setStatus(id: string, status: string) {
    await doAction('s-' + id, () => updateTaskStatus(id, status));
    // Update local state immediately
    allTasks = allTasks.map(t => t.id === id ? {
      ...t, status,
      progress: status === 'done' ? 100 : t.progress,
      completed_at: status === 'done' ? new Date().toISOString() : t.completed_at,
      started_at: status === 'in_progress' ? (t.started_at ?? new Date().toISOString()) : t.started_at,
    } : t);
    refreshDashboard();
  }

  async function setPriority(id: string, priority: string) {
    await doAction('p-' + id, () => updateTaskPriority(id, priority));
    allTasks = allTasks.map(t => t.id === id ? { ...t, priority } : t);
  }

  async function setField(id: string, field: string, value: unknown) {
    await doAction('f-' + id, () => updateTaskField(id, field, value));
    allTasks = allTasks.map(t => t.id === id ? { ...t, [field]: value } : t);
  }

  async function addTask() {
    if (!newTitle.trim()) return;
    await doAction('new', () => createTask({
      title: newTitle.trim(),
      priority: newPriority,
      context: newContext,
      due_date: newDueDate || undefined,
    }));
    newTitle = ''; newPriority = 'medium'; newContext = ''; newDueDate = '';
    showNewForm = false;
    await loadTasks();
    refreshDashboard();
  }

  async function removeTask(id: string) {
    await doAction('del-' + id, () => deleteTask(id));
    allTasks = allTasks.filter(t => t.id !== id);
    refreshDashboard();
  }

  async function refreshDashboard() {
    try {
      const d = await ctx.rpc('dashboard.full', {}, async () => {
        const r = await ctx.fetchRaw('/api/dashboard');
        return r.ok ? r.json() : null;
      });
      if (d) data.set(d);
    } catch {}
  }

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  // ── Velocity chart helpers ──
  function velMax(vel: any[]): number {
    return Math.max(1, ...vel.map(v => Math.max(v.created, v.completed)));
  }

  // ── Progress bar width ──
  function pctBar(pct: number): string {
    return `width:${Math.max(0, Math.min(100, pct))}%`;
  }

  // ── Status color ──
  function statusColor(s: string): string {
    return s === 'done' ? 'var(--green)' : s === 'in_progress' ? 'var(--gold)' : s === 'blocked' ? 'var(--red)' : 'var(--blue)';
  }

  function priorityColor(p: string): string {
    return p === 'urgent' ? 'var(--red)' : p === 'high' ? 'var(--orange)' : p === 'medium' ? 'var(--gold)' : 'var(--text-3)';
  }
</script>

{#if loading && !d}
  <div class="loading-view">Loading tasks...</div>
{:else}
  <!-- ═══ HEADER ═══ -->
  <div class="tasks-header">
    <div class="th-left">
      <h1 class="th-title">Tasks</h1>
      <p class="th-sub">{allTasks.length} total · {totalActive} active</p>
    </div>
    <button class="add-btn" on:click={() => showNewForm = !showNewForm}>
      {showNewForm ? '✕ Cancel' : '+ New Task'}
    </button>
  </div>

  <!-- ═══ NEW TASK FORM ═══ -->
  {#if showNewForm}
    <div class="new-form anim">
      <div class="nf-row">
        <input class="nf-input nf-title" bind:value={newTitle} placeholder="Task title..." on:keydown={e => e.key === 'Enter' && addTask()} />
        <select class="nf-select" bind:value={newPriority}>
          {#each PRIORITY_OPTIONS as p}
            <option value={p}>{p}</option>
          {/each}
        </select>
        <input class="nf-input nf-ctx" bind:value={newContext} placeholder="@context" />
        <input class="nf-input nf-date" type="date" bind:value={newDueDate} />
        <button class="nf-submit" disabled={!newTitle.trim() || actionLoading['new']} on:click={addTask}>
          {actionLoading['new'] ? '...' : 'Add'}
        </button>
      </div>
    </div>
  {/if}

  <!-- ═══ STATUS PILLS ═══ -->
  <div class="status-pills anim">
    <button class="sp" class:active={filter === 'active'} on:click={() => filter = 'active'}>
      Active <span class="sp-count">{totalActive}</span>
    </button>
    {#each STATUS_OPTIONS as s}
      <button class="sp" class:active={filter === s} style="--accent:{statusColor(s)}" on:click={() => filter = s}>
        {s.replace('_', ' ')} <span class="sp-count">{countByStatus[s] ?? 0}</span>
      </button>
    {/each}
    <button class="sp" class:active={filter === 'all'} on:click={() => filter = 'all'}>
      All <span class="sp-count">{allTasks.length}</span>
    </button>
  </div>

  <!-- ═══ TOOLBAR ═══ -->
  <div class="toolbar anim">
    <input class="search-input" bind:value={search} placeholder="Search tasks..." style="max-width:300px" />
    <select class="nf-select" bind:value={priorityFilter}>
      <option value="all">All priorities</option>
      {#each PRIORITY_OPTIONS as p}
        <option value={p}>{p}</option>
      {/each}
    </select>
    <select class="nf-select" bind:value={sortBy}>
      <option value="priority">Sort: Priority</option>
      <option value="status">Sort: Status</option>
      <option value="due">Sort: Due date</option>
      <option value="recent">Sort: Recent</option>
    </select>
    <span class="toolbar-count">{filtered.length} shown</span>
  </div>

  <!-- ═══ TASK LIST ═══ -->
  <div class="task-list">
    {#if !filtered.length}
      <div class="tl-empty">No tasks match your filters</div>
    {/if}
    {#each filtered as task, i (task.id)}
      <div class="task-card" class:is-done={task.status === 'done'} class:is-blocked={task.status === 'blocked'} style="--pc:{priorityColor(task.priority)}; --d:{Math.min(i, 24) * 25}ms">
        <!-- Main row -->
        <div class="tc-main">
          <!-- Status toggle -->
          <button
            class="tc-check"
            class:checked={task.status === 'done'}
            disabled={actionLoading['s-' + task.id]}
            title={task.status === 'done' ? 'Reopen' : 'Mark done'}
            on:click={() => setStatus(task.id, task.status === 'done' ? 'todo' : 'done')}
          >
            {#if task.status === 'done'}✓{:else if task.status === 'blocked'}⊘{:else}&nbsp;{/if}
          </button>

          <!-- Title + meta -->
          <div class="tc-body" on:click={() => toggleExpand(task.id)} role="button" tabindex="0" on:keydown={e => e.key === 'Enter' && toggleExpand(task.id)}>
            <div class="tc-title" class:strikethrough={task.status === 'done'}>{task.title}</div>
            <div class="tc-meta">
              {#if task.due_date}
                <span class="tc-due" class:overdue={task.status !== 'done' && task.due_date < new Date().toISOString().split('T')[0]}>{fmtTime(task.due_date)}</span>
              {/if}
              {#if task.context}<span class="tc-ctx">{task.context}</span>{/if}
              {#if task.tags}<span class="tc-tags">{task.tags}</span>{/if}
              {#if task.progress > 0 && task.progress < 100}
                <span class="tc-progress-text">{task.progress}%</span>
              {/if}
            </div>
          </div>

          <!-- Priority dot -->
          <div class="tc-priority" style="background:{priorityColor(task.priority)}" title={task.priority}></div>

          <!-- Quick actions -->
          <div class="tc-actions">
            {#if task.status !== 'in_progress' && task.status !== 'done'}
              <button class="tc-btn" title="Start" disabled={actionLoading['s-' + task.id]}
                on:click={() => setStatus(task.id, 'in_progress')}>▶</button>
            {/if}
            {#if task.status === 'in_progress'}
              <button class="tc-btn tc-btn-done" title="Done" disabled={actionLoading['s-' + task.id]}
                on:click={() => setStatus(task.id, 'done')}>✓</button>
            {/if}
            {#if task.status === 'blocked'}
              <button class="tc-btn" title="Unblock → todo" disabled={actionLoading['s-' + task.id]}
                on:click={() => setStatus(task.id, 'todo')}>↩</button>
            {/if}
          </div>
        </div>

        <!-- Progress bar -->
        {#if task.status === 'in_progress' && task.progress > 0}
          <div class="tc-progress-bar">
            <div class="tc-pf" style={pctBar(task.progress)}></div>
          </div>
        {/if}

        <!-- Expanded details -->
        {#if expandedId === task.id}
          <div class="tc-expand">
            <div class="tce-grid">
              <!-- Status -->
              <div class="tce-field">
                <span class="tce-label">Status</span>
                <div class="tce-btns">
                  {#each STATUS_OPTIONS as s}
                    <button class="tce-btn" class:active={task.status === s}
                      style="--c:{statusColor(s)}"
                      disabled={actionLoading['s-' + task.id]}
                      on:click={() => setStatus(task.id, s)}>{s.replace('_', ' ')}</button>
                  {/each}
                </div>
              </div>
              <!-- Priority -->
              <div class="tce-field">
                <span class="tce-label">Priority</span>
                <div class="tce-btns">
                  {#each PRIORITY_OPTIONS as p}
                    <button class="tce-btn" class:active={task.priority === p}
                      style="--c:{priorityColor(p)}"
                      disabled={actionLoading['p-' + task.id]}
                      on:click={() => setPriority(task.id, p)}>{p}</button>
                  {/each}
                </div>
              </div>
              <!-- Context -->
              <div class="tce-field">
                <span class="tce-label">Context</span>
                <input class="tce-input" value={task.context ?? ''} placeholder="@home, @work..."
                  on:change={e => setField(task.id, 'context', e.currentTarget.value)} />
              </div>
              <!-- Due date -->
              <div class="tce-field">
                <span class="tce-label">Due date</span>
                <input class="tce-input" type="date" value={task.due_date ?? ''}
                  on:change={e => setField(task.id, 'due_date', e.currentTarget.value || null)} />
              </div>
              <!-- Tags -->
              <div class="tce-field">
                <span class="tce-label">Tags</span>
                <input class="tce-input" value={task.tags ?? ''} placeholder="tag1, tag2"
                  on:change={e => setField(task.id, 'tags', e.currentTarget.value)} />
              </div>
              <!-- Progress -->
              <div class="tce-field">
                <span class="tce-label">Progress</span>
                <div class="tce-slider-row">
                  <input type="range" min="0" max="100" step="5" value={task.progress ?? 0}
                    class="tce-slider"
                    on:change={e => setField(task.id, 'progress', parseInt(e.currentTarget.value))} />
                  <span class="tce-slider-val">{task.progress ?? 0}%</span>
                </div>
              </div>
            </div>
            {#if task.description}
              <div class="tce-desc">{task.description}</div>
            {/if}
            <div class="tce-footer">
              <span class="tce-ts">Created {timeAgo(task.created_at)}</span>
              {#if task.started_at}<span class="tce-ts">Started {timeAgo(task.started_at)}</span>{/if}
              {#if task.completed_at}<span class="tce-ts">Completed {timeAgo(task.completed_at)}</span>{/if}
              <button class="tce-delete" on:click={() => removeTask(task.id)}>Delete</button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- ═══ STATS ROW ═══ -->
  <div class="stats-row anim">
    <!-- Velocity -->
    {#if velocity.length}
      <div class="stat-card">
        <div class="sc-title">Velocity (8 weeks)</div>
        <div class="vel-chart">
          {#each velocity as week}
            <div class="vel-col">
              <div class="vel-bars">
                <div class="vel-bar vel-created" style="height:{Math.max(2, (week.created / velMax(velocity)) * 50)}px" title="{week.created} created"></div>
                <div class="vel-bar vel-completed" style="height:{Math.max(2, (week.completed / velMax(velocity)) * 50)}px" title="{week.completed} completed"></div>
              </div>
              <span class="vel-label">{week.week.split('-W')[1]}</span>
            </div>
          {/each}
        </div>
        <div class="vel-legend">
          <span><span class="vel-dot vel-created"></span> Created</span>
          <span><span class="vel-dot vel-completed"></span> Completed</span>
        </div>
      </div>
    {/if}

    <!-- Completion stats -->
    <div class="stat-card">
      <div class="sc-title">Completion</div>
      <div class="stat-nums">
        <div class="sn-item">
          <span class="sn-val">{completionStats.completedLast7 ?? 0}</span>
          <span class="sn-label">Last 7 days</span>
        </div>
        <div class="sn-item">
          <span class="sn-val">{completionStats.completedLast30 ?? 0}</span>
          <span class="sn-label">Last 30 days</span>
        </div>
        <div class="sn-item">
          <span class="sn-val">{kpis.avgCompletionDays ?? 0}d</span>
          <span class="sn-label">Avg duration</span>
        </div>
        <div class="sn-item">
          <span class="sn-val">{kpis.onTrackPct ?? 100}%</span>
          <span class="sn-label">On track</span>
        </div>
      </div>
    </div>

    <!-- By context -->
    {#if tasks.byContext && Object.keys(tasks.byContext).length}
      <div class="stat-card">
        <div class="sc-title">By Context</div>
        <div class="ctx-bars">
          {#each Object.entries(tasks.byContext).sort((a, b) => Number(b[1]) - Number(a[1])) as [ctx, count]}
            <div class="ctx-row">
              <span class="ctx-label">{ctx}</span>
              <div class="ctx-track"><div class="ctx-fill" style="width:{Math.round((Number(count) / Math.max(1, totalActive)) * 100)}%"></div></div>
              <span class="ctx-val">{count}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ── Header ──────────────────────────────────── */
  .tasks-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  .th-title {
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    color: var(--text-1);
  }
  .th-sub { font-size: 13px; color: var(--text-3); margin-top: 2px; }
  .add-btn {
    background: var(--gold);
    color: var(--bg);
    border: none;
    border-radius: 8px;
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font-body);
    cursor: pointer;
    transition: transform .15s ease, box-shadow .15s ease, opacity .15s ease;
    box-shadow: 0 6px 16px -8px rgba(212, 168, 75, .6);
  }
  .add-btn:hover { transform: translateY(-1px); box-shadow: 0 9px 22px -8px rgba(212, 168, 75, .85); }

  /* ── New task form ───────────────────────────── */
  .new-form {
    background: var(--surface-1);
    border: 1px solid var(--gold);
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 16px;
  }
  .nf-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .nf-input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    font-size: 13px;
    font-family: var(--font-body);
    padding: 7px 12px;
    outline: none;
    transition: border-color 0.15s;
  }
  .nf-input:focus { border-color: var(--gold); }
  .nf-title { flex: 2; min-width: 200px; }
  .nf-ctx { width: 120px; }
  .nf-date { width: 140px; }
  .nf-select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    font-size: 12px;
    font-family: var(--font-body);
    padding: 7px 10px;
    outline: none;
    cursor: pointer;
  }
  .nf-submit {
    background: var(--gold);
    color: var(--bg);
    border: none;
    border-radius: 6px;
    padding: 7px 20px;
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font-body);
    cursor: pointer;
  }
  .nf-submit:disabled { opacity: 0.5; cursor: default; }

  /* ── Status pills ────────────────────────────── */
  .status-pills {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .sp {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface-1);
    color: var(--text-2);
    font-size: 12px;
    font-family: var(--font-body);
    cursor: pointer;
    transition: all 0.15s;
    text-transform: capitalize;
  }
  .sp:hover { border-color: var(--border-h); color: var(--text-1); }
  .sp.active {
    background: color-mix(in srgb, var(--accent, var(--gold)) 12%, transparent);
    border-color: var(--accent, var(--gold));
    color: var(--accent, var(--gold));
  }
  .sp-count {
    font-family: var(--font-mono);
    font-size: 11px;
    opacity: 0.7;
  }

  /* ── Toolbar ─────────────────────────────────── */
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .toolbar-count {
    font-size: 11px;
    color: var(--text-3);
    margin-left: auto;
    font-family: var(--font-mono);
  }

  /* ── Task list ───────────────────────────────── */
  .task-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 20px;
  }
  .tl-empty {
    text-align: center;
    color: var(--text-3);
    padding: 40px 0;
    font-size: 13px;
  }

  /* ── Task card ───────────────────────────────── */
  .task-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--pc, var(--border));
    border-radius: 10px;
    overflow: hidden;
    transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease, background .15s ease;
    animation: tCardIn .3s ease both;
    animation-delay: var(--d, 0ms);
  }
  .task-card:hover {
    border-color: var(--border-h);
    border-left-color: var(--pc, var(--border-h));
    transform: translateY(-2px);
    background: var(--surface-2);
    box-shadow: 0 10px 24px -14px rgba(0, 0, 0, .7);
  }
  .task-card.is-done { opacity: 0.55; }
  .task-card.is-done:hover { opacity: 0.8; }
  .task-card.is-blocked { border-left-color: var(--red); }
  @keyframes tCardIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  .tc-main {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
  }

  /* Check circle */
  .tc-check {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid var(--border-h);
    background: none;
    color: transparent;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
    padding: 0;
  }
  .tc-check:hover { border-color: var(--green); color: var(--green); background: rgba(61,214,140,0.1); }
  .tc-check.checked {
    border-color: var(--green);
    background: var(--green);
    color: var(--bg);
  }

  /* Body */
  .tc-body {
    flex: 1;
    min-width: 0;
    cursor: pointer;
  }
  .tc-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .strikethrough { text-decoration: line-through; color: var(--text-3); }
  .tc-meta {
    display: flex;
    gap: 8px;
    margin-top: 2px;
    font-size: 11px;
    color: var(--text-3);
    flex-wrap: wrap;
  }
  .tc-due { font-family: var(--font-mono); }
  .tc-due.overdue { color: var(--red); font-weight: 600; }
  .tc-ctx { color: var(--teal); }
  .tc-tags { color: var(--purple); }
  .tc-progress-text { color: var(--gold); font-family: var(--font-mono); }

  /* Priority dot */
  .tc-priority {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Quick actions */
  .tc-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .task-card:hover .tc-actions { opacity: 1; }

  .tc-btn {
    width: 26px;
    height: 26px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text-3);
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: all 0.15s;
  }
  .tc-btn:hover:not(:disabled) { border-color: var(--border-h); color: var(--text-1); }
  .tc-btn-done:hover:not(:disabled) { border-color: var(--green); color: var(--green); background: rgba(61,214,140,0.1); }
  .tc-btn:disabled { opacity: 0.3; cursor: default; }

  /* Progress bar */
  .tc-progress-bar {
    height: 3px;
    background: var(--surface-3);
  }
  .tc-pf {
    height: 100%;
    background: var(--gold);
    border-radius: 0 2px 2px 0;
    transition: width 0.4s ease;
  }

  /* ── Expanded details ────────────────────────── */
  .tc-expand {
    padding: 12px 14px 14px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
  }
  .tce-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 10px;
  }
  @media (max-width: 700px) { .tce-grid { grid-template-columns: 1fr; } }

  .tce-field {}
  .tce-label {
    display: block;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-3);
    margin-bottom: 4px;
  }
  .tce-btns { display: flex; gap: 4px; flex-wrap: wrap; }
  .tce-btn {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-2);
    font-size: 11px;
    font-family: var(--font-body);
    cursor: pointer;
    text-transform: capitalize;
    transition: all 0.15s;
  }
  .tce-btn:hover { border-color: var(--c, var(--border-h)); color: var(--c, var(--text-1)); }
  .tce-btn.active {
    background: color-mix(in srgb, var(--c, var(--gold)) 15%, transparent);
    border-color: var(--c, var(--gold));
    color: var(--c, var(--gold));
    font-weight: 600;
  }
  .tce-btn:disabled { opacity: 0.4; cursor: default; }

  .tce-input {
    width: 100%;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    font-size: 12px;
    font-family: var(--font-body);
    padding: 6px 10px;
    outline: none;
    transition: border-color 0.15s;
  }
  .tce-input:focus { border-color: var(--gold); }

  .tce-slider-row { display: flex; align-items: center; gap: 8px; }
  .tce-slider {
    flex: 1;
    accent-color: var(--gold);
    height: 4px;
  }
  .tce-slider-val {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-2);
    width: 36px;
    text-align: right;
  }

  .tce-desc {
    font-size: 12px;
    color: var(--text-2);
    padding: 8px 0;
    border-top: 1px solid var(--border);
    line-height: 1.5;
  }

  .tce-footer {
    display: flex;
    gap: 12px;
    align-items: center;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .tce-ts { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
  .tce-delete {
    margin-left: auto;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--red);
    font-size: 11px;
    font-family: var(--font-body);
    padding: 4px 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .tce-delete:hover { background: rgba(240,71,112,0.1); border-color: var(--red); }

  /* ── Stats row ───────────────────────────────── */
  .stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
    margin-top: 8px;
  }
  .stat-card {
    background:
      radial-gradient(120% 80% at 0% 0%, rgba(212, 168, 75, .05), transparent 55%),
      var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
  }
  .stat-card:hover {
    border-color: var(--border-h);
    transform: translateY(-2px);
    box-shadow: 0 10px 24px -16px rgba(0, 0, 0, .6);
  }
  .sc-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-3);
    margin-bottom: 12px;
  }

  /* Velocity chart */
  .vel-chart { display: flex; gap: 6px; align-items: flex-end; height: 60px; }
  .vel-col { display: flex; flex-direction: column; align-items: center; flex: 1; }
  .vel-bars { display: flex; gap: 2px; align-items: flex-end; }
  .vel-bar { width: 10px; border-radius: 2px 2px 0 0; min-height: 2px; transition: height 0.3s; }
  .vel-bar.vel-created { background: var(--blue); }
  .vel-bar.vel-completed { background: var(--green); }
  .vel-label { font-size: 9px; color: var(--text-3); font-family: var(--font-mono); margin-top: 4px; }
  .vel-legend { display: flex; gap: 12px; margin-top: 8px; font-size: 10px; color: var(--text-3); }
  .vel-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .vel-dot.vel-created { background: var(--blue); }
  .vel-dot.vel-completed { background: var(--green); }

  /* Stat numbers */
  .stat-nums { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .sn-item { text-align: center; }
  .sn-val { display: block; font-family: var(--font-display); font-size: 22px; font-weight: 700; color: var(--text-1); }
  .sn-label { font-size: 10px; color: var(--text-3); text-transform: uppercase; }

  /* Context bars */
  .ctx-bars { display: flex; flex-direction: column; gap: 6px; }
  .ctx-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .ctx-label { width: 100px; color: var(--teal); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
  .ctx-track { flex: 1; height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
  .ctx-fill { height: 100%; background: var(--teal); border-radius: 3px; transition: width 0.4s; }
  .ctx-val { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); width: 24px; text-align: right; }

  /* ── Animation ───────────────────────────────── */
  .anim { animation: fadeUp 0.35s ease-out both; }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
