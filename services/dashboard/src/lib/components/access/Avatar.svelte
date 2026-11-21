<script lang="ts">
  /** A user's initials on their own colour; `crown` marks the super admin. */
  import { initials, toneOf } from './types.js';

  export let name = '';
  export let seed = '';
  export let size: 'sm' | 'md' | 'lg' = 'md';
  export let crown = false;
  export let muted = false;
</script>

<span class="av {size} tone-{crown ? 'gold' : toneOf(seed || name)}" class:muted aria-hidden="true">
  {#if crown}♛{:else}{initials(name)}{/if}
</span>

<style>
  .av {
    display: inline-grid; place-items: center; flex-shrink: 0; border-radius: 50%;
    font: 700 11px var(--font-display); letter-spacing: 0.3px;
    border: 1px solid; position: relative;
  }
  .sm { width: 26px; height: 26px; font-size: 10px; }
  .md { width: 34px; height: 34px; font-size: 12px; }
  .lg { width: 52px; height: 52px; font-size: 18px; border-width: 1.5px; }
  .muted { filter: grayscale(0.9); opacity: 0.55; }
  .tone-teal   { color: var(--teal);   background: color-mix(in srgb, var(--teal) 14%, transparent);   border-color: color-mix(in srgb, var(--teal) 40%, transparent); }
  .tone-purple { color: var(--purple); background: color-mix(in srgb, var(--purple) 14%, transparent); border-color: color-mix(in srgb, var(--purple) 40%, transparent); }
  .tone-blue   { color: var(--blue);   background: color-mix(in srgb, var(--blue) 14%, transparent);   border-color: color-mix(in srgb, var(--blue) 40%, transparent); }
  .tone-gold   { color: var(--gold);   background: color-mix(in srgb, var(--gold) 14%, transparent);   border-color: color-mix(in srgb, var(--gold) 40%, transparent); }
  .tone-green  { color: var(--green);  background: color-mix(in srgb, var(--green) 14%, transparent);  border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .tone-red    { color: var(--red);    background: color-mix(in srgb, var(--red) 14%, transparent);    border-color: color-mix(in srgb, var(--red) 40%, transparent); }
</style>
