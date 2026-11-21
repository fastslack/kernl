<script lang="ts">
  /**
   * Who is signed in, for a user's session: their name and a way out.
   * The super admin (the kernel token) gets nothing here; that dashboard
   * looks as it always did.
   */
  import { session, isUserSession } from '$lib/session.js';
  import { clearAuthToken } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';

  function signOut() {
    clearAuthToken();
    window.location.href = '/login';
  }
</script>

{#if isUserSession($session)}
  <div class="user-chip" title={$session?.email || $session?.name}>
    <span class="user-chip-name">{$session?.name}</span>
    <button class="user-chip-out" on:click={signOut}>{$t('access.sign_out')}</button>
  </div>
{/if}

<style>
  .user-chip {
    display: flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px;
    border: 1px solid var(--border); border-radius: 999px; background: var(--surface-1);
    font-size: 11px; color: var(--text-2); max-width: 220px;
  }
  .user-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .user-chip-out {
    border: none; background: var(--surface-2); color: var(--text-2); border-radius: 999px;
    padding: 3px 8px; font: inherit; font-size: 10px; cursor: pointer;
  }
  .user-chip-out:hover { background: var(--surface-3); color: var(--text-1); }
</style>
