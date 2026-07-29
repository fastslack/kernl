<script lang="ts">
  import { goto } from '$app/navigation';

  export let label: string;
  export let icon: string; // SVG path d attribute
  export let variant: 'primary' | 'purple' | 'blue' | 'orange' | 'teal' | 'green' = 'primary';
  export let href: string = '';
  export let onClick: (() => void) | null = null;

  function handleClick() {
    if (onClick) {
      onClick();
    } else if (href) {
      goto(href);
    }
  }
</script>

<button class="quick-action qa-{variant}" on:click={handleClick}>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
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
    transition: all 0.2s;
    min-width: 100px;
  }
  .quick-action:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
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
