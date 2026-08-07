<script lang="ts">
  // Backward-compatible: `message` alone renders the original compact line.
  // Provide `icon` / `title` / `hint` (and optionally `cta` + `href`) to get
  // the richer, friendlier first-run empty state.
  export let message: string = 'No data available';
  export let icon: string = '';
  export let title: string = '';
  export let hint: string = '';
  export let cta: string = '';
  export let href: string = '';
</script>

{#if icon || title || hint}
  <div class="empty-state anim">
    {#if icon}<div class="empty-icon" aria-hidden="true">{icon}</div>{/if}
    {#if title}<div class="empty-title">{title}</div>{/if}
    {#if hint}<div class="empty-hint">{hint}</div>{/if}
    {#if cta && href}
      <a class="empty-cta" {href}>{cta}</a>
    {:else if cta}
      <button type="button" class="empty-cta" on:click>{cta}</button>
    {/if}
  </div>
{:else}
  <div class="empty">{message}</div>
{/if}

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 6px;
    padding: 40px 24px;
    min-height: 180px;
  }
  .empty-icon {
    font-size: 40px;
    line-height: 1;
    margin-bottom: 6px;
    filter: saturate(0.85);
    opacity: 0.9;
  }
  .empty-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 16px;
    color: var(--text-1);
    letter-spacing: -0.2px;
  }
  .empty-hint {
    font-size: 13px;
    color: var(--text-3);
    max-width: 340px;
    line-height: 1.5;
  }
  .empty-cta {
    margin-top: 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    transition: border-color 0.15s ease, background 0.15s ease, transform 0.1s ease;
  }
  .empty-cta:hover {
    border-color: var(--gold);
    background: var(--surface-3);
    transform: translateY(-1px);
  }
  .empty-cta:focus-visible {
    outline: 2px solid var(--gold);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .empty-cta {
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .empty-cta:hover {
      transform: none;
    }
  }
</style>
