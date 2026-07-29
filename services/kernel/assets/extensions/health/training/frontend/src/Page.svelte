<script lang="ts">
  // /training — migrated from services/dashboard/src/routes/training/+page.svelte
  // (Fase 3). The shell keeps hydrating the training store via the "training"
  // WS channel; this page subscribes and refreshes it after mutations.
  import { onMount, onDestroy } from 'svelte';
  import Badge from '$shared/components/Badge.svelte';
  import CardioPanel from './CardioPanel.svelte';
  import PRsGrid from './PRsGrid.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const training = ctx.getStore('training');

  // ── State ──────────────────────────────────────────────
  let tab: 'overview' | 'workout' | 'cardio' | 'prs' | 'programs' = 'overview';

  // Dashboard data
  $: tr = ($training as any);
  $: k = tr?.kpis ?? {};
  $: weeklyVolume = (tr?.weeklyVolume ?? []) as any[];
  $: recentWorkouts = (tr?.recentWorkouts ?? []) as any[];
  $: recentCardio = (tr?.recentCardio ?? []) as any[];
  $: topPrs = (tr?.topPrs ?? []) as any[];
  $: maxWo = weeklyVolume.length ? Math.max(...weeklyVolume.map((w: any) => w.workouts || 0)) || 1 : 1;
  $: maxSets = weeklyVolume.length ? Math.max(...weeklyVolume.map((w: any) => w.total_sets || 0)) || 1 : 1;

  // ── Active Workout State ───────────────────────────────
  let activeWorkout: any = null;
  let workoutSets: any[] = [];
  let timerSecs = 0;
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  // Start workout form
  let woName = '';
  let woSport = 'strength';
  let woMoodBefore: number | null = null;
  let woFatigue: number | null = null;
  let showStartModal = false;

  // Set logging
  let setExercise = '';
  let setReps: number | null = null;
  let setWeight: number | null = null;
  let setRpe: number | null = null;
  let setWarmup = false;
  let showPrFlash = false;
  let lastPrExercise = '';

  // Finish workout
  let showFinishModal = false;
  let finishMoodAfter: number | null = null;
  let finishCalories: number | null = null;

  // Exercise library
  let exercises: any[] = [];
  let exFiltered: any[] = [];
  let showExDropdown = false;

  // Programs
  let programs: any[] = [];

  // Error toast
  let errorMsg = '';
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  function showError(msg: string) {
    errorMsg = msg;
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { errorMsg = ''; }, 4000);
  }

  // Delete workout
  let showDeleteConfirm: string | null = null; // workout id to delete

  // ── Helpers ────────────────────────────────────────────
  const BASE = '';

  async function api(path: string, opts?: RequestInit): Promise<any> {
    // Convert path to RPC action name: /api/training/log-set → training.logSet
    const action = path.replace(/^\/api\//, '').replace(/\//g, '.').replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    const body = opts?.body ? JSON.parse(opts.body as string) : {};
    try {
      return await ctx.rpc(action, body, async () => {
        const res = await ctx.fetchRaw(`${BASE}${path}`, {
          headers: { 'Content-Type': 'application/json' },
          ...opts,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          showError(err.error || `Request failed: ${res.status}`);
          return { _error: true };
        }
        return await res.json();
      });
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Network error');
      return { _error: true };
    }
  }

  async function refreshTraining() {
    try {
      const fresh = await ctx.rpc('dashboard.training', {}, async () => {
        const res = await ctx.fetchRaw(`/api/dashboard/training?_t=${Date.now()}`, {
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!res.ok) return null;
        return res.json();
      });
      // The store stays shell-owned; writing fresh data back keeps every
      // subscriber (e.g. /wellness) in sync after a mutation here.
      if (fresh) (training as any).set(fresh);
    } catch {}
  }

  function fmtTimer(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ── Exercise Autocomplete ──────────────────────────────
  function onExInput() {
    const q = setExercise.toLowerCase();
    exFiltered = q.length > 0
      ? exercises.filter((e: any) => e.name.toLowerCase().includes(q)).slice(0, 8)
      : exercises.slice(0, 8);
    showExDropdown = exFiltered.length > 0 && q.length > 0;
  }

  function pickExercise(name: string) {
    setExercise = name;
    showExDropdown = false;
  }

  // ── Workout Actions ────────────────────────────────────
  async function startWorkout() {
    if (!woName.trim()) return;
    const data = await api('/api/training/start-workout', {
      method: 'POST',
      body: JSON.stringify({
        name: woName.trim(),
        sport: woSport,
        mood_before: woMoodBefore,
        fatigue_level: woFatigue,
      }),
    });
    if (data._error) return;
    if (data.id) {
      activeWorkout = data;
      workoutSets = [];
      timerSecs = 0;
      showStartModal = false;
      woName = '';
      woMoodBefore = null;
      woFatigue = null;
      startTimer();
    }
  }

  function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => { timerSecs++; }, 1000);
  }

  async function logSet() {
    if (!activeWorkout || !setExercise.trim()) return;
    const data = await api('/api/training/log-set', {
      method: 'POST',
      body: JSON.stringify({
        workout_id: activeWorkout.id,
        exercise_name: setExercise.trim(),
        reps: setReps,
        weight_kg: setWeight,
        rpe: setRpe,
        is_warmup: setWarmup,
      }),
    });
    if (data._error) return;
    if (data.id) {
      workoutSets = [...workoutSets, data];
      if (data.is_pr) {
        lastPrExercise = data.exercise_name;
        showPrFlash = true;
        setTimeout(() => { showPrFlash = false; }, 3000);
      }
      // Keep exercise, clear reps for next set
      setReps = null;
      setRpe = null;
      setWarmup = false;
    }
  }

  async function finishWorkout() {
    if (!activeWorkout) return;
    const data = await api('/api/training/finish-workout', {
      method: 'POST',
      body: JSON.stringify({
        workout_id: activeWorkout.id,
        mood_after: finishMoodAfter,
        calories_burned: finishCalories,
      }),
    });
    if (data._error) return;
    if (data.id || data.name) {
      activeWorkout = null;
      workoutSets = [];
      showFinishModal = false;
      finishMoodAfter = null;
      finishCalories = null;
      if (timerInterval) clearInterval(timerInterval);
      timerSecs = 0;
      await refreshTraining();
    }
  }

  async function deleteWorkout(id: string) {
    const data = await api('/api/training/delete-workout', {
      method: 'POST',
      body: JSON.stringify({ workout_id: id }),
    });
    if (data._error) return;
    showDeleteConfirm = null;
    await refreshTraining();
  }

  // Group workout sets by exercise
  $: groupedSets = (() => {
    const groups: Record<string, any[]> = {};
    for (const s of workoutSets) {
      if (!groups[s.exercise_name]) groups[s.exercise_name] = [];
      groups[s.exercise_name].push(s);
    }
    return Object.entries(groups);
  })();

  // ── Lifecycle ──────────────────────────────────────────
  onMount(async () => {
    try { const d = await api('/api/training/exercises'); exercises = d.exercises ?? []; } catch {}
    try { const d = await api('/api/training/programs'); programs = d.programs ?? []; } catch {}
  });

  onDestroy(() => {
    if (timerInterval) clearInterval(timerInterval);
  });

  // Sports icons
  const SPORT_ICONS: Record<string, string> = {
    strength: '🏋️', running: '🏃', cycling: '🚴', swimming: '🏊',
    rowing: '🚣', hiking: '🥾', yoga: '🧘', boxing: '🥊',
    football: '⚽', basketball: '🏀', tennis: '🎾', default: '💪',
  };
  function sportIcon(s: string) { return SPORT_ICONS[s] || SPORT_ICONS.default; }

  const MOODS = ['😫','😟','😐','🙂','😤','💪','🔥','⚡','🚀','👑'];
</script>

<!-- Error Toast -->
{#if errorMsg}
  <div class="error-toast">{errorMsg}</div>
{/if}

<div class="trn">
  <!-- Tabs -->
  <div class="trn-tabs">
    <button type="button" class="trn-tab" class:active={tab === 'overview'} on:click={() => tab = 'overview'}>Overview</button>
    <button type="button" class="trn-tab" class:active={tab === 'workout'} on:click={() => tab = 'workout'}>
      Workout
      {#if activeWorkout}<span class="live-dot"></span>{/if}
    </button>
    <button type="button" class="trn-tab" class:active={tab === 'cardio'} on:click={() => tab = 'cardio'}>Cardio</button>
    <button type="button" class="trn-tab" class:active={tab === 'prs'} on:click={() => tab = 'prs'}>PRs{#if topPrs.length > 0}<span class="tab-cnt">{topPrs.length}</span>{/if}</button>
    <button type="button" class="trn-tab" class:active={tab === 'programs'} on:click={() => tab = 'programs'}>Programs</button>
  </div>

  {#if !tr || !tr.available}
    <div class="trn-empty">
      <div class="trn-empty-icon">💪</div>
      <div class="trn-empty-title">Training module loading...</div>
      <div class="trn-empty-sub">Start logging workouts to see your progress here.</div>
    </div>

  <!-- ═══════════════════ OVERVIEW ═══════════════════ -->
  {:else if tab === 'overview'}
    <div class="anim">
      <!-- KPIs -->
      <div class="trn-kpis">
        <div class="trn-kpi">
          <div class="trn-kpi-val" style="color:var(--teal)">{k.totalWorkouts ?? 0}</div>
          <div class="trn-kpi-lbl">Total</div>
        </div>
        <div class="trn-kpi">
          <div class="trn-kpi-val" style="color:var(--gold)">{k.workoutsThisWeek ?? 0}</div>
          <div class="trn-kpi-lbl">This Week</div>
        </div>
        <div class="trn-kpi">
          <div class="trn-kpi-val" style="color:var(--purple)">{k.prsAllTime ?? 0}</div>
          <div class="trn-kpi-lbl">PRs</div>
        </div>
        <div class="trn-kpi">
          <div class="trn-kpi-val" style="color:{k.activeProgramName ? 'var(--green)' : 'var(--text-3)'}">{k.activeProgramName ? '●' : '○'}</div>
          <div class="trn-kpi-lbl">{k.activeProgramName ?? 'No Program'}</div>
        </div>
      </div>

      <!-- Weekly Volume Chart -->
      {#if weeklyVolume.length}
        <div class="trn-panel anim d1">
          <div class="trn-panel-head">
            <span>Weekly Volume</span>
            <span class="trn-panel-sub">Last {weeklyVolume.length} weeks</span>
          </div>
          <div class="vol-chart">
            {#each weeklyVolume as w, i}
              {@const woH = Math.max(3, Math.round((w.workouts || 0) / maxWo * 56))}
              {@const setH = Math.max(2, Math.round((w.total_sets || 0) / maxSets * 56))}
              <div class="vol-col" style="animation-delay:{i * 40}ms">
                <div class="vol-bars">
                  <div class="vol-bar wo" style="height:{woH}px" title="{w.workouts} workouts"></div>
                  <div class="vol-bar sets" style="height:{setH}px" title="{w.total_sets} sets"></div>
                </div>
                <div class="vol-lbl">{String(w.week ?? '').slice(5)}</div>
              </div>
            {/each}
          </div>
          <div class="vol-legend">
            <span><i class="vol-dot" style="background:var(--teal)"></i>Workouts</span>
            <span><i class="vol-dot" style="background:var(--gold)"></i>Sets</span>
          </div>
        </div>
      {/if}

      <!-- Recent Activity -->
      <div class="trn-grid anim d2">
        <div class="trn-panel">
          <div class="trn-panel-head">Recent Workouts</div>
          {#if recentWorkouts.length}
            <div class="wo-list">
              {#each recentWorkouts.slice(0, 6) as w}
                <div class="wo-row">
                  <span class="wo-icon">{sportIcon(w.sport ?? 'strength')}</span>
                  <div class="wo-info">
                    <div class="wo-name">{w.name}</div>
                    <div class="wo-meta">{w.date ? String(w.date).slice(5,10) : ''} · {w.duration_minutes ? w.duration_minutes + 'm' : 'in progress'}</div>
                  </div>
                  {#if w.calories_burned}
                    <span class="wo-cal">{w.calories_burned} kcal</span>
                  {/if}
                  <button type="button" class="wo-del-btn" on:click={() => { showDeleteConfirm = w.id; }} title="Delete workout">✕</button>
                </div>
              {/each}
            </div>
          {:else}
            <div class="trn-empty-sm">No workouts yet</div>
          {/if}
        </div>

        <div class="trn-panel">
          <div class="trn-panel-head">Recent Cardio</div>
          {#if recentCardio.length}
            <div class="wo-list">
              {#each recentCardio.slice(0, 6) as c}
                <div class="wo-row">
                  <span class="wo-icon">{sportIcon(c.sport ?? 'running')}</span>
                  <div class="wo-info">
                    <div class="wo-name">{c.sport}</div>
                    <div class="wo-meta">
                      {c.date ? String(c.date).slice(5,10) : ''} ·
                      {c.duration_minutes}m
                      {#if c.distance_m} · {(c.distance_m / 1000).toFixed(1)}km{/if}
                    </div>
                  </div>
                  {#if c.avg_hr}
                    <span class="wo-hr">{c.avg_hr} bpm</span>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <div class="trn-empty-sm">No cardio sessions</div>
          {/if}
        </div>
      </div>

      <!-- Quick PRs -->
      {#if topPrs.length}
        <div class="trn-panel anim d3">
          <div class="trn-panel-head">Latest PRs</div>
          <div class="pr-strip">
            {#each topPrs.slice(0, 5) as pr}
              <div class="pr-chip">
                <span class="pr-val">{pr.value}{pr.unit === 'kg' ? 'kg' : ''}</span>
                <span class="pr-ex">{pr.exercise_name}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

  <!-- ═══════════════════ WORKOUT ═══════════════════ -->
  {:else if tab === 'workout'}
    <div class="anim">
      {#if !activeWorkout}
        <!-- No active workout -->
        <div class="wo-start-zone">
          <div class="wo-start-visual">
            <div class="wo-start-ring">
              <span class="wo-start-icon">🏋️</span>
            </div>
          </div>
          <div class="wo-start-title">Ready to train?</div>
          <div class="wo-start-sub">Start a workout to log sets in real-time</div>
          <button type="button" class="wo-start-btn" on:click={() => { showStartModal = true; }}>
            Start Workout
          </button>

          <!-- Recent workouts quick view -->
          {#if recentWorkouts.length}
            <div class="wo-recent">
              <div class="trn-panel-head" style="margin-top:24px">Recent</div>
              {#each recentWorkouts.slice(0, 4) as w}
                <div class="wo-row">
                  <span class="wo-icon">{sportIcon(w.sport ?? 'strength')}</span>
                  <div class="wo-info">
                    <div class="wo-name">{w.name}</div>
                    <div class="wo-meta">{w.date ? String(w.date).slice(0,10) : ''} · {w.duration_minutes ? w.duration_minutes + 'm' : '—'}</div>
                  </div>
                  <button type="button" class="wo-del-btn" on:click={() => { showDeleteConfirm = w.id; }} title="Delete workout">✕</button>
                </div>
              {/each}
            </div>
          {/if}
        </div>

      {:else}
        <!-- Active Workout -->
        <div class="wo-active">
          <!-- Header with timer -->
          <div class="wo-header">
            <div class="wo-header-left">
              <span class="live-badge">LIVE</span>
              <div>
                <div class="wo-header-name">{activeWorkout.name}</div>
                <div class="wo-header-sport">{sportIcon(activeWorkout.sport)} {activeWorkout.sport}</div>
              </div>
            </div>
            <div class="wo-timer">{fmtTimer(timerSecs)}</div>
          </div>

          <!-- PR Flash -->
          {#if showPrFlash}
            <div class="pr-flash">
              <span class="pr-flash-icon">🏆</span>
              <span>NEW PR — {lastPrExercise}</span>
            </div>
          {/if}

          <!-- Set Logger -->
          <div class="set-logger">
            <div class="set-row">
              <div class="set-field ex-field">
                <input
                  class="set-input"
                  type="text"
                  placeholder="Exercise"
                  bind:value={setExercise}
                  on:input={onExInput}
                  on:focus={onExInput}
                  on:blur={() => setTimeout(() => { showExDropdown = false; }, 200)}
                />
                {#if showExDropdown}
                  <div class="ex-dropdown">
                    {#each exFiltered as ex}
                      <button class="ex-option" on:mousedown={() => pickExercise(ex.name)}>
                        <span class="ex-opt-name">{ex.name}</span>
                        <span class="ex-opt-cat">{ex.category}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <input class="set-input sm" type="number" placeholder="Reps" bind:value={setReps} />
              <input class="set-input sm" type="number" placeholder="kg" bind:value={setWeight} step="0.5" />
              <div class="set-field rpe-field">
                <select class="set-select" bind:value={setRpe}>
                  <option value={null}>RPE</option>
                  {#each [6,7,7.5,8,8.5,9,9.5,10] as r}
                    <option value={r}>{r}</option>
                  {/each}
                </select>
              </div>
              <label class="set-warmup" title="Warmup set">
                <input type="checkbox" bind:checked={setWarmup} />
                <span>W</span>
              </label>
              <button type="button" class="set-add-btn" on:click={logSet} disabled={!setExercise.trim()}>+</button>
            </div>
          </div>

          <!-- Logged Sets -->
          {#if groupedSets.length}
            <div class="sets-list">
              {#each groupedSets as [exName, sets]}
                <div class="sets-group">
                  <div class="sets-group-head">
                    <span class="sets-group-name">{exName}</span>
                    <span class="sets-group-cnt">{sets.length} sets</span>
                  </div>
                  <div class="sets-grid">
                    {#each sets as s}
                      <div class="set-chip" class:warmup={s.is_warmup} class:pr={s.is_pr}>
                        <span class="set-num">S{s.set_number}</span>
                        {#if s.reps && s.weight_kg}
                          <span class="set-detail">{s.reps}×{s.weight_kg}kg</span>
                        {:else if s.reps}
                          <span class="set-detail">{s.reps} reps</span>
                        {:else if s.duration_secs}
                          <span class="set-detail">{s.duration_secs}s</span>
                        {/if}
                        {#if s.rpe}<span class="set-rpe">@{s.rpe}</span>{/if}
                        {#if s.is_pr}<span class="set-pr-badge">PR</span>{/if}
                        {#if s.is_warmup}<span class="set-w-badge">W</span>{/if}
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            <div class="sets-empty">
              <div class="sets-empty-text">Log your first set above</div>
            </div>
          {/if}

          <!-- Finish Button -->
          <div class="wo-footer">
            <button type="button" class="wo-finish-btn" on:click={() => { showFinishModal = true; }}>
              Finish Workout
            </button>
          </div>
        </div>
      {/if}
    </div>

  <!-- ═══════════════════ CARDIO ═══════════════════ -->
  {:else if tab === 'cardio'}
    <CardioPanel {ctx} {recentCardio} on:logged={refreshTraining} />

  <!-- ═══════════════════ PRs ═══════════════════ -->
  {:else if tab === 'prs'}
    <PRsGrid prs={topPrs} />

  <!-- ═══════════════════ PROGRAMS ═══════════════════ -->
  {:else if tab === 'programs'}
    <div class="anim">
      {#if tr.activeProgram}
        <div class="prog-active trn-panel">
          <div class="prog-badge"><Badge text={tr.activeProgram.status} variant="active" /></div>
          <div class="prog-name">{tr.activeProgram.name}</div>
          <div class="prog-meta">
            <span>{tr.activeProgram.goal}</span>
            <span>·</span>
            <span>{tr.activeProgram.days_per_week}d/wk</span>
          </div>
        </div>
      {/if}

      {#if programs.length}
        <div class="prog-list">
          {#each programs as p}
            <div class="prog-card trn-panel">
              <div class="prog-card-head">
                <span class="prog-card-name">{p.name}</span>
                <Badge text={p.status} variant={p.status === 'active' ? 'active' : p.status === 'completed' ? 'done' : 'pending'} />
              </div>
              <div class="prog-card-meta">
                {p.goal} · {p.difficulty} · {p.days_per_week}d/wk × {p.duration_weeks}wks
              </div>
              {#if p.description}
                <div class="prog-card-desc">{p.description}</div>
              {/if}
            </div>
          {/each}
        </div>
      {:else if !tr.activeProgram}
        <div class="trn-empty">
          <div class="trn-empty-icon">📋</div>
          <div class="trn-empty-title">No programs</div>
          <div class="trn-empty-sub">Create a training program via MCP tools to structure your workouts</div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- ═══════════════════ START WORKOUT MODAL ═══════════════════ -->
{#if showStartModal}
  <div class="modal-scrim" on:click={() => { showStartModal = false; }} on:keydown={(e) => { if (e.key === 'Escape') showStartModal = false; }}>
    <div class="modal-box" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-title">Start Workout</div>

      <div class="modal-field">
        <label class="modal-label">Name *</label>
        <input class="modal-input" type="text" placeholder="Push Day A, Leg Day, Full Body..." bind:value={woName} autofocus />
      </div>

      <div class="modal-field">
        <label class="modal-label">Type</label>
        <select class="modal-input" bind:value={woSport}>
          <option value="strength">🏋️ Strength</option>
          <option value="cardio">🏃 Cardio</option>
          <option value="yoga">🧘 Yoga</option>
          <option value="boxing">🥊 Boxing</option>
          <option value="sport">⚽ Sport</option>
          <option value="crossfit">💥 CrossFit</option>
          <option value="calisthenics">🤸 Calisthenics</option>
          <option value="other">💪 Other</option>
        </select>
      </div>

      <div class="modal-field">
        <label class="modal-label">How are you feeling?</label>
        <div class="mood-row">
          {#each MOODS as m, i}
            <button
              type="button"
              class="mood-btn"
              class:selected={woMoodBefore === i + 1}
              on:click={() => { woMoodBefore = woMoodBefore === i + 1 ? null : i + 1; }}
              title="Mood: {i + 1}/10"
            >{m}</button>
          {/each}
        </div>
      </div>

      <div class="modal-field">
        <label class="modal-label">Fatigue level</label>
        <div class="fatigue-row">
          {#each Array(10) as _, i}
            <button
              type="button"
              class="fatigue-dot"
              class:active={woFatigue !== null && i < woFatigue}
              style="background:{woFatigue !== null && i < woFatigue ? (i < 3 ? 'var(--green)' : i < 6 ? 'var(--gold)' : i < 8 ? 'var(--orange)' : 'var(--red)') : 'var(--surface-3)'}"
              on:click={() => { woFatigue = woFatigue === i + 1 ? null : i + 1; }}
              title="Fatigue: {i + 1}/10"
            ></button>
          {/each}
          <span class="fatigue-label">{woFatigue ? woFatigue + '/10' : '—'}</span>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="modal-cancel" on:click={() => { showStartModal = false; }}>Cancel</button>
        <button type="button" class="modal-go" on:click={startWorkout} disabled={!woName.trim()}>Start</button>
      </div>
    </div>
  </div>
{/if}

<!-- ═══════════════════ FINISH WORKOUT MODAL ═══════════════════ -->
{#if showFinishModal}
  <div class="modal-scrim" on:click={() => { showFinishModal = false; }} on:keydown={(e) => { if (e.key === 'Escape') showFinishModal = false; }}>
    <div class="modal-box" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-title">Finish Workout</div>
      <div class="modal-sub">{fmtTimer(timerSecs)} · {workoutSets.length} sets logged</div>

      <div class="modal-field">
        <label class="modal-label">How do you feel now?</label>
        <div class="mood-row">
          {#each MOODS as m, i}
            <button
              type="button"
              class="mood-btn"
              class:selected={finishMoodAfter === i + 1}
              on:click={() => { finishMoodAfter = finishMoodAfter === i + 1 ? null : i + 1; }}
            >{m}</button>
          {/each}
        </div>
      </div>

      <div class="modal-field">
        <label class="modal-label">Estimated calories (optional)</label>
        <input class="modal-input" type="number" placeholder="350" bind:value={finishCalories} />
      </div>

      <div class="modal-actions">
        <button type="button" class="modal-cancel" on:click={() => { showFinishModal = false; }}>Cancel</button>
        <button type="button" class="modal-go finish" on:click={finishWorkout}>Complete</button>
      </div>
    </div>
  </div>
{/if}

<!-- ═══════════════════ DELETE CONFIRM MODAL ═══════════════════ -->
{#if showDeleteConfirm}
  <div class="modal-scrim" on:click={() => { showDeleteConfirm = null; }} on:keydown={(e) => { if (e.key === 'Escape') showDeleteConfirm = null; }}>
    <div class="modal-box modal-sm" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="modal-title" style="color:var(--red)">Delete Workout?</div>
      <div class="modal-del-text">This will permanently remove the workout and all its sets. This cannot be undone.</div>
      <div class="modal-actions">
        <button type="button" class="modal-cancel" on:click={() => { showDeleteConfirm = null; }}>Cancel</button>
        <button type="button" class="modal-go modal-del" on:click={() => { if (showDeleteConfirm) deleteWorkout(showDeleteConfirm); }}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Layout ──────────────────────────────────────────── */
  .trn {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 120px);
    overflow: hidden;
  }

  /* ── Tabs ───────────────────────────────────────────── */
  .trn-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    flex-shrink: 0;
  }
  .trn-tab {
    padding: 7px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-3);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-body);
    transition: all 0.15s;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .trn-tab:hover { background: var(--surface-3); color: var(--text-2); }
  .trn-tab.active { background: var(--gold); border-color: var(--gold); color: var(--bg); }
  .live-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
    animation: pulse 1.5s ease infinite;
  }
  .tab-cnt {
    font-size: 10px;
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.15);
    padding: 1px 5px;
    border-radius: 8px;
  }

  /* ── KPIs ───────────────────────────────────────────── */
  .trn-kpis {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  }
  .trn-kpi {
    flex: 1;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    text-align: center;
    transition: border-color 0.15s;
  }
  .trn-kpi:hover { border-color: var(--border-h); }
  .trn-kpi-val {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    line-height: 1;
  }
  .trn-kpi-lbl {
    font-size: 10px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 4px;
  }

  /* ── Panel ──────────────────────────────────────────── */
  .trn-panel {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 12px;
    transition: border-color 0.15s;
  }
  .trn-panel:hover { border-color: var(--border-h); }
  .trn-panel-head {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-2);
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .trn-panel-sub { font-weight: 400; color: var(--text-3); }
  .trn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  /* ── Volume Chart ──────────────────────────────────── */
  .vol-chart {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 80px;
    margin-top: 8px;
  }
  .vol-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    animation: fadeSlideIn 0.3s ease both;
  }
  .vol-bars {
    display: flex;
    gap: 2px;
    align-items: flex-end;
    width: 100%;
    justify-content: center;
  }
  .vol-bar {
    width: 40%;
    border-radius: 3px 3px 0 0;
    transition: height 0.4s ease;
    min-height: 3px;
  }
  .vol-bar.wo { background: var(--teal); }
  .vol-bar.sets { background: var(--gold); opacity: 0.7; }
  .vol-lbl { font-size: 9px; color: var(--text-3); font-family: var(--font-mono); }
  .vol-legend {
    display: flex;
    gap: 14px;
    margin-top: 8px;
    font-size: 10px;
    color: var(--text-3);
  }
  .vol-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 2px;
    margin-right: 4px;
    vertical-align: middle;
  }

  /* ── Workout List ──────────────────────────────────── */
  .wo-list { display: flex; flex-direction: column; gap: 2px; }
  .wo-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .wo-row:last-child { border-bottom: none; }
  .wo-icon { font-size: 16px; width: 24px; text-align: center; flex-shrink: 0; }
  .wo-info { flex: 1; min-width: 0; }
  .wo-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wo-meta { font-size: 11px; color: var(--text-3); margin-top: 1px; }
  .wo-cal { font-size: 11px; color: var(--gold); font-family: var(--font-mono); flex-shrink: 0; }
  .wo-hr { font-size: 11px; color: var(--red); font-family: var(--font-mono); flex-shrink: 0; }

  /* ── PR Strip ──────────────────────────────────────── */
  .pr-strip { display: flex; gap: 8px; flex-wrap: wrap; }
  .pr-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(212,168,75,0.1);
    border: 1px solid rgba(212,168,75,0.25);
    border-radius: 20px;
    padding: 5px 12px;
  }
  .pr-val { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--gold); }
  .pr-ex { font-size: 11px; color: var(--text-2); }

  /* ── Start Workout Zone ────────────────────────────── */
  .wo-start-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 40px;
  }
  .wo-start-visual { margin-bottom: 20px; }
  .wo-start-ring {
    width: 80px; height: 80px;
    border-radius: 50%;
    border: 2px solid var(--gold);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: pulse-ring 2s ease infinite;
  }
  .wo-start-icon { font-size: 32px; }
  .wo-start-title { font-family: var(--font-display); font-size: 20px; font-weight: 700; }
  .wo-start-sub { font-size: 13px; color: var(--text-3); margin-top: 4px; }
  .wo-start-btn {
    margin-top: 20px;
    background: var(--gold);
    border: none;
    border-radius: 10px;
    color: var(--bg);
    font-size: 14px;
    font-weight: 700;
    font-family: var(--font-body);
    padding: 12px 32px;
    cursor: pointer;
    transition: transform 0.15s, box-shadow 0.15s;
    box-shadow: 0 4px 16px rgba(212,168,75,0.3);
  }
  .wo-start-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(212,168,75,0.4); }
  .wo-recent { width: 100%; max-width: 400px; margin-top: 8px; }

  /* ── Active Workout ────────────────────────────────── */
  .wo-active {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 190px);
    overflow: hidden;
  }
  .wo-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 12px;
    flex-shrink: 0;
  }
  .wo-header-left { display: flex; align-items: center; gap: 12px; }
  .live-badge {
    background: var(--green);
    color: var(--bg);
    font-size: 9px;
    font-weight: 800;
    font-family: var(--font-mono);
    padding: 3px 8px;
    border-radius: 4px;
    letter-spacing: 1px;
    animation: pulse 1.5s ease infinite;
  }
  .wo-header-name { font-size: 14px; font-weight: 600; }
  .wo-header-sport { font-size: 11px; color: var(--text-3); margin-top: 1px; }
  .wo-timer {
    font-family: var(--font-mono);
    font-size: 28px;
    font-weight: 700;
    color: var(--gold);
    letter-spacing: 1px;
  }

  /* ── PR Flash ──────────────────────────────────────── */
  .pr-flash {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px;
    background: linear-gradient(90deg, rgba(212,168,75,0.15), rgba(212,168,75,0.05));
    border: 1px solid rgba(212,168,75,0.4);
    border-radius: 10px;
    margin-bottom: 12px;
    font-weight: 700;
    color: var(--gold);
    animation: prFlash 0.5s ease;
    flex-shrink: 0;
  }
  .pr-flash-icon { font-size: 20px; }

  /* ── Set Logger ────────────────────────────────────── */
  .set-logger {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
    flex-shrink: 0;
  }
  .set-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .set-field { position: relative; }
  .ex-field { flex: 2; }
  .set-input {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    font-size: 13px;
    font-family: var(--font-body);
    padding: 8px 10px;
    outline: none;
    transition: border-color 0.15s;
  }
  .set-input:focus { border-color: var(--gold); }
  .set-input.sm { width: 72px; flex: none; }
  .set-input::placeholder { color: var(--text-3); }
  .set-select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-1);
    font-size: 12px;
    font-family: var(--font-body);
    padding: 8px 6px;
    outline: none;
    width: 64px;
    cursor: pointer;
  }
  .set-warmup {
    display: flex;
    align-items: center;
    gap: 2px;
    font-size: 11px;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
  }
  .set-warmup input { display: none; }
  .set-warmup span {
    width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    transition: all 0.15s;
  }
  .set-warmup input:checked + span {
    background: rgba(91,155,247,0.15);
    border-color: var(--blue);
    color: var(--blue);
  }
  .set-add-btn {
    width: 36px; height: 36px;
    background: var(--gold);
    border: none;
    border-radius: 8px;
    color: var(--bg);
    font-size: 18px;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .set-add-btn:hover { opacity: 0.85; }
  .set-add-btn:disabled { opacity: 0.4; cursor: default; }

  /* ── Exercise Dropdown ─────────────────────────────── */
  .ex-dropdown {
    position: absolute;
    top: 100%;
    left: 0; right: 0;
    background: var(--surface-2);
    border: 1px solid var(--border-h);
    border-radius: 8px;
    margin-top: 4px;
    z-index: 50;
    max-height: 200px;
    overflow-y: auto;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .ex-option {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    color: var(--text-1);
    font-size: 12px;
    cursor: pointer;
    font-family: var(--font-body);
    text-align: left;
    transition: background 0.1s;
  }
  .ex-option:hover { background: var(--surface-3); }
  .ex-opt-name { font-weight: 500; }
  .ex-opt-cat { font-size: 10px; color: var(--text-3); }

  /* ── Sets List ─────────────────────────────────────── */
  .sets-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-right: 4px;
  }
  .sets-group {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
  }
  .sets-group-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .sets-group-name { font-size: 13px; font-weight: 600; }
  .sets-group-cnt { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
  .sets-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .set-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    transition: border-color 0.15s;
  }
  .set-chip.pr { border-color: rgba(212,168,75,0.5); background: rgba(212,168,75,0.08); }
  .set-chip.warmup { opacity: 0.6; border-style: dashed; }
  .set-num { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); }
  .set-detail { font-weight: 600; }
  .set-rpe { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
  .set-pr-badge {
    font-size: 8px;
    font-weight: 800;
    background: var(--gold);
    color: var(--bg);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--font-mono);
  }
  .set-w-badge {
    font-size: 8px;
    font-weight: 800;
    background: rgba(91,155,247,0.2);
    color: var(--blue);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--font-mono);
  }
  .sets-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sets-empty-text { color: var(--text-3); font-size: 13px; font-style: italic; }

  /* ── Workout Footer ────────────────────────────────── */
  .wo-footer {
    flex-shrink: 0;
    padding-top: 12px;
    display: flex;
    justify-content: center;
  }
  .wo-finish-btn {
    background: none;
    border: 2px solid var(--red);
    border-radius: 10px;
    color: var(--red);
    font-size: 14px;
    font-weight: 700;
    font-family: var(--font-body);
    padding: 10px 32px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .wo-finish-btn:hover { background: var(--red); color: #fff; }

  /* ── Programs ──────────────────────────────────────── */
  .prog-active {
    border-color: rgba(61,214,140,0.3);
    margin-bottom: 16px;
  }
  .prog-badge { margin-bottom: 8px; }
  .prog-name { font-family: var(--font-display); font-size: 18px; font-weight: 700; }
  .prog-meta { font-size: 12px; color: var(--text-2); margin-top: 4px; display: flex; gap: 6px; }
  .prog-list { display: flex; flex-direction: column; gap: 8px; }
  .prog-card-head { display: flex; justify-content: space-between; align-items: center; }
  .prog-card-name { font-size: 14px; font-weight: 600; }
  .prog-card-meta { font-size: 11px; color: var(--text-3); margin-top: 4px; }
  .prog-card-desc { font-size: 12px; color: var(--text-2); margin-top: 6px; line-height: 1.5; }

  /* ── Empty States ──────────────────────────────────── */
  .trn-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    text-align: center;
  }
  .trn-empty-icon { font-size: 40px; margin-bottom: 12px; }
  .trn-empty-title { font-family: var(--font-display); font-size: 18px; font-weight: 700; }
  .trn-empty-sub { font-size: 13px; color: var(--text-3); margin-top: 4px; max-width: 300px; }
  .trn-empty-sm { font-size: 12px; color: var(--text-3); font-style: italic; padding: 16px 0; text-align: center; }

  /* ── Modal ──────────────────────────────────────────── */
  .modal-scrim {
    position: fixed; inset: 0; z-index: 500;
    background: rgba(7,8,12,0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.15s ease;
  }
  .modal-box {
    background: var(--surface-1);
    border: 1px solid var(--border-h);
    border-radius: 14px;
    width: 420px;
    max-width: 92vw;
    padding: 28px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
    animation: modalSlide 0.2s ease;
  }
  .modal-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 20px;
  }
  .modal-sub {
    font-size: 13px;
    color: var(--text-2);
    margin-top: -14px;
    margin-bottom: 20px;
    font-family: var(--font-mono);
  }
  .modal-field { margin-bottom: 16px; }
  .modal-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .modal-input {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-1);
    font-size: 14px;
    font-family: var(--font-body);
    padding: 10px 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .modal-input:focus { border-color: var(--gold); }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 24px;
  }
  .modal-cancel {
    background: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-2);
    font-size: 13px;
    font-family: var(--font-body);
    padding: 8px 18px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .modal-cancel:hover { border-color: var(--border-h); }
  .modal-go {
    background: var(--gold);
    border: none;
    border-radius: 8px;
    color: var(--bg);
    font-size: 13px;
    font-weight: 700;
    font-family: var(--font-body);
    padding: 8px 24px;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .modal-go:hover { opacity: 0.85; }
  .modal-go:disabled { opacity: 0.4; cursor: default; }
  .modal-go.finish { background: var(--green); }

  /* ── Mood Selector ─────────────────────────────────── */
  .mood-row {
    display: flex;
    gap: 4px;
  }
  .mood-btn {
    width: 32px; height: 32px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }
  .mood-btn:hover { border-color: var(--border-h); transform: scale(1.1); }
  .mood-btn.selected { border-color: var(--gold); background: rgba(212,168,75,0.15); transform: scale(1.15); }

  /* ── Fatigue Selector ──────────────────────────────── */
  .fatigue-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .fatigue-dot {
    width: 20px; height: 20px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    transition: transform 0.1s;
  }
  .fatigue-dot:hover { transform: scale(1.15); }
  .fatigue-label {
    font-size: 11px;
    color: var(--text-3);
    font-family: var(--font-mono);
    margin-left: 8px;
    min-width: 28px;
  }

  /* ── Error Toast ──────────────────────────────────── */
  .error-toast {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--red);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font-body);
    padding: 10px 24px;
    border-radius: 10px;
    z-index: 600;
    box-shadow: 0 8px 24px rgba(240,71,112,0.35);
    animation: toastIn 0.25s ease;
    pointer-events: none;
  }

  /* ── Delete Button ──────────────────────────────────── */
  .wo-del-btn {
    width: 24px; height: 24px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-3);
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }
  .wo-del-btn:hover { color: var(--red); border-color: var(--red); background: rgba(240,71,112,0.1); }

  /* ── Delete Modal ───────────────────────────────────── */
  .modal-sm { width: 340px; }
  .modal-del-text { font-size: 13px; color: var(--text-2); line-height: 1.5; }
  .modal-del { background: var(--red); }
  .modal-del:hover { opacity: 0.85; }

  /* ── Animations ────────────────────────────────────── */
  @keyframes toastIn {
    from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes modalSlide {
    from { opacity: 0; transform: translateY(-10px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  @keyframes pulse-ring {
    0% { box-shadow: 0 0 0 0 rgba(212,168,75,0.4); }
    70% { box-shadow: 0 0 0 12px rgba(212,168,75,0); }
    100% { box-shadow: 0 0 0 0 rgba(212,168,75,0); }
  }
  @keyframes prFlash {
    0% { opacity: 0; transform: scale(0.9); }
    50% { transform: scale(1.02); }
    100% { opacity: 1; transform: scale(1); }
  }

  .anim { animation: fadeSlideIn 0.25s ease both; }
  .d1 { animation-delay: 0.05s; }
  .d2 { animation-delay: 0.1s; }
  .d3 { animation-delay: 0.15s; }

  /* ── Responsive ────────────────────────────────────── */
  @media (max-width: 700px) {
    .trn-grid { grid-template-columns: 1fr; }
    .trn-kpis { flex-wrap: wrap; }
    .trn-kpi { min-width: 70px; }
    .set-row { flex-wrap: wrap; }
    .set-input.sm { width: 60px; }
  }
</style>
