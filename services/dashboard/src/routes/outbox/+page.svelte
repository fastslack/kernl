<!--
  Approvals now live in the Bandeja (/inbox): the same review, next to the questions and the tasks. This keeps the old
  links (the badge, a project's pending approvals, a notification) working: they land on the drafts, with their filters.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    const from = new URL(window.location.href).searchParams;
    const to = new URLSearchParams({ kind: 'approve' });
    for (const k of ['project', 'item', 'channel']) { const v = from.get(k); if (v) to.set(k, v); }
    void goto(`/inbox?${to}`, { replaceState: true });
  });
</script>
