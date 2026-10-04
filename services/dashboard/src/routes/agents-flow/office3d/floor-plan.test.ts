import { describe, it, expect } from 'bun:test';
import { computeFloorPlan } from './floor-plan.js';
import { cellRect, lotAt, registerOffGridKinds } from '$shared/office-lots.js';
import type { OffGridSite, WorldAabb } from '$shared/world-plugin.js';
import { buildPath, segHitsAabb } from './walkers/pathfinding.js';
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

describe('computeFloorPlan — off-grid offices (world plugins)', () => {
	registerOffGridKinds(['test-yard']);
	const yard = (id: string): FlowData => ({ ...flow(id, 'Yard'), kind: 'test-yard' } as FlowData);

	/** A plain building 30u east of the main one, door on its west wall at a corridor Z. */
	const fakeSite = (b: WorldAabb, zs: number[]): OffGridSite => {
		const z = zs.reduce((best, v) => (Math.abs(v) < Math.abs(best) ? v : best), zs[0] ?? 0);
		const x0 = b.maxX + 30, w = 16, d = 12;
		const room = { cx: x0 + w / 2, cz: z, w, d, doorDir: 'left' as const, doorX: x0, doorCZ: z, doorZ: z, corridorZ: z, side: -1 as const };
		return {
			room,
			extraSegments: [{ x1: b.maxX, z1: z, x2: x0, z2: z, width: 4, outdoor: true }],
			extraNodes: [{ x: b.maxX, y: 0, z }, { x: x0 - 1, y: 0, z }],
			obstacles: [
				{ minX: x0 - 0.25, maxX: x0 + 0.25, minZ: z - d / 2, maxZ: z - 1.6 },
				{ minX: x0 - 0.25, maxX: x0 + 0.25, minZ: z + 1.6, maxZ: z + d / 2 },
			],
			extent: { minX: b.maxX, maxX: x0 + w, minZ: z - d / 2, maxZ: z + d / 2 },
			focus: room,
			desks: (ids) => new Map(ids.map((id, i) => [id, { x: x0 + 3 + (i % 4) * 3, y: 0, z: z - 2 + Math.floor(i / 4) * 3 }])),
		};
	};
	const opts = { offGridSites: (k: string) => (k === 'test-yard' ? fakeSite : null) };

	it('stands an off-grid office in its plugin building, never on a lot', () => {
		const fp = computeFloorPlan([...team('f1', 3), ...team('y', 6)], [], [flow('f1', 'A', '-1,1'), yard('y')], [], opts);
		const room = fp.rooms.get('y')!;
		expect((room as any).lotId).toBe('');
		expect(room.cx).toBeGreaterThan(fp.corridorGrid.buildingBounds.maxX + 30);
		expect(fp.offGridSites.has('test-yard')).toBe(true);
		expect(fp.freeLots.length).toBe(computeFloorPlan(team('f1', 3), [], [flow('f1', 'A', '-1,1')]).freeLots.length);
	});

	it('seats the agents where the plugin says', () => {
		const fp = computeFloorPlan(team('y', 6), [], [yard('y')], [], opts);
		const site = fp.offGridSites.get('test-yard')!;
		for (const a of team('y', 6)) {
			const p = fp.deskPositions.get(a.id)!;
			expect(Math.abs(p.x - site.room.cx)).toBeLessThan(site.room.w / 2);
		}
	});

	it('links the building to the corridors and keeps the main bounds', () => {
		const plain = computeFloorPlan(team('f1', 3), [], [flow('f1', 'A', '-1,1')]);
		const fp = computeFloorPlan([...team('f1', 3), ...team('y', 2)], [], [flow('f1', 'A', '-1,1'), yard('y')], [], opts);
		expect(fp.corridorGrid.buildingBounds).toEqual(plain.corridorGrid.buildingBounds);
		expect(fp.corridorGrid.segments.length).toBe(plain.corridorGrid.segments.length + 1);
	});

	it('leaves an off-grid office off the floor while its plugin is not loaded', () => {
		const fp = computeFloorPlan(team('y', 2), [], [yard('y')]);
		expect(fp.rooms.has('y')).toBe(false);
		expect(fp.offGridSites.size).toBe(0);
	});

	it('walks agents into the building through its door only', () => {
		const fp = computeFloorPlan([...team('f1', 3), ...team('y', 2)], [], [flow('f1', 'A', '-1,1'), yard('y')], [], opts);
		const site = fp.offGridSites.get('test-yard')!;
		const src = fp.rooms.get('f1')!, tgt = fp.rooms.get('y')!;
		const path = buildPath(fp.deskPositions.get('f1-0')!, fp.deskPositions.get('y-0')!, src, tgt, fp.corridorGrid);
		expect(path[path.length - 1]).toEqual(fp.deskPositions.get('y-0')!);
		for (let i = 1; i < path.length; i++) for (const wall of site.obstacles) expect(segHitsAabb(path[i - 1], path[i], wall)).toBe(false);
	});
});
