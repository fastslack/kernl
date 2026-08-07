<script lang="ts">
  /**
   * /wellness — cross-module overview for the Wellness nav group.
   *
   * Ships with the health extension (it owns the healthData store this page is
   * anchored on); the training and nutrition stores stay shell-owned and are
   * only subscribed to here.
   *
   * Two things worth knowing before editing:
   *
   * 1. Field paths. The dashboard payloads nest almost everything under `kpis`
   *    and use snake_case for macros, and an earlier version of this page read
   *    a flat shape that never existed (`train.thisWeek`, `nutr.todayCalories`,
   *    `health.todayMetrics`). The result was a dashboard that rendered zeros
   *    over a database with data in it. The `sel*` helpers below are the single
   *    place those paths are decoded — change them, not the markup.
   *
   * 2. Streak is derived here. No payload carries one: it is computed from the
   *    union of workout and cardio dates, which is also what the Training card
   *    lists, so the number and the list can never disagree.
   */
  import { onDestroy } from 'svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import QuickAction from '$shared/components/QuickAction.svelte';
  import OverviewCard from '$shared/components/OverviewCard.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { createI18n } from '$shared/i18n';
  import type { ExtPageContext } from '$shared/types';
  import WellnessLogModal from './WellnessLogModal.svelte';
  import { en, es } from './wellness-i18n';

  export let ctx: ExtPageContext;

  const { t, locale, destroy: destroyI18n } = createI18n({
    initial: ctx.locale,
    events: ctx.events,
    dicts: { en, es },
  });
  onDestroy(destroyI18n);

  const healthData = ctx.getStore('healthData');
  const training = ctx.getStore('training');
  const nutrition = ctx.getStore('nutrition');

  $: health = $healthData as any;
  $: train = $training as any;
  $: nutr = $nutrition as any;

  // ── Payload decoding ──────────────────────────────────────────────
  // Every read of a store goes through here. Optional chaining throughout:
  // a module that is off sends `{ available: false }` and nothing else.

  $: healthOn = health?.available === true;
  $: trainingOn = train?.available === true;
  $: nutritionOn = nutr?.available === true;

  $: latestMetrics = (health?.latestMetrics ?? {}) as Record<string, any>;
  $: recentMetrics = (health?.recentMetrics ?? []) as any[];
  $: activeMeds = (health?.kpis?.activeMedications ?? 0) as number;

  /** Workouts and cardio are separate tables; the overview treats them as one. */
  $: sessions = [
    ...((train?.recentWorkouts ?? []) as any[]).map((w) => ({
      id: w.id,
      label: w.name || $t('card.training'),
      date: w.date,
      meta: w.duration_minutes ? `${w.duration_minutes} min` : '',
    })),
    ...((train?.recentCardio ?? []) as any[]).map((c) => ({
      id: c.id,
      label: $t(`act.${c.sport}`) !== `act.${c.sport}` ? $t(`act.${c.sport}`) : c.sport,
      date: c.date,
      meta: [
        c.duration_minutes ? `${c.duration_minutes} min` : '',
        c.distance_m ? `${(c.distance_m / 1000).toFixed(1)} km` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  $: sessionsThisWeek = sessions.filter((s) => s.date >= startOfWeek()).length;
  $: streak = computeStreak(sessions.map((s) => String(s.date).slice(0, 10)));

  $: kcalToday = (nutr?.kpis?.caloriestoday ?? 0) as number;
  $: macros = (nutr?.todayMacros ?? {}) as Record<string, number>;
  $: waterMl = (nutr?.kpis?.waterTodayMl ?? 0) as number;
  $: waterGoalMl = (nutr?.kpis?.waterGoalMl ?? 0) as number;
  $: waterPct = waterGoalMl > 0 ? Math.min(100, Math.round((waterMl / waterGoalMl) * 100)) : 0;

  $: anyStoreLoaded = health != null || train != null || nutr != null;

  // ── Formatting ────────────────────────────────────────────────────
  // Intl everywhere: the shell ships eight locales and hardcoded formats
  // would read wrong in most of them.

  $: nf = new Intl.NumberFormat($locale);
  $: dayFmt = new Intl.DateTimeFormat($locale, { weekday: 'long', day: 'numeric', month: 'long' });
  $: shortFmt = new Intl.DateTimeFormat($locale, { day: 'numeric', month: 'short' });

  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : '0');

  /**
   * Today, as a plain reactive value rather than a helper call.
   *
   * An earlier `todayIso()` helper compiled down to `undefined` at both its
   * call sites: Svelte hoists a function with no instance references to module
   * scope and treats a call to it in an attribute as a constant, and the
   * minifier then folded the whole thing away — the date inputs shipped blank
   * with no `max`. A bound value cannot be constant-folded like that.
   *
   * Ticking it also fixes the real bug the helper had: a dashboard left open
   * overnight kept offering yesterday as the default date.
   */
  let today = new Date().toISOString().slice(0, 10);
  const dayTick = setInterval(() => {
    const now = new Date().toISOString().slice(0, 10);
    if (now !== today) today = now;
  }, 60_000);
  onDestroy(() => clearInterval(dayTick));

  function startOfWeek(): string {
    const d = new Date();
    // ISO weeks start Monday; getDay() is 0-Sunday.
    const shift = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - shift);
    return d.toISOString().slice(0, 10);
  }

  /** Parsed as local noon so a date-only string can't slip a day via UTC. */
  function asDate(iso: string): Date {
    return new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  }

  function fmtDay(iso: string): string {
    if (!iso) return '—';
    try {
      return shortFmt.format(asDate(iso));
    } catch {
      return String(iso).slice(0, 10);
    }
  }

  /** Consecutive days ending today or yesterday; a gap of 2+ days resets it. */
  function computeStreak(dates: string[]): number {
    if (!dates.length) return 0;
    const days = new Set(dates);
    const cursor = new Date();
    // Yesterday still counts as alive — a streak shouldn't die at midnight.
    if (!days.has(cursor.toISOString().slice(0, 10))) {
      cursor.setDate(cursor.getDate() - 1);
      if (!days.has(cursor.toISOString().slice(0, 10))) return 0;
    }
    let n = 0;
    while (days.has(cursor.toISOString().slice(0, 10))) {
      n += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return n;
  }

  /** Metric type → the unit it is almost always recorded in. */
  const METRIC_TYPES = [
    { id: 'weight', unit: 'kg' },
    { id: 'steps', unit: 'steps' },
    { id: 'blood_pressure', unit: 'mmHg' },
    { id: 'heart_rate', unit: 'bpm' },
    { id: 'sleep_hours', unit: 'h' },
    { id: 'body_fat', unit: '%' },
    { id: 'glucose', unit: 'mg/dL' },
    { id: 'temperature', unit: '°C' },
  ];
  const ACTIVITIES = ['running', 'cycling', 'walking', 'swimming', 'rowing', 'elliptical', 'hiking', 'other'];
  const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
  const WATER_PRESETS = [250, 330, 500, 750];

  const ICONS = {
    logMetric:
      'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    logWorkout: 'M13 10V3L4 14h7v7l9-11h-7z',
    logMeal:
      'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7',
    logWater: 'M12 2.69l5.66 5.66a8 8 0 11-11.31 0z',
    health:
      'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
    training: 'M13 10V3L4 14h7v7l9-11h-7z',
    nutrition:
      'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7',
  };

  // ── Logging ───────────────────────────────────────────────────────

  type ModalKind = 'metric' | 'workout' | 'meal' | 'water';
  let openModal: ModalKind | null = null;
  let submitting = false;
  let formError = '';
  let fieldErrors: Record<string, string> = {};

  let toast = '';
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Metric form
  let mType = 'weight';
  let mValue = '';
  let mUnit = 'kg';
  let mDate = today;
  // Following the type keeps the unit correct without taking the field away:
  // it stays editable for anyone recording lb or mg/L.
  $: mUnit = METRIC_TYPES.find((x) => x.id === mType)?.unit ?? mUnit;

  // Workout form
  let wSport = 'running';
  let wDuration = '';
  let wDistance = '';
  let wCalories = '';
  let wDate = today;

  // Meal form
  let fName = '';
  let fMeal = 'breakfast';
  let fQty = '';
  let fCalories = '';
  let fProtein = '';
  let fCarbs = '';
  let fFat = '';

  // Water form
  let waterAmount = 250;
  let waterCustom = '';

  function openLog(kind: ModalKind) {
    formError = '';
    fieldErrors = {};
    openModal = kind;
  }

  function closeLog() {
    if (submitting) return;
    openModal = null;
    formError = '';
    fieldErrors = {};
  }

  function showToast(msg: string) {
    toast = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = '';
    }, 4500);
  }

  onDestroy(() => {
    if (toastTimer) clearTimeout(toastTimer);
  });

  /**
   * Races the WS bridge against `POST /api/rpc/<action>`. The HTTP route serves
   * every registered action, so logging keeps working on stacks that run with
   * the bridge disabled — which is the case on the default local stack.
   */
  async function callRpc(action: string, params: Record<string, unknown>): Promise<any> {
    return ctx.rpc(action, params, async () => {
      const res = await ctx.fetchRaw(`/api/rpc/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.error) throw new Error(body?.error || `HTTP ${res.status}`);
      return body;
    });
  }

  /**
   * Pull the module's dashboard payload and write it back into the shell store.
   * The stores are shell-owned and shared, so this also refreshes /health,
   * /training and /nutrition if they are mounted.
   */
  async function refresh(store: any, url: string) {
    try {
      const fresh = await ctx.fetchJson(`${url}?_t=${Date.now()}`);
      if (fresh) store.set(fresh);
    } catch {
      // A stale card is not worth an error toast — the write already succeeded.
    }
  }

  /** Moves focus to the first field that failed, per WCAG 3.3.1. */
  function focusFirstError() {
    requestAnimationFrame(() => {
      const key = Object.keys(fieldErrors)[0];
      if (!key) return;
      document.getElementById(`wf-${key}`)?.focus();
    });
  }

  function requireText(key: string, value: string): boolean {
    if (!value.trim()) {
      fieldErrors[key] = $t('modal.required');
      return false;
    }
    return true;
  }

  function requireNumber(key: string, value: string): boolean {
    if (!value.trim()) {
      fieldErrors[key] = $t('modal.required');
      return false;
    }
    if (!Number.isFinite(Number(value))) {
      fieldErrors[key] = $t('modal.number');
      return false;
    }
    return true;
  }

  const optionalNumber = (v: string) => (v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

  async function submitLog() {
    fieldErrors = {};
    formError = '';

    let ok = true;
    if (openModal === 'metric') ok = requireNumber('value', mValue) && ok;
    if (openModal === 'workout') ok = requireNumber('duration', wDuration) && ok;
    if (openModal === 'meal') ok = requireText('food', fName) && ok;
    if (openModal === 'water') {
      const amount = waterCustom.trim() ? Number(waterCustom) : waterAmount;
      if (!Number.isFinite(amount) || amount <= 0) {
        fieldErrors['water'] = $t('modal.number');
        ok = false;
      }
    }

    if (!ok) {
      fieldErrors = { ...fieldErrors };
      focusFirstError();
      return;
    }

    submitting = true;
    try {
      if (openModal === 'metric') {
        await callRpc('health.metrics.log', {
          type: mType,
          value: mValue.trim(),
          unit: mUnit.trim(),
          date: mDate || today,
        });
        await refresh(healthData, '/api/dashboard/health');
        showToast($t('m.metric.ok', { type: $t(`mt.${mType}`), value: mValue.trim(), unit: mUnit }));
        mValue = '';
      } else if (openModal === 'workout') {
        const km = optionalNumber(wDistance);
        await callRpc('training.cardio.log', {
          sport: wSport,
          duration_minutes: Number(wDuration),
          // The column is metres; the field asks for km because that is what
          // people know their run in.
          distance_m: km !== undefined ? Math.round(km * 1000) : undefined,
          calories: optionalNumber(wCalories),
          date: wDate || today,
        });
        await refresh(training, '/api/dashboard/training');
        showToast($t('m.workout.ok', { activity: $t(`act.${wSport}`), duration: wDuration }));
        wDuration = '';
        wDistance = '';
        wCalories = '';
      } else if (openModal === 'meal') {
        const kcal = optionalNumber(fCalories) ?? 0;
        await callRpc('nutrition.entries.log', {
          food_name: fName.trim(),
          meal_type: fMeal,
          quantity_g: optionalNumber(fQty) ?? 0,
          calories: kcal,
          protein_g: optionalNumber(fProtein) ?? 0,
          carbs_g: optionalNumber(fCarbs) ?? 0,
          fat_g: optionalNumber(fFat) ?? 0,
        });
        await refresh(nutrition, '/api/dashboard/nutrition');
        showToast($t('m.meal.ok', { food: fName.trim(), calories: num(kcal) }));
        fName = '';
        fQty = '';
        fCalories = '';
        fProtein = '';
        fCarbs = '';
        fFat = '';
      } else if (openModal === 'water') {
        const amount = waterCustom.trim() ? Number(waterCustom) : waterAmount;
        await callRpc('nutrition.water.log', { amount_ml: amount });
        await refresh(nutrition, '/api/dashboard/nutrition');
        showToast($t('m.water.ok', { amount: num(amount) }));
        waterCustom = '';
      }
      openModal = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      formError = msg ? $t('err.prefix', { msg }) : $t('err.generic');
    } finally {
      submitting = false;
    }
  }

  $: canSubmit =
    openModal === 'metric'
      ? mValue.trim().length > 0
      : openModal === 'workout'
        ? wDuration.trim().length > 0
        : openModal === 'meal'
          ? fName.trim().length > 0
          : true;
</script>

{#if !anyStoreLoaded}
  <ViewHeader title={$t('title')} sub={$t('loading')} />
  <div class="skeleton-row" aria-hidden="true">
    {#each Array(4) as _}<div class="skeleton skeleton-qa"></div>{/each}
  </div>
  <div class="skeleton-row" aria-hidden="true">
    {#each Array(4) as _}<div class="skeleton skeleton-kpi"></div>{/each}
  </div>
  <div class="overview-grid" aria-hidden="true">
    {#each Array(3) as _}<div class="skeleton skeleton-card"></div>{/each}
  </div>
  <p class="sr-only" role="status">{$t('loading')}</p>
{:else}
  <ViewHeader title={$t('title')} sub={$t('sub')} />
  <p class="anchor-date">{$t('sub.date', { date: dayFmt.format(new Date()) })}</p>

  <!-- Quick Actions — every one of these writes through an RPC. -->
  <div class="quick-actions">
    <QuickAction
      label={$t('qa.metric')}
      icon={ICONS.logMetric}
      variant="primary"
      onClick={() => openLog('metric')}
    />
    <QuickAction
      label={$t('qa.workout')}
      icon={ICONS.logWorkout}
      variant="orange"
      onClick={() => openLog('workout')}
    />
    <QuickAction
      label={$t('qa.meal')}
      icon={ICONS.logMeal}
      variant="teal"
      onClick={() => openLog('meal')}
    />
    <QuickAction
      label={$t('qa.water')}
      icon={ICONS.logWater}
      variant="blue"
      onClick={() => openLog('water')}
    />
  </div>

  <!-- KPI row. Cards render a placeholder rather than unmounting, so the grid
       keeps its column count as data arrives. -->
  <div class="kpi-row anim">
    <KpiCard
      label={$t('kpi.weight')}
      value={latestMetrics.weight ? `${latestMetrics.weight.value} ${latestMetrics.weight.unit}` : '—'}
      sub={latestMetrics.weight ? fmtDay(latestMetrics.weight.date) : $t('kpi.sub.none')}
      accent="--blue"
      color={latestMetrics.weight ? 'var(--blue)' : 'var(--text-3)'}
    />
    <KpiCard
      label={$t('kpi.steps')}
      value={latestMetrics.steps ? num(Number(latestMetrics.steps.value)) : '—'}
      sub={latestMetrics.steps ? fmtDay(latestMetrics.steps.date) : $t('kpi.sub.none')}
      accent="--teal"
      color={latestMetrics.steps ? 'var(--teal)' : 'var(--text-3)'}
    />
    <KpiCard
      label={$t('kpi.workouts')}
      value={num(sessionsThisWeek)}
      sub={$t('kpi.sub.week')}
      accent="--orange"
      color={sessionsThisWeek > 0 ? 'var(--orange)' : 'var(--text-3)'}
    />
    <KpiCard
      label={$t('kpi.streak')}
      value={num(streak)}
      sub={streak === 1 ? $t('kpi.sub.days.one') : $t('kpi.sub.days')}
      accent="--gold"
      color={streak > 0 ? 'var(--gold)' : 'var(--text-3)'}
    />
    <KpiCard
      label={$t('kpi.calories')}
      value={num(kcalToday)}
      sub={$t('kpi.sub.today')}
      accent="--green"
      color={kcalToday > 0 ? 'var(--green)' : 'var(--text-3)'}
    />
    <KpiCard
      label={$t('kpi.medications')}
      value={num(activeMeds)}
      sub={$t('kpi.sub.active')}
      accent="--purple"
      color={activeMeds > 0 ? 'var(--purple)' : 'var(--text-3)'}
    />
  </div>

  <div class="overview-grid">
    <!-- Health -->
    <OverviewCard
      title={$t('card.health')}
      icon={ICONS.health}
      iconColor="var(--red)"
      actions={[{ label: $t('card.view.health'), href: '/health' }]}
      navigate={ctx.navigate}
    >
      {#if healthOn && recentMetrics.length > 0}
        <ul class="card-list">
          {#each recentMetrics.slice(0, 4) as m (m.id)}
            <li>
              <span class="card-list-title">{$t(`mt.${m.type}`) !== `mt.${m.type}` ? $t(`mt.${m.type}`) : String(m.type).replace(/_/g, ' ')}</span>
              <span class="card-list-side">
                <span class="card-list-value">{m.value} {m.unit}</span>
                <span class="card-list-meta">{fmtDay(m.date)}</span>
              </span>
            </li>
          {/each}
        </ul>
      {:else if healthOn}
        <Empty
          icon="🩺"
          title={$t('empty.health.title')}
          hint={$t('empty.health.hint')}
          cta={$t('empty.health.cta')}
          on:click={() => openLog('metric')}
        />
      {:else}
        <Empty
          icon="🔌"
          title={$t('off.health.title')}
          hint={$t('off.health.hint')}
          cta={$t('off.cta')}
          on:click={() => ctx.navigate('/extensions')}
        />
      {/if}
    </OverviewCard>

    <!-- Training -->
    <OverviewCard
      title={$t('card.training')}
      icon={ICONS.training}
      iconColor="var(--orange)"
      actions={[{ label: $t('card.view.training'), href: '/training' }]}
      navigate={ctx.navigate}
    >
      {#if trainingOn && sessions.length > 0}
        <ul class="card-list">
          {#each sessions.slice(0, 4) as s (s.id)}
            <li>
              <span class="card-list-title">{s.label}</span>
              <span class="card-list-side">
                {#if s.meta}<span class="card-list-value">{s.meta}</span>{/if}
                <span class="card-list-meta">{fmtDay(s.date)}</span>
              </span>
            </li>
          {/each}
        </ul>
      {:else if trainingOn}
        <Empty
          icon="💪"
          title={$t('empty.training.title')}
          hint={$t('empty.training.hint')}
          cta={$t('empty.training.cta')}
          on:click={() => openLog('workout')}
        />
      {:else}
        <Empty
          icon="🔌"
          title={$t('off.training.title')}
          hint={$t('off.training.hint')}
          cta={$t('off.cta')}
          on:click={() => ctx.navigate('/extensions')}
        />
      {/if}
    </OverviewCard>

    <!-- Nutrition -->
    <OverviewCard
      title={$t('card.nutrition')}
      icon={ICONS.nutrition}
      iconColor="var(--teal)"
      actions={[{ label: $t('card.view.nutrition'), href: '/nutrition' }]}
      navigate={ctx.navigate}
    >
      {#if nutritionOn && (kcalToday > 0 || waterMl > 0)}
        <div class="nutrition-stats">
          <div class="stat-big">
            <span class="stat-value">{num(kcalToday)}</span>
            <span class="stat-label">{$t('nutr.kcal')}</span>
          </div>

          <dl class="macros">
            <div class="macro">
              <dt>{$t('nutr.protein')}</dt>
              <dd>{num(Math.round(macros.protein_g ?? 0))} g</dd>
            </div>
            <div class="macro">
              <dt>{$t('nutr.carbs')}</dt>
              <dd>{num(Math.round(macros.carbs_g ?? 0))} g</dd>
            </div>
            <div class="macro">
              <dt>{$t('nutr.fat')}</dt>
              <dd>{num(Math.round(macros.fat_g ?? 0))} g</dd>
            </div>
          </dl>

          {#if waterGoalMl > 0}
            <div class="water">
              <div class="water-head">
                <span>{$t('nutr.water')}</span>
                <span class="water-nums">{num(waterMl)} / {num(waterGoalMl)} ml</span>
              </div>
              <div
                class="water-track"
                role="progressbar"
                aria-label={$t('nutr.water')}
                aria-valuenow={waterMl}
                aria-valuemin="0"
                aria-valuemax={waterGoalMl}
              >
                <div class="water-fill" style="width:{waterPct}%"></div>
              </div>
            </div>
          {/if}
        </div>
      {:else if nutritionOn}
        <Empty
          icon="🥗"
          title={$t('empty.nutrition.title')}
          hint={$t('empty.nutrition.hint')}
          cta={$t('empty.nutrition.cta')}
          on:click={() => openLog('meal')}
        />
      {:else}
        <Empty
          icon="🔌"
          title={$t('off.nutrition.title')}
          hint={$t('off.nutrition.hint')}
          cta={$t('off.cta')}
          on:click={() => ctx.navigate('/extensions')}
        />
      {/if}
    </OverviewCard>
  </div>
{/if}

<!-- Success announcements. Lives outside the branches so the region is present
     in the DOM before it ever has content — assistive tech needs it mounted. -->
<div class="toast-region" aria-live="polite" role="status">
  {#if toast}
    <div class="toast">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
        <path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      {toast}
    </div>
  {/if}
</div>

{#if openModal === 'metric'}
  <WellnessLogModal
    title={$t('m.metric.title')}
    sub={$t('m.metric.sub')}
    submitLabel={$t('m.metric.save')}
    cancelLabel={$t('modal.cancel')}
    closeLabel={$t('modal.close')}
    savingLabel={$t('modal.saving')}
    {submitting}
    {canSubmit}
    error={formError}
    on:close={closeLog}
    on:submit={submitLog}
  >
    <div class="wf">
      <label class="wf-label" for="wf-type">{$t('m.metric.type')}</label>
      <select class="wf-input" id="wf-type" bind:value={mType}>
        {#each METRIC_TYPES as mt}
          <option value={mt.id}>{$t(`mt.${mt.id}`)}</option>
        {/each}
      </select>
    </div>

    <div class="wf-pair">
      <div class="wf">
        <label class="wf-label" for="wf-value">{$t('m.metric.value')}</label>
        <input
          class="wf-input"
          id="wf-value"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          spellcheck="false"
          placeholder="78.4"
          bind:value={mValue}
          aria-invalid={fieldErrors.value ? 'true' : undefined}
          aria-describedby={fieldErrors.value ? 'wf-value-err' : undefined}
        />
        {#if fieldErrors.value}
          <p class="wf-err" id="wf-value-err">{fieldErrors.value}</p>
        {/if}
      </div>
      <div class="wf">
        <label class="wf-label" for="wf-unit">{$t('m.metric.unit')}</label>
        <input class="wf-input" id="wf-unit" type="text" autocomplete="off" spellcheck="false" bind:value={mUnit} />
      </div>
    </div>

    <div class="wf">
      <label class="wf-label" for="wf-date">{$t('m.metric.date')}</label>
      <input class="wf-input" id="wf-date" type="date" bind:value={mDate} max={today} />
    </div>
  </WellnessLogModal>
{/if}

{#if openModal === 'workout'}
  <WellnessLogModal
    title={$t('m.workout.title')}
    sub={$t('m.workout.sub')}
    submitLabel={$t('m.workout.save')}
    cancelLabel={$t('modal.cancel')}
    closeLabel={$t('modal.close')}
    savingLabel={$t('modal.saving')}
    {submitting}
    {canSubmit}
    error={formError}
    on:close={closeLog}
    on:submit={submitLog}
  >
    <div class="wf">
      <label class="wf-label" for="wf-sport">{$t('m.workout.activity')}</label>
      <select class="wf-input" id="wf-sport" bind:value={wSport}>
        {#each ACTIVITIES as a}
          <option value={a}>{$t(`act.${a}`)}</option>
        {/each}
      </select>
    </div>

    <div class="wf">
      <label class="wf-label" for="wf-duration">{$t('m.workout.duration')}</label>
      <input
        class="wf-input"
        id="wf-duration"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        placeholder="32"
        bind:value={wDuration}
        aria-invalid={fieldErrors.duration ? 'true' : undefined}
        aria-describedby={fieldErrors.duration ? 'wf-duration-err' : undefined}
      />
      {#if fieldErrors.duration}
        <p class="wf-err" id="wf-duration-err">{fieldErrors.duration}</p>
      {/if}
    </div>

    <div class="wf-pair">
      <div class="wf">
        <label class="wf-label" for="wf-distance">
          {$t('m.workout.distance')} <span class="wf-opt">{$t('m.workout.optional')}</span>
        </label>
        <input class="wf-input" id="wf-distance" type="text" inputmode="decimal" autocomplete="off" placeholder="5.4" bind:value={wDistance} />
      </div>
      <div class="wf">
        <label class="wf-label" for="wf-calories">
          {$t('m.workout.calories')} <span class="wf-opt">{$t('m.workout.optional')}</span>
        </label>
        <input class="wf-input" id="wf-calories" type="text" inputmode="numeric" autocomplete="off" placeholder="410" bind:value={wCalories} />
      </div>
    </div>

    <div class="wf">
      <label class="wf-label" for="wf-wdate">{$t('m.workout.date')}</label>
      <input class="wf-input" id="wf-wdate" type="date" bind:value={wDate} max={today} />
    </div>
  </WellnessLogModal>
{/if}

{#if openModal === 'meal'}
  <WellnessLogModal
    title={$t('m.meal.title')}
    sub={$t('m.meal.sub')}
    submitLabel={$t('m.meal.save')}
    cancelLabel={$t('modal.cancel')}
    closeLabel={$t('modal.close')}
    savingLabel={$t('modal.saving')}
    {submitting}
    {canSubmit}
    error={formError}
    on:close={closeLog}
    on:submit={submitLog}
  >
    <div class="wf">
      <label class="wf-label" for="wf-food">{$t('m.meal.food')}</label>
      <input
        class="wf-input"
        id="wf-food"
        type="text"
        autocomplete="off"
        placeholder={$t('m.meal.placeholder')}
        bind:value={fName}
        aria-invalid={fieldErrors.food ? 'true' : undefined}
        aria-describedby={fieldErrors.food ? 'wf-food-err' : undefined}
      />
      {#if fieldErrors.food}
        <p class="wf-err" id="wf-food-err">{fieldErrors.food}</p>
      {/if}
    </div>

    <div class="wf-pair">
      <div class="wf">
        <label class="wf-label" for="wf-meal">{$t('m.meal.type')}</label>
        <select class="wf-input" id="wf-meal" bind:value={fMeal}>
          {#each MEAL_TYPES as mt}
            <option value={mt}>{$t(`meal.${mt}`)}</option>
          {/each}
        </select>
      </div>
      <div class="wf">
        <label class="wf-label" for="wf-qty">{$t('m.meal.qty')}</label>
        <input class="wf-input" id="wf-qty" type="text" inputmode="numeric" autocomplete="off" placeholder="80" bind:value={fQty} />
      </div>
    </div>

    <div class="wf">
      <label class="wf-label" for="wf-kcal">{$t('m.meal.calories')}</label>
      <input class="wf-input" id="wf-kcal" type="text" inputmode="numeric" autocomplete="off" placeholder="312" bind:value={fCalories} />
    </div>

    <div class="wf-triple">
      <div class="wf">
        <label class="wf-label" for="wf-protein">{$t('m.meal.protein')}</label>
        <input class="wf-input" id="wf-protein" type="text" inputmode="decimal" autocomplete="off" placeholder="11" bind:value={fProtein} />
      </div>
      <div class="wf">
        <label class="wf-label" for="wf-carbs">{$t('m.meal.carbs')}</label>
        <input class="wf-input" id="wf-carbs" type="text" inputmode="decimal" autocomplete="off" placeholder="54" bind:value={fCarbs} />
      </div>
      <div class="wf">
        <label class="wf-label" for="wf-fat">{$t('m.meal.fat')}</label>
        <input class="wf-input" id="wf-fat" type="text" inputmode="decimal" autocomplete="off" placeholder="6" bind:value={fFat} />
      </div>
    </div>
  </WellnessLogModal>
{/if}

{#if openModal === 'water'}
  <WellnessLogModal
    title={$t('m.water.title')}
    sub={$t('m.water.sub')}
    submitLabel={$t('m.water.save')}
    cancelLabel={$t('modal.cancel')}
    closeLabel={$t('modal.close')}
    savingLabel={$t('modal.saving')}
    {submitting}
    canSubmit={true}
    error={formError}
    on:close={closeLog}
    on:submit={submitLog}
  >
    <div class="wf">
      <span class="wf-label" id="wf-water-label">{$t('m.water.amount')}</span>
      <div class="water-presets" role="group" aria-labelledby="wf-water-label">
        {#each WATER_PRESETS as amount}
          <button
            type="button"
            class="water-chip"
            class:selected={!waterCustom.trim() && waterAmount === amount}
            aria-pressed={!waterCustom.trim() && waterAmount === amount}
            on:click={() => {
              waterAmount = amount;
              waterCustom = '';
            }}
          >
            {num(amount)} ml
          </button>
        {/each}
      </div>
    </div>

    <div class="wf">
      <label class="wf-label" for="wf-water">{$t('m.water.custom')}</label>
      <input
        class="wf-input"
        id="wf-water"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        placeholder="1000"
        bind:value={waterCustom}
        aria-invalid={fieldErrors.water ? 'true' : undefined}
        aria-describedby={fieldErrors.water ? 'wf-water-err' : undefined}
      />
      {#if fieldErrors.water}
        <p class="wf-err" id="wf-water-err">{fieldErrors.water}</p>
      {/if}
    </div>
  </WellnessLogModal>
{/if}

<style>
  .anchor-date {
    margin: -6px 0 18px;
    font-size: 12px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .quick-actions {
    display: flex;
    gap: 12px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }

  .overview-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    align-items: stretch;
  }
  /* Cards were ending at different heights, which left the three footer
     buttons on three different baselines. */
  .overview-grid > :global(.overview-card) {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .overview-grid > :global(.overview-card) > :global(.overview-card-content) {
    flex: 1;
  }

  /* ── Card lists ─────────────────────────────────────── */
  .card-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .card-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
  }
  .card-list li:last-child {
    border-bottom: none;
  }
  .card-list-title {
    font-size: 12.5px;
    color: var(--text-1);
    /* min-width:0 is what actually lets the ellipsis happen in a flex row. */
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-list-side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    flex: none;
  }
  .card-list-value {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-1);
    font-variant-numeric: tabular-nums;
  }
  .card-list-meta {
    font-size: 10.5px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  /* ── Nutrition card ─────────────────────────────────── */
  .nutrition-stats {
    padding: 4px 0;
  }
  .stat-big {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .stat-value {
    font-size: 30px;
    font-weight: 700;
    color: var(--teal);
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .stat-label {
    font-size: 11px;
    color: var(--text-3);
  }
  .macros {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 16px 0 0;
  }
  .macro {
    text-align: center;
    padding: 8px 4px;
    border-radius: 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .macro dt {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--text-3);
  }
  .macro dd {
    margin: 3px 0 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
    font-variant-numeric: tabular-nums;
  }
  .water {
    margin-top: 14px;
  }
  .water-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 10.5px;
    color: var(--text-3);
    margin-bottom: 5px;
  }
  .water-nums {
    font-variant-numeric: tabular-nums;
  }
  .water-track {
    height: 6px;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .water-fill {
    height: 100%;
    background: var(--blue);
    border-radius: 999px;
    transition: width 0.3s ease;
  }

  /* ── Toast ──────────────────────────────────────────── */
  .toast-region {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 600;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 9px;
    max-width: 380px;
    padding: 11px 15px;
    border-radius: 10px;
    background: var(--surface-1);
    border: 1px solid color-mix(in srgb, var(--green) 50%, var(--border));
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.4;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    animation: toastIn 0.2s ease;
  }
  .toast svg {
    width: 16px;
    height: 16px;
    flex: none;
    color: var(--green);
  }

  /* ── Modal fields ───────────────────────────────────── */
  .wf {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .wf-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .wf-triple {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .wf-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .wf-opt {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
    opacity: 0.75;
  }
  .wf-input {
    width: 100%;
    min-height: 38px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-1);
    font-size: 14px;
    font-family: var(--font-body);
    padding: 9px 13px;
    transition: border-color 0.15s ease;
  }
  .wf-input:focus {
    border-color: var(--gold);
  }
  .wf-input[aria-invalid='true'] {
    border-color: var(--red);
  }
  /* Native selects render with the OS palette on Windows dark mode unless
     both colours are stated. */
  select.wf-input {
    background-color: var(--surface-2);
    color: var(--text-1);
  }
  .wf-err {
    display: block;
    margin: 6px 0 0;
    font-size: 11.5px;
    color: var(--red);
  }

  .water-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .water-chip {
    min-height: 34px;
    padding: 7px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 13px;
    font-family: var(--font-body);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    touch-action: manipulation;
    transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
  }
  .water-chip:hover {
    border-color: var(--border-h);
    color: var(--text-1);
  }
  .water-chip.selected {
    border-color: var(--blue);
    color: var(--text-1);
    background: color-mix(in srgb, var(--blue) 16%, transparent);
  }

  /* ── Loading skeleton ───────────────────────────────── */
  .skeleton-row {
    display: flex;
    gap: 12px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .skeleton {
    background: linear-gradient(
      90deg,
      var(--surface-2) 25%,
      var(--surface-3, var(--border)) 50%,
      var(--surface-2) 75%
    );
    background-size: 200% 100%;
    border-radius: 12px;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  .skeleton-qa {
    width: 108px;
    height: 84px;
  }
  .skeleton-kpi {
    flex: 1;
    min-width: 150px;
    height: 96px;
  }
  .skeleton-card {
    height: 220px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes toastIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes shimmer {
    from { background-position: 200% 0; }
    to { background-position: -200% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast,
    .skeleton {
      animation: none;
    }
    .water-fill {
      transition: none;
    }
  }

  @media (max-width: 520px) {
    .wf-pair,
    .wf-triple {
      grid-template-columns: 1fr;
    }
    .toast-region {
      left: 16px;
      right: 16px;
    }
    .toast {
      max-width: none;
    }
  }
</style>
