import { describe, it, expect } from 'bun:test';
import { opinionChoice } from './opinion-send.js';

const options = [{ task: true }, { task: true }, {}, {}];
const opinion = (matches_option: number | null, extends_option = false) => ({ answer: 'the plan', matches_option, extends_option });

describe('opinionChoice', () => {
	it('a bare pick goes as that option', () => {
		expect(opinionChoice({ status: 'pending', options }, opinion(2))).toEqual({ kind: 'option', index: 2 });
		expect(opinionChoice({ status: 'pending', options }, opinion(1))).toEqual({ kind: 'option', index: 1 });
	});

	it('a pick with conditions, or none, goes as the whole answer', () => {
		expect(opinionChoice({ status: 'pending', options }, opinion(2, true))).toEqual({ kind: 'free', text: 'the plan' });
		expect(opinionChoice({ status: 'pending', options }, opinion(null))).toEqual({ kind: 'free', text: 'the plan' });
		expect(opinionChoice({ status: 'pending', options }, opinion(9))).toEqual({ kind: 'free', text: 'the plan' });
	});

	it('on a question the operator already took on, a "leave it to me" pick goes as the answer, not refused', () => {
		expect(opinionChoice({ status: 'owed', options }, opinion(1))).toEqual({ kind: 'free', text: 'the plan' });
		// The options still open on it go as themselves.
		expect(opinionChoice({ status: 'owed', options }, opinion(3))).toEqual({ kind: 'option', index: 3 });
	});
});
