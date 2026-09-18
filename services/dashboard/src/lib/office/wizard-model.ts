/**
 * The "Nueva oficina" wizard's state and its translation to and from Office
 * Kit definitions. Pure: the component only binds inputs to a WizardState.
 */
import { OFFICE_PALETTE } from './office-palette.js';
import { checkEvery, everyFor, parseEvery, type CadenceChoice } from './cadence.js';
import type { OfficeKind } from './office-kinds.js';
import type { Isolation, OfficeDefinition, OfficeTemplate } from './office-api.js';

export const LEAD_TOOLS = ['kernel_agents_run', 'kernel_agents_list', 'kernel_notes_create'] as const;

export interface WizardAgent { key: string; name: string; does: string; prompt: string; lead: boolean }

export interface WizardState {
	templateId: string | null;
	name: string;
	color: string;
	kind: OfficeKind;
	purpose: string;
	useRepo: boolean;
	repoPath: string;
	isolation: Isolation;
	agents: WizardAgent[];
	chain: boolean;
	cadence: CadenceChoice;
	customEvery: string;
}

export type WizardError =
	| 'name_required' | 'name_taken' | 'repo_required' | 'agents_required' | 'agent_does'
	| 'cadence_invalid' | 'cadence_too_short' | 'cadence_needs_lead';

let rowSeq = 0;

export function newAgentRow(partial: Partial<WizardAgent> = {}): WizardAgent {
	rowSeq += 1;
	return { key: `agent-${rowSeq}`, name: '', does: '', prompt: '', lead: false, ...partial };
}

export function emptyWizard(): WizardState {
	return {
		templateId: null,
		name: '',
		color: OFFICE_PALETTE[0],
		kind: 'general',
		purpose: '',
		useRepo: false,
		repoPath: '',
		isolation: 'sandbox',
		agents: [newAgentRow({ lead: true })],
		chain: true,
		cadence: 'manual',
		customEvery: '',
	};
}

export function namedAgents(s: WizardState): WizardAgent[] {
	return s.agents.filter((a) => a.name.trim());
}

export function leadOf(s: WizardState): WizardAgent | undefined {
	return namedAgents(s).find((a) => a.lead);
}

function cadenceFrom(every: string | undefined): { cadence: CadenceChoice; customEvery: string } {
	if (!every) return { cadence: 'manual', customEvery: '' };
	const ms = parseEvery(every);
	for (const preset of ['15m', '1h', '1d'] as const) {
		if (ms !== null && parseEvery(preset) === ms) return { cadence: preset, customEvery: '' };
	}
	return { cadence: 'custom', customEvery: every };
}

function rowsFrom(def: OfficeDefinition, summaries: string[] = []): WizardAgent[] {
	const rows = def.agents.map((a, i) =>
		newAgentRow({ name: a.name, does: a.description ?? summaries[i] ?? '', prompt: a.prompt ?? '', lead: a.role === 'manager' }),
	);
	if (rows.length === 0) return [newAgentRow({ lead: true })];
	if (!rows.some((r) => r.lead)) rows[0] = { ...rows[0], lead: true };
	return rows;
}

export function wizardFromTemplate(template: OfficeTemplate, current: WizardState): WizardState {
	const def = template.definition ?? { name: '', agents: [] };
	const agents = rowsFrom(def, template.agents.map((a) => a.summary));
	return {
		...current,
		templateId: template.id,
		kind: def.kind ?? template.kind,
		color: template.color || current.color,
		agents,
		chain: def.agents.length > 1,
		...cadenceFrom(def.cron?.every),
	};
}

export function wizardFromDraft(def: OfficeDefinition, current: WizardState): WizardState {
	const lead = def.agents.find((a) => a.role === 'manager');
	return {
		...current,
		templateId: null,
		name: def.name || current.name,
		purpose: def.description ?? current.purpose,
		kind: def.kind ?? current.kind,
		agents: rowsFrom(def),
		chain: (lead?.chainTo?.length ?? 0) > 0,
		...cadenceFrom(def.cron?.every),
	};
}

export function definitionFromWizard(s: WizardState): OfficeDefinition {
	const agents = namedAgents(s);
	const lead = agents.find((a) => a.lead);
	const workers = agents.filter((a) => a !== lead);
	const handsOut = s.chain && !!lead && workers.length > 0;
	const every = everyFor(s.cadence, s.customEvery);

	const def: OfficeDefinition = {
		name: s.name.trim(),
		color: s.color,
		kind: s.kind,
		agents: agents.map((a) => {
			const name = a.name.trim();
			const does = a.does.trim();
			return {
				name,
				role: a === lead ? 'manager' : 'worker',
				...(does ? { description: does } : {}),
				prompt: a.prompt.trim() || (does ? `You are ${name}. ${does}` : `You are ${name}.`),
				...(a === lead && handsOut ? { tools: [...LEAD_TOOLS], chainTo: workers.map((w) => w.name.trim()) } : {}),
			};
		}),
	};
	if (s.purpose.trim()) def.description = s.purpose.trim();
	if (s.useRepo && s.repoPath.trim()) {
		def.repo = s.repoPath.trim();
		def.repoIsolation = s.isolation;
	}
	if (every && lead) def.cron = { agent: lead.name.trim(), every, goal: 'resume' };
	return def;
}

export function officeStepErrors(s: WizardState, existingNames: string[]): WizardError[] {
	const errors: WizardError[] = [];
	const name = s.name.trim().toLowerCase();
	if (!name) errors.push('name_required');
	else if (existingNames.some((n) => n.trim().toLowerCase() === name)) errors.push('name_taken');
	if (s.useRepo && !s.repoPath.trim()) errors.push('repo_required');
	return errors;
}

export function teamStepErrors(s: WizardState, minSeconds = 300): WizardError[] {
	const errors: WizardError[] = [];
	const agents = namedAgents(s);
	if (agents.length === 0) return ['agents_required'];
	if (agents.some((a) => !a.does.trim() && !a.prompt.trim())) errors.push('agent_does');
	if (s.cadence === 'custom') {
		const check = checkEvery(s.customEvery, minSeconds);
		if (check === 'invalid') errors.push('cadence_invalid');
		else if (check === 'too_short') errors.push('cadence_too_short');
	}
	if (everyFor(s.cadence, s.customEvery) && !agents.some((a) => a.lead) && !errors.some((e) => e.startsWith('cadence'))) {
		errors.push('cadence_needs_lead');
	}
	return errors;
}
