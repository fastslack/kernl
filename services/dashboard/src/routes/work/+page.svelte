<!-- The old Work overview: its tasks, reminders and approvals now live in the Bandeja. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  onMount(() => { void goto('/inbox', { replaceState: true }); });
</script>
