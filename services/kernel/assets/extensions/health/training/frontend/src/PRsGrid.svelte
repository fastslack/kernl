<script lang="ts">
  export let prs: any[] = [];
</script>

<div class="anim">
  {#if prs.length}
    <div class="pr-grid">
      {#each prs as pr, i}
        <div class="pr-card" style="animation-delay:{i * 50}ms">
          <div class="pr-card-type">{pr.pr_type}</div>
          <div class="pr-card-exercise">{pr.exercise_name}</div>
          <div class="pr-card-value">{pr.value}<span class="pr-card-unit">{pr.unit}</span></div>
          <div class="pr-card-date">{pr.date ? String(pr.date).slice(0,10) : ''}</div>
          <div class="pr-card-glow"></div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="trn-empty">
      <div class="trn-empty-icon">🏆</div>
      <div class="trn-empty-title">No records yet</div>
      <div class="trn-empty-sub">Log workouts and sets to track your personal records</div>
    </div>
  {/if}
</div>

<style>
  /* ── PR Grid ───────────────────────────────────────── */
  .pr-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
  }
  .pr-card {
    position: relative;
    background: var(--surface-1);
    border: 1px solid rgba(212,168,75,0.2);
    border-radius: 10px;
    padding: 16px;
    overflow: hidden;
    animation: fadeSlideIn 0.3s ease both;
    transition: border-color 0.2s, transform 0.15s;
  }
  .pr-card:hover { border-color: rgba(212,168,75,0.5); transform: translateY(-2px); }
  .pr-card-type {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--gold);
    opacity: 0.8;
  }
  .pr-card-exercise { font-size: 14px; font-weight: 600; margin-top: 4px; }
  .pr-card-value {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 800;
    color: var(--gold);
    margin-top: 8px;
    line-height: 1;
  }
  .pr-card-unit { font-size: 14px; opacity: 0.6; margin-left: 2px; }
  .pr-card-date { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); margin-top: 6px; }
  .pr-card-glow {
    position: absolute;
    bottom: -20px; right: -20px;
    width: 60px; height: 60px;
    background: radial-gradient(circle, rgba(212,168,75,0.12) 0%, transparent 70%);
    pointer-events: none;
  }

  /* ── Empty State ───────────────────────────────────── */
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

  /* ── Animation ─────────────────────────────────────── */
  .anim { animation: fadeSlideIn 0.25s ease both; }
  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
