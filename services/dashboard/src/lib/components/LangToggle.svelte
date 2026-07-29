<script lang="ts">
  import { locale, setUserLocale, type Locale } from '$lib/i18n';

  export let variant: 'pill' | 'minimal' = 'pill';

  // Pages can pass their own list; default = the two we curate copy for.
  export let langs: Locale[] = ['es', 'en'];

  function pick(loc: Locale): void {
    if ($locale === loc) return;
    setUserLocale(loc);
  }

  const labels: Record<Locale, string> = {
    es: 'ES',
    en: 'EN',
    nl: 'NL',
    de: 'DE',
    fr: 'FR',
    pt: 'PT',
    ja: 'JA',
    zh: 'ZH',
  };
</script>

<div class="lang-toggle" class:minimal={variant === 'minimal'} role="group" aria-label="Language">
  {#each langs as l}
    <button
      type="button"
      class:active={$locale === l}
      aria-pressed={$locale === l}
      on:click={() => pick(l)}
    >
      {labels[l]}
    </button>
  {/each}
</div>

<style>
  .lang-toggle {
    display: inline-flex;
    gap: 0;
    border: 1px solid var(--border, #2A3038);
    border-radius: 999px;
    overflow: hidden;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .lang-toggle button {
    padding: 4px 10px;
    background: transparent;
    border: 0;
    color: var(--text-3, #6F8A60);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s, color 0.12s;
  }
  .lang-toggle button:hover { color: var(--gold, #FFB74D); }
  .lang-toggle button.active {
    background: var(--gold, #FFB74D);
    color: var(--bg, #07080C);
  }
  .lang-toggle.minimal {
    border: 0;
    gap: 6px;
  }
  .lang-toggle.minimal button {
    padding: 2px 6px;
    border-radius: 3px;
  }
  .lang-toggle.minimal button.active {
    background: transparent;
    color: var(--gold, #FFB74D);
    text-decoration: underline;
    text-underline-offset: 4px;
  }
</style>
