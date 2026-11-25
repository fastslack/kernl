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
	const HUES = ['#60A5FA', '#34D399', '#A78BFA', '#F472B6', '#FBBF24', '#22D3EE', '#FB923C', '#4ADE80'];
	function hue(s: string): string {
		let h = 0;
		for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		return HUES[h % HUES.length];
	}
	function initials(f: ShareFriend): string {
		const n = (f.petname || f.npub.replace(/^npub1/, '')).trim();
		const parts = n.split(/\s+/).filter(Boolean);
		return (parts.length > 1 ? parts[0][0] + parts[1][0] : n.slice(0, 2)).toUpperCase();
	}
</script>

<aside class="col">
	<div class="col-title">{$t('share.friends')}</div>
	{#if friends.length === 0}
		<div class="none">
			<span class="none-mark" aria-hidden="true">⇄</span>
			<p class="empty">{$t('share.friends_empty')}</p>
			<a class="add cta" href="/friends">{$t('share.friends_add')}</a>
		</div>
	{:else}
		<ul>
			{#each friends as f (f.npub)}
				{@const r = reach(f)}
				<li>
					<button class="friend" class:on={selected === f.npub} style="--h: {hue(f.npub)}" on:click={() => dispatch('select', f.npub)}>
						<span class="mark" aria-hidden="true">{initials(f)}<span class="dot {r}"></span></span>
						<span class="name">{f.petname || f.npub.slice(0, 14) + '…'}</span>
						<span class="reach">{$t(`share.reach.${r}`)}</span>
					</button>
				</li>
			{/each}
		</ul>
		<a class="add" href="/friends">+ {$t('share.friends_add')}</a>
	{/if}
</aside>

<style>
	.col { width: 260px; flex-shrink: 0; padding: 12px 10px; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }
	.col-title { font: 700 10px/1.4 var(--font-body); letter-spacing: .14em; color: var(--gold); text-transform: uppercase; padding: 0 6px 4px; }
	ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
	.friend { --h: #60A5FA; width: 100%; display: grid; grid-template-columns: 34px 1fr; grid-template-rows: auto auto; column-gap: 10px; align-items: center; text-align: left;
		background: none; border: 1px solid transparent; border-radius: 12px; padding: 7px 9px; cursor: pointer; color: var(--text-1); transition: background .15s, border-color .15s; }
	.friend:hover { background: color-mix(in srgb, var(--h) 8%, var(--surface-2)); }
	.friend.on { border-color: var(--gold); background: linear-gradient(160deg, color-mix(in srgb, var(--gold) 14%, var(--surface-1)), var(--surface-1)); }
	.friend:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
	.mark { grid-row: 1 / 3; position: relative; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; font: 800 11.5px var(--font-body);
		color: color-mix(in srgb, var(--h) 80%, white); background: color-mix(in srgb, var(--h) 22%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--h) 40%, transparent); }
	.dot { position: absolute; right: -3px; bottom: -3px; width: 10px; height: 10px; border-radius: 50%; background: var(--text-3); border: 2px solid var(--surface-1); }
	.dot.lan { background: #34D399; box-shadow: 0 0 8px #34D399; } .dot.direct { background: #60A5FA; box-shadow: 0 0 8px #60A5FA; } .dot.onion { background: #A78BFA; box-shadow: 0 0 8px #A78BFA; }
	.name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.reach { font-size: 11.5px; color: var(--text-3); }
	.none { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 10px; }
	.none-mark { width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; font-size: 24px; color: #67E8F9;
		background: radial-gradient(circle at 30% 20%, color-mix(in srgb, #22D3EE 30%, transparent), color-mix(in srgb, #22D3EE 8%, var(--surface-1))); border: 1px solid color-mix(in srgb, #22D3EE 40%, transparent); box-shadow: 0 10px 28px -14px #22D3EE; }
	.empty { font-size: 12.5px; color: var(--text-2); line-height: 1.5; margin: 0 6px; }
	.add { font-size: 12.5px; color: var(--gold); margin: 6px; text-decoration: none; }
	.add:hover { text-decoration: underline; }
	.add.cta { margin: 4px 0 0; padding: 7px 16px; border-radius: 10px; background: linear-gradient(135deg, #FBBF24, #F59E0B); color: #1a1205; font-weight: 700; }
	.add.cta:hover { text-decoration: none; filter: brightness(1.08); }
</style>
