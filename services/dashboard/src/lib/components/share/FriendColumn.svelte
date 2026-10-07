<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { t } from '$lib/i18n';
	import type { ShareFriend } from '$lib/share-api';
	export let friends: ShareFriend[] = [];
	export let selected = '';
	const dispatch = createEventDispatcher<{ select: string }>();

	function reach(f: ShareFriend): 'lan' | 'direct' | 'onion' | 'offline' {
		if (f.last_error || !f.last_reach) return 'offline';
		if (f.last_reach.includes('.onion')) return 'onion';
		if (f.last_reach.includes('.local') || /^https?:\/\/(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(f.last_reach)) return 'lan';
		return 'direct';
	}
</script>

<aside class="col">
	<div class="col-title">{$t('share.friends')}</div>
	{#if friends.length === 0}
		<p class="empty">{$t('share.friends_empty')}</p>
		<a class="add" href="/friends">{$t('share.friends_add')}</a>
	{:else}
		<ul>
			{#each friends as f (f.npub)}
				{@const r = reach(f)}
				<li>
					<button class="friend" class:on={selected === f.npub} on:click={() => dispatch('select', f.npub)}>
						<span class="dot {r}" aria-hidden="true"></span>
						<span class="name">{f.petname || f.npub.slice(0, 14) + '…'}</span>
						<span class="reach">{$t(`share.reach.${r}`)}</span>
					</button>
				</li>
			{/each}
		</ul>
		<a class="add" href="/friends">{$t('share.friends_add')}</a>
	{/if}
</aside>

<style>
	.col { width: 260px; flex-shrink: 0; border-right: 1px solid var(--border); padding: 14px 12px; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }
	.col-title { font-size: 11px; font-weight: 800; letter-spacing: 1px; color: var(--text-3); text-transform: uppercase; padding: 0 6px 4px; }
	ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
	.friend { width: 100%; display: grid; grid-template-columns: 10px 1fr; grid-template-rows: auto auto; column-gap: 10px; align-items: center; text-align: left; background: none; border: 1px solid transparent; border-radius: 8px; padding: 8px 10px; cursor: pointer; color: var(--text-1); }
	.friend:hover { background: var(--surface-2); }
	.friend.on { border-color: var(--teal); background: color-mix(in srgb, var(--teal) 8%, transparent); }
	.dot { grid-row: 1 / 3; width: 9px; height: 9px; border-radius: 50%; background: var(--text-3); }
	.dot.lan { background: var(--green); } .dot.direct { background: var(--blue); } .dot.onion { background: var(--purple); }
	.name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.reach { font-size: 11.5px; color: var(--text-3); }
	.empty { font-size: 12.5px; color: var(--text-2); line-height: 1.5; margin: 4px 6px; }
	.add { font-size: 12.5px; color: var(--teal); margin: 6px; }
</style>
