<!--
  /skills is retired.

  Skills are extensions (`installed_extensions.type = 'skill'`) and are now
  managed in /extensions → Skills, alongside the agents that carry them.
  This route stays as a redirect only: it is bookmarked, linked from older
  release notes, and `CORE_ROUTES` still allows it — deleting the directory
  outright would 404 those instead of landing people where the feature went.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	const TARGET = '/extensions?tab=skills';

	onMount(() => {
		void goto(TARGET, { replaceState: true });
	});
</script>

<svelte:head>
	<title>Skills → Extensions</title>
</svelte:head>

<div class="moved">
	<div class="moved-mark" aria-hidden="true">✦</div>
	<h1>Skills moved to Extensions</h1>
	<p>Taking you to <a href={TARGET}>Extensions → Skills</a>…</p>
</div>

<style>
	.moved {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 50vh;
		text-align: center;
	}
	.moved-mark {
		font-size: 28px;
		color: var(--skill);
		text-shadow: 0 0 22px color-mix(in srgb, var(--skill) 45%, transparent);
	}
	h1 {
		margin: 6px 0 0;
		font-family: var(--font-display, inherit);
		font-size: 17px;
		color: var(--text-1);
	}
	p {
		margin: 0;
		font-size: 13px;
		color: var(--text-2);
	}
	a { color: var(--gold); }
</style>
