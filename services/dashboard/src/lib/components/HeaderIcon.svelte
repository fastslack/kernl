<script lang="ts" context="module">
  /** A header badge never grows past three characters: 4414 unread reads as "99+". */
  export function badgeText(n: number): string {
    return n > 99 ? '99+' : String(n);
  }
</script>

<script lang="ts">
  /*
    The header's status icons, drawn as one stroke family (currentColor, so they
    follow the theme) instead of emoji that each platform paints its own way.
  */
  export let name: 'tasks' | 'mail' | 'outbox' | 'bell';
  export let size = 17;
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  {#if name === 'tasks'}
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <path d="M8 12.2l2.8 2.8L16.2 9.3" />
  {:else if name === 'mail'}
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M3.8 6.5l8.2 6.2 8.2-6.2" />
  {:else if name === 'outbox'}
    <path d="M12 14.5V3.8" />
    <path d="M7.8 8l4.2-4.2L16.2 8" />
    <path d="M4 13.5v4.2A2.3 2.3 0 0 0 6.3 20h11.4a2.3 2.3 0 0 0 2.3-2.3v-4.2" />
  {:else if name === 'bell'}
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  {/if}
</svg>
