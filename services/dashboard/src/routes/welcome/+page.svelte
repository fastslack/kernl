<script lang="ts">
  /**
   * Legacy onboarding page — superseded by the 3-step wizard at /setup.
   * Kept only as a client-side redirect so old bookmarks and the layout's
   * legacy `kernl.welcomeSeen` flow keep working.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    goto('/setup', { replaceState: true });
  });
</script>

<svelte:head>
  <title>Kernl</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="redirect">
  <p>
    <a href="/setup">/setup →</a>
  </p>
</div>

<style>
  .redirect {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(ellipse at top, #161a30 0%, #0d1020 50%, #07080c 100%);
    color: #b8bdd1;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 14px;
  }
  .redirect a {
    color: #818cf8;
    text-decoration: none;
  }
  .redirect a:hover {
    text-decoration: underline;
  }
</style>
