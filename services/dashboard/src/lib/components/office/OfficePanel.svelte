<script lang="ts" context="module">
	export interface PanelOffice {
		id: string;
		name: string;
		color: string;
		kind?: string | null;
		description?: string;
		repo_isolation?: string;
		home_repo_path?: string;
	}

	export interface PanelMoveTarget {
		id: string;
		name: string;
		color: string;
	}
</script>

<script lang="ts">
	import { createEventDispatcher, tick } from 'svelte';
	import Drawer from '$lib/components/ui/Drawer.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import LockedFeature from '$lib/components/ui/LockedFeature.svelte';
	import OfficeInfraPanel from '$lib/components/OfficeInfraPanel.svelte';
	import DeleteOfficeDialog from './DeleteOfficeDialog.svelte';
	import RepoPicker from './RepoPicker.svelte';
	import { isAbsoluteHostPath } from '$lib/host-path.js';
	import { apiFetch, createAgent } from '$lib/api.js';
	import { t } from '$lib/i18n/index.js';
	import { OFFICE_KINDS, officeKindOf, traitsOf } from '$lib/office/office-kinds.js';
	import { OFFICE_PALETTE } from '$lib/office/office-palette.js';
	import { CADENCE_PRESETS, checkEvery, choiceForInterval, everyFor, parseEvery, type CadenceChoice } from '$lib/office/cadence.js';
	import {
		updateOffice,
		moveAgentToOffice,
		setOfficeLead,
		setLeadDistributes,
		setAgentActive,
		addLeadSchedule,
		updateSchedule,
		deleteSchedule,
		setOfficeRepo,
		type OfficePatch,
	} from '$lib/office/office-api.js';
	import { errorMessage } from '$lib/office/office-errors.js';
	import {
		cadencePlan,
		distributeState,
		leadSchedule,
		leadStatus,
		manualChainCount,
		type TeamChain,
		type TeamSchedule,
	} from '$lib/office/team-model.js';
	import { placeMenu, type MenuPlacement } from '$lib/office/menu-placement.js';
	import type { RailAgent } from '$lib/office/rail-model.js';

	export let open = false;
	export let office: PanelOffice | null = null;
	export let agents: RailAgent[] = [];
	export let unassigned: RailAgent[] = [];
	/** Graph chains; the panel reads the lead → member ones. */
	export let chains: TeamChain[] = [];
	/** Graph schedules (active rows only). */
	export let schedules: TeamSchedule[] = [];
	/** Agents with active = 0 — a paused agent that is still finishing a run shows "working" in the rail. */
	export let inactiveIds: string[] = [];
	/** Offices a member of this one can move to. */
	export let moveTargets: PanelMoveTarget[] = [];
	/** The kernel's schedule floor (KERNEL_AGENT_MIN_SCHEDULE_SECONDS default). */
	export let minScheduleSeconds = 300;
	/** The repo the office's agents work on (home_repo_path, else the __cwd_path__ they share). */
	export let repoPath = '';
	/** null while the shell does not know yet (templates loading or failed): only an explicit false blocks Host. */
	export let hostAllowed: boolean | null = null;
	/** Real number of agents the backend will unassign on delete (includes the top agent the team list hides). */
	export let deleteCount: number | null = null;
	/** null while the shell is still reading the license. */
	export let envAvailable: boolean | null = null;
	export let otherOfficeNames: string[] = [];
	export let top = '52px';

	const dispatch = createEventDispatcher<{ close: void; changed: void; agentopen: { id: string }; deleted: { unassigned: number } }>();

	type FieldStatus = { status: 'idle' | 'saving' | 'saved' | 'error'; error?: string };
	const MENU_SIZE = { width: 232, height: 200 };
	let fields: Record<string, FieldStatus> = {};
	let name = '';
	let purpose = '';
	let loadedId = '';
	let bringOpen = false;
	let busy = '';
	let actionError = '';
	let teamError = '';
	let deleteOpen = false;
	let menuFor: string | null = null;
	let menuPos: MenuPlacement = { top: 0, left: 0, flipped: false };
	let menuEl: HTMLDivElement | undefined;
	let cadenceChoice: CadenceChoice = 'manual';
	let cadenceCustom = '';
	let cadenceError = '';
	let cadenceLoadedKey = '';
	let repoEditing = false;
	let repoDraft = '';
	let repoGitInit = true;
	let repoNote = '';
	/** "Quitar repo" strips the agents' repo variables: it takes a second click. */
	let repoConfirmRemove = false;
	/** The lead a schedule 'add' was already sent for, until the refreshed schedules prove it landed. */
	let cadencePendingAdd: string | null = null;

	$: if (office && office.id !== loadedId) {
		loadedId = office.id;
		name = office.name;
		purpose = office.description ?? '';
		fields = {};
		bringOpen = false;
		actionError = '';
		teamError = '';
		deleteOpen = false;
		menuFor = null;
		repoEditing = false;
		repoNote = '';
		repoConfirmRemove = false;
	}
	$: kind = officeKindOf(office);
	$: traits = traitsOf(office);
	$: nameTaken = !!office && name.trim().toLowerCase() !== office.name.trim().toLowerCase()
		&& otherOfficeNames.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase());
	$: palette = office && !(OFFICE_PALETTE as readonly string[]).includes(office.color) ? [office.color, ...OFFICE_PALETTE] : [...OFFICE_PALETTE];
	$: working = agents.filter((a) => a.state === 'working').length;
	$: isolation = office?.repo_isolation === 'host' ? 'host' : 'sandbox';
	$: hostBroken = office?.repo_isolation === 'host' && hostAllowed === false;

	$: lead = leadStatus(agents);
	$: leadId = lead.kind === 'one' ? lead.leadId : null;
	// The set the kernel counts (Task 4): the rail's office agents, paused ones included; the rail already drops the top agent.
	$: memberIds = agents.filter((a) => a.id !== leadId).map((a) => a.id);
	$: distribute = distributeState(chains, leadId, memberIds);
	$: manualChains = manualChainCount(chains, leadId, memberIds);
	$: currentSchedule = leadSchedule(schedules, leadId);
	$: cadenceKey = `${office?.id ?? ''}:${leadId ?? ''}:${currentSchedule?.id ?? ''}:${currentSchedule?.interval_ms ?? 0}:${currentSchedule?.cron_expression ?? ''}`;
	$: if (cadenceKey !== cadenceLoadedKey) {
		cadenceLoadedKey = cadenceKey;
		cadencePendingAdd = null;
		loadCadence(currentSchedule);
	}
	$: menuAgent = menuFor ? (agents.find((a) => a.id === menuFor) ?? null) : null;

	const ids = { name: 'k-op-name', purpose: 'k-op-purpose', kind: 'k-op-kind', cadence: 'k-op-cadence' };

	function loadCadence(schedule: TeamSchedule | null) {
		const picked = choiceForInterval(schedule?.cron_expression ? null : schedule?.interval_ms);
		cadenceChoice = schedule?.cron_expression ? 'custom' : picked.choice;
		cadenceCustom = picked.custom;
		cadenceError = '';
	}

	function markSaved(field: string) {
		fields = { ...fields, [field]: { status: 'saved' } };
		setTimeout(() => {
			if (fields[field]?.status === 'saved') fields = { ...fields, [field]: { status: 'idle' } };
		}, 1500);
	}

	async function save(field: string, patch: OfficePatch) {
		if (!office) return;
		fields = { ...fields, [field]: { status: 'saving' } };
		try {
			await updateOffice(office.id, patch);
			markSaved(field);
			dispatch('changed');
		} catch (err) {
			fields = { ...fields, [field]: { status: 'error', error: errorMessage(err) } };
		}
	}

	function blurOnEnter(e: KeyboardEvent) {
		if (e.key === 'Enter') (e.currentTarget as HTMLElement).blur();
	}

	function saveKind(e: Event) {
		const value = (e.currentTarget as HTMLSelectElement).value as (typeof OFFICE_KINDS)[number];
		void save('kind', { kind: value });
	}

	function saveName() {
		if (!office) return;
		const value = name.trim();
		if (!value) { name = office.name; return; }
		if (value === office.name || nameTaken) return;
		void save('name', { name: value });
	}

	function savePurpose() {
		if (!office || purpose.trim() === (office.description ?? '').trim()) return;
		void save('purpose', { description: purpose.trim() });
	}

	async function addAgent() {
		if (!office) return;
		busy = 'new';
		actionError = '';
		try {
			const res = (await createAgent({ name: $t('office.panel.new_agent'), flow_id: office.id })) as {
				agent_id?: string;
				agent?: { id?: string };
				id?: string;
			};
			dispatch('changed');
			const id = res?.agent_id ?? res?.agent?.id ?? res?.id;
			if (id) dispatch('agentopen', { id });
		} catch (err) {
			actionError = errorMessage(err);
		} finally {
			busy = '';
		}
	}

	async function bring(agentId: string) {
		if (!office) return;
		busy = agentId;
		actionError = '';
		try {
			await moveAgentToOffice(agentId, office.id);
			bringOpen = false;
			dispatch('changed');
		} catch (err) {
			actionError = errorMessage(err);
		} finally {
			busy = '';
		}
	}

	async function exportOffice() {
		if (!office) return;
		actionError = '';
		try {
			const data = await apiFetch(`/api/agents/flows/${encodeURIComponent(office.id)}/export`);
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = `${office.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'office'}.json`;
			link.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			actionError = errorMessage(err);
		}
	}

	// ── Member menu ────────────────────────────────────────────
	async function openMenu(e: MouseEvent, agentId: string) {
		if (menuFor === agentId) { menuFor = null; return; }
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menuPos = placeMenu(rect, MENU_SIZE, { width: window.innerWidth, height: window.innerHeight });
		menuFor = agentId;
		await tick();
		menuEl?.querySelector<HTMLElement>('button, select')?.focus({ preventScroll: true });
	}

	function onWindowClick(e: MouseEvent) {
		if (!menuFor) return;
		if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
		menuFor = null;
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (menuFor && e.key === 'Escape') {
			// Bound with |capture: Svelte attaches the Drawer's window listener (a child)
			// before this component's, so a bubbling listener here would run after it.
			e.preventDefault();
			e.stopPropagation();
			menuFor = null;
		}
	}

	async function teamAction(key: string, action: () => Promise<unknown>) {
		menuFor = null;
		busy = key;
		teamError = '';
		try {
			await action();
			dispatch('changed');
		} catch (err) {
			teamError = errorMessage(err);
		} finally {
			busy = '';
		}
	}

	function openMember(agentId: string) {
		menuFor = null;
		dispatch('agentopen', { id: agentId });
	}

	function makeLead(agentId: string) {
		if (!office) return;
		const flowId = office.id;
		void teamAction(`lead:${agentId}`, () => setOfficeLead(flowId, agentId));
	}

	function moveMember(agentId: string, e: Event) {
		const flowId = (e.currentTarget as HTMLSelectElement).value;
		if (!flowId) return;
		void teamAction(`move:${agentId}`, () => moveAgentToOffice(agentId, flowId));
	}

	function togglePause(agentId: string) {
		const paused = inactiveIds.includes(agentId);
		void teamAction(`pause:${agentId}`, () => setAgentActive(agentId, paused));
	}

	function toggleDistribute(e: Event) {
		// Show the real state until the refreshed graph arrives; a failure then leaves it right.
		(e.currentTarget as HTMLInputElement).checked = distribute === 'on';
		if (!office || !leadId) return;
		const flowId = office.id;
		const enable = distribute !== 'on';
		void teamAction('distribute', () => setLeadDistributes(flowId, enable));
	}

	// ── Lead cadence ───────────────────────────────────────────
	async function applyCadence(choice: CadenceChoice, custom: string) {
		if (!leadId || fields.cadence?.status === 'saving') return;
		cadenceError = '';
		const every = everyFor(choice, custom);
		let nextMs: number | null = null;
		if (every !== null) {
			const check = checkEvery(every, minScheduleSeconds);
			if (check === 'invalid') { cadenceError = $t('office.cadence.invalid'); return; }
			if (check === 'too_short') { cadenceError = $t('office.cadence.too_short', { min: Math.ceil(minScheduleSeconds / 60) }); return; }
			nextMs = parseEvery(every);
		}
		const plan = cadencePlan(currentSchedule, nextMs);
		if (plan.action === 'none') return;
		// Adding already went out for this lead; the schedules prop hasn't caught up yet — wait for
		// cadenceKey to move (leadSchedule finds the new row) before another 'add' can be planned.
		if (plan.action === 'add' && cadencePendingAdd === leadId) return;
		const agentId = leadId;
		fields = { ...fields, cadence: { status: 'saving' } };
		try {
			if (plan.action === 'add') { await addLeadSchedule(agentId, plan.intervalMs); cadencePendingAdd = agentId; }
			else if (plan.action === 'update') await updateSchedule(plan.scheduleId, { interval_ms: plan.intervalMs });
			else await deleteSchedule(plan.scheduleId);
			markSaved('cadence');
			dispatch('changed');
		} catch (err) {
			fields = { ...fields, cadence: { status: 'error', error: errorMessage(err) } };
		}
	}

	function onCadenceSelect(e: Event) {
		const value = (e.currentTarget as HTMLSelectElement).value as CadenceChoice;
		cadenceChoice = value;
		cadenceError = '';
		if (value !== 'custom') void applyCadence(value, '');
	}

	function applyCustomCadence() {
		if (!cadenceCustom.trim()) return;
		void applyCadence('custom', cadenceCustom);
	}

	// ── Repo ───────────────────────────────────────────────────
	function startRepoEdit() {
		repoEditing = true;
		repoDraft = repoPath;
		repoGitInit = true;
		repoNote = '';
		repoConfirmRemove = false;
		fields = { ...fields, repo: { status: 'idle' } };
	}

	async function saveRepo(path: string | null) {
		if (!office) return;
		const flowId = office.id;
		const clean = path === null ? null : path.trim();
		if (clean !== null && !isAbsoluteHostPath(clean)) {
			fields = { ...fields, repo: { status: 'error', error: $t('office.panel.repo_absolute') } };
			return;
		}
		fields = { ...fields, repo: { status: 'saving' } };
		try {
			const result = await setOfficeRepo(flowId, clean, repoGitInit);
			repoEditing = false;
			repoConfirmRemove = false;
			repoNote = result.git === 'missing' ? $t('office.panel.repo_git_missing') : result.git === 'failed' ? result.gitDetail : '';
			markSaved('repo');
			dispatch('changed');
		} catch (err) {
			fields = { ...fields, repo: { status: 'error', error: errorMessage(err) } };
		}
	}

	function statusText(field: string): string {
		const f = fields[field];
		if (!f) return '';
		if (f.status === 'saving') return $t('office.common.saving');
		if (f.status === 'saved') return $t('office.common.saved');
		if (f.status === 'error') return $t('office.common.save_failed', { error: f.error ?? '' });
		return '';
	}
</script>

<svelte:window on:click={onWindowClick} on:keydown|capture={onWindowKeydown} on:scroll|capture={() => (menuFor = null)} on:resize={() => (menuFor = null)} />

<Drawer open={open && !!office} {top} label={office ? $t('office.panel.label', { name: office.name }) : ''} on:close>
	<svelte:fragment slot="head">
		{#if office}
			<div class="op-top">
				<span class="op-dot" style="background:{office.color}"></span>
				<h2 class="op-title">{office.name}</h2>
				<button class="k-icon-btn" type="button" aria-label={$t('office.common.close')} on:click={() => dispatch('close')}><Icon name="x" /></button>
			</div>
			<div class="op-chips">
				<span class="k-chip op-kind">{$t(`office.kind.${kind}`)}</span>
				<span class="k-chip">{$t('office.panel.agents', { n: agents.length })}</span>
				{#if working > 0}
					<span class="k-chip op-working"><span class="k-led k-led--working" aria-hidden="true"></span>{$t('office.panel.working', { n: working })}</span>
				{/if}
			</div>
		{/if}
	</svelte:fragment>

	{#if office}
		<section class="op-section">
			<h3 class="k-section-title">{$t('office.panel.general')}</h3>
			<div class="k-field">
				<label class="k-label" for={ids.name}>{$t('office.panel.name')}<span class="op-status">{statusText('name')}</span></label>
				<input id={ids.name} class="k-input" bind:value={name} aria-invalid={nameTaken} maxlength="40"
					on:blur={saveName} on:keydown={blurOnEnter} />
				{#if nameTaken}<p class="k-error">{$t('office.panel.name_taken')}</p>{/if}
			</div>
			<div class="op-row2">
				<div class="k-field">
					<span class="k-label" id="k-op-color">{$t('office.panel.color')}<span class="op-status">{statusText('color')}</span></span>
					<div class="op-swatches" role="radiogroup" aria-labelledby="k-op-color">
						{#each palette as color, i (color)}
							<button class="op-swatch" type="button" role="radio" aria-checked={office.color === color} aria-label={$t('office.common.color_n', { n: i + 1, total: palette.length })}
								style="background:{color}" on:click={() => { if (office && office.color !== color) void save('color', { color }); }}></button>
						{/each}
					</div>
				</div>
				<div class="k-field">
					<label class="k-label" for={ids.kind}>{$t('office.panel.kind')}<span class="op-status">{statusText('kind')}</span></label>
					<select id={ids.kind} class="k-input" value={kind} title={$t('office.kind.help')}
						on:change={saveKind}>
						{#each OFFICE_KINDS as k (k)}<option value={k}>{$t(`office.kind.${k}`)}</option>{/each}
					</select>
				</div>
			</div>
			<div class="k-field">
				<label class="k-label" for={ids.purpose}>{$t('office.panel.purpose')}<span class="op-status">{statusText('purpose')}</span></label>
				<textarea id={ids.purpose} class="k-input" rows="2" bind:value={purpose} placeholder={$t('office.panel.purpose_ph')} on:blur={savePurpose}></textarea>
			</div>
			{#each ['name', 'color', 'kind', 'purpose'] as field (field)}
				{#if fields[field]?.status === 'error'}<p class="k-error" role="alert">{statusText(field)}</p>{/if}
			{/each}
		</section>

		<section class="op-section">
			<h3 class="k-section-title">{$t('office.panel.team', { n: agents.length })}</h3>
			{#if agents.length === 0}
				<p class="k-help">{$t('office.panel.no_agents')}</p>
			{:else}
				<ul class="op-members">
					{#each agents as agent (agent.id)}
						<li class="op-member">
							<span class="op-member-rank">{#if agent.lead}<Icon name="star" size={13} filled label={$t('office.rail.lead')} />{/if}</span>
							<span class="op-member-name">{agent.name}</span>
							{#if agent.state !== 'idle'}
								<span class="k-state k-state--{agent.state}"><span class="k-led k-led--{agent.state}" aria-hidden="true"></span>{$t(`office.state.${agent.state}`)}</span>
							{/if}
							<button class="k-btn k-btn--ghost op-open" type="button" aria-haspopup="menu" aria-expanded={menuFor === agent.id}
								aria-label={$t('office.panel.member_menu', { name: agent.name })} disabled={busy.endsWith(`:${agent.id}`)}
								on:click|stopPropagation={(e) => openMenu(e, agent.id)}>
								<Icon name="more" size={14} />
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if menuAgent}
				{@const m = menuAgent}
				<div bind:this={menuEl} class="op-menu" class:op-menu--up={menuPos.flipped} role="menu" tabindex="-1"
					style="top:{menuPos.top}px;left:{menuPos.left}px">
					<button class="op-menu-item" type="button" role="menuitem" on:click={() => openMember(m.id)}>
						<Icon name="chev-r" size={14} />{$t('office.panel.menu_open')}
					</button>
					{#if !m.lead}
						<button class="op-menu-item" type="button" role="menuitem" on:click={() => makeLead(m.id)}>
							<Icon name="star" size={14} />{$t('office.panel.menu_make_lead')}
						</button>
					{/if}
					{#if moveTargets.length > 0}
						<div class="op-menu-move">
							<span class="op-menu-label" id="k-op-move-{m.id}"><Icon name="move" size={14} />{$t('office.panel.menu_move')}</span>
							<select class="k-input" aria-labelledby="k-op-move-{m.id}" title={$t('office.panel.move_label', { name: m.name })}
								on:change={(e) => moveMember(m.id, e)}>
								<option value="">{$t('office.panel.move_pick')}</option>
								{#each moveTargets as target (target.id)}<option value={target.id}>{target.name}</option>{/each}
							</select>
						</div>
					{/if}
					<button class="op-menu-item" type="button" role="menuitem" on:click={() => togglePause(m.id)}>
						<Icon name={inactiveIds.includes(m.id) ? 'play' : 'minus'} size={14} />
						{inactiveIds.includes(m.id) ? $t('office.panel.menu_resume') : $t('office.panel.menu_pause')}
					</button>
				</div>
			{/if}

			<div class="op-row2">
				<button class="k-btn" type="button" disabled={busy === 'new'} on:click={addAgent}><Icon name="plus" />{$t('office.panel.new_agent')}</button>
				<button class="k-btn" type="button" aria-expanded={bringOpen} on:click={() => (bringOpen = !bringOpen)}><Icon name="move" />{$t('office.panel.bring')}</button>
			</div>
			{#if bringOpen}
				{#if unassigned.length === 0}
					<p class="k-help">{$t('office.panel.no_unassigned')}</p>
				{:else}
					<ul class="op-bring">
						{#each unassigned as agent (agent.id)}
							<li><button class="op-bring-item" type="button" disabled={busy === agent.id} on:click={() => bring(agent.id)}><Icon name="plus" size={13} />{agent.name}</button></li>
						{/each}
					</ul>
				{/if}
			{/if}

			<div class="op-toggle-row">
				<label class="op-switch">
					<input type="checkbox" role="switch" checked={distribute === 'on'} disabled={!leadId || busy === 'distribute'} on:change={toggleDistribute} />
					<span class="op-switch-track" aria-hidden="true"><span class="op-switch-thumb"></span></span>
					<span>{$t('office.panel.distribute')}</span>
				</label>
				<p class="k-help">{$t('office.panel.distribute_help')}</p>
				{#if lead.kind === 'none'}
					<p class="k-help">{$t('office.panel.no_lead')}</p>
				{:else if lead.kind === 'many'}
					<p class="k-help">{$t('office.panel.many_leads')}</p>
				{:else if distribute === 'partial'}
					<p class="k-help">{$t('office.panel.distribute_partial')}</p>
				{/if}
				{#if manualChains > 0}<p class="k-help">{$t('office.panel.distribute_manual', { n: manualChains })}</p>{/if}
			</div>

			<div class="k-field">
				<label class="k-label" for={ids.cadence}>{$t('office.panel.cadence')}<span class="op-status">{statusText('cadence')}</span></label>
				<select id={ids.cadence} class="k-input" value={cadenceChoice} disabled={!leadId || fields.cadence?.status === 'saving'} on:change={onCadenceSelect}>
					{#each CADENCE_PRESETS as preset (preset)}<option value={preset}>{$t(`office.cadence.${preset}`)}</option>{/each}
					<option value="custom">{$t('office.cadence.custom')}</option>
				</select>
				{#if cadenceChoice === 'custom'}
					<input class="k-input" bind:value={cadenceCustom} placeholder={$t('office.cadence.custom_ph')} aria-label={$t('office.cadence.custom')}
						aria-invalid={!!cadenceError} disabled={!leadId || fields.cadence?.status === 'saving'} on:blur={applyCustomCadence} on:keydown={blurOnEnter} />
				{/if}
				{#if currentSchedule?.cron_expression}
					<p class="k-help">{$t('office.panel.cadence_cron', { cron: currentSchedule?.cron_expression ?? '' })}</p>
				{/if}
				<p class="k-help">{$t('office.cadence.help')}</p>
				{#if cadenceError}<p class="k-error" role="alert">{cadenceError}</p>{/if}
				{#if fields.cadence?.status === 'error'}<p class="k-error" role="alert">{statusText('cadence')}</p>{/if}
			</div>
			{#if teamError}<p class="k-error" role="alert">{teamError}</p>{/if}
			{#if actionError}<p class="k-error" role="alert">{actionError}</p>{/if}
		</section>

		<section class="op-section">
			<h3 class="k-section-title op-section-head">{$t('office.panel.repo')}<span class="op-status">{statusText('repo')}</span></h3>
			{#if repoEditing}
				<RepoPicker bind:value={repoDraft} label={$t('office.panel.repo_path')} required allowRegistered
					disabled={fields.repo?.status === 'saving'} invalid={fields.repo?.status === 'error'}
					on:change={() => (fields = { ...fields, repo: { status: 'idle' } })} />
				<label class="op-check">
					<input type="checkbox" bind:checked={repoGitInit} />
					<span>{$t('office.panel.repo_git_init')}</span>
				</label>
				<div class="op-row2">
					<button class="k-btn" type="button" disabled={!repoDraft.trim() || fields.repo?.status === 'saving'} on:click={() => saveRepo(repoDraft)}>
						<Icon name="check" />{$t('office.panel.repo_save')}
					</button>
					<button class="k-btn k-btn--ghost" type="button" on:click={() => (repoEditing = false)}>{$t('office.common.cancel')}</button>
				</div>
			{:else if repoPath}
				<div class="op-repo"><Icon name="branch" /><code>{repoPath}</code></div>
				{#if repoConfirmRemove}
					<div class="op-row2">
						<button class="k-btn k-btn--danger" type="button" disabled={fields.repo?.status === 'saving'} on:click={() => saveRepo(null)}>
							<Icon name="x" />{$t('office.panel.repo_remove_confirm')}
						</button>
						<button class="k-btn k-btn--ghost" type="button" on:click={() => (repoConfirmRemove = false)}>{$t('office.common.cancel')}</button>
					</div>
				{:else}
					<div class="op-row2">
						<button class="k-btn" type="button" on:click={startRepoEdit}><Icon name="pencil" />{$t('office.panel.repo_change')}</button>
						<button class="k-btn k-btn--ghost" type="button" disabled={fields.repo?.status === 'saving'} on:click={() => (repoConfirmRemove = true)}>
							<Icon name="x" />{$t('office.panel.repo_remove')}
						</button>
					</div>
				{/if}
				<p class="k-help">{$t('office.panel.repo_remove_help')}</p>
				<div class="k-field">
					<span class="k-label" id="k-op-iso">{$t('office.panel.isolation')}<span class="op-status">{statusText('isolation')}</span></span>
					<div class="k-segmented" role="radiogroup" aria-labelledby="k-op-iso">
						<button class="k-seg" type="button" role="radio" aria-checked={isolation === 'sandbox'}
							on:click={() => { if (isolation !== 'sandbox') void save('isolation', { repo_isolation: 'sandbox' }); }}>{$t('office.panel.sandbox')}</button>
						<button class="k-seg" type="button" role="radio" aria-checked={isolation === 'host'} disabled={hostAllowed === false && isolation !== 'host'}
							on:click={() => { if (isolation !== 'host') void save('isolation', { repo_isolation: 'host' }); }}>{$t('office.panel.host')}</button>
					</div>
					<p class="k-help">{$t('office.panel.isolation_help')}{#if hostAllowed === false} {$t('office.panel.host_off')}{/if}</p>
				</div>
				{#if hostBroken}
					<div class="op-callout" role="alert">
						<Icon name="alert" />
						<div>
							<p>{$t('office.panel.host_broken')}</p>
							<button class="k-btn" type="button" on:click={() => void save('isolation', { repo_isolation: 'sandbox' })}>{$t('office.panel.switch_sandbox')}</button>
						</div>
					</div>
				{/if}
			{:else}
				<p class="k-help">{$t('office.panel.no_repo')}</p>
				<button class="k-btn op-self-start" type="button" on:click={startRepoEdit}><Icon name="branch" />{$t('office.panel.repo_set')}</button>
			{/if}
			{#if fields.repo?.status === 'error'}<p class="k-error" role="alert">{statusText('repo')}</p>{/if}
			{#if repoNote}<p class="k-help">{repoNote}</p>{/if}
		</section>

		<section class="op-section">
			<h3 class="k-section-title">{$t('office.panel.environment')}</h3>
			{#if envAvailable === true}
				<OfficeInfraPanel flowId={office.id} officeName={office.name} color={office.color} />
			{:else if envAvailable === false}
				<LockedFeature title={$t('office.locked.environment_title')} description={$t('office.locked.environment_body')} />
			{/if}
		</section>
	{/if}

	<svelte:fragment slot="foot">
		{#if office}
			<div class="op-foot-left">
				<button class="k-btn k-btn--ghost" type="button" on:click={exportOffice}><Icon name="download" />{$t('office.panel.export')}</button>
				{#if traits.devopsLink}
					<a class="k-btn k-btn--ghost" href="/devops">{$t('office.panel.devops')}</a>
				{/if}
			</div>
			<button class="k-btn k-btn--danger" type="button" on:click={() => (deleteOpen = true)}><Icon name="trash" />{$t('office.panel.delete')}</button>
		{/if}
	</svelte:fragment>
</Drawer>

{#if office}
	<DeleteOfficeDialog
		open={deleteOpen}
		officeId={office.id}
		officeName={office.name}
		agentCount={deleteCount ?? agents.length}
		on:close={() => (deleteOpen = false)}
		on:deleted={(e) => { deleteOpen = false; dispatch('deleted', e.detail); }}
	/>
{/if}

<style>
	.op-top { display: flex; align-items: center; gap: 10px; }
	.op-dot { width: 12px; height: 12px; border-radius: 3px; flex: none; }
	.op-title { flex: 1; min-width: 0; margin: 0; font: 600 18px/1.2 var(--font-display); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.op-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
	.op-kind { font-family: var(--font-mono); letter-spacing: 0.04em; text-transform: uppercase; }
	.op-working { color: var(--green); }
	.op-section { display: grid; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--border); }
	.op-section:last-child { border-bottom: 0; }
	.op-status { margin-left: auto; font-weight: 400; font-size: 11.5px; color: var(--text-3); }
	.op-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.op-swatches { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 36px; }
	.op-swatch { width: 22px; height: 22px; padding: 0; border-radius: 6px; border: 2px solid transparent; cursor: pointer; }
	.op-swatch[aria-checked='true'] { border-color: var(--text-1); box-shadow: inset 0 0 0 2px var(--surface-1); }
	.op-swatch:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
	.op-members, .op-bring { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
	.op-member {
		display: grid; grid-template-columns: 16px 1fr auto 32px; align-items: center; gap: 10px;
		padding: 6px 6px 6px 10px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border);
	}
	.op-member-rank { color: var(--gold); display: grid; place-items: center; }
	.op-member-name { font: 600 13px/1.3 var(--font-body); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.op-open { width: 32px; padding: 0; }
	.op-menu {
		position: fixed; z-index: var(--z-modal); width: 232px; padding: 6px; display: grid; gap: 2px;
		background: var(--surface-2); border: 1px solid var(--border-h); border-radius: var(--radius);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45); outline: none;
	}
	.op-menu--up { box-shadow: 0 -16px 40px rgba(0, 0, 0, 0.45); }
	.op-menu-item {
		display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 0; border-radius: 6px;
		background: transparent; color: var(--text-1); font: 500 13px/1.2 var(--font-body); text-align: left; cursor: pointer;
	}
	.op-menu-item:hover, .op-menu-item:focus-visible { background: var(--surface-3); outline: none; }
	.op-menu-move { display: grid; gap: 4px; padding: 6px 8px; }
	.op-menu-label { display: flex; align-items: center; gap: 8px; font: 500 13px/1.2 var(--font-body); color: var(--text-2); }
	.op-bring-item {
		width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: var(--radius-sm);
		border: 1px dashed var(--border-h); background: transparent; color: var(--text-1); font: 500 13px/1.3 var(--font-body); cursor: pointer; text-align: left;
	}
	.op-bring-item:hover { border-color: var(--teal); }
	.op-toggle-row { display: grid; gap: 4px; }
	.op-switch { position: relative; display: flex; align-items: center; gap: 10px; cursor: pointer; font: 600 13px/1.3 var(--font-body); color: var(--text-1); }
	.op-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
	.op-switch-track {
		position: relative; flex: none; width: 32px; height: 18px; border-radius: 9px;
		background: var(--surface-3); border: 1px solid var(--border-h); transition: background 240ms var(--ease-out);
	}
	.op-switch-thumb {
		position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
		background: var(--text-2); transition: transform 240ms var(--ease-out);
	}
	.op-switch input:checked + .op-switch-track { background: var(--teal); border-color: var(--teal); }
	.op-switch input:checked + .op-switch-track .op-switch-thumb { transform: translateX(14px); background: var(--bg); }
	.op-switch input:focus-visible + .op-switch-track { outline: 2px solid var(--teal); outline-offset: 2px; }
	.op-switch input:disabled + .op-switch-track { opacity: 0.45; }
	.op-repo { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); }
	.op-repo code { font: 400 12px/1.4 var(--font-mono); color: var(--text-1); overflow-wrap: anywhere; }
	.op-section-head { display: flex; align-items: center; }
	.op-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2); cursor: pointer; }
	.op-check input { accent-color: var(--teal); }
	.op-self-start { justify-self: start; }
	.op-callout {
		display: grid; grid-template-columns: 16px 1fr; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--red) 8%, transparent); border: 1px solid color-mix(in srgb, var(--red) 30%, transparent); color: var(--text-1); font-size: 12.5px;
	}
	.op-callout p { margin: 0 0 8px; }
	.op-foot-left { display: flex; gap: 4px; }
	@media (prefers-reduced-motion: reduce) {
		.op-switch-track, .op-switch-thumb { transition: none; }
	}
</style>
