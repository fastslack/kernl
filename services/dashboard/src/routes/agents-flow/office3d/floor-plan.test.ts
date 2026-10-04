import { describe, it, expect } from 'bun:test';
import { computeFloorPlan } from './floor-plan.js';
import { cellRect, lotAt } from '$shared/office-lots.js';
import type { AgentData, FlowData } from './types.js';

const agent = (id: string, flowId: string): AgentData => ({
	id, name: id, description: '', provider: '', model: '', active: 1, builtin_handler: '', flow_id: flowId,
});

const flow = (id: string, name: string, lot_id = ''): FlowData => ({ id, name, color: '#2563eb', active: 1, lot_id });

const team = (flowId: string, n: number) => Array.from({ length: n }, (_, i) => agent(`${flowId}-${i}`, flowId));

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

	it('builds an office on its lot', () => {
		const lot = lotAt(2, -2)!;
		const room = computeFloorPlan(team('f1', 3), [], [flow('f1', 'A', lot.id)]).rooms.get('f1')!;
		expect({ cx: room.cx, cz: room.cz, w: room.w, d: room.d }).toEqual({ cx: lot.cx, cz: lot.cz, w: lot.w, d: lot.d });
	});

	it('never moves an office when another one appears', () => {
		const before = computeFloorPlan(team('f1', 3), [], [flow('f1', 'A', '-1,1')]).rooms.get('f1')!;
		const after = computeFloorPlan(
			[...team('f1', 3), ...team('f2', 12), ...team('f3', 2)], [],
			[flow('f1', 'A', '-1,1'), flow('f2', 'B', '1,1'), flow('f3', 'C', '2,0')],
		).rooms.get('f1')!;
		expect({ cx: after.cx, cz: after.cz, w: after.w, d: after.d }).toEqual({ cx: before.cx, cz: before.cz, w: before.w, d: before.d });
	});

	it('still draws an office the kernel has not given a lot, on a free one', () => {
		const plan = computeFloorPlan([...team('f1', 2), ...team('f2', 2)], [], [flow('f1', 'A', '-1,1'), flow('f2', 'B')]);
		const a = plan.rooms.get('f1')!, b = plan.rooms.get('f2')!;
		expect(b).toBeDefined();
		expect({ cx: b.cx, cz: b.cz }).not.toEqual({ cx: a.cx, cz: a.cz });
	});

	it('leaves a hidden office off the floor and its lot free', () => {
		const plan = computeFloorPlan(team('f1', 2), [], [flow('f1', 'A', '-1,1')], [], { hiddenFlowIds: new Set(['f1']) });
		expect(plan.rooms.has('f1')).toBe(false);
		expect(plan.deskPositions.size).toBe(0);
		expect(plan.freeLots.some((l) => l.id === '-1,1')).toBe(true);
	});

	it('lists the free lots, not the taken ones', () => {
		const plan = computeFloorPlan(team('f1', 2), [], [flow('f1', 'A', '-1,1')]);
		expect(plan.freeLots.some((l) => l.id === '-1,1')).toBe(false);
		expect(plan.freeLots.length).toBeGreaterThan(0);
	});

	it('keeps the core in its fixed order with the hall at the origin', () => {
		const plan = computeFloorPlan(team('f1', 2), [], [flow('f1', 'A', '-1,1')]);
		expect(plan.meetingRooms).toHaveLength(6);
		expect(plan.meetingRooms[1]).toEqual(cellRect(0, 0));
		expect(plan.meetingRooms[3]).toEqual(cellRect(0, -1));
	});

	it('keeps every desk inside its room', () => {
		const plan = computeFloorPlan(team('f1', 14), [], [flow('f1', 'A', '2,0')]);
		const room = plan.rooms.get('f1')!;
		for (const p of plan.deskPositions.values()) {
			expect(Math.abs(p.x - room.cx)).toBeLessThan(room.w / 2);
			expect(Math.abs(p.z - room.cz)).toBeLessThan(room.d / 2);
		}
	});

	it('opens the door on the wall facing the hall', () => {
		const room = computeFloorPlan(team('f1', 2), [], [flow('f1', 'A', '3,0')]).rooms.get('f1')!;
		expect(room.doorDir).toBe('left');
	});
});

