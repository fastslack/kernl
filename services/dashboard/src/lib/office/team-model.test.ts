import { describe, it, expect } from 'bun:test';
import {
	DISTRIBUTE_LABEL,
	ENVIRONMENT_FEATURE,
	cadencePlan,
	distributeState,
	environmentLicensed,
	leadSchedule,
	leadStatus,
	manualChainCount,
	officeRepoPath,
	type TeamChain,
} from './team-model.js';

const chain = (id: string, source: string, target: string, label = DISTRIBUTE_LABEL, active = 1): TeamChain => ({
	id, source_agent_id: source, target_agent_id: target, label, active,
});

describe('leadStatus', () => {
	it('finds exactly one lead', () => {
		expect(leadStatus([{ id: 'a', lead: false }, { id: 'l', lead: true }])).toEqual({ kind: 'one', leadId: 'l' });
	});
	it('reports none and many', () => {
		expect(leadStatus([{ id: 'a', lead: false }])).toEqual({ kind: 'none' });
		expect(leadStatus([{ id: 'a', lead: true }, { id: 'b', lead: true }])).toEqual({ kind: 'many' });
	});
});

describe('distributeState', () => {
	it('is on when every member has a chain from the lead, whatever its label', () => {
		const chains = [chain('1', 'l', 'a'), chain('2', 'l', 'b', 'lead → b')];
		expect(distributeState(chains, 'l', ['a', 'b'])).toBe('on');
	});
	it('is partial when only some members are covered', () => {
		expect(distributeState([chain('1', 'l', 'a')], 'l', ['a', 'b'])).toBe('partial');
	});
	it('is off without chains, without a lead, without members, or with inactive chains', () => {
		expect(distributeState([], 'l', ['a'])).toBe('off');
		expect(distributeState([chain('1', 'l', 'a')], null, ['a'])).toBe('off');
		expect(distributeState([chain('1', 'l', 'a')], 'l', [])).toBe('off');
		expect(distributeState([chain('1', 'l', 'a', DISTRIBUTE_LABEL, 0)], 'l', ['a'])).toBe('off');
	});
	it('ignores chains from other sources', () => {
		expect(distributeState([chain('1', 'x', 'a')], 'l', ['a'])).toBe('off');
	});
});

describe('manualChainCount', () => {
	it('counts lead → member chains the toggle does not own', () => {
		const chains = [chain('1', 'l', 'a'), chain('2', 'l', 'b', 'lead → b'), chain('3', 'l', 'outsider', 'x')];
		expect(manualChainCount(chains, 'l', ['a', 'b'])).toBe(1);
		expect(manualChainCount(chains, null, ['a', 'b'])).toBe(0);
	});
});

describe('leadSchedule', () => {
	it('returns the lead\'s active schedule', () => {
		const schedules = [
			{ id: 's0', agent_id: 'l', interval_ms: 1, active: 0 },
			{ id: 's1', agent_id: 'l', interval_ms: 3_600_000, active: 1 },
			{ id: 's2', agent_id: 'x', interval_ms: 60_000 },
		];
		expect(leadSchedule(schedules, 'l')?.id).toBe('s1');
		expect(leadSchedule(schedules, 'nobody')).toBeNull();
		expect(leadSchedule(schedules, null)).toBeNull();
	});
});

describe('cadencePlan', () => {
	const current = { id: 's1', agent_id: 'l', interval_ms: 3_600_000 };
	it('adds, updates, deletes or does nothing', () => {
		expect(cadencePlan(null, 900_000)).toEqual({ action: 'add', intervalMs: 900_000 });
		expect(cadencePlan(current, 900_000)).toEqual({ action: 'update', scheduleId: 's1', intervalMs: 900_000 });
		expect(cadencePlan(current, null)).toEqual({ action: 'delete', scheduleId: 's1' });
		expect(cadencePlan(null, null)).toEqual({ action: 'none' });
		expect(cadencePlan(current, 3_600_000)).toEqual({ action: 'none' });
	});
	it('replaces a cron schedule even when the interval matches', () => {
		expect(cadencePlan({ ...current, cron_expression: '0 7 * * *' }, 3_600_000)).toEqual({
			action: 'update', scheduleId: 's1', intervalMs: 3_600_000,
		});
	});
});

describe('officeRepoPath', () => {
	it('prefers home_repo_path, else the one __cwd_path__ the agents share', () => {
		expect(officeRepoPath('/home/repo', [])).toBe('/home/repo');
		expect(officeRepoPath('', [JSON.stringify({ __cwd_path__: '/r' }), JSON.stringify({ __cwd_path__: '/r' }), '{}'])).toBe('/r');
	});
	it('is empty when agents disagree or variables are broken', () => {
		expect(officeRepoPath('', [JSON.stringify({ __cwd_path__: '/a' }), JSON.stringify({ __cwd_path__: '/b' })])).toBe('');
		expect(officeRepoPath(undefined, ['nope', undefined])).toBe('');
	});
});

describe('environmentLicensed', () => {
	it('reads the devops feature from the license features', () => {
		expect(ENVIRONMENT_FEATURE).toBe('pro:devops');
		expect(environmentLicensed(['pro:trading', 'pro:devops'])).toBe(true);
		expect(environmentLicensed(['pro:trading'])).toBe(false);
		expect(environmentLicensed(undefined)).toBe(false);
	});
});
