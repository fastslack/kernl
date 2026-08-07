<script lang="ts">
  // Copy of $lib/components/QuickAction.svelte adapted for extension pages:
  // no $app/navigation — pass ctx.navigate via the `navigate` prop.
  export let label: string;
  export let icon: string; // SVG path d attribute
  export let variant: 'primary' | 'purple' | 'blue' | 'orange' | 'teal' | 'green' = 'primary';
  export let href: string = '';
  export let onClick: (() => void) | null = null;
  export let navigate: (path: string) => void = (p) => { window.location.href = p; };

  function handleClick() {
    if (onClick) {
      onClick();
    } else if (href) {
      navigate(href);
    }
  }
</script>

<button type="button" class="quick-action qa-{variant}" on:click={handleClick}>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={icon} />
  </svg>
  <span>{label}</span>
</button>

<style>
  .quick-action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 16px 20px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    cursor: pointer;
    /* Explicit property list: `transition: all` also animates border-color on
       every variant swap and fights the focus ring. */
    transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
    min-width: 100px;
    touch-action: manipulation;
  }
  .quick-action:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }
  .quick-action:focus-visible {
    outline: 2px solid var(--gold);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .quick-action {
      transition: box-shadow 0.2s ease, border-color 0.2s ease;
    }
    .quick-action:hover {
      transform: none;
    }
  }
  .quick-action svg {
    width: 24px;
    height: 24px;
  }
  .quick-action span {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-2);
  }
  .qa-primary { border-color: var(--blue); }
  .qa-primary svg { color: var(--blue); }
  .qa-purple { border-color: var(--purple); }
  .qa-purple svg { color: var(--purple); }
  .qa-blue { border-color: var(--blue); }
  .qa-blue svg { color: var(--blue); }
  .qa-orange { border-color: var(--orange); }
  .qa-orange svg { color: var(--orange); }
  .qa-teal { border-color: var(--teal); }
  .qa-teal svg { color: var(--teal); }
  .qa-green { border-color: var(--green); }
  .qa-green svg { color: var(--green); }
</style>
