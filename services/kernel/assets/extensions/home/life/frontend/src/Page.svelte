<script lang="ts">
  // /life — migrated from services/dashboard/src/routes/life/+page.svelte
  // (Fase 3). The shell keeps hydrating the life store via the "life" WS
  // channel for this path; we only subscribe.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import BarChart from '$shared/components/BarChart.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { weatherEmoji, aqLabel, uvLabel } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const life = ctx.getStore('life');

  $: l = ($life as any);
  $: weather = l?.weather;
  $: air = l?.airQuality;
  $: sun = l?.sunTimes;
  $: moon = l?.moonPhase;
  // API: currency = { base, date, rates:{str→num}, pairs:[{from,to,rate}] }
  $: currency = l?.currency;
  // API: worldClocks = [{timezone, city, time, offset}]
  $: clocks = (l?.worldClocks ?? []) as any[];
  // API: earthquakes = { quakes:[{magnitude,place,time,url}] }
  $: quakes = (l?.earthquakes?.quakes ?? []) as any[];
  $: holidays = (l?.holidays ?? []) as any[];
  $: quote = l?.quote;
  $: habits = (l?.habits ?? []) as any[];
  // API: waterIntake = { glasses, goal }
  $: waterIntake = l?.waterIntake;
  $: moods = (l?.moodLog ?? []) as any[];

  function timeStr(iso: string) {
    if (!iso) return '?';
    try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  }

  $: aqInfo = air ? aqLabel(air.europeanAqi) : null;
  $: uvInfo = weather?.current ? uvLabel(weather.current.uvIndex) : null;

  $: rainBars = (weather?.hourly ?? []).slice(0, 24).map((h: any) => ({
    label: h.time?.split('T')[1]?.slice(0, 5) ?? '',
    value: h.precipitationProbability,
    color: h.precipitationProbability > 50 ? 'var(--blue)' : 'var(--surface-3)'
  }));

  $: aqBars = air ? [
    { label: 'PM2.5', value: air.pm25, color: 'var(--blue)' },
    { label: 'PM10', value: air.pm10, color: 'var(--teal)' },
    { label: 'Ozone', value: air.ozone, color: 'var(--purple)' },
    { label: 'NO₂', value: air.no2, color: 'var(--orange)' }
  ] : [];

  $: pollenBars = air?.pollen ? [
    { label: 'Grass', value: air.pollen.grass ?? 0, color: 'var(--green)' },
    { label: 'Birch', value: air.pollen.birch ?? 0, color: 'var(--gold)' },
    { label: 'Alder', value: air.pollen.alder ?? 0, color: 'var(--orange)' },
    { label: 'Mugwort', value: air.pollen.mugwort ?? 0, color: 'var(--purple)' }
  ] : [];

  // Use pairs array if available, else fall back to rates object
  $: currencyEntries = currency
    ? (currency.pairs ?? Object.entries(currency.rates ?? {}).map(([to, rate]) => ({ from: currency.base, to, rate }))).map((p: any) => ({
        label: p.to, value: p.rate as number, color: 'var(--gold)'
      }))
    : [];

  const MOOD_EMOJIS = ['','😭','😔','😐','😊','🤩'];
</script>

<ViewHeader title="Life Intelligence" sub="Real-time world data" />

{#if !l}
  <div class="loading-view">Loading life data...</div>
{:else}
  <!-- Weather KPIs -->
  <div class="kpi-row anim">
    {#if weather?.current}
      <KpiCard
        label="{weatherEmoji(weather.current.weatherCode)} {Math.round(weather.current.temperature)}°C"
        value="Feels {Math.round(weather.current.feelsLike)}°"
        accent="--gold"
        color="var(--gold)"
      />
      <KpiCard label="Humidity" value="{weather.current.humidity}%" sub="{weather.current.windSpeed} km/h wind" accent="--blue" color="var(--blue)" />
    {/if}
    {#if air && aqInfo}
      <KpiCard label="AQI {air.europeanAqi}" value={aqInfo.t} sub="PM2.5: {air.pm25}" accent="--teal" color={aqInfo.c} />
    {/if}
    {#if weather?.current && uvInfo}
      <KpiCard label="UV {weather.current.uvIndex}" value={uvInfo.t} accent="--orange" color={uvInfo.c} />
    {/if}
    {#if moon}
      <KpiCard label="{moon.emoji} {moon.illumination}%" value={moon.phase} sub="Day {moon.age}" accent="--purple" color="var(--purple)" />
    {/if}
    {#if moods.length}
      <KpiCard label="{MOOD_EMOJIS[moods[0].value] ?? '😐'} Mood" value={moods[0].date} accent="--green" color="var(--green)" />
    {/if}
  </div>

  <!-- Rain + Forecast -->
  <div class="grid-2 anim d1">
    {#if rainBars.length}
      <Panel title="Rain Next 24h" dotColor="var(--blue)">
        <div style="display:flex;align-items:flex-end;gap:2px;height:80px">
          {#each rainBars as bar}
            <div style="flex:1;height:{Math.max(2, bar.value)}%;background:{bar.color};border-radius:2px 2px 0 0;min-width:4px" title="{bar.label}: {bar.value}%"></div>
          {/each}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:4px">
          <span>Now</span><span>+12h</span><span>+24h</span>
        </div>
      </Panel>
    {/if}

    {#if weather?.daily}
      <Panel title="7-Day Forecast" dotColor="var(--gold)">
        {#each weather.daily as d}
          <div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0">
            <span style="width:36px;color:var(--text-2);font-weight:500">{new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', {weekday:'short'})}</span>
            <span style="width:24px;text-align:center">{weatherEmoji(d.weatherCode)}</span>
            <span style="width:70px;font-family:var(--font-mono);font-size:12px">{Math.round(d.tempMin)}°/{Math.round(d.tempMax)}°</span>
            <span style="width:36px;text-align:right;font-size:11px;color:{d.precipitationProbabilityMax > 40 ? 'var(--blue)' : 'var(--text-3)'}">{d.precipitationProbabilityMax}%</span>
            <span style="font-size:11px;color:{uvLabel(d.uvIndexMax).c};margin-left:auto">UV {d.uvIndexMax}</span>
          </div>
        {/each}
      </Panel>
    {/if}
  </div>

  <!-- Sun & Moon + AQI -->
  <div class="grid-2 anim d2">
    {#if sun}
      <Panel title="Sun & Golden Hour" dotColor="var(--gold)">
        <div class="cov-grid" style="margin-bottom:12px">
          <div class="cov-item"><div class="cov-val" style="color:var(--gold)">🌅 {timeStr(sun.sunrise)}</div><div class="cov-label">Sunrise</div></div>
          <div class="cov-item"><div class="cov-val" style="color:var(--orange)">🌇 {timeStr(sun.sunset)}</div><div class="cov-label">Sunset</div></div>
          <div class="cov-item"><div class="cov-val" style="color:var(--blue)">{sun.dayLength?.toFixed(1)}h</div><div class="cov-label">Daylight</div></div>
        </div>
        {#if sun.goldenHourMorning}
          <div style="font-size:12px;color:var(--text-2)">
            <div>📷 Morning: {timeStr(sun.goldenHourMorning.start)} - {timeStr(sun.goldenHourMorning.end)}</div>
            <div>📷 Evening: {timeStr(sun.goldenHourEvening.start)} - {timeStr(sun.goldenHourEvening.end)}</div>
            {#if sun.dayLengthTrend !== 0}
              <div style="color:{sun.dayLengthTrend > 0 ? 'var(--green)' : 'var(--red)'}">{sun.dayLengthTrend > 0 ? '+' : ''}{sun.dayLengthTrend} min vs yesterday</div>
            {/if}
          </div>
        {/if}
      </Panel>
    {/if}

    {#if aqBars.length}
      <Panel title="Air Quality & Pollen" dotColor="var(--teal)">
        <BarChart entries={aqBars} />
        {#if pollenBars.length}
          <div class="section-label" style="margin-top:14px">Pollen</div>
          <BarChart entries={pollenBars} />
        {/if}
      </Panel>
    {/if}
  </div>

  <!-- Currencies + World Clocks -->
  <div class="grid-2 anim d3">
    {#if currencyEntries.length}
      <Panel title="Exchange Rates (EUR base)" dotColor="var(--gold)">
        {#each currencyEntries as c}
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:13px">
            <span style="color:var(--text-2)">EUR → {c.label}</span>
            <span style="font-family:var(--font-mono);color:var(--gold)">{typeof c.value === 'number' ? c.value.toFixed(4) : c.value}</span>
          </div>
        {/each}
      </Panel>
    {/if}

    {#if clocks.length}
      <Panel title="World Clocks" dotColor="var(--teal)">
        {#each clocks as ck}
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:13px">
            <span style="color:var(--text-2)">{ck.city ?? ck.timezone}</span>
            <span style="font-family:var(--font-mono);color:var(--teal)">{ck.time}</span>
          </div>
        {/each}
      </Panel>
    {/if}
  </div>

  <!-- Earthquakes + Holidays -->
  <div class="grid-2 anim d4">
    {#if quakes.length}
      <Panel title="Earthquakes (24h M2.5+)" dotColor="var(--red)">
        {#each quakes.slice(0, 5) as q}
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">
            <span style="color:var(--text-2)">{q.place}</span>
            <span style="color:var(--red);font-family:var(--font-mono)">M{q.magnitude}</span>
          </div>
        {/each}
      </Panel>
    {/if}

    {#if holidays.length}
      <Panel title="Upcoming Holidays" dotColor="var(--teal)">
        {#each holidays.slice(0, 5) as h}
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">
            <span>{h.name}</span>
            <span style="color:var(--teal);font-family:var(--font-mono)">{h.date} {h.daysUntil != null ? '(' + h.daysUntil + 'd)' : ''}</span>
          </div>
        {/each}
      </Panel>
    {/if}
  </div>

  <!-- Quote + Habits + Water -->
  {#if quote}
    <Panel cls="anim d5" style="border-left:3px solid var(--purple)">
      <div style="font-size:14px;font-style:italic;color:var(--text-1);margin-bottom:6px">"{quote.text}"</div>
      {#if quote.author}<div style="font-size:12px;color:var(--text-3)">— {quote.author}</div>{/if}
    </Panel>
  {/if}

  {#if habits.length}
    <Panel title="Habits" dotColor="var(--green)" cls="anim d5">
      {#each habits as h}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:13px;font-weight:500">{h.value}</div>
            <div style="font-size:11px;color:var(--text-3)">Streak: {h.streak ?? 0} days</div>
          </div>
          <span style="font-size:18px">{h.streak >= 7 ? '🔥' : '⬜'}</span>
        </div>
      {/each}
    </Panel>
  {/if}

  {#if waterIntake}
    <Panel title="Water Intake" dotColor="var(--blue)" cls="anim d5">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:24px;font-family:var(--font-display);font-weight:700;color:var(--blue)">{waterIntake.glasses}</div>
        <div style="flex:1">
          <div style="font-size:12px;color:var(--text-3);margin-bottom:4px">of {waterIntake.goal} glasses</div>
          <div style="height:8px;background:var(--surface-3);border-radius:4px;overflow:hidden">
            <div style="height:100%;background:var(--blue);border-radius:4px;width:{Math.min(100, Math.round((waterIntake.glasses ?? 0) / (waterIntake.goal || 1) * 100))}%"></div>
          </div>
        </div>
        <div style="font-size:20px">{(waterIntake.glasses ?? 0) >= (waterIntake.goal ?? 8) ? '✅' : '💧'}</div>
      </div>
    </Panel>
  {/if}
{/if}
