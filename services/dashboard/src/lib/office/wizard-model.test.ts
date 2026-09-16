import { describe, it, expect } from 'bun:test';
import {
	LEAD_TOOLS, emptyWizard, newAgentRow, wizardFromTemplate, wizardFromDraft, definitionFromWizard,
	officeStepErrors, teamStepErrors, namedAgents, leadOf, type WizardState,
} from './wizard-model.js';
import type { OfficeTemplate } from './office-api.js';

const builder: OfficeTemplate = {
	id: 'builtin:builder', source: 'builtin', name: 'Constructora', description: '', kind: 'devops', color: '#16a34a',
	agents: [
		{ name: 'Tech Lead', role: 'manager', summary: 'Elige una tarea y la reparte' },
		{ name: 'Builder', role: 'worker', summary: 'Implementa la tarea' },
		{ name: 'QA', role: 'worker', summary: 'Verifica' },
	],
	definition: {
		name: '', kind: 'devops',
		agents: [
			{ name: 'Tech Lead', role: 'manager', prompt: 'LEAD PROMPT', tools: [...LEAD_TOOLS], chainTo: [] },
			{ name: 'Builder', role: 'worker', prompt: 'BUILDER PROMPT' },
			{ name: 'QA', role: 'worker', prompt: 'QA PROMPT' },
		],
	},
};

function withTeam(overrides: Partial<WizardState> = {}): WizardState {
	return {
		...emptyWizard(),
		name: 'Code Review',
		agents: [newAgentRow({ name: 'Lead', does: 'Reparte', lead: true }), newAgentRow({ name: 'QA', does: 'Prueba' })],
		...overrides,
	};
}

describe('emptyWizard', () => {
	it('starts with one lead row, sandbox isolation and a manual cadence', () => {
		const s = emptyWizard();
		expect(s.agents).toHaveLength(1);
		expect(s.agents[0].lead).toBe(true);
		expect(s.isolation).toBe('sandbox');
		expect(s.cadence).toBe('manual');
		expect(s.kind).toBe('general');
	});

	it('gives every row a unique key', () => {
		expect(newAgentRow().key).not.toBe(newAgentRow().key);
	});
});

describe('wizardFromTemplate', () => {
	it('takes kind, color, agents with summaries and prompts, and turns the chain on', () => {
		const current = { ...emptyWizard(), name: 'Mi oficina', purpose: 'algo' };
		const s = wizardFromTemplate(builder, current);
		expect(s.templateId).toBe('builtin:builder');
		expect(s.name).toBe('Mi oficina');
		expect(s.purpose).toBe('algo');
		expect(s.kind).toBe('devops');
		expect(s.color).toBe('#16a34a');
		expect(s.agents.map((a) => [a.name, a.does, a.prompt, a.lead])).toEqual([
			['Tech Lead', 'Elige una tarea y la reparte', 'LEAD PROMPT', true],
			['Builder', 'Implementa la tarea', 'BUILDER PROMPT', false],
			['QA', 'Verifica', 'QA PROMPT', false],
		]);
		expect(s.chain).toBe(true);
	});

	it('a blank template leaves one empty lead row', () => {
		const blank: OfficeTemplate = { ...builder, id: 'builtin:blank', kind: 'general', agents: [], definition: { name: '', agents: [] } };
		const s = wizardFromTemplate(blank, emptyWizard());
		expect(s.agents).toHaveLength(1);
		expect(s.agents[0].lead).toBe(true);
		expect(s.kind).toBe('general');
	});
});

describe('wizardFromDraft', () => {
	it('fills name, purpose, kind, team, chain and cadence', () => {
		const s = wizardFromDraft(
			{
				name: 'Code Review', description: 'Revisa PRs', kind: 'devops',
				agents: [
					{ name: 'Lead', role: 'manager', description: 'Reparte', prompt: 'P1', chainTo: ['QA'] },
					{ name: 'QA', role: 'worker', description: 'Prueba', prompt: 'P2' },
				],
				cron: { agent: 'Lead', every: '45m' },
			},
			emptyWizard(),
		);
		expect(s.name).toBe('Code Review');
		expect(s.purpose).toBe('Revisa PRs');
		expect(s.kind).toBe('devops');
		expect(s.agents.map((a) => a.name)).toEqual(['Lead', 'QA']);
		expect(s.chain).toBe(true);
		expect(s.cadence).toBe('custom');
		expect(s.customEvery).toBe('45m');
	});

	it('recognizes a preset cadence and marks the first agent lead when the draft has none', () => {
		const s = wizardFromDraft(
			{ name: 'Solo', agents: [{ name: 'Uno', prompt: 'p' }], cron: { agent: 'Uno', every: '1h' } },
			emptyWizard(),
		);
		expect(s.cadence).toBe('1h');
		expect(s.agents[0].lead).toBe(true);
		expect(s.chain).toBe(false);
	});
});

describe('definitionFromWizard', () => {
	it('builds the Office Kit definition with names in chainTo and the lead tools', () => {
		const def = definitionFromWizard(withTeam({ purpose: ' Revisa PRs ', cadence: '1h', kind: 'devops', color: '#e11d48' }));
		expect(def).toEqual({
			name: 'Code Review',
			color: '#e11d48',
			kind: 'devops',
			description: 'Revisa PRs',
			agents: [
				{ name: 'Lead', role: 'manager', description: 'Reparte', prompt: 'You are Lead. Reparte', tools: [...LEAD_TOOLS], chainTo: ['QA'] },
				{ name: 'QA', role: 'worker', description: 'Prueba', prompt: 'You are QA. Prueba' },
			],
			cron: { agent: 'Lead', every: '1h', goal: 'resume' },
		});
	});

	it('keeps an explicit prompt, drops unnamed rows, and omits chain/cron/repo when off', () => {
		const s = withTeam({ chain: false });
		s.agents[0].prompt = 'Custom';
		s.agents.push(newAgentRow({ name: '   ' }));
		const def = definitionFromWizard(s);
		expect(def.agents).toHaveLength(2);
		expect(def.agents[0].prompt).toBe('Custom');
		expect(def.agents[0].chainTo).toBeUndefined();
		expect(def.agents[0].tools).toBeUndefined();
		expect(def.cron).toBeUndefined();
		expect(def.repo).toBeUndefined();
	});

	it('adds repo and isolation only when the repo toggle is on with a path', () => {
		expect(definitionFromWizard(withTeam({ useRepo: true, repoPath: '/workspace/kernl', isolation: 'host' }))).toMatchObject({
			repo: '/workspace/kernl',
			repoIsolation: 'host',
		});
		expect(definitionFromWizard(withTeam({ useRepo: true, repoPath: '  ' })).repo).toBeUndefined();
	});
});

describe('step errors', () => {
	it('office step: name required, taken ignoring case, repo required', () => {
		expect(officeStepErrors({ ...emptyWizard(), name: '  ' }, [])).toEqual(['name_required']);
		expect(officeStepErrors({ ...emptyWizard(), name: 'research' }, ['Research'])).toEqual(['name_taken']);
		expect(officeStepErrors({ ...emptyWizard(), name: 'Ops', useRepo: true, repoPath: '' }, [])).toEqual(['repo_required']);
		expect(officeStepErrors({ ...emptyWizard(), name: 'Ops' }, ['Research'])).toEqual([]);
	});

	it('team step: agents, descriptions and cadence', () => {
		expect(teamStepErrors({ ...emptyWizard() })).toEqual(['agents_required']);
		expect(teamStepErrors(withTeam({ agents: [newAgentRow({ name: 'Lead', lead: true })] }))).toEqual(['agent_does']);
		expect(teamStepErrors(withTeam({ cadence: 'custom', customEvery: 'nope' }))).toEqual(['cadence_invalid']);
		expect(teamStepErrors(withTeam({ cadence: 'custom', customEvery: '2m' }))).toEqual(['cadence_too_short']);
		expect(teamStepErrors(withTeam({ cadence: '1h', agents: [newAgentRow({ name: 'Solo', does: 'x' })] }))).toEqual(['cadence_needs_lead']);
		expect(teamStepErrors(withTeam({ cadence: '1h' }))).toEqual([]);
	});

	it('namedAgents and leadOf ignore blank rows', () => {
		const s = withTeam();
		s.agents.push(newAgentRow({ name: ' ', lead: false }));
		expect(namedAgents(s)).toHaveLength(2);
		expect(leadOf(s)?.name).toBe('Lead');
	});
});
