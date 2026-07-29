<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import ExtensionGate from '$lib/components/ExtensionGate.svelte';
	import {
		extPages,
		extPagesReady,
		loadExtPageModule,
		buildExtPageContext,
		type ExtPageInfo
	} from '$lib/ext-host.js';

	let container: HTMLDivElement | null = null;
	let handle: { destroy(): void } | null = null;
	let mountedView = '';
	let loading = false;
	let loadErr = '';

	// First URL segment decides which extension page owns this route.
	$: segment = ($page.params.ext ?? '').split('/')[0] ?? '';
	$: info = $extPages.find((p) => p.view === segment);

	// Same-view sub-route changes (e.g. /cinema → /cinema/directories) do NOT
	// remount the page; broadcast them on the kernl: event bus so mounted
	// pages can react (see ExtPageContext.events).
	$: if (typeof window !== 'undefined' && $page.url.pathname) {
		window.dispatchEvent(
			new CustomEvent('kernl:navigate', { detail: { path: $page.url.pathname } })
		);
	}

	// (Re)mount whenever the target view or the container changes.
	$: if (container && info && info.view !== mountedView) {
		mountPage(info);
	}

	// The bound extension disappeared (disabled / uninstalled) → tear down.
	$: if (!info && mountedView) {
		teardown();
	}

	async function mountPage(target: ExtPageInfo) {
		teardown();
		mountedView = target.view;
		loading = true;
		loadErr = '';
		try {
			const mod = await loadExtPageModule(target);
			// Navigation may have moved on while the bundle was downloading.
			if (mountedView !== target.view || !container) return;
			container.innerHTML = '';
			handle = mod.mount(container, buildExtPageContext(target));
		} catch (err) {
			if (mountedView === target.view) {
				loadErr = err instanceof Error ? err.message : String(err);
			}
		} finally {
			if (mountedView === target.view) loading = false;
		}
	}

	function teardown() {
		try {
			handle?.destroy();
		} catch {
			/* extension destroy failed — container is cleared below anyway */
		}
		handle = null;
		mountedView = '';
		if (container) container.innerHTML = '';
	}

	onDestroy(teardown);
</script>

{#if info}
	<div class="ext-page-host" bind:this={container}></div>
	{#if loading}
		<div class="ext-page-state">▮ loading extension…</div>
	{:else if loadErr}
		<div class="ext-page-state ext-page-err">⚠ Failed to load extension page: {loadErr}</div>
	{/if}
{:else if $extPagesReady}
	<!-- Known URL shape but no active extension page bound to this view. -->
	<ExtensionGate />
{:else}
	<div class="ext-page-state">▮ loading…</div>
{/if}

<style>
	.ext-page-host {
		height: 100%;
		min-height: 0;
	}
	.ext-page-state {
		padding: 60px 20px;
		text-align: center;
		color: var(--text-2);
		font-size: 14px;
	}
	.ext-page-err {
		color: var(--red);
	}
</style>
