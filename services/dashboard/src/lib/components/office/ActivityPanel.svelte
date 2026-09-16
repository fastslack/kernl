<script lang="ts" context="module">
	export type ActivityTab = 'meetings' | 'log';

	export type WaitingCard =
		| { state: 'waiting'; moderatorName: string }
		| { state: 'not_opened'; moderatorName: string; status: string; result: string; error: string };

	export interface HumanMeetingState {
		active: boolean;
		topic: string;
		attendees: number;
	}
</script>

<script lang="ts">
	import { createEventDispatcher, tick } from 'svelte';
	import Drawer from '$lib/components/ui/Drawer.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { t } from '$lib/i18n/index.js';
	import { closedCount, meetingRows, mgmtRows, type MeetingInput, type MgmtInput } from '$lib/office/activity-model.js';

	export let open = false;
	export let tab: ActivityTab = 'meetings';
	export let meetings: MeetingInput[] = [];
	export let entries: MgmtInput[] = [];
	export let waiting: WaitingCard | null = null;
	export let humanMeeting: HumanMeetingState = { active: false, topic: '', attendees: 0 };
	export let top = '0px';

	const dispatch = createEventDispatcher<{
		close: void;
		tab: { tab: ActivityTab };
		openmeeting: { id: string };
		archive: { id: string };
		archiveall: void;
		convene: void;
		retry: void;
		dismisswaiting: void;
		openhuman: void;
	}>();

	const TABS: Array<{ id: ActivityTab; label: string }> = [
		{ id: 'meetings', label: 'meeting.activity.tab_meetings' },
		{ id: 'log', label: 'meeting.activity.tab_log' },
	];
	const uid = `k-act-${Math.random().toString(36).slice(2, 9)}`;
	let tabEls: Partial<Record<ActivityTab, HTMLButtonElement>> = {};

	$: rows = meetingRows(meetings);
	$: closed = closedCount(meetings);
	$: liveCount = meetings.filter((m) => m.status === 'requested' || m.status === 'started').length + (humanMeeting.active ? 1 : 0);
	$: logRows = mgmtRows(entries);

	function select(next: ActivityTab) {
		if (next !== tab) dispatch('tab', { tab: next });
	}

	async function onTabKeydown(e: KeyboardEvent) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
		e.preventDefault();
		const i = TABS.findIndex((x) => x.id === tab);
		const next =
			e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
		select(TABS[next].id);
		await tick();
		tabEls[TABS[next].id]?.focus();
	}

	function waitingResult(card: WaitingCard): string {
		if (card.state !== 'not_opened') return '';
		if (card.status === 'failed' && card.error) return $t('meeting.activity.run_failed', { error: card.error });
		return card.result || $t('meeting.activity.no_result');
	}

	function topicOf(topic: string): string {
		return topic || $t('meeting.activity.no_topic');
	}
</script>

<Drawer {open} {top} width="420px" label={$t('meeting.activity.label')} on:close>
	<svelte:fragment slot="head">
		<div class="ap-top">
			<h2 class="ap-title">{$t('meeting.activity.title')}</h2>
			<button class="k-icon-btn" type="button" aria-label={$t('office.common.close')} on:click={() => dispatch('close')}><Icon name="x" /></button>
		</div>
		<div class="ap-tabs" role="tablist" aria-label={$t('meeting.activity.label')}>
			{#each TABS as item (item.id)}
				<button
					bind:this={tabEls[item.id]}
					id="{uid}-tab-{item.id}"
					class="ap-tab"
					type="button"
					role="tab"
					aria-selected={tab === item.id}
					aria-controls="{uid}-panel-{item.id}"
					tabindex={tab === item.id ? 0 : -1}
					on:click={() => select(item.id)}
					on:keydown={onTabKeydown}
				>
					{$t(item.label)}
					{#if item.id === 'meetings' && liveCount > 0}<span class="ap-count">{liveCount}</span>{/if}
					{#if item.id === 'log' && entries.length > 0}<span class="ap-count">{entries.length}</span>{/if}
				</button>
			{/each}
		</div>
	</svelte:fragment>

	<div id="{uid}-panel-meetings" class="ap-panel" role="tabpanel" aria-labelledby="{uid}-tab-meetings" hidden={tab !== 'meetings'}>
		{#if waiting}
			<div class="ap-waiting" class:ap-waiting--failed={waiting.state === 'not_opened'} role="status" aria-live="polite">
				{#if waiting.state === 'waiting'}
					<span class="k-led k-led--working" aria-hidden="true"></span>
					<p class="ap-waiting-text">{$t('meeting.activity.waiting', { name: waiting.moderatorName })}</p>
				{:else}
					<span class="k-led k-led--error" aria-hidden="true"></span>
					<div class="ap-waiting-body">
						<p class="ap-waiting-text">{$t('meeting.activity.not_opened', { name: waiting.moderatorName })}</p>
						<p class="ap-waiting-result">{waitingResult(waiting)}</p>
						<div class="ap-actions">
							<button class="k-btn" type="button" on:click={() => dispatch('retry')}><Icon name="play" />{$t('meeting.activity.retry')}</button>
							<button class="k-btn k-btn--ghost" type="button" on:click={() => dispatch('dismisswaiting')}>{$t('meeting.activity.dismiss')}</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}

		{#if humanMeeting.active}
			<div class="ap-human">
				<span class="k-led k-led--working" aria-hidden="true"></span>
				<div class="ap-human-body">
					<p class="ap-row-topic">{$t('meeting.activity.human_live')}</p>
					<p class="ap-row-meta">{$t('meeting.activity.human_meta', { topic: topicOf(humanMeeting.topic), n: humanMeeting.attendees })}</p>
				</div>
				<button class="k-btn" type="button" on:click={() => dispatch('openhuman')}>{$t('meeting.activity.reopen')}</button>
			</div>
		{/if}

		{#if rows.length === 0 && !waiting && !humanMeeting.active}
			<div class="ap-empty">
				<Icon name="users" size={22} />
				<p class="ap-empty-title">{$t('meeting.activity.empty')}</p>
				<p class="k-help">{$t('meeting.activity.empty_help')}</p>
				<button class="k-btn" type="button" on:click={() => dispatch('convene')}><Icon name="plus" />{$t('meeting.activity.convene')}</button>
			</div>
		{:else if rows.length > 0}
			{#if closed > 0}
				<div class="ap-list-head">
					<button class="k-btn k-btn--ghost" type="button" on:click={() => dispatch('archiveall')}>
						<Icon name="check" />{$t('meeting.activity.archive_read', { n: closed })}
					</button>
				</div>
			{/if}
			<ul class="ap-list">
				{#each rows as row (row.id)}
					<li class="ap-row">
						<button class="ap-row-main" type="button" on:click={() => dispatch('openmeeting', { id: row.id })}>
							<span class="ap-row-head">
								<span class="k-state ap-state ap-state--{row.shape}"><span class="ap-shape ap-shape--{row.shape}" aria-hidden="true"></span>{$t(row.statusKey)}</span>
								<span class="ap-row-topic">{topicOf(row.topic)}</span>
							</span>
							<span class="ap-row-meta">
								{$t('meeting.activity.meta', { moderator: row.moderatorName, n: row.participants, turns: row.turns })}{#if row.tokens > 0}
									· {$t('meeting.activity.tokens', { n: row.tokens.toLocaleString() })}{/if}
							</span>
							{#if row.summary}<span class="ap-row-summary">{row.summary}</span>{/if}
						</button>
						{#if row.closed}
							<button class="k-icon-btn ap-row-x" type="button" aria-label={$t('meeting.activity.archive', { topic: topicOf(row.topic) })}
								on:click={() => dispatch('archive', { id: row.id })}>
								<Icon name="x" size={14} />
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div id="{uid}-panel-log" class="ap-panel" role="tabpanel" aria-labelledby="{uid}-tab-log" hidden={tab !== 'log'}>
		{#if logRows.length === 0}
			<div class="ap-empty">
				<Icon name="activity" size={22} />
				<p class="ap-empty-title">{$t('meeting.activity.log_empty')}</p>
				<p class="k-help">{$t('meeting.activity.log_empty_help')}</p>
			</div>
		{:else}
			<ul class="ap-list">
				{#each logRows as row (row.key)}
					<li class="ap-log ap-log--{row.kind}">
						<span class="ap-log-icon"><Icon name={row.icon} size={14} /></span>
						<div class="ap-log-body">
							<p class="ap-log-head">
								<span class="ap-log-kind">{$t(row.labelKey)}</span>
								<span class="ap-log-names">{row.from}<Icon name="chev-r" size={12} />{row.to}</span>
								{#if row.crossOffice}<span class="k-chip">{$t('meeting.activity.cross_office')}</span>{/if}
								{#if row.manager}<span class="k-chip">{$t('meeting.activity.manager')}</span>{/if}
							</p>
							<p class="ap-log-detail">{row.detail}</p>
							{#if row.preview}<p class="ap-log-preview">{row.preview}</p>{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</Drawer>

<style>
	.ap-top { display: flex; align-items: center; gap: 10px; }
	.ap-title { flex: 1; margin: 0; font: 600 18px/1.2 var(--font-display); color: var(--text-1); }
	.ap-tabs { display: flex; gap: 4px; margin-top: 12px; }
	.ap-tab {
		display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 0; border-bottom: 2px solid transparent;
		background: transparent; color: var(--text-2); font: 600 13px/1.2 var(--font-body); cursor: pointer;
	}
	.ap-tab[aria-selected='true'] { color: var(--text-1); border-bottom-color: var(--teal); }
	.ap-tab:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
	.ap-count {
		min-width: 18px; padding: 1px 5px; border-radius: 9px; background: var(--surface-3); color: var(--text-2);
		font: 500 11px/1.3 var(--font-mono); text-align: center;
	}
	.ap-panel { display: grid; gap: 12px; padding: 14px 0; }
	.ap-waiting, .ap-human {
		display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 10px; padding: 10px 12px;
		border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border);
	}
	.ap-waiting { grid-template-columns: 10px 1fr; }
	.ap-waiting--failed { align-items: start; border-color: color-mix(in srgb, var(--red) 30%, transparent); }
	.ap-waiting--failed .k-led { margin-top: 5px; }
	.ap-waiting-text { margin: 0; font: 600 13px/1.4 var(--font-body); color: var(--text-1); }
	.ap-waiting-body { display: grid; gap: 6px; min-width: 0; }
	.ap-waiting-result { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
	.ap-actions { display: flex; gap: 6px; }
	.ap-human-body { min-width: 0; }
	.ap-empty { display: grid; justify-items: center; gap: 8px; padding: 32px 12px; text-align: center; color: var(--text-3); }
	.ap-empty-title { margin: 0; font: 600 14px/1.3 var(--font-body); color: var(--text-1); }
	.ap-list-head { display: flex; justify-content: flex-end; }
	.ap-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
	.ap-row { display: flex; align-items: flex-start; gap: 4px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border); }
	.ap-row-main {
		flex: 1; min-width: 0; display: grid; gap: 4px; padding: 9px 10px; border: 0; border-radius: var(--radius-sm);
		background: transparent; color: var(--text-1); text-align: left; cursor: pointer;
	}
	.ap-row-main:hover { background: var(--surface-3); }
	.ap-row-main:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
	.ap-row-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.ap-row-topic { margin: 0; min-width: 0; font: 600 13px/1.35 var(--font-body); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ap-row-meta { margin: 0; font: 400 11.5px/1.4 var(--font-mono); color: var(--text-3); }
	.ap-row-summary { font-size: 12px; line-height: 1.45; color: var(--text-2); }
	.ap-row-x { margin: 6px 6px 0 0; }
	.ap-shape { flex: none; width: 7px; height: 7px; }
	.ap-shape--live { border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 18%, transparent); }
	.ap-shape--pending { border-radius: 50%; border: 1.5px solid var(--text-3); }
	.ap-shape--done { border-radius: 50%; background: var(--text-3); }
	.ap-shape--failed { width: 6px; height: 6px; border-radius: 1px; background: var(--red); transform: rotate(45deg); }
	.ap-state--live { color: var(--green); }
	.ap-state--failed { color: var(--red); }
	.ap-log {
		display: grid; grid-template-columns: 24px 1fr; gap: 8px; padding: 9px 10px;
		border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border);
	}
	.ap-log-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; background: var(--surface-3); color: var(--text-2); }
	.ap-log--escalation .ap-log-icon { color: var(--orange); }
	.ap-log-body { min-width: 0; display: grid; gap: 3px; }
	.ap-log-head { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-1); }
	.ap-log-kind { font-weight: 600; }
	.ap-log-names { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); }
	.ap-log-detail { margin: 0; font-size: 12.5px; color: var(--text-2); }
	.ap-log-preview { margin: 0; font-size: 12px; color: var(--text-3); overflow-wrap: anywhere; }
</style>
