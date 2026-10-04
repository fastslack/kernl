<script lang="ts">
  // The license lives in Settings → License (LicensePanel), the first item of
  // the settings rail. This route stays so the links that point here — the
  // store's "requires a licence" cards, the purchase email, old bookmarks —
  // land on it instead of a 404.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    void goto('/settings?section=license', { replaceState: true });
  });
</script>
