<script lang="ts">
	/*
	  /share — friend-to-friend text and files (file-lane). One screen: friends
	  on the left, what you are about to send on top, everything that came and
	  went below. Polls /api/transfers while something is moving.
	*/
	import { onMount, onDestroy } from 'svelte';
	import { t } from '$lib/i18n';
	import { apiFetchRaw } from '$lib/api.js';
	import ViewHeader from '$shared/components/ViewHeader.svelte';
	import FriendColumn from '$lib/components/share/FriendColumn.svelte';
	import Composer from '$lib/components/share/Composer.svelte';
	import ActivityRow from '$lib/components/share/ActivityRow.svelte';
	import {
		listTransfers, nextSpeed, sendToFriend, resumeUpload, acceptTransfer, rejectTransfer, cancelTransfer, retryTransfer,
		type TransferView, type ShareFriend, type SpeedSample,
	} from '$lib/share-api';

	// resumeUpload throws this exact message when the picked files don't match.
	const RESUME_MISMATCH = 'pick the same files again to continue';

	let friends: ShareFriend[] = [];
	let transfers: TransferView[] = [];
	let selected = '';
	type Filter = 'all' | 'in' | 'out';
	const FILTERS: Filter[] = ['all', 'in', 'out'];
	let filter: Filter = 'all';
	let busy = false;
	let progress = 0;
	let loadError = '';
	let actionError = '';
	let destroyed = false;
	let composer: Composer;
	let resumeInput: HTMLInputElement;
	let resuming: TransferView | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Last done_bytes sample per moving transfer, for the speed on each row.
	let speeds: Record<string, SpeedSample> = {};
	const MOVING = ['accepted', 'sending'];

	$: trusted = friends.filter((f) => f.trust === 'trusted');
	$: friend = trusted.find((f) => f.npub === selected);
	$: shown = transfers.filter((x) => filter === 'all' || x.direction === filter);
	$: error = actionError || loadError;

	function errMsg(e: unknown): string {
		const msg = String(e instanceof Error ? e.message : e);
		return msg === RESUME_MISMATCH ? $t('share.resume_hint') : $t('share.error.generic', { msg });
	}

	async function loadFriends() {
		try {
			const r = await apiFetchRaw('/api/peering/friends');
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			friends = (await r.json()).friends ?? [];
			const ok = friends.filter((f) => f.trust === 'trusted');
			if (!selected && ok.length) selected = ok[0].npub;
			loadError = '';
		} catch (e) { loadError = errMsg(e); }
	}

	async function refresh() {
		if (destroyed) return;
		let list: TransferView[] | null = null;
		try { list = await listTransfers(); } catch (e) { loadError = errMsg(e); }
		if (destroyed) return;
		if (list) { transfers = list; loadError = ''; speeds = sampleSpeeds(list); }
		const live = (list ?? transfers).some((x) => ['staging', 'pending', 'accepted', 'sending'].includes(x.state));
		clearTimeout(timer);
		timer = setTimeout(refresh, live ? 1500 : 8000);
	}

	function sampleSpeeds(list: TransferView[]): Record<string, SpeedSample> {
		const at = Date.now();
		const next: Record<string, SpeedSample> = {};
		for (const x of list) if (MOVING.includes(x.state)) next[x.id] = nextSpeed(speeds[x.id], x.done_bytes, at);
		return next;
	}

	async function act(fn: () => Promise<void>) {
		actionError = '';
		try { await fn(); } catch (e) { actionError = errMsg(e); }
		await refresh();
	}

	async function send(e: CustomEvent<{ text: string; files: File[] }>) {
		if (!friend) return;
		busy = true; progress = 0;
		await act(async () => {
			await sendToFriend(friend.npub, e.detail.text, e.detail.files, (s, total) => (progress = total ? s / total : 1));
			composer.reset();
		});
		busy = false;
	}

	function startResume(tr: TransferView) { resuming = tr; resumeInput.click(); }
	async function onResumeFiles(list: FileList | null) {
		if (!resuming || !list) return;
		const tr = resuming; resuming = null;
		await act(() => resumeUpload(tr, Array.from(list)));
	}

	onMount(async () => { await loadFriends(); await refresh(); });
	onDestroy(() => { destroyed = true; clearTimeout(timer); });
</script>

<div class="S">
	<div class="S-head"><ViewHeader title={$t('share.title')} sub={$t('share.sub')} /></div>
	{#if error}<div class="S-err" role="alert">{error}</div>{/if}
	<div class="S-body">
		<FriendColumn friends={trusted} {selected} on:select={(e) => (selected = e.detail)} />
		<div class="S-main">
			{#if friend}
				<Composer bind:this={composer} friendName={friend.petname || friend.npub.slice(0, 14)} offline={!!friend.last_error || !friend.last_reach} {busy} {progress} on:send={send} />
			{:else}
				<p class="S-pick">{$t('share.pick_friend')}</p>
			{/if}
			<div class="S-acts">
				<span class="S-acts-title">{$t('share.activity')}</span>
				{#each FILTERS as f (f)}
					<button class="pill" class:on={filter === f} on:click={() => (filter = f)}>{$t(`share.filter.${f}`)}</button>
				{/each}
			</div>
			<div class="S-list">
				{#if shown.length === 0}
					<p class="S-empty">{$t('share.activity_empty')}</p>
				{:else}
					{#each shown as tr (tr.id)}
						<ActivityRow {tr} speed={speeds[tr.id]?.bps ?? 0}
							on:accept={(e) => act(() => acceptTransfer(tr.id, e.detail.always))}
							on:reject={() => act(() => rejectTransfer(tr.id))}
							on:cancel={() => act(() => cancelTransfer(tr.id))}
							on:retry={() => act(() => retryTransfer(tr.id))}
							on:resume={() => startResume(tr)} />
					{/each}
				{/if}
			</div>
		</div>
	</div>
	<input bind:this={resumeInput} type="file" multiple hidden title={$t('share.resume_hint')} on:change={(e) => { onResumeFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
</div>

<style>
	.S { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
	.S-head { padding: 12px 24px 0; }
	.S-err { margin: 8px 24px 0; padding: 8px 12px; border-radius: 6px; background: color-mix(in srgb, var(--red) 12%, transparent); color: var(--red); font-size: 12.5px; }
	.S-body { flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--border); margin-top: 10px; }
	.S-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
	.S-pick { padding: 18px 20px; color: var(--text-2); font-size: 13px; border-bottom: 1px solid var(--border); margin: 0; }
	.S-acts { display: flex; gap: 6px; align-items: center; padding: 10px 20px 6px; }
	.S-acts-title { font-size: 11px; font-weight: 800; letter-spacing: 1px; color: var(--text-3); text-transform: uppercase; margin-right: 8px; }
	.pill { padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border); background: none; color: var(--text-2); font-size: 12px; cursor: pointer; }
	.pill.on { background: var(--teal); border-color: var(--teal); color: var(--bg); }
	.S-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 20px 16px; }
	.S-empty { color: var(--text-3); font-size: 13px; }
	@media (max-width: 800px) { .S-body { flex-direction: column; } }
</style>
