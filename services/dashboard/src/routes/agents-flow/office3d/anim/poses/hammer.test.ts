import { describe, it, expect } from 'bun:test';
import { computeHammerPose, hammerStrikeIndex, HAMMER_HZ } from './hammer.js';

describe('hammer pose', () => {
	it('raises the hammer before the strike and drops it on impact', () => {
		const period = 1 / HAMMER_HZ;
		const raised = computeHammerPose(period * 0.64);
		const impact = computeHammerPose(period * 0.8);
		expect(raised.armRX).toBeLessThan(impact.armRX);
	});

	it('lands exactly one strike per swing', () => {
		let strikes = 0;
		let last = hammerStrikeIndex(0);
		for (let t = 0; t < 10; t += 1 / 120) {
			const i = hammerStrikeIndex(t);
			if (i !== last) { strikes++; last = i; }
		}
		expect(strikes).toBe(Math.floor(10 * HAMMER_HZ));
	});

	it('stays within a natural range', () => {
		for (let t = 0; t < 3; t += 0.05) {
			const p = computeHammerPose(t, 0.3);
			expect(p.armRX).toBeGreaterThan(-2.8);
			expect(p.armRX).toBeLessThan(0);
		}
	});
});
