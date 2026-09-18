<script lang="ts">
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.js';

	export let title: string;
	export let description: string;
	export let href = '/extensions';
</script>

<div class="k-locked">
	<div class="k-locked-ic"><Icon name="lock" /></div>
	<div class="k-locked-txt">
		<strong>{title}</strong>
		<p>{description}</p>
		<a class="k-btn" {href}>{$t('office.locked.store')}</a>
	</div>
</div>

<style>
	.k-locked { display: grid; grid-template-columns: 32px 1fr; gap: 12px; align-items: start; padding: 12px; border: 1px dashed var(--border-h); border-radius: var(--radius); }
	.k-locked-ic { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; background: var(--surface-3); color: var(--text-2); }
	.k-locked-txt strong { font-size: 13px; color: var(--text-1); }
	.k-locked-txt p { margin: 2px 0 8px; font-size: 12.5px; color: var(--text-2); }
</style>
