import { describe, it, expect } from 'bun:test';
import { computeFloorPlan } from '../floor-plan.js';
import { roomAabbs, segHitsAabb } from '../walkers/pathfinding.js';
import { crewRoute, workSpots, wallRise, WALL_IDS } from './route.js';
import type { AgentData, FlowData } from '../types.js';

const agent = (id: string, flowId: string): AgentData => ({
	id, name: id, description: '', provider: '', model: '', active: 1, builtin_handler: '', flow_id: flowId,
});
const team = (flowId: string, n: number) => Array.from({ length: n }, (_, i) => agent(`${flowId}-${i}`, flowId));
const flow = (id: string, lot_id: string): FlowData => ({ id, name: id, color: '#2563eb', active: 1, lot_id });

const LOTS = ['-1,1', '1,1', '2,0', '-2,0', '0,-2', '2,-2', '-2,2', '1,2', '-1,-2'];

function floor() {
	const flows = LOTS.map((lot, i) => flow(`f${i}`, lot));
	const agents = flows.flatMap((f, i) => team(f.id, 2 + (i % 4)));
	return computeFloorPlan(agents, [], flows);
}

describe('crew routes', () => {
	const plan = floor();
	const entrance = { x: 0, y: 0, z: plan.corridorGrid.buildingBounds.maxZ - 1 };

	for (const [fid, room] of plan.rooms) {
		it(`reach every wall of ${(room as any).lotId} without crossing another office`, () => {
			const others = new Map([...plan.rooms].filter(([id]) => id !== fid));
			const boxes = roomAabbs(others, new Set());
			for (const spot of workSpots(room)) {
				const path = crewRoute(entrance, spot.pos, room, plan.rooms, plan.corridorGrid, plan.meetingRooms);
				expect(path[0]).toEqual(entrance);
				expect(path[path.length - 1]).toEqual(spot.pos);
				for (let i = 0; i < path.length - 1; i++) {
					for (const b of boxes) expect(segHitsAabb(path[i], path[i + 1], b)).toBe(false);
				}
			}
		});
	}
});

describe('work spots', () => {
	const room = [...floor().rooms.values()][0];

	it('puts one builder at each wall, inside the room', () => {
		const spots = workSpots(room);
		expect(spots.map((s) => s.wall).sort()).toEqual([...WALL_IDS].sort());
		for (const s of spots) {
			expect(Math.abs(s.pos.x - room.cx)).toBeLessThan(room.w / 2);
			expect(Math.abs(s.pos.z - room.cz)).toBeLessThan(room.d / 2);
		}
	});

	it('keeps the builder at the door wall off the doorway', () => {
		const door = workSpots(room).find((s) => s.wall === room.doorDir)!;
		const dx = Math.abs(door.pos.x - ((room as any).doorX ?? room.cx));
		const dz = Math.abs(door.pos.z - ((room as any).doorCZ ?? room.doorZ));
		expect(Math.max(dx, dz)).toBeGreaterThan(2);
	});
});

describe('wall rise', () => {
	it('starts flat and ends at full height', () => {
		for (let k = 0; k < 4; k++) {
			expect(wallRise(0, k, 4)).toBe(0);
			expect(wallRise(1, k, 4)).toBe(1);
		}
	});

	it('raises the walls one after another', () => {
		expect(wallRise(0.2, 0, 4)).toBeGreaterThan(wallRise(0.2, 3, 4));
	});

	it('never shrinks back once raised a tier', () => {
		let last = 0;
		for (let p = 0; p <= 1; p += 0.01) {
			const s = wallRise(p, 1, 4);
			expect(s).toBeGreaterThanOrEqual(last - 0.12); // the bounce settles, it never drops a tier
			last = Math.max(last, s);
		}
	});
});

describe('crew routes — heading out of the lobby', () => {
	it('sets off toward the lot, whichever side of the hall the builder stands on', () => {
		const plan = floor();
		const room = [...plan.rooms.values()].find((r) => r.cx > 30)!;
		const z = plan.corridorGrid.buildingBounds.maxZ - 1;
		for (const x of [-1, 1]) {
			const path = crewRoute({ x, y: 0, z }, workSpots(room)[0].pos, room, plan.rooms, plan.corridorGrid, plan.meetingRooms);
			expect(path[1].x).toBeGreaterThan(0);
		}
	});
});
