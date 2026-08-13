<script lang="ts">
  // Copy of $lib/components/OverviewCard.svelte adapted for extension pages:
  // no $app/navigation — pass ctx.navigate via the `navigate` prop.
  export let title: string;
  export let icon: string; // SVG path d attribute
  export let iconColor: string = 'var(--gold)';
  export let actions: { label: string; href: string }[] = [];
  export let navigate: (path: string) => void = (p) => { window.location.href = p; };
</script>

<div class="overview-card">
  <div class="overview-card-header">
    <div class="overview-card-title">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: {iconColor}" aria-hidden="true">
        <path d={icon} />
      </svg>
      <span>{title}</span>
    </div>
  </div>
  <div class="overview-card-content">
    <slot />
  </div>
  {#if actions.length > 0}
    <div class="overview-card-actions">
      {#each actions as action}
        <button type="button" class="overview-card-btn" on:click={() => navigate(action.href)}>{action.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .overview-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .overview-card-header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .overview-card-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
  }
  .overview-card-title svg {
    width: 18px;
    height: 18px;
  }
  .overview-card-content {
    padding: 14px 16px;
    min-height: 80px;
  }
  .overview-card-actions {
    display: flex;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-1);
  }
  .overview-card-btn {
    flex: 1;
    padding: 8px 12px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-2);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    min-height: 32px;
    touch-action: manipulation;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
  }
  .overview-card-btn:hover {
    background: var(--bg-2);
    border-color: var(--text-3);
    color: var(--text-1);
  }
  .overview-card-btn:focus-visible {
    outline: 2px solid var(--gold);
    outline-offset: 2px;
  }
</style>
