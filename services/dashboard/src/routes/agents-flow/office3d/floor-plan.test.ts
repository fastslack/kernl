import { describe, it, expect } from 'bun:test';
import { computeFloorPlan } from './floor-plan.js';
import type { AgentData, FlowData } from './types.js';

const agent = (id: string, flowId: string): AgentData => ({
	id, name: id, description: '', provider: '', model: '', active: 1, builtin_handler: '', flow_id: flowId,
});

const flow = (id: string, name: string): FlowData => ({ id, name, color: '#2563eb', active: 1 });

describe('computeFloorPlan', () => {
	it('places an office the same way whatever it is called', () => {
		const agents = [agent('a1', 'f1')];
		const pinned = computeFloorPlan(agents, [], [flow('f1', 'Communications')]).rooms.get('f1')!;
		const plain = computeFloorPlan(agents, [], [flow('f1', 'Research')]).rooms.get('f1')!;
		expect({ cx: pinned.cx, cz: pinned.cz }).toEqual({ cx: plain.cx, cz: plain.cz });
	});

	it('labels the room with the real office name', () => {
		const room = computeFloorPlan([agent('a1', 'f1')], [], [flow('f1', 'Market Analysis')]).rooms.get('f1')!;
		expect(room.name).toBe('Market Analysis');
	});
});
