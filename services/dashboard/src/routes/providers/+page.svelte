<script lang="ts">
  /** Legacy /providers page — superseded by the unified AI section in Settings. */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { t } from '$lib/i18n/index.js';

  onMount(() => {
    goto('/settings?section=ai', { replaceState: true });
  });
</script>

<div class="redir">
  <p>{$t('settings.redirect')}</p>
  <a href="/settings?section=ai">{$t('settings.redirect_link')}</a>
</div>

<style>
  .redir {
    padding: 48px 24px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
    color: var(--text-2); font-size: 13px;
  }
  .redir a { color: var(--teal); font-weight: 600; text-decoration: none; }
  .redir a:hover { text-decoration: underline; }
</style>
