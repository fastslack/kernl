import { describe, it, expect } from 'bun:test';
import { reviewSummary, joinNames } from './review-summary.js';

const team = [
	{ name: 'Lead', lead: true },
	{ name: 'Reviewer', lead: false },
	{ name: 'QA', lead: false },
];

describe('joinNames', () => {
	it('joins with the language conjunction', () => {
		expect(joinNames(['A'], 'es')).toBe('A');
		expect(joinNames(['A', 'B'], 'es')).toBe('A y B');
		expect(joinNames(['A', 'B', 'C'], 'en')).toBe('A, B and C');
		expect(joinNames([], 'en')).toBe('');
	});
});

describe('reviewSummary', () => {
	it('reads like the spec example in Spanish', () => {
		expect(
			reviewSummary({ officeName: 'Code Review', agents: team, chain: true, every: '1h', repoName: 'kernl', isolation: 'sandbox', language: 'es' }),
		).toBe('Vas a crear Code Review con 3 agentes. Lead reparte el trabajo cada hora entre Reviewer y QA. Trabajan sobre kernl dentro de un sandbox.');
	});

	it('reads in English, on the host, without cadence', () => {
		expect(
			reviewSummary({ officeName: 'Code Review', agents: team, chain: true, every: null, repoName: 'kernl', isolation: 'host', language: 'en' }),
		).toBe('You are creating Code Review with 3 agents. Lead hands out the work to Reviewer and QA. They work on kernl directly on the host.');
	});

	it('describes a lead that only runs on a cadence when there is no chain', () => {
		expect(
			reviewSummary({ officeName: 'Research', agents: team.slice(0, 1), chain: false, every: '1d', repoName: null, isolation: 'sandbox', language: 'es' }),
		).toBe('Vas a crear Research con 1 agente. Lead corre solo cada día.');
	});

	it('ignores unnamed agent rows and trims names', () => {
		expect(
			reviewSummary({
				officeName: '  Ops ',
				agents: [{ name: ' Boss ', lead: true }, { name: '   ', lead: false }],
				chain: true,
				every: null,
				repoName: null,
				isolation: 'sandbox',
				language: 'en',
			}),
		).toBe('You are creating Ops with 1 agent.');
	});
});
