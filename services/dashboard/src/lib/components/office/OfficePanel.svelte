<script lang="ts" context="module">
	export interface PanelOffice {
		id: string;
		name: string;
		color: string;
		kind?: string | null;
		description?: string;
		repo_isolation?: string;
		home_repo_path?: string;
		/** 1 = switched off: its agents never run. */
		paused?: number;
	}

	export interface PanelMoveTarget {
		id: string;
		name: string;
		color: string;
	}
</script>

<script lang="ts">
	import OfficeProjects from './OfficeProjects.svelte';
	import OfficeQuestions from './OfficeQuestions.svelte';
	import type { PendingQuestion } from '../../../routes/agents-flow/world-types.js';
	import PanelHost from '$lib/components/panels/PanelHost.svelte';
	import { createEventDispatcher, onDestroy, tick } from 'svelte';
	import { extPages } from '$lib/ext-host.js';
	import Drawer from '$lib/components/ui/Drawer.svelte';
	import Icon, { type IconName } from '$lib/components/ui/Icon.svelte';
	import { hueOf } from '$lib/panels/look.js';
	import LockedFeature from '$lib/components/ui/LockedFeature.svelte';
	import OfficeInfraPanel from '$lib/components/OfficeInfraPanel.svelte';
	import DeleteOfficeDialog from './DeleteOfficeDialog.svelte';
	import RepoPicker from './RepoPicker.svelte';
	import { isAbsoluteHostPath } from '$lib/host-path.js';
	import { apiFetch, createAgent } from '$lib/api.js';
	import { t, locale } from '$lib/i18n/index.js';
	import { extWorlds, extensionKindLabel } from '$lib/world-plugins.js';
	import { OFFICE_KINDS, officeKindOf, traitsOf } from '$lib/office/office-kinds.js';
	import { OFFICE_PALETTE } from '$lib/office/office-palette.js';
	import { CADENCE_PRESETS, checkEvery, choiceForInterval, everyFor, parseEvery, type CadenceChoice } from '$lib/office/cadence.js';
	import {
		updateOffice,
		moveAgentToOffice,
		setOfficeLead,
		setLeadDistributes,
		setOfficePaused,
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
	import { fetchPanel } from '$lib/panels/client.js';
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
	/** View of the office's declared panels to open first (from ?panel= in the URL). */
	export let initialPanelView: string | null = null;

	const dispatch = createEventDispatcher<{ close: void; changed: void; agentopen: { id: string }; deleted: { unassigned: number; flowId: string } }>();

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

	// ── Tabs ───────────────────────────────────────────────────
	// Same strip as the agent drawer, tinted with the office colour so the
	// two panels never read as one. Panels only shows up when the office
	// declares some (panels.v1); it opens first because it is the office's
	// own working surface.
	type OfficeTab = 'panels' | 'questions' | 'general' | 'team' | 'repo' | 'projects' | 'environment';
	let tab: OfficeTab = 'general';
	let hasPanels = false;
	/** The operator picked a tab: the panels probe landing late must not yank them back. */
	let tabTouched = false;

	async function probePanels(flowId: string) {
		hasPanels = false;
		const res = await fetchPanel(flowId);
		if (office?.id !== flowId) return;
		hasPanels = !!res?.spec && (res.spec.views?.length ?? 0) > 0;
		if (hasPanels && !tabTouched && tab !== 'questions') tab = 'panels';
	}

	type TabItem = { id: OfficeTab; icon: IconName; label: string; count?: number; live?: boolean; warn?: boolean };
	$: tabList = [
		...(hasPanels ? [{ id: 'panels', icon: 'grid', label: $t('office.panel.tab_panels') } as TabItem] : []),
		{ id: 'questions', icon: 'help', label: $t('office.chief.tab_questions'), count: officeQuestions.length || undefined, warn: officeQuestions.length > 0 },
		{ id: 'general', icon: 'sliders', label: $t('office.panel.general') },
		{ id: 'team', icon: 'users', label: $t('office.panel.tab_team'), count: agents.length, live: working > 0 },
		{ id: 'repo', icon: 'branch', label: $t('office.panel.repo'), warn: hostBroken },
		{ id: 'projects', icon: 'folder', label: $t('office.panel.tab_projects') },
		{ id: 'environment', icon: 'server', label: $t('office.panel.environment') },
	] as TabItem[];

	// What this office waits on from the operator (pending + "Te toca"). Every
	// office has the tab: any agent can raise a question. Polled while open.
	let officeQuestions: PendingQuestion[] = [];
	async function loadOfficeQuestions() {
		const flowId = office?.id;
		if (!flowId) return;
		try {
			const lists = await Promise.all(['pending', 'owed'].map(async (st) => {
				const r = await fetch(`/api/agents/questions?status=${st}&limit=200`);
				return r.ok ? ((await r.json()).questions ?? []) as PendingQuestion[] : [];
			}));
			if (office?.id !== flowId) return;
			// A question keeps the office its agent was in when it asked: an agent
			// that moved since still brings its open questions to its new office.
			const members = new Set(agents.map((a) => a.id));
			officeQuestions = lists.flat().filter((q) => q.flow_id === flowId || members.has(q.from_agent_id));
			// Waiting on the operator wins over everything else the panel can open on.
			if (officeQuestions.length > 0 && !tabTouched) tab = 'questions';
		} catch { /* keep the last list */ }
	}
	const questionsTimer = setInterval(() => { if (open) void loadOfficeQuestions(); }, 20_000);
	onDestroy(() => clearInterval(questionsTimer));
	$: agentNames = Object.fromEntries(agents.map((a) => [a.id, a.name]));

	/** A member's avatar: initials on a colour that is theirs across every visit. */
	const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

	function selectTab(next: OfficeTab) {
		tab = next;
		tabTouched = true;
	}

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
		tab = 'general';
		tabTouched = false;
		officeQuestions = [];
		void probePanels(office.id);
		void loadOfficeQuestions();
	}
	// Kinds installed extensions declare (their own building in 3D) keep their id.
	$: extKinds = $extWorlds.flatMap((w) => w.kinds.map((k) => k.id));
	$: kind = office?.kind && extKinds.includes(office.kind) ? office.kind : officeKindOf(office);
	$: kindLabel = (k: string) => extensionKindLabel(k, $locale) ?? $t(`office.kind.${k}`);
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
		const value = (e.currentTarget as HTMLSelectElement).value;
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

	function togglePower() {
		if (!office) return;
		const flowId = office.id;
		const paused = office.paused !== 1;
		void teamAction('power', () => setOfficePaused(flowId, paused));
	}

	// Switched off while runs are still finishing: "Cortar ya" cancels them.
	$: draining = office?.paused === 1 && working > 0;
	function cutNow() {
		if (!office) return;
		const flowId = office.id;
		void teamAction('power', () => setOfficePaused(flowId, true, true));
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

<Drawer open={open && !!office} {top} width="clamp(480px, 64vw, 1080px)" label={office ? $t('office.panel.label', { name: office.name }) : ''} on:close>
	<svelte:fragment slot="head">
		{#if office}
			<div class="op-hero" style="--oc:{office.color}">
				<div class="op-top">
					<span class="op-glyph" aria-hidden="true">{initials(office.name)}</span>
					<div class="op-head-txt">
						<h2 class="op-title">{office.name}</h2>
						<div class="op-chips">
							<span class="op-chip op-kind">{kindLabel(kind)}</span>
							<span class="op-chip op-agents"><Icon name="users" size={12} />{$t('office.panel.agents', { n: agents.length })}</span>
							{#if working > 0}
								<span class="op-chip op-working"><i aria-hidden="true"></i>{$t('office.panel.working', { n: working })}</span>
							{/if}
							{#if draining}
								<span class="op-chip op-off">{$t('office.power.draining', { n: working })}</span>
								<button class="op-chip op-cut" type="button" disabled={busy === 'power'} title={$t('office.power.cut_now_help')} on:click={cutNow}>{$t('office.power.cut_now')}</button>
							{:else if office.paused === 1}<span class="op-chip op-off">{$t('office.power.off_help')}</span>{/if}
						</div>
					</div>
					<button class="op-power" class:on={office.paused !== 1} type="button" role="switch" aria-checked={office.paused !== 1}
						disabled={busy === 'power'}
						title={$t(office.paused === 1 ? 'office.power.turn_on' : 'office.power.turn_off')}
						on:click={togglePower}>
						<span class="op-power-sw" aria-hidden="true"><span></span></span>{$t(office.paused === 1 ? 'office.power.off' : 'office.power.on')}
					</button>
					<button class="op-close" type="button" aria-label={$t('office.common.close')} on:click={() => dispatch('close')}><Icon name="x" /></button>
				</div>
				<div class="op-tabs" role="tablist" aria-label={$t('office.panel.tabs_label')}>
					{#each tabList as it (it.id)}
						<button class="op-tab" role="tab" type="button" aria-selected={tab === it.id} class:active={tab === it.id} on:click={() => selectTab(it.id)}>
							<Icon name={it.icon} size={14} />
							<span>{it.label}</span>
							{#if it.count !== undefined}<span class="op-tab-count">{it.count}</span>{/if}
							{#if it.live}<span class="op-tab-live" aria-hidden="true"></span>{/if}
							{#if it.warn}<span class="op-tab-warn" aria-hidden="true">!</span>{/if}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</svelte:fragment>

	{#if office}
		<!-- The office's own panels (panels.v1). The tab only exists when it declares some. -->
		{#if tab === 'panels' && hasPanels}
		<section class="op-panels" style="--oc:{office.color}">
			<PanelHost flowId={office.id} initialView={initialPanelView} />
		</section>
		{/if}
		{#if tab === 'general'}
		<div class="op-grid2">
		<section class="op-section" style="--hue:#22D3EE">
			<h3 class="op-h">{$t('office.panel.identity')}</h3>
			<div class="k-field">
				<label class="k-label" for={ids.name}>{$t('office.panel.name')}<span class="op-status">{statusText('name')}</span></label>
				<input id={ids.name} class="k-input" bind:value={name} aria-invalid={nameTaken} maxlength="40"
					on:blur={saveName} on:keydown={blurOnEnter} />
				{#if nameTaken}<p class="k-error">{$t('office.panel.name_taken')}</p>{/if}
			</div>
			<div class="k-field">
				<label class="k-label" for={ids.purpose}>{$t('office.panel.purpose')}<span class="op-status">{statusText('purpose')}</span></label>
				<textarea id={ids.purpose} class="k-input" rows="4" bind:value={purpose} placeholder={$t('office.panel.purpose_ph')} on:blur={savePurpose}></textarea>
			</div>
		</section>
		<section class="op-section" style="--hue:{office.color}">
			<h3 class="op-h">{$t('office.panel.look')}</h3>
			<div class="op-look">
				<div class="k-field">
					<span class="k-label" id="k-op-color">{$t('office.panel.color')}<span class="op-status">{statusText('color')}</span></span>
					<div class="op-swatches" role="radiogroup" aria-labelledby="k-op-color">
						{#each palette as color, i (color)}
							<button class="op-swatch" type="button" role="radio" aria-checked={office.color === color} aria-label={$t('office.common.color_n', { n: i + 1, total: palette.length })}
								style="background:{color};--sw:{color}" on:click={() => { if (office && office.color !== color) void save('color', { color }); }}></button>
						{/each}
					</div>
				</div>
				<div class="k-field">
					<label class="k-label" for={ids.kind}>{$t('office.panel.kind')}<span class="op-status">{statusText('kind')}</span></label>
					<select id={ids.kind} class="k-input" value={kind} title={$t('office.kind.help')}
						on:change={saveKind}>
						{#each [...OFFICE_KINDS, ...extKinds] as k (k)}<option value={k}>{kindLabel(k)}</option>{/each}
					</select>
				</div>
			</div>
			{#each ['name', 'color', 'kind', 'purpose'] as field (field)}
				{#if fields[field]?.status === 'error'}<p class="k-error" role="alert">{statusText(field)}</p>{/if}
			{/each}
		</section>
		</div>

		<section class="op-section op-danger" style="--hue:#F43F5E">
			<div class="op-danger-txt">
				<h3 class="op-h">{$t('office.panel.danger')}</h3>
				<p class="k-help">{$t('office.panel.danger_help')}</p>
			</div>
			<button class="k-btn k-btn--danger" type="button" on:click={() => (deleteOpen = true)}><Icon name="trash" />{$t('office.panel.delete')}</button>
		</section>
		{/if}

		{#if tab === 'team'}
		<section class="op-section" style="--hue:#A78BFA">
			<h3 class="op-h">{$t('office.panel.team', { n: agents.length })}</h3>
			{#if agents.length === 0}
				<p class="k-help">{$t('office.panel.no_agents')}</p>
			{:else}
				<ul class="op-members">
					{#each agents as agent (agent.id)}
						<li class="op-member" class:lead={agent.lead} style="--hue:{hueOf(agent.name)}">
							<button class="op-member-main" type="button" on:click={() => openMember(agent.id)} title={$t('office.panel.menu_open')}>
								<span class="op-avatar" aria-hidden="true">{initials(agent.name)}{#if agent.lead}<span class="op-crown"><Icon name="star" size={10} filled /></span>{/if}</span>
								<span class="op-member-name">{agent.name}{#if agent.lead}<small>{$t('office.rail.lead')}</small>{/if}</span>
							</button>
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
				<button class="k-btn op-cta" type="button" disabled={busy === 'new'} on:click={addAgent}><Icon name="plus" />{$t('office.panel.new_agent')}</button>
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

			{#if teamError}<p class="k-error" role="alert">{teamError}</p>{/if}
			{#if actionError}<p class="k-error" role="alert">{actionError}</p>{/if}
		</section>

		<section class="op-section" style="--hue:#FBBF24">
			<h3 class="op-h">{$t('office.panel.coordination')}</h3>
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
		</section>
		{/if}

		{#if tab === 'repo'}
		<section class="op-section" style="--hue:#34D399">
			<h3 class="op-h">{$t('office.panel.repo')}<span class="op-status">{statusText('repo')}</span></h3>
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
		{/if}

		{#if tab === 'questions'}
		<section class="op-section" style="--hue:#F0B874">
			<h3 class="op-h">{$t('office.chief.tab_questions')}</h3>
			<OfficeQuestions questions={officeQuestions} {agentNames} color={office.color} onChanged={loadOfficeQuestions} />
		</section>
		{/if}

		{#if tab === 'projects'}
		<section class="op-section" style="--hue:#60A5FA">
			<h3 class="op-h">{$t('office.panel.tab_projects')}</h3>
			<OfficeProjects flowId={office.id} leadId={agents.find((a) => a.lead)?.id ?? null} />
		</section>
		{/if}

		{#if tab === 'environment'}
		<section class="op-section" style="--hue:#FB923C">
			<h3 class="op-h">{$t('office.panel.environment')}</h3>
			{#if envAvailable === true}
				<OfficeInfraPanel flowId={office.id} officeName={office.name} color={office.color} />
			{:else if envAvailable === false}
				<LockedFeature title={$t('office.locked.environment_title')} description={$t('office.locked.environment_body')} />
			{/if}
		</section>
		{/if}
	{/if}

	<svelte:fragment slot="foot">
		{#if office}
			<div class="op-foot-left">
				<button class="k-btn k-btn--ghost" type="button" on:click={exportOffice}><Icon name="download" />{$t('office.panel.export')}</button>
				{#if traits.devopsLink && $extPages.some((p) => p.view === 'devops')}
					<a class="k-btn k-btn--ghost" href="/devops">{$t('office.panel.devops')}</a>
				{/if}
			</div>
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
	/* ── Hero: the office's colour washes the whole header, so an office panel is
	   never mistaken for an agent's. Same bright language as Sistema → Resumen. */
	.op-hero {
		margin: -16px -16px -14px -20px; padding: 16px 16px 0 20px;
		background:
			radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--oc) 30%, transparent), transparent 60%),
			linear-gradient(180deg, color-mix(in srgb, var(--oc) 12%, var(--surface-1)), var(--surface-1));
		border-bottom: 1px solid color-mix(in srgb, var(--oc) 35%, var(--border));
	}
	.op-top { display: flex; align-items: center; gap: 12px; }
	.op-glyph {
		flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 13px;
		font: 800 16px var(--font-display); color: #fff; letter-spacing: .02em;
		background: linear-gradient(140deg, var(--oc), color-mix(in srgb, var(--oc) 55%, #A78BFA));
		box-shadow: 0 10px 24px -10px var(--oc), inset 0 1px 0 rgba(255, 255, 255, .25);
	}
	.op-head-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
	.op-title { margin: 0; font: 800 20px/1.15 var(--font-display); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.op-chips { display: flex; flex-wrap: wrap; gap: 6px; }
	.op-chip {
		--tone: #A78BFA;
		display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px;
		font: 800 10px var(--font-body); letter-spacing: .04em;
		color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 18%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
	}
	.op-kind { --tone: var(--oc); text-transform: uppercase; }
	.op-agents { --tone: #22D3EE; }
	.op-working { --tone: #34D399; box-shadow: 0 0 12px -4px #34D399; }
	.op-working i { width: 7px; height: 7px; border-radius: 50%; background: #34D399; box-shadow: 0 0 8px #34D399; animation: op-pulse 1.4s ease-in-out infinite; }
	.op-off { --tone: #FBBF24; }
	.op-cut { --tone: #F87171; cursor: pointer; }
	.op-cut:hover:not(:disabled) { background: color-mix(in srgb, var(--tone) 32%, transparent); }
	.op-cut:disabled { opacity: .55; cursor: wait; }
	.op-cut:focus-visible { outline: 2px solid var(--tone); outline-offset: 2px; }
	.op-power {
		flex: none; display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 14px 0 6px; border-radius: 999px; cursor: pointer;
		font: 700 12px var(--font-body); color: #FBBF24;
		background: color-mix(in srgb, currentColor 10%, var(--surface-1)); border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
		transition: color .25s, background .25s, border-color .25s, box-shadow .25s;
	}
	.op-power.on { color: #34D399; box-shadow: 0 8px 20px -12px #34D399; }
	.op-power:hover:not(:disabled) { background: color-mix(in srgb, currentColor 18%, var(--surface-1)); }
	.op-power:disabled { opacity: .55; cursor: wait; }
	.op-power:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
	.op-power-sw { position: relative; width: 30px; height: 18px; border-radius: 999px; background: color-mix(in srgb, currentColor 30%, transparent); }
	.op-power-sw span { position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%; background: currentColor; box-shadow: 0 1px 3px rgba(0, 0, 0, .4); transition: transform .28s cubic-bezier(.34, 1.56, .64, 1); }
	.op-power.on .op-power-sw span { transform: translateX(12px); }
	.op-close {
		flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; cursor: pointer;
		color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border); transition: all .15s;
	}
	.op-close:hover { color: #F43F5E; border-color: color-mix(in srgb, #F43F5E 45%, transparent); background: color-mix(in srgb, #F43F5E 12%, var(--surface-2)); }
	.op-close:focus-visible { outline: 2px solid #F43F5E; outline-offset: 2px; }

	/* ── Tabs: icon + word, the open one a lit pill in the office colour. */
	.op-tabs { display: flex; gap: 4px; margin-top: 14px; padding-bottom: 10px; overflow-x: auto; scrollbar-width: none; }
	.op-tabs::-webkit-scrollbar { display: none; }
	.op-tab {
		flex: none; display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px; border-radius: 10px; cursor: pointer;
		border: 1px solid transparent; background: none; color: var(--text-2); font: 700 12.5px var(--font-body);
		transition: color .15s, background .2s, border-color .2s, box-shadow .2s, transform .2s ease-out;
	}
	.op-tab :global(svg) { color: color-mix(in srgb, var(--oc) 70%, white); opacity: .8; }
	.op-tab:hover { color: var(--text-1); background: color-mix(in srgb, var(--oc) 12%, transparent); transform: translateY(-1px); }
	.op-tab.active {
		color: #fff; border-color: color-mix(in srgb, var(--oc) 70%, transparent);
		background: linear-gradient(135deg, color-mix(in srgb, var(--oc) 42%, var(--surface-2)), color-mix(in srgb, var(--oc) 18%, var(--surface-2)));
		box-shadow: 0 10px 22px -12px var(--oc);
	}
	.op-tab.active :global(svg) { color: #fff; opacity: 1; }
	.op-tab:focus-visible { outline: 2px solid var(--oc); outline-offset: 2px; }
	.op-tab-count {
		font: 800 10px var(--font-body); padding: 1px 7px; border-radius: 999px;
		color: color-mix(in srgb, var(--oc) 60%, white); background: color-mix(in srgb, var(--oc) 22%, transparent); border: 1px solid color-mix(in srgb, var(--oc) 45%, transparent);
	}
	.op-tab.active .op-tab-count { color: #fff; background: rgba(255, 255, 255, .16); border-color: rgba(255, 255, 255, .3); }
	.op-tab-live { width: 7px; height: 7px; border-radius: 50%; background: #34D399; box-shadow: 0 0 8px #34D399; animation: op-pulse 1.4s ease-in-out infinite; }
	.op-tab-warn { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: #F43F5E; color: #fff; font: 800 10px var(--font-body); box-shadow: 0 0 8px #F43F5E; }

	/* ── Body: every block a card tinted by its own hue. */
	.op-panels { padding: 14px 0 6px; }
	.op-grid2 { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 12px; margin-top: 14px; }
	.op-section {
		--hue: #22D3EE;
		display: grid; gap: 12px; align-content: start; margin-top: 14px; padding: 14px 16px; border-radius: 14px;
		background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 9%, var(--surface-1)), var(--surface-1) 55%);
		border: 1px solid color-mix(in srgb, var(--hue) 26%, var(--border));
	}
	.op-grid2 > .op-section { margin-top: 0; }
	.op-h {
		margin: 0; display: flex; align-items: center; gap: 8px;
		font: 800 10.5px var(--font-body); text-transform: uppercase; letter-spacing: .07em; color: color-mix(in srgb, var(--hue) 65%, white);
	}
	.op-h::before { content: ''; width: 3px; height: 12px; border-radius: 2px; background: linear-gradient(var(--hue), #A78BFA); box-shadow: 0 0 8px var(--hue); flex: none; }
	.op-status { margin-left: auto; font-weight: 600; font-size: 11px; text-transform: none; letter-spacing: 0; color: var(--text-3); }
	.op-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
	.op-look { display: grid; gap: 12px; }
	.op-swatches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
	.op-swatch {
		width: 28px; height: 28px; padding: 0; border-radius: 9px; border: 2px solid transparent; cursor: pointer;
		transition: transform .2s cubic-bezier(.34, 1.56, .64, 1), box-shadow .2s;
	}
	.op-swatch:hover { transform: translateY(-2px) scale(1.08); }
	.op-swatch[aria-checked='true'] { border-color: #fff; box-shadow: 0 0 0 2px var(--surface-1), 0 6px 16px -4px var(--sw); transform: scale(1.1); }
	.op-swatch:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }

	/* Members: tiles with an avatar in the member's own colour. */
	.op-members, .op-bring { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
	.op-members { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
	.op-member {
		display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 8px; border-radius: 12px; min-width: 0;
		background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 14%, var(--surface-1)), var(--surface-1) 70%);
		border: 1px solid color-mix(in srgb, var(--hue) 30%, var(--border));
		transition: transform .2s ease-out, box-shadow .2s, border-color .2s;
	}
	.op-member:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--hue) 60%, var(--border)); box-shadow: 0 10px 22px -16px var(--hue); }
	.op-member.lead { border-color: color-mix(in srgb, #FBBF24 55%, var(--border)); }
	.op-member-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 0; border: 0; background: none; cursor: pointer; text-align: left; color: inherit; }
	.op-member-main:focus-visible { outline: 2px solid var(--hue); outline-offset: 2px; border-radius: 8px; }
	.op-avatar {
		position: relative; flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%;
		font: 800 12px var(--font-body); color: #fff;
		background: linear-gradient(140deg, var(--hue), color-mix(in srgb, var(--hue) 50%, #1e1b4b));
		box-shadow: 0 6px 14px -6px var(--hue);
	}
	.op-crown { position: absolute; right: -4px; top: -4px; display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: #FBBF24; color: #3b2a00; box-shadow: 0 0 8px #FBBF24; }
	.op-member-name { display: flex; flex-direction: column; min-width: 0; font: 700 13px/1.25 var(--font-body); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.op-member-name small { font: 800 9.5px var(--font-body); text-transform: uppercase; letter-spacing: .05em; color: #FBBF24; }
	.op-open { width: 32px; padding: 0; flex: none; }
	.op-cta { border-color: color-mix(in srgb, #22D3EE 50%, var(--border)); background: linear-gradient(135deg, color-mix(in srgb, #22D3EE 20%, var(--surface-2)), color-mix(in srgb, #A78BFA 16%, var(--surface-2))); color: var(--text-1); }
	.op-cta:hover:not(:disabled) { box-shadow: 0 10px 22px -12px #22D3EE; }
	.op-menu {
		position: fixed; z-index: var(--z-modal); width: 232px; padding: 6px; display: grid; gap: 2px;
		background: linear-gradient(180deg, #1d1f27, #16171d); border: 1px solid rgba(140, 150, 190, .22); border-radius: 12px;
		box-shadow: 0 18px 48px rgba(0, 0, 0, .55); outline: none;
	}
	.op-menu--up { box-shadow: 0 -16px 40px rgba(0, 0, 0, 0.45); }
	.op-menu-item {
		display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 0; border-radius: 8px;
		background: transparent; color: var(--text-1); font: 600 13px/1.2 var(--font-body); text-align: left; cursor: pointer;
	}
	.op-menu-item:hover, .op-menu-item:focus-visible { background: color-mix(in srgb, #22D3EE 14%, transparent); outline: none; }
	.op-menu-move { display: grid; gap: 4px; padding: 6px 8px; }
	.op-menu-label { display: flex; align-items: center; gap: 8px; font: 500 13px/1.2 var(--font-body); color: var(--text-2); }
	.op-bring { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
	.op-bring-item {
		width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px; min-height: 38px;
		border: 1px dashed color-mix(in srgb, #22D3EE 40%, var(--border)); background: color-mix(in srgb, #22D3EE 5%, transparent);
		color: var(--text-1); font: 600 12.5px/1.3 var(--font-body); cursor: pointer; text-align: left; transition: all .15s;
	}
	.op-bring-item :global(svg) { color: #22D3EE; }
	.op-bring-item:hover { border-style: solid; border-color: #22D3EE; background: color-mix(in srgb, #22D3EE 12%, transparent); }
	.op-toggle-row { display: grid; gap: 4px; }
	.op-switch { position: relative; display: flex; align-items: center; gap: 10px; cursor: pointer; font: 700 13px/1.3 var(--font-body); color: var(--text-1); }
	.op-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
	.op-switch-track {
		position: relative; flex: none; width: 36px; height: 20px; border-radius: 10px;
		background: var(--surface-3); border: 1px solid var(--border-h); transition: background 240ms var(--ease-out), box-shadow 240ms;
	}
	.op-switch-thumb {
		position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%;
		background: var(--text-2); transition: transform 280ms cubic-bezier(.34, 1.56, .64, 1);
	}
	.op-switch input:checked + .op-switch-track { background: #FBBF24; border-color: #FBBF24; box-shadow: 0 0 12px -2px #FBBF24; }
	.op-switch input:checked + .op-switch-track .op-switch-thumb { transform: translateX(16px); background: #1a1300; }
	.op-switch input:focus-visible + .op-switch-track { outline: 2px solid #FBBF24; outline-offset: 2px; }
	.op-switch input:disabled + .op-switch-track { opacity: 0.45; }
	.op-repo {
		display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; color: #34D399;
		background: color-mix(in srgb, #34D399 10%, var(--surface-1)); border: 1px solid color-mix(in srgb, #34D399 35%, var(--border));
	}
	.op-repo code { font: 500 12.5px/1.4 var(--font-mono); color: var(--text-1); overflow-wrap: anywhere; }
	.op-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2); cursor: pointer; }
	.op-check input { accent-color: #34D399; }
	.op-self-start { justify-self: start; }
	.op-callout {
		display: grid; grid-template-columns: 16px 1fr; gap: 8px; padding: 10px 12px; border-radius: 10px; color: var(--text-1); font-size: 12.5px;
		background: color-mix(in srgb, #F43F5E 10%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 40%, transparent);
	}
	.op-callout :global(svg) { color: #F43F5E; }
	.op-callout p { margin: 0 0 8px; }
	.op-danger { grid-template-columns: 1fr auto; align-items: center; margin-top: 12px; }
	.op-danger-txt { display: grid; gap: 4px; }
	.op-danger .k-help { margin: 0; }
	.op-foot-left { display: flex; gap: 4px; }

	@keyframes op-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: .7; } }
	@media (max-width: 760px) { .op-grid2, .op-row2 { grid-template-columns: minmax(0, 1fr); } }
	@media (prefers-reduced-motion: reduce) {
		.op-switch-track, .op-switch-thumb, .op-tab, .op-member, .op-swatch, .op-power, .op-power-sw span { transition: none; }
		.op-tab:hover, .op-member:hover, .op-swatch:hover { transform: none; }
		.op-working i, .op-tab-live { animation: none; }
	}
</style>
