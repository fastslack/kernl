<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;
  export let recentCardio: any[] = [];

  const dispatch = createEventDispatcher();

  // ── Sport Icons ──────────────────────────────────────
  const SPORT_ICONS: Record<string, string> = {
    strength: '🏋️', running: '🏃', cycling: '🚴', swimming: '🏊',
    rowing: '🚣', hiking: '🥾', yoga: '🧘', boxing: '🥊',
    football: '⚽', basketball: '🏀', tennis: '🎾', default: '💪',
  };
  function sportIcon(s: string) { return SPORT_ICONS[s] || SPORT_ICONS.default; }

  // ── Cardio Form State ────────────────────────────────
  let cardioSport = 'running';
  let cardioDuration: number | null = null;
  let cardioDistance: number | null = null;
  let cardioHr: number | null = null;
  let cardioMaxHr: number | null = null;
  let cardioCals: number | null = null;
  let cardioElev: number | null = null;
  let cardioSaving = false;
  let cardioSaved = false;

  // ── Helpers ──────────────────────────────────────────
  function fmtPace(distM: number, mins: number): string {
    if (!distM || distM <= 0) return '—';
    const paceMinKm = mins / (distM / 1000);
    const pm = Math.floor(paceMinKm);
    const ps = Math.round((paceMinKm - pm) * 60);
    return `${pm}:${String(ps).padStart(2, '0')}/km`;
  }

  // ── API helper ───────────────────────────────────────
  async function api(path: string, opts?: RequestInit): Promise<any> {
    const action = path.replace(/^\/api\//, '').replace(/\//g, '.').replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    const body = opts?.body ? JSON.parse(opts.body as string) : {};
    try {
      return await ctx.rpc(action, body, async () => {
        const res = await ctx.fetchRaw(path, {
          headers: { 'Content-Type': 'application/json' },
          ...opts,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          console.error(err.error || `Request failed: ${res.status}`);
          return { _error: true };
        }
        return await res.json();
      });
    } catch (e) {
      console.error(e instanceof Error ? e.message : 'Network error');
      return { _error: true };
    }
  }

  // ── Log Cardio ───────────────────────────────────────
  async function logCardio() {
    if (!cardioSport || !cardioDuration) return;
    cardioSaving = true;
    const data = await api('/api/training/log-cardio', {
      method: 'POST',
      body: JSON.stringify({
        sport: cardioSport,
        duration_minutes: cardioDuration,
        distance_m: cardioDistance,
        avg_hr: cardioHr,
        max_hr: cardioMaxHr,
        calories: cardioCals,
        elevation_m: cardioElev,
      }),
    });
    cardioSaving = false;
    if (data._error) return;
    if (data.id) {
      cardioSaved = true;
      setTimeout(() => { cardioSaved = false; }, 2000);
      cardioDuration = null;
      cardioDistance = null;
      cardioHr = null;
      cardioMaxHr = null;
      cardioCals = null;
      cardioElev = null;
      dispatch('logged');
    }
  }
</script>

<div class="anim">
  <div class="trn-grid">
    <!-- Log Form -->
    <div class="trn-panel">
      <div class="trn-panel-head">Log Cardio Session</div>
      <div class="cardio-form">
        <div class="cf-row">
          <label class="cf-label">Sport</label>
          <select class="cf-input" bind:value={cardioSport}>
            <option value="running">🏃 Running</option>
            <option value="cycling">🚴 Cycling</option>
            <option value="swimming">🏊 Swimming</option>
            <option value="rowing">🚣 Rowing</option>
            <option value="hiking">🥾 Hiking</option>
            <option value="walking">🚶 Walking</option>
            <option value="elliptical">⭕ Elliptical</option>
            <option value="jump_rope">🪢 Jump Rope</option>
          </select>
        </div>
        <div class="cf-row-2">
          <div class="cf-col">
            <label class="cf-label">Duration (min)*</label>
            <input class="cf-input" type="number" placeholder="30" bind:value={cardioDuration} />
          </div>
          <div class="cf-col">
            <label class="cf-label">Distance (m)</label>
            <input class="cf-input" type="number" placeholder="5000" bind:value={cardioDistance} />
          </div>
        </div>
        <div class="cf-row-2">
          <div class="cf-col">
            <label class="cf-label">Avg HR (bpm)</label>
            <input class="cf-input" type="number" placeholder="145" bind:value={cardioHr} />
          </div>
          <div class="cf-col">
            <label class="cf-label">Max HR (bpm)</label>
            <input class="cf-input" type="number" placeholder="175" bind:value={cardioMaxHr} />
          </div>
        </div>
        <div class="cf-row-2">
          <div class="cf-col">
            <label class="cf-label">Calories</label>
            <input class="cf-input" type="number" placeholder="350" bind:value={cardioCals} />
          </div>
          <div class="cf-col">
            <label class="cf-label">Elevation (m)</label>
            <input class="cf-input" type="number" placeholder="120" bind:value={cardioElev} />
          </div>
        </div>
        <button type="button" class="cf-save-btn" on:click={logCardio} disabled={!cardioDuration || cardioSaving}>
          {#if cardioSaving}Saving...{:else if cardioSaved}Saved!{:else}Log Session{/if}
        </button>
      </div>
    </div>

    <!-- Recent Cardio -->
    <div class="trn-panel">
      <div class="trn-panel-head">History</div>
      {#if recentCardio.length}
        <div class="cardio-history">
          {#each recentCardio as c}
            <div class="cardio-card">
              <div class="cardio-card-top">
                <span class="cardio-sport">{sportIcon(c.sport)} {c.sport}</span>
                <span class="cardio-date">{c.date ? String(c.date).slice(5,10) : ''}</span>
              </div>
              <div class="cardio-stats">
                <div class="cardio-stat">
                  <span class="cs-val">{c.duration_minutes}m</span>
                  <span class="cs-lbl">Time</span>
                </div>
                {#if c.distance_m}
                  <div class="cardio-stat">
                    <span class="cs-val">{(c.distance_m / 1000).toFixed(1)}km</span>
                    <span class="cs-lbl">Dist</span>
                  </div>
                  <div class="cardio-stat">
                    <span class="cs-val">{fmtPace(c.distance_m, c.duration_minutes)}</span>
                    <span class="cs-lbl">Pace</span>
                  </div>
                {/if}
                {#if c.avg_hr}
                  <div class="cardio-stat">
                    <span class="cs-val" style="color:var(--red)">{c.avg_hr}</span>
                    <span class="cs-lbl">HR</span>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="trn-empty-sm">No cardio sessions yet</div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* ── Panel (shared) ──────────────────────────────────── */
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
  .trn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .trn-empty-sm { font-size: 12px; color: var(--text-3); font-style: italic; padding: 16px 0; text-align: center; }

  /* ── Cardio Form ───────────────────────────────────── */
  .cardio-form { display: flex; flex-direction: column; gap: 10px; }
  .cf-row { display: flex; flex-direction: column; gap: 4px; }
  .cf-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .cf-col { display: flex; flex-direction: column; gap: 4px; }
  .cf-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-3); }
  .cf-input {
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
  .cf-input:focus { border-color: var(--gold); }
  .cf-save-btn {
    background: var(--teal);
    border: none;
    border-radius: 8px;
    color: var(--bg);
    font-size: 13px;
    font-weight: 700;
    font-family: var(--font-body);
    padding: 10px;
    cursor: pointer;
    margin-top: 4px;
    transition: opacity 0.15s;
  }
  .cf-save-btn:hover { opacity: 0.85; }
  .cf-save-btn:disabled { opacity: 0.5; cursor: default; }

  /* ── Cardio History ────────────────────────────────── */
  .cardio-history { display: flex; flex-direction: column; gap: 8px; }
  .cardio-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .cardio-card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .cardio-sport { font-size: 12px; font-weight: 600; text-transform: capitalize; }
  .cardio-date { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
  .cardio-stats { display: flex; gap: 16px; }
  .cardio-stat { display: flex; flex-direction: column; align-items: center; }
  .cs-val { font-family: var(--font-mono); font-size: 13px; font-weight: 700; }
  .cs-lbl { font-size: 9px; color: var(--text-3); text-transform: uppercase; }

  /* ── Animation ─────────────────────────────────────── */
  .anim { animation: fadeSlideIn 0.25s ease both; }
  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ── Responsive ────────────────────────────────────── */
  @media (max-width: 700px) {
    .trn-grid { grid-template-columns: 1fr; }
  }
</style>
