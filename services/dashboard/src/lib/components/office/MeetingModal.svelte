<script lang="ts" context="module">
	import type { Urgency } from '$lib/office/meeting-model.js';

	export type MeetingStart =
		| { moderator: 'me'; topic: string; context: string; points: string[]; attendeeIds: string[] }
		| {
				moderator: 'agent';
				moderatorId: string;
				topic: string;
				context: string;
				points: string[];
				attendeeIds: string[];
				rounds: number;
				urgency: Urgency;
		  };
</script>

<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { t } from '$lib/i18n/index.js';
	import {
		DEFAULT_ROUNDS,
		MEETING_ROUNDS,
		groupInvitees,
		parseTopics,
		type InviteeAgentInput,
		type InviteeFlowInput,
		type InviteeGroup,
	} from '$lib/office/meeting-model.js';

	export let open = false;
	export let agents: InviteeAgentInput[] = [];
	export let flows: InviteeFlowInput[] = [];
	/** The shell is starting the moderator's run. */
	export let busy = false;
	/** Why the last start failed (shell). */
	export let error = '';

	const dispatch = createEventDispatcher<{ close: void; start: MeetingStart }>();
	const formId = `k-meet-${Math.random().toString(36).slice(2, 9)}`;

	let topic = '';
	let context = '';
	let pointDraft = '';
	let points: string[] = [];
	let selected = new Set<string>();
	let moderator: 'me' | 'agent' = 'me';
	let moderatorId = '';
	let rounds = DEFAULT_ROUNDS;
	let urgency: Urgency = 'normal';
	let advancedOpen = false;
	let search = '';
	let touched = false;
	let wasOpen = false;

	$: if (open !== wasOpen) {
		wasOpen = open;
		if (open) reset();
	}
	$: groups = groupInvitees(agents, flows);
	$: visibleGroups = filterGroups(groups, search, moderator === 'agent' ? moderatorId : '');
	$: attendeeIds = [...selected].filter((id) => !(moderator === 'agent' && id === moderatorId));
	$: headcount = attendeeIds.length + (moderator === 'agent' && moderatorId ? 1 : 0);
	$: canStart = !!topic.trim() && attendeeIds.length > 0 && (moderator === 'me' || !!moderatorId);

	function reset() {
		topic = '';
		context = '';
		pointDraft = '';
		points = [];
		selected = new Set();
		moderator = 'me';
		moderatorId = '';
		rounds = DEFAULT_ROUNDS;
		urgency = 'normal';
		advancedOpen = false;
		search = '';
		touched = false;
	}

	function filterGroups(list: InviteeGroup[], query: string, excludeId: string): InviteeGroup[] {
		const q = query.trim().toLowerCase();
		return list
			.map((g) => ({ ...g, agents: g.agents.filter((a) => a.id !== excludeId && (!q || a.name.toLowerCase().includes(q))) }))
			.filter((g) => g.agents.length > 0);
	}

	function addPoints() {
		const added = parseTopics(pointDraft);
		if (added.length > 0) points = [...points, ...added];
		pointDraft = '';
	}

	function onPointKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			addPoints();
		} else if (e.key === 'Backspace' && !pointDraft && points.length > 0) {
			points = points.slice(0, -1);
		}
	}

	function removePoint(index: number) {
		points = points.filter((_, i) => i !== index);
	}

	function toggleAgent(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function allSelected(group: InviteeGroup, current: Set<string>): boolean {
		return group.agents.length > 0 && group.agents.every((a) => current.has(a.id));
	}

	function toggleGroup(group: InviteeGroup) {
		const next = new Set(selected);
		if (allSelected(group, selected)) group.agents.forEach((a) => next.delete(a.id));
		else group.agents.forEach((a) => next.add(a.id));
		selected = next;
	}

	function submit() {
		touched = true;
		if (pointDraft.trim()) addPoints();
		if (!canStart || busy) return;
		const base = { topic: topic.trim(), context: context.trim(), points: [...points], attendeeIds };
		if (moderator === 'me') dispatch('start', { moderator: 'me', ...base });
		else dispatch('start', { moderator: 'agent', moderatorId, rounds, urgency, ...base });
	}
</script>

<Modal {open} title={$t('meeting.modal.title')} width="680px" on:close>
	<form class="mm" id={formId} on:submit|preventDefault={submit}>
		<div class="k-field">
			<label class="k-label" for="{formId}-topic">{$t('meeting.modal.topic')}</label>
			<input id="{formId}-topic" class="k-input" bind:value={topic} placeholder={$t('meeting.modal.topic_ph')} maxlength="200"
				aria-invalid={touched && !topic.trim()} />
			{#if touched && !topic.trim()}<p class="k-error">{$t('meeting.modal.topic_required')}</p>{/if}
		</div>

		<div class="k-field">
			<label class="k-label" for="{formId}-context">{$t('meeting.modal.context')}</label>
			<textarea id="{formId}-context" class="k-input" rows="3" bind:value={context} placeholder={$t('meeting.modal.context_ph')}></textarea>
		</div>

		<div class="k-field">
			<label class="k-label" for="{formId}-points">{$t('meeting.modal.points')}</label>
			{#if points.length > 0}
				<ul class="mm-chips">
					{#each points as point, i (`${i}-${point}`)}
						<li class="k-chip mm-chip">
							<span>{point}</span>
							<button class="mm-chip-x" type="button" aria-label={$t('meeting.modal.point_remove', { point })} on:click={() => removePoint(i)}>
								<Icon name="x" size={12} />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
			<input id="{formId}-points" class="k-input" bind:value={pointDraft} placeholder={$t('meeting.modal.points_ph')}
				on:keydown={onPointKeydown} on:blur={addPoints} />
		</div>

		<fieldset class="mm-fieldset">
			<legend class="k-label mm-legend">{$t('meeting.modal.moderator')}</legend>
			<div class="k-segmented" role="radiogroup" aria-label={$t('meeting.modal.moderator')}>
				<button class="k-seg" type="button" role="radio" aria-checked={moderator === 'me'} on:click={() => (moderator = 'me')}>
					{$t('meeting.modal.moderator_me')}
				</button>
				<button class="k-seg" type="button" role="radio" aria-checked={moderator === 'agent'} on:click={() => (moderator = 'agent')}>
					{$t('meeting.modal.moderator_agent')}
				</button>
			</div>
			<p class="k-help">{moderator === 'me' ? $t('meeting.modal.me_help') : $t('meeting.modal.agent_help')}</p>

			{#if moderator === 'agent'}
				<div class="k-field">
					<label class="k-label" for="{formId}-moderator">{$t('meeting.modal.moderator_pick')}</label>
					<select id="{formId}-moderator" class="k-input" bind:value={moderatorId} aria-invalid={touched && !moderatorId}>
						<option value="">{$t('meeting.modal.moderator_ph')}</option>
						{#each groups as group (group.id)}
							<optgroup label={group.name || $t('meeting.modal.no_office')}>
								{#each group.agents as agent (agent.id)}<option value={agent.id}>{agent.name}</option>{/each}
							</optgroup>
						{/each}
					</select>
					{#if touched && !moderatorId}<p class="k-error">{$t('meeting.modal.need_moderator')}</p>{/if}
				</div>
				<button class="mm-advanced" type="button" aria-expanded={advancedOpen} on:click={() => (advancedOpen = !advancedOpen)}>
					<span class="mm-chev" class:mm-chev--open={advancedOpen}><Icon name="chev-r" size={14} /></span>{$t('meeting.modal.advanced')}
				</button>
				{#if advancedOpen}
					<div class="mm-row2">
						<div class="k-field">
							<label class="k-label" for="{formId}-rounds">{$t('meeting.modal.rounds')}</label>
							<select id="{formId}-rounds" class="k-input" bind:value={rounds}>
								{#each MEETING_ROUNDS as r (r)}<option value={r}>{r}</option>{/each}
							</select>
						</div>
						<div class="k-field">
							<label class="k-label" for="{formId}-urgency">{$t('meeting.modal.urgency')}</label>
							<select id="{formId}-urgency" class="k-input" bind:value={urgency}>
								<option value="normal">{$t('meeting.modal.urgency_normal')}</option>
								<option value="urgent">{$t('meeting.modal.urgency_urgent')}</option>
							</select>
						</div>
					</div>
				{/if}
			{/if}
		</fieldset>

		<div class="k-field">
			<div class="mm-inv-head">
				<span class="k-label" id="{formId}-inv">{$t('meeting.modal.invitees', { n: attendeeIds.length })}</span>
				<!-- Enter filters; without preventDefault, implicit submission would start the meeting. -->
				<input class="k-input mm-search" type="search" bind:value={search} placeholder={$t('meeting.modal.search')} aria-label={$t('meeting.modal.search')}
					on:keydown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
			</div>
			{#if visibleGroups.length === 0}
				<p class="k-help">{$t('meeting.modal.no_agents')}</p>
			{:else}
				<div class="mm-groups" role="group" aria-labelledby="{formId}-inv">
					{#each visibleGroups as group (group.id)}
						<div class="mm-group">
							<div class="mm-group-head">
								<span class="mm-dot" style="background:{group.color || 'var(--text-3)'}"></span>
								<span class="mm-group-name">{group.name || $t('meeting.modal.no_office')}</span>
								<label class="mm-all">
									<input type="checkbox" checked={allSelected(group, selected)} on:change={() => toggleGroup(group)} />
									<span>{$t('meeting.modal.whole_office')}</span>
								</label>
							</div>
							<div class="mm-cards">
								{#each group.agents as agent (agent.id)}
									<button class="mm-card" type="button" aria-pressed={selected.has(agent.id)} on:click={() => toggleAgent(agent.id)}>
										<span class="mm-card-check" aria-hidden="true">{#if selected.has(agent.id)}<Icon name="check" size={12} />{/if}</span>
										<span class="mm-card-name">{agent.name}</span>
									</button>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#if touched && attendeeIds.length === 0}<p class="k-error">{$t('meeting.modal.need_guests')}</p>{/if}
			{#if error}<p class="k-error" role="alert">{error}</p>{/if}
		</div>
	</form>

	<svelte:fragment slot="footer">
		<span class="mm-spacer"></span>
		<button class="k-btn k-btn--ghost" type="button" on:click={() => dispatch('close')}>{$t('office.common.cancel')}</button>
		<button class="k-btn k-btn--primary" type="submit" form={formId} disabled={busy}>
			<Icon name="users" />{busy ? $t('meeting.modal.starting') : $t('meeting.modal.start', { n: headcount })}
		</button>
	</svelte:fragment>
</Modal>

<style>
	.mm { display: grid; gap: 16px; }
	.mm-fieldset { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: 8px; }
	.mm-legend { padding: 0; margin-bottom: 6px; }
	.mm-chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
	.mm-chip { display: inline-flex; align-items: center; gap: 4px; }
	.mm-chip-x {
		display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px;
		background: transparent; color: var(--text-3); cursor: pointer;
	}
	.mm-chip-x:hover, .mm-chip-x:focus-visible { color: var(--text-1); background: var(--surface-3); outline: none; }
	.mm-advanced {
		justify-self: start; display: inline-flex; align-items: center; gap: 6px; padding: 4px 0; border: 0; background: none;
		color: var(--text-2); font: 600 12.5px/1.3 var(--font-body); cursor: pointer;
	}
	.mm-advanced:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
	.mm-chev { display: grid; place-items: center; transition: transform 240ms var(--ease-out); }
	.mm-chev--open { transform: rotate(90deg); }
	.mm-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.mm-inv-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.mm-search { max-width: 220px; }
	.mm-groups {
		display: grid; gap: 12px; max-height: 280px; overflow-y: auto; padding: 8px;
		border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2);
	}
	.mm-group { display: grid; gap: 6px; }
	.mm-group-head { display: flex; align-items: center; gap: 8px; }
	.mm-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
	.mm-group-name { flex: 1; min-width: 0; font: 600 12px/1.3 var(--font-body); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mm-all { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); cursor: pointer; }
	.mm-all input { accent-color: var(--teal); }
	.mm-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
	.mm-card {
		display: flex; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm);
		background: var(--surface-1); color: var(--text-1); font: 500 12.5px/1.3 var(--font-body); text-align: left; cursor: pointer;
	}
	.mm-card:hover { border-color: var(--border-h); }
	.mm-card[aria-pressed='true'] { border-color: var(--teal); background: color-mix(in srgb, var(--teal) 10%, var(--surface-1)); }
	.mm-card:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
	.mm-card-check {
		display: grid; place-items: center; flex: none; width: 16px; height: 16px; border-radius: 4px;
		border: 1px solid var(--border-h); color: var(--teal);
	}
	.mm-card[aria-pressed='true'] .mm-card-check { border-color: var(--teal); }
	.mm-card-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mm-spacer { flex: 1; }
	@media (prefers-reduced-motion: reduce) {
		.mm-chev { transition: none; }
	}
</style>
