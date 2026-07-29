<script lang="ts">
  // /nutrition — migrated from services/dashboard/src/routes/nutrition/+page.svelte
  // (Fase 3). The shell keeps hydrating the nutrition store; we only subscribe.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const nutrition = ctx.getStore('nutrition');

  $: nt = ($nutrition as any);
  $: k = nt?.kpis ?? {};
  $: g = nt?.goal ?? null;
  $: m = nt?.todayMacros ?? {};
  $: weeklyCalories = (nt?.weeklyCalories ?? []) as any[];
  $: todayMeals = (nt?.todayMeals ?? []) as any[];
  $: recentBodyStats = (nt?.recentBodyStats ?? []) as any[];

  $: wPct = k.waterGoalMl > 0 ? Math.round(k.waterTodayMl / k.waterGoalMl * 100) : 0;

  // Pre-filter meals by type to avoid arrow-function-with-type-annotation inside template
  $: breakfastMeals = todayMeals.filter((e: any) => e.meal_type === 'breakfast');
  $: lunchMeals = todayMeals.filter((e: any) => e.meal_type === 'lunch');
  $: dinnerMeals = todayMeals.filter((e: any) => e.meal_type === 'dinner');
  $: snackMeals = todayMeals.filter((e: any) => e.meal_type === 'snack');
  $: otherMeals = todayMeals.filter((e: any) => e.meal_type === 'other');
  $: mealSections = [
    { label: 'breakfast', entries: breakfastMeals },
    { label: 'lunch',     entries: lunchMeals },
    { label: 'dinner',    entries: dinnerMeals },
    { label: 'snack',     entries: snackMeals },
    { label: 'other',     entries: otherMeals }
  ] as { label: string; entries: any[] }[];
  $: waterL = Math.round((k.waterTodayMl ?? 0) / 100) / 10;

  $: maxCal = weeklyCalories.length
    ? Math.max(...weeklyCalories.map((d: any) => d.calories || 0), g?.calories || 1) || 1
    : 1;

  interface Macro { label: string; val: number; goal: number; unit: string; col: string }
  $: macros = g ? [
    { label: 'Calories', val: m.calories ?? 0, goal: g.calories ?? 0, unit: 'kcal', col: 'var(--orange)' },
    { label: 'Protein',  val: m.protein_g ?? 0, goal: g.protein_g ?? 0, unit: 'g', col: 'var(--teal)' },
    { label: 'Carbs',    val: m.carbs_g ?? 0, goal: g.carbs_g ?? 0, unit: 'g', col: 'var(--gold)' },
    { label: 'Fat',      val: m.fat_g ?? 0, goal: g.fat_g ?? 0, unit: 'g', col: 'var(--purple)' },
    { label: 'Fiber',    val: m.fiber_g ?? 0, goal: g.fiber_g ?? 0, unit: 'g', col: 'var(--text-2)' }
  ] as Macro[] : [] as Macro[];
</script>

<ViewHeader title="Nutrition" sub="Macros & meals" />

{#if !nt || !nt.available}
  <Panel cls="anim"><Empty message="Nutrition module not available. Use MCP tools to log meals and track macros." /></Panel>
{:else}
  <div class="kpi-row anim">
    <KpiCard label="Calories Today" value={k.caloriestoday ?? 0} sub={g ? '/ ' + g.calories + ' kcal' : 'kcal'} accent="--orange" color="var(--orange)" />
    <KpiCard label="Protein Today" value={(k.proteinToday ?? 0) + 'g'} sub={g ? '/ ' + g.protein_g + 'g goal' : ''} accent="--teal" color="var(--teal)" />
    <KpiCard label="Water" value={waterL + 'L'} sub={wPct + '% of goal'} accent="--blue" color={wPct >= 100 ? 'var(--teal)' : 'var(--blue)'} />
    <KpiCard label="Fast" value={k.activeFast ? 'Active' : 'Inactive'} sub={k.activeFast && nt.activeFast ? nt.activeFast.elapsed_hours + 'h / ' + nt.activeFast.target_hours + 'h' : k.activeFast ? 'in progress' : 'not fasting'} accent="--purple" color={k.activeFast ? 'var(--teal)' : 'var(--text-2)'} />
  </div>

  {#if g && macros.length}
    <Panel title="Macro Progress Today" dotColor="var(--orange)" cls="anim d1">
      {#each macros as mac}
        {#if mac.goal}
          {@const pct = Math.min(100, Math.round(mac.val / mac.goal * 100))}
          <div style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
              <span>{mac.label}</span>
              <span style="color:var(--text-2)">{mac.val} / {mac.goal} {mac.unit} ({pct}%)</span>
            </div>
            <div style="height:8px;border-radius:4px;background:var(--surface-3)">
              <div style="height:100%;border-radius:4px;width:{pct}%;background:{mac.col};transition:width .3s"></div>
            </div>
          </div>
        {/if}
      {/each}
    </Panel>
  {/if}

  {#if weeklyCalories.length}
    <Panel title="Calorie Trend (7 days)" dotColor="var(--orange)" cls="anim d2">
      <div style="display:flex;align-items:flex-end;gap:6px;height:80px;margin-top:12px;position:relative">
        {#if g?.calories}
          {@const goalY = Math.round((1 - g.calories / maxCal) * 80)}
          <div style="position:absolute;left:0;right:0;top:{goalY}px;border-top:1px dashed var(--gold);opacity:0.5"></div>
        {/if}
        {#each weeklyCalories as d}
          {@const barH = Math.max(4, Math.round((d.calories || 0) / maxCal * 80))}
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
            <div style="width:100%;background:var(--orange);border-radius:3px 3px 0 0;height:{barH}px"></div>
            <div style="font-size:9px;color:var(--text-3)">{d.date ? String(d.date).slice(5) : ''}</div>
          </div>
        {/each}
      </div>
    </Panel>
  {/if}

  <Panel title="Today's Meals" dotColor="var(--gold)" cls="anim d3">
    {#each mealSections as section}
      {#if section.entries.length}
        <div style="margin-bottom:12px">
          <div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:capitalize;margin-bottom:4px">{section.label}</div>
          {#each section.entries as e}
            <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--surface-2)">
              <span>{e.food_name ?? ''}</span>
              <span style="color:var(--text-2)">{e.quantity_g ?? 0}g — {Math.round(e.calories ?? 0)} kcal</span>
            </div>
          {/each}
        </div>
      {/if}
    {/each}
    {#if !todayMeals.length}
      <Empty message="No meals logged today." />
    {/if}
  </Panel>

  {#if recentBodyStats.length}
    <Panel title="Body Stats (recent)" dotColor="var(--blue)" cls="anim d4">
      <table class="data-table" style="width:100%;font-size:12px">
        <tr><th>Date</th><th>Weight</th><th>Body Fat</th><th>BMI</th></tr>
        {#each recentBodyStats as s}
          <tr>
            <td style="color:var(--text-2)">{s.date ? String(s.date).slice(0,10) : ''}</td>
            <td>{s.weight_kg != null ? s.weight_kg + ' kg' : '—'}</td>
            <td>{s.body_fat_pct != null ? s.body_fat_pct + '%' : '—'}</td>
            <td>{s.bmi != null ? s.bmi : '—'}</td>
          </tr>
        {/each}
      </table>
    </Panel>
  {/if}
{/if}
