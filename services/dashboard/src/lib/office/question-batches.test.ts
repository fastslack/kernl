import { describe, it, expect } from 'bun:test';
import { groupQuestions } from './question-batches.js';

const WAIT = [{ label: 'Reanudar' }, { label: 'Lo veo yo', task: true }, { label: 'Descartar el issue' }];
const q = (id: string, agent: string, options = WAIT, status = 'pending') => ({ id, from_agent_id: agent, status, options });

describe('groupQuestions', () => {
	it('batches pending questions from one agent with the same options, where the first one was', () => {
		const g = groupQuestions([q('a', 'qa', [{ label: 'Sí' }]), q('w1', 'int'), q('b', 'qa', [{ label: 'No' }]), q('w2', 'int'), q('w3', 'int')]);
		expect(g.map((x) => (x.kind === 'batch' ? x.questions.map((m) => m.id).join('+') : x.q.id))).toEqual(['a', 'w1+w2+w3', 'b']);
	});

	it('a different agent, a different option or a different task flag keeps it apart', () => {
		const g = groupQuestions([
			q('w1', 'int'),
			q('w2', 'other'),
			q('w3', 'int', [...WAIT.slice(0, 2), { label: 'Otra' }]),
			q('w4', 'int', [{ label: 'Reanudar' }, { label: 'Lo veo yo' }, { label: 'Descartar el issue' }]),
		]);
		expect(g.every((x) => x.kind === 'single')).toBe(true);
	});

	it('never batches owed questions, and one alone is a single', () => {
		const g = groupQuestions([q('w1', 'int', WAIT, 'owed'), q('w2', 'int', WAIT, 'owed'), q('w3', 'int')]);
		expect(g.map((x) => x.kind)).toEqual(['single', 'single', 'single']);
	});

	it('ignores spaces around a label', () => {
		const g = groupQuestions([q('w1', 'int'), q('w2', 'int', [{ label: ' Reanudar ' }, WAIT[1], WAIT[2]])]);
		expect(g).toHaveLength(1);
	});
});
