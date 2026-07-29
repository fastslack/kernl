<script lang="ts">
  // /wellness — migrated from services/dashboard/src/routes/wellness/+page.svelte
  // (Fase 3). Formerly navigated by the wellness-suite (UI-only, no backend);
  // the page now ships with the health extension, which owns the healthData
  // store this overview is anchored on. Training/nutrition stores stay
  // shell-owned; we only subscribe.
  import KpiCard from '$shared/components/KpiCard.svelte';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import QuickAction from '$shared/components/QuickAction.svelte';
  import OverviewCard from '$shared/components/OverviewCard.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { fmtTime } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const healthData = ctx.getStore('healthData');
  const training = ctx.getStore('training');
  const nutrition = ctx.getStore('nutrition');

  // Data from stores
  $: health = ($healthData as any);
  $: train = ($training as any);
  $: nutr = ($nutrition as any);

  // Health breakdown
  $: healthAvailable = health?.available ?? false;
  $: todayMetrics = health?.todayMetrics ?? {};
  $: recentMetrics = (health?.recentMetrics ?? []) as any[];
  $: activeMedications = health?.activeMedications ?? 0;

  // Training breakdown
  $: trainingAvailable = train?.available ?? false;
  $: thisWeekWorkouts = train?.thisWeek ?? 0;
  $: currentStreak = train?.currentStreak ?? 0;
  $: recentWorkouts = (train?.recentWorkouts ?? []) as any[];

  // Nutrition breakdown
  $: nutritionAvailable = nutr?.available ?? false;
  $: todayCalories = nutr?.todayCalories ?? 0;
  $: macros = nutr?.macros ?? {};

  // Count configured modules
  $: configuredModules = [healthAvailable, trainingAvailable, nutritionAvailable].filter(Boolean).length;

  // SVG paths
  const ICONS = {
    logMetric: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    logWorkout: 'M13 10V3L4 14h7v7l9-11h-7z',
    logMeal: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7',
    viewTraining: 'M13 10V3L4 14h7v7l9-11h-7z',
    health: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
    training: 'M13 10V3L4 14h7v7l9-11h-7z',
    nutrition: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7'
  };
</script>

{#if !health && !train && !nutr}
  <div class="loading-view">Loading wellness overview...</div>
{:else}
  <ViewHeader title="Wellness" sub="Your health and fitness dashboard" />

  <!-- Quick Actions -->
  <div class="quick-actions">
    <QuickAction label="Log Metric" icon={ICONS.logMetric} variant="primary" onClick={() => alert('Use MCP: kernel_health_log_metric')} />
    <QuickAction label="Log Workout" icon={ICONS.logWorkout} variant="orange" onClick={() => alert('Use MCP: kernel_training_log_workout')} />
    <QuickAction label="Log Meal" icon={ICONS.logMeal} variant="teal" onClick={() => alert('Use MCP: kernel_nutrition_log_meal')} />
    <QuickAction label="View Training" icon={ICONS.viewTraining} variant="purple" href="/training" navigate={ctx.navigate} />
  </div>

  <!-- KPI Row -->
  <div class="kpi-row anim">
    {#if healthAvailable}
      {#if todayMetrics.weight}
        <KpiCard label="Weight" value="{todayMetrics.weight.value} {todayMetrics.weight.unit}" sub="today" accent="--blue" color="var(--blue)" />
      {/if}
      {#if todayMetrics.steps}
        <KpiCard label="Steps" value={todayMetrics.steps.value} sub="today" accent="--teal" color="var(--teal)" />
      {/if}
      <KpiCard label="Medications" value={activeMedications} sub="active" accent="--purple" color="var(--purple)" />
    {/if}
    {#if trainingAvailable}
      <KpiCard label="Workouts" value={thisWeekWorkouts} sub="this week" accent="--orange" color="var(--orange)" />
      <KpiCard label="Streak" value={currentStreak} sub="days" accent="--gold" color="var(--gold)" />
    {/if}
    {#if nutritionAvailable}
      <KpiCard label="Calories" value={todayCalories} sub="today" accent="--green" color="var(--green)" />
    {/if}
    {#if configuredModules === 0}
      <KpiCard label="Modules" value={0} sub="configured" accent="--text-3" color="var(--text-3)" />
    {/if}
  </div>

  <!-- Overview Grid -->
  <div class="overview-grid">
    <!-- Health Card -->
    <OverviewCard title="Health" icon={ICONS.health} iconColor="var(--red)" actions={[{ label: 'View Health', href: '/health' }]} navigate={ctx.navigate}>
      {#if healthAvailable && recentMetrics.length > 0}
        <ul class="card-list">
          {#each recentMetrics.slice(0, 4) as m}
            <li>
              <span class="card-list-title">{m.type}</span>
              <span class="card-list-value">{m.value} {m.unit}</span>
            </li>
          {/each}
        </ul>
      {:else if healthAvailable}
        <Empty message="No recent metrics." />
      {:else}
        <Empty message="Health module not configured." />
      {/if}
    </OverviewCard>

    <!-- Training Card -->
    <OverviewCard title="Training" icon={ICONS.training} iconColor="var(--orange)" actions={[{ label: 'View Training', href: '/training' }]} navigate={ctx.navigate}>
      {#if trainingAvailable && recentWorkouts.length > 0}
        <ul class="card-list">
          {#each recentWorkouts.slice(0, 4) as w}
            <li>
              <span class="card-list-title">{w.name || w.type}</span>
              <span class="card-list-meta">{fmtTime(w.date)}</span>
            </li>
          {/each}
        </ul>
      {:else if trainingAvailable}
        <Empty message="No recent workouts." />
      {:else}
        <Empty message="Training module not configured." />
      {/if}
    </OverviewCard>

    <!-- Nutrition Card -->
    <OverviewCard title="Nutrition" icon={ICONS.nutrition} iconColor="var(--teal)" actions={[{ label: 'View Nutrition', href: '/nutrition' }]} navigate={ctx.navigate}>
      {#if nutritionAvailable}
        <div class="nutrition-stats">
          <div class="stat-big">
            <span class="stat-value">{todayCalories}</span>
            <span class="stat-label">kcal today</span>
          </div>
          {#if macros.protein || macros.carbs || macros.fat}
            <div class="macros">
              P: {macros.protein ?? 0}g | C: {macros.carbs ?? 0}g | F: {macros.fat ?? 0}g
            </div>
          {/if}
        </div>
      {:else}
        <Empty message="Nutrition module not configured." />
      {/if}
    </OverviewCard>
  </div>
{/if}

<style>
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
  }
  .card-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .card-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .card-list li:last-child {
    border-bottom: none;
  }
  .card-list-title {
    font-size: 12px;
    color: var(--text-1);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: 8px;
  }
  .card-list-meta {
    font-size: 10px;
    color: var(--text-3);
  }
  .card-list-value {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-1);
  }
  .nutrition-stats {
    text-align: center;
    padding: 8px 0;
  }
  .stat-big {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .stat-value {
    font-size: 28px;
    font-weight: 700;
    color: var(--teal);
  }
  .macros {
    margin-top: 12px;
    font-size: 11px;
    color: var(--text-3);
  }
  .stat-label {
    font-size: 11px;
    color: var(--text-3);
  }
</style>
