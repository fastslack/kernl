import { describe, it, expect } from 'bun:test';
import { buildRailModel, filterRail, topAgentId, agentState, latestRunStatus, type RailInput } from './rail-model.js';

const ranks = [
	{ id: 'r-chief', level: 11, active: 1 },
	{ id: 'r-staff', level: 1, active: 1 },
];

function input(overrides: Partial<RailInput> = {}): RailInput {
	return {
		flows: [
			{ id: 'f-mgmt', name: 'Management', color: '#111111', active: 1, kind: 'general' },
			{ id: 'f-cr', name: 'Code Review', color: '#2563eb', active: 1, kind: 'devops' },
			{ id: 'f-rs', name: 'research', color: '#7c3aed', active: 1 },
			{ id: 'f-empty', name: 'Ávila', color: '#0d9488', active: 1, kind: 'general' },
			{ id: 'f-old', name: 'Old', color: '#999999', active: 0 },
		],
		agents: [
			{ id: 'chief', name: 'Chief', flow_id: 'f-mgmt', active: 1, rank_id: 'r-chief' },
			{ id: 'rev', name: 'Reviewer', flow_id: 'f-cr', active: 0, rank_id: 'r-staff' },
			{ id: 'lead', name: 'Lead', flow_id: 'f-cr', active: 1, role: 'manager' },
			{ id: 'qa', name: 'QA', flow_id: 'f-cr', active: 1 },
			{ id: 'cur', name: 'Curador', flow_id: 'f-rs', active: 1, role: 'manager' },
			{ id: 'lost', name: 'Traductor', flow_id: 'f-old', active: 0 },
			{ id: 'loose', name: 'Scraper', flow_id: '', active: 1 },
		],
		ranks,
		runningIds: new Set(['lead']),
		lastRunStatus: { qa: 'failed', cur: 'completed' },
		...overrides,
	};
}

describe('topAgentId', () => {
	it('picks the agent holding the highest active rank', () => {
		expect(topAgentId(input().agents, ranks)).toBe('chief');
	});

	it('is null without active ranks', () => {
		expect(topAgentId(input().agents, [{ id: 'r-chief', level: 11, active: 0 }])).toBeNull();
	});
});

describe('agentState', () => {
	it('orders running, paused, failed, idle', () => {
		const running = new Set(['a']);
		expect(agentState({ id: 'a', name: 'A', flow_id: '', active: 1 }, running, {})).toBe('working');
		expect(agentState({ id: 'b', name: 'B', flow_id: '', active: 0 }, running, { b: 'failed' })).toBe('paused');
		expect(agentState({ id: 'c', name: 'C', flow_id: '', active: 1 }, running, { c: 'failed' })).toBe('error');
		expect(agentState({ id: 'd', name: 'D', flow_id: '', active: 1 }, running, { d: 'completed' })).toBe('idle');
	});
});

describe('buildRailModel', () => {
	it('lists active offices by name, hiding the office that only hosts Dirección', () => {
		const model = buildRailModel(input());
		expect(model.offices.map((o) => o.id)).toEqual(['f-empty', 'f-cr', 'f-rs']);
	});

	it('keeps an office with no agents', () => {
		const empty = buildRailModel(input()).offices.find((o) => o.id === 'f-empty')!;
		expect(empty.agents).toEqual([]);
		expect(empty.working).toBe(0);
	});

	it('puts the lead first, then agents by name, with their state', () => {
		const cr = buildRailModel(input()).offices.find((o) => o.id === 'f-cr')!;
		expect(cr.agents).toEqual([
			{ id: 'lead', name: 'Lead', lead: true, state: 'working' },
			{ id: 'qa', name: 'QA', lead: false, state: 'error' },
			{ id: 'rev', name: 'Reviewer', lead: false, state: 'paused' },
		]);
		expect(cr.working).toBe(1);
		expect(cr.kind).toBe('devops');
	});

	it('reads a missing kind as general', () => {
		expect(buildRailModel(input()).offices.find((o) => o.id === 'f-rs')!.kind).toBe('general');
	});

	it('exposes Dirección and the unassigned agents', () => {
		const model = buildRailModel(input());
		expect(model.headquarters).toEqual({ id: 'chief', name: 'Chief', lead: false, state: 'idle' });
		expect(model.unassigned.map((a) => a.id)).toEqual(['loose', 'lost']);
	});

	it('lists Management as an office once it has other members', () => {
		const i = input();
		i.agents.push({ id: 'aide', name: 'Aide', flow_id: 'f-mgmt', active: 1 });
		const mgmt = buildRailModel(i).offices.find((o) => o.id === 'f-mgmt')!;
		expect(mgmt.agents.map((a) => a.id)).toEqual(['aide']);
	});
});

describe('filterRail', () => {
	const model = buildRailModel(input());

	it('returns the model untouched for a blank query', () => {
		expect(filterRail(model, '   ')).toBe(model);
	});

	it('keeps a matching office whole, ignoring case and accents', () => {
		const r = filterRail(model, 'avila');
		expect(r.offices.map((o) => o.id)).toEqual(['f-empty']);
	});

	it('keeps only the matching agents of other offices', () => {
		const r = filterRail(model, 'qa');
		expect(r.offices).toHaveLength(1);
		expect(r.offices[0].agents.map((a) => a.id)).toEqual(['qa']);
		expect(r.headquarters).toBeNull();
		expect(r.unassigned).toEqual([]);
	});

	it('filters Dirección and Sin asignar too', () => {
		const r = filterRail(model, 'CHI');
		expect(r.headquarters?.id).toBe('chief');
		expect(filterRail(model, 'scrap').unassigned.map((a) => a.id)).toEqual(['loose']);
	});
});

describe('latestRunStatus', () => {
	it('keeps the most recent run per agent', () => {
		expect(
			latestRunStatus([
				{ agent_id: 'a', status: 'completed', created_at: '2026-09-15T10:00:00Z' },
				{ agent_id: 'a', status: 'failed', created_at: '2026-09-15T12:00:00Z' },
				{ agent_id: 'b', status: 'running', created_at: '2026-09-15T09:00:00Z' },
			]),
		).toEqual({ a: 'failed', b: 'running' });
	});

	it('is empty for no runs', () => {
		expect(latestRunStatus([])).toEqual({});
	});
});
