<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import OfficeBlueprint from './OfficeBlueprint.svelte';
	import RepoPicker from './RepoPicker.svelte';
	import { t, locale } from '$lib/i18n/index.js';
	import { OFFICE_KINDS } from '$lib/office/office-kinds.js';
	import { OFFICE_PALETTE } from '$lib/office/office-palette.js';
	import { CADENCE_PRESETS, everyFor, humanEvery } from '$lib/office/cadence.js';
	import { reviewSummary } from '$lib/office/review-summary.js';
	import {
		LEAD_TOOLS, emptyWizard, newAgentRow, wizardFromTemplate, wizardFromDraft, definitionFromWizard,
		officeStepErrors, teamStepErrors, namedAgents, leadOf, type WizardError,
	} from '$lib/office/wizard-model.js';
	import {
		draftOffice, createOfficeFromWizard, type OfficeReport, type OfficeTemplate, type OfficeTemplatesResponse,
	} from '$lib/office/office-api.js';

	export let open = false;
	export let templates: OfficeTemplatesResponse | null = null;
	export let templatesError = false;
	export let existingNames: string[] = [];

	const dispatch = createEventDispatcher<{ close: void; created: { report: OfficeReport; name: string; agentCount: number } }>();
	const STEPS = [1, 2, 3, 4] as const;
	type Step = (typeof STEPS)[number];
	const STEP_KEYS: Record<Step, string> = {
		1: 'office.wizard.step_template',
		2: 'office.wizard.step_office',
		3: 'office.wizard.step_team',
		4: 'office.wizard.step_review',
	};

	let step: Step = 1;
	let state = emptyWizard();
	let description = '';
	let drafting = false;
	let draftMessage = '';
	/** The kernel's own reason, shown under the message. Folded away because it
	 *  is schema talk ("agents[0].prompt is required") — useful to whoever is
	 *  debugging the model, noise to everyone else. */
	let draftDetail = '';
	let creating = false;
	let createMessage = '';
	let showErrors = false;
	let wasOpen = false;
	/** Names the create step has rejected as taken, merged into `existingNames`
	 *  without reassigning the prop the parent passed in. */
	let knownNames: string[] = [];

	$: if (open !== wasOpen) {
		wasOpen = open;
		if (open) {
			step = 1;
			state = emptyWizard();
			description = '';
			draftMessage = '';
			createMessage = '';
			showErrors = false;
			knownNames = [];
		}
	}

	$: language = ($locale === 'es' ? 'es' : 'en') as 'es' | 'en';
	$: hostAllowed = templates?.host_allowed ?? false;
	$: allNames = [...existingNames, ...knownNames];
	$: officeErrors = officeStepErrors(state, allNames);
	$: teamErrors = teamStepErrors(state);
	$: every = everyFor(state.cadence, state.customEvery);
	$: named = namedAgents(state);
	$: lead = leadOf(state);
	$: workers = named.filter((a) => a !== lead);
	$: blueprintAgents = named.map((a) => ({ name: a.name, lead: a.lead }));
	$: repoName = state.useRepo && state.repoPath.trim() ? state.repoPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || state.repoPath : null;
	$: summary = reviewSummary({ officeName: state.name, agents: blueprintAgents, chain: state.chain, every, repoName, isolation: state.isolation, language });

	function errorText(error: WizardError): string {
		return $t(`office.wizard.err_${error}`);
	}

	function chooseTemplate(template: OfficeTemplate) {
		if (template.source !== 'builtin') return;
		state = wizardFromTemplate(template, state);
		step = 2;
		showErrors = false;
	}

	function extensionAction(template: OfficeTemplate): { label: string; href: string | null; locked: boolean } {
		const ext = template.extension;
		if (!ext) return { label: '', href: null, locked: false };
		if (ext.installed && ext.enabled) return { label: $t('office.wizard.ext_ready'), href: null, locked: false };
		if (ext.entitlement && !ext.entitlement.licensed) return { label: $t('office.locked.store'), href: '/extensions', locked: true };
		if (ext.installed) return { label: $t('office.wizard.ext_enable'), href: '/extensions', locked: false };
		return { label: $t('office.wizard.ext_install'), href: '/extensions', locked: false };
	}

	async function draft() {
		drafting = true;
		draftMessage = '';
		draftDetail = '';
		const result = await draftOffice(description, language);
		drafting = false;
		if (result.ok) {
			state = wizardFromDraft(result.definition, state);
			step = 2;
			showErrors = false;
		} else if (result.reason === 'invalid') {
			// The kernel retries once with the validation error fed back, so
			// reaching here means the model missed the schema twice. Saying
			// "describe it better" would blame the operator for that, and they
			// would rewrite a description that was never the problem — so name
			// the model when the kernel reports one.
			draftMessage = result.model
				? $t('office.wizard.draft_invalid_model', { model: result.model })
				: $t('office.wizard.draft_invalid');
			draftDetail = result.detail ?? '';
		} else {
			draftMessage = result.message;
		}
	}

	function next() {
		if ((step === 2 && officeErrors.length > 0) || (step === 3 && teamErrors.length > 0)) {
			showErrors = true;
			return;
		}
		showErrors = false;
		createMessage = '';
		if (step < 4) step = (step + 1) as Step;
	}

	function back() {
		showErrors = false;
		if (step > 1) step = (step - 1) as Step;
	}

	function setLead(key: string) {
		state = { ...state, agents: state.agents.map((a) => ({ ...a, lead: a.key === key })) };
	}

	function addAgent() {
		state = { ...state, agents: [...state.agents, newAgentRow()] };
	}

	function removeAgent(key: string) {
		let rest = state.agents.filter((a) => a.key !== key);
		if (rest.length === 0) rest = [newAgentRow({ lead: true })];
		if (!rest.some((a) => a.lead)) rest = [{ ...rest[0], lead: true }, ...rest.slice(1)];
		state = { ...state, agents: rest };
	}

	async function found() {
		creating = true;
		createMessage = '';
		const definition = definitionFromWizard(state);
		const result = await createOfficeFromWizard(definition);
		creating = false;
		if (result.ok) {
			dispatch('created', { report: result.report, name: definition.name, agentCount: definition.agents.length });
		} else if (result.reason === 'exists') {
			knownNames = [...knownNames, definition.name];
			step = 2;
			showErrors = true;
			createMessage = $t('office.wizard.exists', { name: definition.name });
		} else {
			createMessage = $t('office.wizard.failed', { error: result.message });
		}
	}
</script>

<Modal {open} title={$t('office.wizard.title')} width="960px" on:close={() => dispatch('close')}>
	<svelte:fragment slot="header">
		<ol class="wz-steps" aria-label={$t('office.wizard.steps_label')}>
			{#each STEPS as s (s)}
				<li class="wz-step" class:wz-step--done={s < step} class:wz-step--current={s === step} aria-current={s === step ? 'step' : undefined}>
					<span class="wz-step-n">{#if s < step}<Icon name="check" size={11} />{:else}{s}{/if}</span>{$t(STEP_KEYS[s])}
				</li>
			{/each}
		</ol>
	</svelte:fragment>

	{#if step === 1}
		{#if templatesError}<p class="k-error">{$t('office.wizard.templates_failed')}</p>{/if}
		{#if !templates && !templatesError}
			<p class="k-help">{$t('office.wizard.templates_loading')}</p>
		{:else if templates}
			<div class="wz-gallery">
				{#each templates.templates as template (template.id)}
					{#if template.source === 'builtin'}
						<button class="wz-card" type="button" on:click={() => chooseTemplate(template)}>
							<span class="wz-mini" style="--office:{template.color}" aria-hidden="true">
								{#if template.agents.length === 0}
									<span class="wz-mini-empty">{$t('office.wizard.empty_room')}</span>
								{:else}
									{#each template.agents.slice(0, 6) as agent, i (i)}
										<span class="wz-mini-desk" class:wz-mini-desk--lead={agent.role === 'manager'}></span>
									{/each}
								{/if}
							</span>
							<span class="wz-card-body">
								<span class="wz-card-name">{template.name}</span>
								<span class="wz-card-desc">{template.description}</span>
								{#if template.agents.length > 0}
									<span class="wz-roles">
										{#each template.agents as agent, i (i)}
											<span class="wz-role">{#if agent.role === 'manager'}<Icon name="star" size={11} filled />{/if}{agent.name}</span>
										{/each}
									</span>
								{/if}
							</span>
						</button>
					{:else}
						{@const action = extensionAction(template)}
						<article class="wz-card wz-card--ext">
							<span class="wz-card-body">
								<span class="wz-card-top">
									<span class="wz-card-name">{template.name}</span>
									{#if action.locked}<span class="wz-tag wz-tag--pro"><Icon name="lock" size={11} />{$t('office.common.pro')}</span>{/if}
								</span>
								<span class="wz-card-desc">{template.description}</span>
								<span class="k-help">{$t('office.wizard.ext_note')}</span>
								{#if action.href}
									<a class="k-btn wz-card-action" href={action.href}>{action.label}</a>
								{:else}
									<span class="wz-card-ready"><Icon name="check" size={13} />{action.label}</span>
								{/if}
							</span>
						</article>
					{/if}
				{/each}
			</div>
		{/if}

		<div class="wz-or"><span>{$t('office.wizard.or_describe')}</span></div>
		<div class="wz-describe">
			<div class="k-field">
				<label class="k-label" for="wz-describe">{$t('office.wizard.describe_label')}</label>
				<textarea id="wz-describe" class="k-input" rows="3" maxlength="2000" bind:value={description} placeholder={$t('office.wizard.describe_ph')}></textarea>
			</div>
			<button class="k-btn" type="button" disabled={drafting || !description.trim()} on:click={draft}>
				<Icon name="spark" />{drafting ? $t('office.wizard.drafting') : $t('office.wizard.draft')}
			</button>
		</div>
		{#if draftMessage}
			<p class="k-error" role="alert">{draftMessage}</p>
			{#if draftDetail}
				<details class="wz-draft-detail"><summary>{$t('office.wizard.draft_detail')}</summary><code>{draftDetail}</code></details>
			{/if}
		{/if}
		<p class="k-help">{$t('office.wizard.draft_note')}</p>
	{:else}
		<div class="wz-grid">
			<div class="wz-form">
				{#if step === 2}
					<div class="k-field">
						<label class="k-label" for="wz-name">{$t('office.wizard.name')}</label>
						<input id="wz-name" class="k-input" maxlength="40" bind:value={state.name} placeholder={$t('office.wizard.name_ph')}
							aria-invalid={showErrors && (officeErrors.includes('name_required') || officeErrors.includes('name_taken'))} />
						{#if showErrors}
							{#each officeErrors.filter((e) => e.startsWith('name')) as error (error)}<p class="k-error">{errorText(error)}</p>{/each}
						{/if}
						{#if createMessage}<p class="k-error" role="alert">{createMessage}</p>{/if}
					</div>
					<div class="wz-row2">
						<div class="k-field">
							<span class="k-label" id="wz-color">{$t('office.panel.color')}</span>
							<div class="wz-swatches" role="radiogroup" aria-labelledby="wz-color">
								{#each OFFICE_PALETTE as color, i (color)}
									<button class="wz-swatch" type="button" role="radio" aria-checked={state.color === color} aria-label={$t('office.common.color_n', { n: i + 1, total: OFFICE_PALETTE.length })}
										style="background:{color}" on:click={() => (state = { ...state, color })}></button>
								{/each}
							</div>
						</div>
						<div class="k-field">
							<label class="k-label" for="wz-kind">{$t('office.panel.kind')}</label>
							<select id="wz-kind" class="k-input" bind:value={state.kind} title={$t('office.kind.help')}>
								{#each OFFICE_KINDS as kind (kind)}<option value={kind}>{$t(`office.kind.${kind}`)}</option>{/each}
							</select>
						</div>
					</div>
					<div class="k-field">
						<label class="k-label" for="wz-purpose">{$t('office.panel.purpose')}</label>
						<textarea id="wz-purpose" class="k-input" rows="2" bind:value={state.purpose} placeholder={$t('office.panel.purpose_ph')}></textarea>
					</div>
					<label class="wz-check">
						<input type="checkbox" bind:checked={state.useRepo} />
						<span>{$t('office.wizard.use_repo')}</span>
					</label>
					{#if state.useRepo}
						<RepoPicker bind:value={state.repoPath} label={$t('office.wizard.repo_label')} required allowRegistered
							invalid={showErrors && officeErrors.includes('repo_required')} />
						{#if showErrors && officeErrors.includes('repo_required')}<p class="k-error">{errorText('repo_required')}</p>{/if}
						<div class="k-field">
							<span class="k-label" id="wz-iso">{$t('office.panel.isolation')}</span>
							<div class="k-segmented" role="radiogroup" aria-labelledby="wz-iso">
								<button class="k-seg" type="button" role="radio" aria-checked={state.isolation === 'sandbox'}
									on:click={() => (state = { ...state, isolation: 'sandbox' })}>{$t('office.panel.sandbox')}</button>
								<button class="k-seg" type="button" role="radio" aria-checked={state.isolation === 'host'} disabled={!hostAllowed}
									on:click={() => (state = { ...state, isolation: 'host' })}>{$t('office.panel.host')}</button>
							</div>
							<p class="k-help">{$t('office.panel.isolation_help')}{#if !hostAllowed} {$t('office.panel.host_off')}{/if}</p>
						</div>
						{#if state.isolation === 'host'}<p class="wz-warn"><Icon name="alert" />{$t('office.wizard.warn_host')}</p>{/if}
					{/if}
				{:else if step === 3}
					<p class="k-help">{$t('office.wizard.team_help')}</p>
					<ul class="wz-team">
						{#each state.agents as agent (agent.key)}
							<li class="wz-agent">
								<button class="wz-lead" class:wz-lead--on={agent.lead} type="button" aria-pressed={agent.lead}
									aria-label={$t('office.wizard.make_lead', { name: agent.name.trim() || '—' })} on:click={() => setLead(agent.key)}>
									<Icon name="star" size={14} filled={agent.lead} />
								</button>
								<input class="k-input" aria-label={$t('office.wizard.agent_name')} placeholder={$t('office.wizard.agent_name')} maxlength="32" bind:value={agent.name} />
								<input class="k-input" aria-label={$t('office.wizard.agent_does')} placeholder={$t('office.wizard.agent_does_ph')} bind:value={agent.does} />
								<button class="k-icon-btn" type="button" aria-label={$t('office.wizard.remove_agent', { name: agent.name.trim() || '—' })} on:click={() => removeAgent(agent.key)}>
									<Icon name="x" size={14} />
								</button>
							</li>
						{/each}
					</ul>
					<button class="k-btn wz-add" type="button" on:click={addAgent}><Icon name="plus" />{$t('office.wizard.add_agent')}</button>
					{#if showErrors}
						{#each teamErrors.filter((e) => e === 'agents_required' || e === 'agent_does') as error (error)}<p class="k-error">{errorText(error)}</p>{/each}
					{/if}
					{#if named.length > 1}
						<label class="wz-check">
							<input type="checkbox" bind:checked={state.chain} />
							<span>{$t('office.wizard.chain')}<span class="k-help wz-inline-help">{$t('office.wizard.chain_help')}</span></span>
						</label>
					{/if}
					<div class="wz-row2">
						<div class="k-field">
							<label class="k-label" for="wz-cadence">{$t('office.panel.cadence')}</label>
							<select id="wz-cadence" class="k-input" bind:value={state.cadence} title={$t('office.cadence.help')}>
								{#each CADENCE_PRESETS as preset (preset)}<option value={preset}>{$t(`office.cadence.${preset}`)}</option>{/each}
								<option value="custom">{$t('office.cadence.custom')}</option>
							</select>
						</div>
						{#if state.cadence === 'custom'}
							<div class="k-field">
								<label class="k-label" for="wz-every">{$t('office.wizard.custom_every')}</label>
								<input id="wz-every" class="k-input" bind:value={state.customEvery} placeholder={$t('office.cadence.custom_ph')}
									aria-invalid={showErrors && teamErrors.some((e) => e.startsWith('cadence'))} />
							</div>
						{/if}
					</div>
					{#if showErrors}
						{#each teamErrors.filter((e) => e.startsWith('cadence')) as error (error)}<p class="k-error">{errorText(error)}</p>{/each}
					{/if}
					{#if state.chain && lead && workers.length > 0}
						<div class="k-field">
							<span class="k-label">{$t('office.wizard.lead_tools')}</span>
							<span class="wz-roles">{#each LEAD_TOOLS as tool (tool)}<span class="k-chip wz-tool">{tool}</span>{/each}</span>
						</div>
					{/if}
				{:else}
					<p class="wz-summary">{summary}</p>
					<dl class="wz-review">
						<dt>{$t('office.wizard.review_office')}</dt>
						<dd>{state.name.trim()} · {$t(`office.kind.${state.kind}`)}</dd>
						<dt>{$t('office.wizard.review_team')}</dt>
						<dd>{#each named as agent, i (agent.key)}{#if i > 0} · {/if}{#if agent.lead}<span class="wz-star">★</span> {/if}{agent.name.trim()}{/each}</dd>
						<dt>{$t('office.wizard.review_chain')}</dt>
						<dd>{state.chain && lead && workers.length ? `${lead.name.trim()} → ${workers.map((w) => w.name.trim()).join(', ')}` : $t('office.wizard.review_none')}</dd>
						<dt>{$t('office.wizard.review_cadence')}</dt>
						<dd>{every ? humanEvery(every, language) : $t('office.cadence.manual')}</dd>
						<dt>{$t('office.wizard.review_repo')}</dt>
						<dd>
							{#if repoName}<code>{state.repoPath.trim()}</code> · {$t(state.isolation === 'host' ? 'office.panel.host' : 'office.panel.sandbox')}{:else}{$t('office.wizard.review_none')}{/if}
						</dd>
					</dl>
					{#if repoName && state.isolation === 'host'}<p class="wz-warn"><Icon name="alert" />{$t('office.wizard.warn_host')}</p>{/if}
					{#if createMessage}<p class="k-error" role="alert">{createMessage}</p>{/if}
					<p class="k-help">{$t('office.wizard.edit_later')}</p>
				{/if}
			</div>
			<aside class="wz-plan">
				<OfficeBlueprint name={state.name} color={state.color} agents={blueprintAgents} repo={!!repoName} {every} />
			</aside>
		</div>
	{/if}

	<svelte:fragment slot="footer">
		{#if step > 1}<button class="k-btn k-btn--ghost" type="button" on:click={back}>{$t('office.wizard.back')}</button>{/if}
		<span class="wz-spacer"></span>
		{#if step === 1}
			<button class="k-btn k-btn--ghost" type="button" on:click={() => dispatch('close')}>{$t('office.common.cancel')}</button>
		{:else if step < 4}
			<button class="k-btn k-btn--primary" type="button" on:click={next}>{$t('office.wizard.next')}</button>
		{:else}
			<button class="k-btn k-btn--primary" type="button" disabled={creating} on:click={found}>
				<Icon name="check" />{creating ? $t('office.wizard.founding') : $t('office.wizard.found')}
			</button>
		{/if}
	</svelte:fragment>
</Modal>

<style>
	.wz-draft-detail { margin: .25rem 0 0; font-size: .75rem; opacity: .8; }
	.wz-draft-detail summary { cursor: pointer; }
	.wz-draft-detail code { display: block; margin-top: .25rem; word-break: break-word; }

	.wz-steps { list-style: none; margin: 0; padding: 0; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
	.wz-step { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; font-size: 12.5px; color: var(--text-3); }
	.wz-step-n { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font: 400 10.5px/1 var(--font-mono); border: 1px solid var(--border-h); }
	.wz-step--done { color: var(--text-2); }
	.wz-step--done .wz-step-n { background: var(--surface-3); border-color: var(--surface-3); color: var(--teal); }
	.wz-step--current { color: var(--text-1); background: var(--surface-3); }
	.wz-step--current .wz-step-n { background: var(--teal); border-color: var(--teal); color: var(--bg); }

	.wz-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
	.wz-card {
		display: grid; grid-template-rows: auto 1fr; text-align: left; padding: 0; overflow: hidden; cursor: pointer;
		border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
		transition: border-color 0.15s, transform 0.15s var(--ease-out);
	}
	.wz-card:hover { border-color: var(--text-3); transform: translateY(-1px); }
	.wz-card:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
	.wz-card--ext { cursor: default; grid-template-rows: 1fr; }
	.wz-card--ext:hover { transform: none; }
	.wz-mini {
		height: 72px; display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: 8px; padding: 12px 24px;
		background: #0b1220; border-bottom: 1px solid var(--border); box-shadow: inset 0 3px 0 var(--office);
	}
	.wz-mini-empty { font: 400 9px/1 var(--font-mono); letter-spacing: 0.1em; color: #3a5a8c; }
	.wz-mini-desk { width: 22px; height: 12px; border-radius: 2px; border: 1px solid #3a5a8c; }
	.wz-mini-desk--lead { border-color: var(--gold); }
	.wz-card-body { display: grid; gap: 6px; padding: 12px 14px 14px; align-content: start; }
	.wz-card-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
	.wz-card-name { font: 600 14.5px/1.2 var(--font-display); }
	.wz-card-desc { font-size: 12.5px; color: var(--text-2); }
	.wz-card-action { justify-self: start; margin-top: 4px; }
	.wz-card-ready { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--green); }
	.wz-tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; font: 500 10px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; }
	.wz-tag--pro { color: var(--text-2); border: 1px solid var(--border-h); }
	.wz-roles { display: flex; flex-wrap: wrap; gap: 4px; }
	.wz-role { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 4px; background: var(--surface-3); font-size: 11px; color: var(--text-2); }
	.wz-role :global(.k-svg-icon), .wz-star { color: var(--gold); }
	.wz-tool { font-family: var(--font-mono); font-size: 11px; }

	.wz-or { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; margin: 20px 0 12px; font-size: 12px; color: var(--text-3); }
	.wz-or::before, .wz-or::after { content: ''; height: 1px; background: var(--border); }
	.wz-describe { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: end; }

	.wz-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; align-items: start; }
	.wz-form { display: grid; gap: 14px; }
	.wz-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.wz-swatches { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 36px; }
	.wz-swatch { width: 22px; height: 22px; padding: 0; border-radius: 6px; border: 2px solid transparent; cursor: pointer; }
	.wz-swatch[aria-checked='true'] { border-color: var(--text-1); box-shadow: inset 0 0 0 2px var(--surface-1); }
	.wz-swatch:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
	.wz-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--text-1); cursor: pointer; }
	.wz-check input { margin-top: 3px; accent-color: var(--teal); }
	.wz-inline-help { display: block; }
	.wz-warn {
		display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 12.5px;
		background: color-mix(in srgb, var(--orange) 8%, transparent); border: 1px solid color-mix(in srgb, var(--orange) 30%, transparent); color: var(--text-1);
	}
	.wz-team { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
	.wz-agent { display: grid; grid-template-columns: 32px minmax(0, 0.8fr) minmax(0, 1.2fr) 32px; gap: 8px; align-items: center; }
	.wz-lead { width: 32px; height: 32px; display: grid; place-items: center; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface-2); color: var(--text-3); cursor: pointer; }
	.wz-lead--on { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 45%, transparent); }
	.wz-lead:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
	.wz-add { justify-self: start; }
	.wz-summary { margin: 0; font-size: 15px; line-height: 1.65; color: var(--text-1); max-width: 58ch; }
	.wz-review { display: grid; grid-template-columns: 110px 1fr; gap: 8px 16px; margin: 0; font-size: 13px; }
	.wz-review dt { color: var(--text-3); }
	.wz-review dd { margin: 0; color: var(--text-1); overflow-wrap: anywhere; }
	.wz-review code { font: 400 12px/1.4 var(--font-mono); }
	.wz-plan { position: sticky; top: 0; }
	.wz-spacer { flex: 1; }
	@media (max-width: 860px) {
		.wz-grid { grid-template-columns: 1fr; }
		.wz-plan { display: none; }
		.wz-describe, .wz-row2 { grid-template-columns: 1fr; }
	}
	@media (prefers-reduced-motion: reduce) { .wz-card { transition: none; } .wz-card:hover { transform: none; } }
</style>
