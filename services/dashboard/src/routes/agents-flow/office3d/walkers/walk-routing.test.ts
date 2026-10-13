import { describe, it, expect, afterEach } from "bun:test";
import { computeFloorPlan } from "../floor-plan.js";
import {
  buildPath, planPointWalk, setWalkZones, segHitsAabb, roomAabbs, zoneObstacles, corridorRoute,
} from "./pathfinding.js";
import { receptionObstacles, receptionPickupPos } from "../office/reception-geometry.js";
import type { AgentData, FlowData, Aabb2D, Vec3 } from "../types.js";

/**
 * How walkers get from one place to another, measured on a floor shaped like
 * the live one. Three things used to go wrong on every rebuild:
 *
 *  - The corridor leg was hand-rolled: "go to the vertical corridor between us
 *    at my horizontal corridor's Z". An office whose door opens onto a
 *    VERTICAL corridor is not on any horizontal one, so the walker jumped
 *    diagonally from its doorstep to a junction 30 units away — through a
 *    meeting room on the live floor (545 of 6816 agent-to-agent walks).
 *  - Meeting rooms were only obstacles when the caller remembered to pass
 *    them, and only the meeting walks did.
 *  - Taxi commuters entered and left the building through the package-pickup
 *    spot, which sits BEHIND the reception counter: 86 of 86 crossed it.
 */

const SIZES = [15, 7, 8, 3, 5, 9, 3, 3, 3, 4, 3, 5, 4, 6, 3, 4, 5, 3, 2];
const flows: FlowData[] = SIZES.map((_, i) => ({ id: `f${i}`, name: `Office ${i}`, color: "#2563eb", active: 1 }));
const agents: AgentData[] = SIZES.flatMap((n, i) =>
  Array.from({ length: n }, (_, k) => ({
    id: `a${i}-${k}`, name: `a${i}-${k}`, description: "", provider: "", model: "",
    active: 1, builtin_handler: "", flow_id: `f${i}`,
  })),
);
const plan = computeFloorPlan(agents, [], flows);
const grid = plan.corridorGrid;
const hall = plan.meetingRooms[1];
const office = plan.meetingRooms[3];
const meetingSlots = plan.meetingRooms.filter((_, i) => i !== 1 && i !== 3);
const reception = receptionObstacles(hall.cx, hall.cz);
const zones = {
  myOffice: { rect: office, door: { x: office.cx, z: office.cz + office.d / 2 } },
  reception,
  meetingRooms: meetingSlots,
};

const box = (r: { cx: number; cz: number; w: number; d: number }): Aabb2D => ({
  minX: r.cx - r.w / 2, maxX: r.cx + r.w / 2, minZ: r.cz - r.d / 2, maxZ: r.cz + r.d / 2,
});

const sources = flows.map((f) => {
  const a = agents.find((x) => x.flow_id === f.id)!;
  return { id: a.id, from: plan.deskPositions.get(a.id)!, room: plan.rooms.get(f.id)! };
});

const fmt = (p: Vec3) => `(${p.x.toFixed(1)},${p.z.toFixed(1)})`;

function diagonals(path: Vec3[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.z - b.z) > 0.01) out.push(`${fmt(a)}→${fmt(b)}`);
  }
  return out;
}

function hitsAny(path: Vec3[], boxes: Aabb2D[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) for (const b of boxes) if (segHitsAabb(path[i - 1], path[i], b)) n++;
  return n;
}

/** The walk sendWalker builds between two desks (same obstacle list). */
function deskToDesk(s: typeof sources[number], t: typeof sources[number]): Vec3[] {
  const to = { x: t.from.x, y: 0, z: t.from.z - 1.5 };
  return buildPath(s.from, to, s.room, t.room, grid, [
    ...roomAabbs(plan.rooms, new Set([s.room, t.room])),
    ...zoneObstacles(),
  ]);
}

describe("corridorRoute — along the corridors, never across a block", () => {
  it("every leg lies on a corridor segment", () => {
    const off: string[] = [];
    // The building's four corner nodes sit on no segment; a route from one
    // starts with a square step onto the nearest corridor, covered below.
    const onNet = (n: Vec3) => grid.segments.some((s) => Math.abs(s.z1 - s.z2) < 0.1
      ? Math.abs(n.z - s.z1) < 0.5 && n.x >= Math.min(s.x1, s.x2) - 0.5 && n.x <= Math.max(s.x1, s.x2) + 0.5
      : Math.abs(n.x - s.x1) < 0.5 && n.z >= Math.min(s.z1, s.z2) - 0.5 && n.z <= Math.max(s.z1, s.z2) + 0.5);
    const nodes = grid.nodes.filter(onNet);
    expect(nodes.length).toBeGreaterThan(20);
    for (const a of nodes) for (const b of nodes) {
      const r = corridorRoute(a, b, grid);
      for (let i = 1; i < r.length; i++) {
        const p = r[i - 1], q = r[i];
        const onSeg = grid.segments.some((s) => {
          const horiz = Math.abs(s.z1 - s.z2) < 0.1;
          const lo = (u: number, v: number) => Math.min(u, v) - 0.01, hi = (u: number, v: number) => Math.max(u, v) + 0.01;
          return horiz
            ? Math.abs(p.z - s.z1) < 0.01 && Math.abs(q.z - s.z1) < 0.01 && Math.min(p.x, q.x) >= lo(s.x1, s.x2) && Math.max(p.x, q.x) <= hi(s.x1, s.x2)
            : Math.abs(p.x - s.x1) < 0.01 && Math.abs(q.x - s.x1) < 0.01 && Math.min(p.z, q.z) >= lo(s.z1, s.z2) && Math.max(p.z, q.z) <= hi(s.z1, s.z2);
        });
        if (!onSeg) { off.push(`${fmt(a)}→${fmt(b)}: leg ${fmt(p)}→${fmt(q)}`); break; }
      }
      if (off.length > 5) break;
    }
    expect(off).toEqual([]);
  });

  it("takes the shortest way: one turn between a horizontal and a vertical corridor", () => {
    const h = grid.segments.find((s) => Math.abs(s.z1 - s.z2) < 0.1)!;
    const v = grid.segments.find((s) => Math.abs(s.x1 - s.x2) < 0.1)!;
    const a = { x: v.x1 + 20, y: 0, z: h.z1 };
    const b = { x: v.x1, y: 0, z: h.z1 + 25 };
    const r = corridorRoute(a, b, grid);
    const len = r.slice(1).reduce((s, q, i) => s + Math.abs(q.x - r[i].x) + Math.abs(q.z - r[i].z), 0);
    expect(len).toBeCloseTo(20 + 25, 5);
  });

  it("a point off every corridor steps onto the nearest one squarely, never diagonally", () => {
    const off: string[] = [];
    for (const a of grid.nodes) for (const b of grid.nodes) {
      const d = diagonals(corridorRoute(a, b, grid));
      if (d.length) off.push(`${fmt(a)}→${fmt(b)}: ${d[0]}`);
    }
    expect(off.slice(0, 5)).toEqual([]);
  });
});

describe("walker routes on the live-shaped floor", () => {
  afterEach(() => setWalkZones({}));

  it("desk to desk across offices: no diagonal legs", () => {
    setWalkZones(zones);
    const off: string[] = [];
    for (const s of sources) for (const t of sources) {
      if (s === t) continue;
      const d = diagonals(deskToDesk(s, t));
      if (d.length) off.push(`${s.room.name} → ${t.room.name}: ${d[0]}`);
    }
    expect(off.slice(0, 5)).toEqual([]);
  });

  it("desk to desk across offices: never through a meeting room", () => {
    setWalkZones(zones);
    const off: string[] = [];
    for (const s of sources) for (const t of sources) {
      if (s === t) continue;
      if (hitsAny(deskToDesk(s, t), meetingSlots.map(box))) off.push(`${s.room.name} → ${t.room.name}`);
    }
    expect(off.slice(0, 5)).toEqual([]);
  });

  it("package pickup and the chief's office: never through a meeting room, even when the caller passes none", () => {
    setWalkZones(zones);
    const targets = [receptionPickupPos(hall.cx, hall.cz), { x: office.cx, y: 0, z: office.cz + office.d / 2 - 3 }];
    const off: string[] = [];
    for (const s of sources) for (const targetPoint of targets) {
      const p = planPointWalk({ from: s.from, targetPoint, srcRoom: s.room, rooms: plan.rooms, corridorGrid: grid, deskObstacles: [] });
      if (hitsAny(p, meetingSlots.map(box))) off.push(`${s.room.name} → ${fmt(targetPoint)}`);
      if (diagonals(p).length) off.push(`${s.room.name} → ${fmt(targetPoint)} diagonal ${diagonals(p)[0]}`);
    }
    expect(off.slice(0, 5)).toEqual([]);
  });

  it("desk to desk: never through another desk, and no doubling back", () => {
    setWalkZones(zones);
    // Real desk footprints, mirroring office3d/furniture.ts (desk group scale 1.3).
    const S = 1.3, sx = S * 2.4 / 2 + 0.25, zf = S * 0.65 + 0.25, zb = S * 0.9 + 0.25;
    const desks = [...plan.deskPositions].map(([id, p]) => ({ id, b: { minX: p.x - sx, maxX: p.x + sx, minZ: p.z - zf, maxZ: p.z + zb } }));
    const ids = [...plan.deskPositions.keys()].filter((_, i) => i % 3 === 0);
    const roomOf = (id: string) => plan.rooms.get(agents.find((a) => a.id === id)!.flow_id);
    const off: string[] = [];
    for (const s of ids) for (const t of ids) {
      if (s === t) continue;
      const from = plan.deskPositions.get(s)!, to0 = plan.deskPositions.get(t)!;
      const others = desks.filter((d) => d.id !== s && d.id !== t).map((d) => d.b);
      const p = buildPath(from, { x: to0.x, y: 0, z: to0.z - 1.5 }, roomOf(s), roomOf(t), grid, [
        ...others, ...roomAabbs(plan.rooms, new Set([roomOf(s), roomOf(t)])), ...zoneObstacles(),
      ]);
      const leg = p.findIndex((q, i) => i > 0 && others.some((b) => segHitsAabb(p[i - 1], q, b)));
      if (leg > 0) { off.push(`${s} → ${t}: through a desk on ${fmt(p[leg - 1])}→${fmt(p[leg])}`); continue; }
      for (let i = 2; i < p.length; i++) {
        const ax = p[i - 1].x - p[i - 2].x, az = p[i - 1].z - p[i - 2].z;
        const bx = p[i].x - p[i - 1].x, bz = p[i].z - p[i - 1].z;
        if (ax * bx + az * bz < -0.01) { off.push(`${s} → ${t}: doubles back at ${fmt(p[i - 1])}`); break; }
      }
    }
    expect(off.slice(0, 5)).toEqual([]);
  });

  it("taxi commuters leave by the lobby's south end: never over the reception, never the long way", () => {
    setWalkZones(zones);
    const exit = { x: hall.cx, y: 0, z: grid.buildingBounds.maxZ };
    const stairsTop = { x: hall.cx, y: 0, z: grid.buildingBounds.maxZ + 4 };
    const off: string[] = [];
    const len = (p: Vec3[]) => p.slice(1).reduce((s, q, i) => s + Math.abs(q.x - p[i].x) + Math.abs(q.z - p[i].z), 0);
    for (const s of sources) {
      const p = [...planPointWalk({ from: s.from, targetPoint: exit, srcRoom: s.room, rooms: plan.rooms, corridorGrid: grid, deskObstacles: [] }), stairsTop];
      if (hitsAny(p, reception)) off.push(`${s.room.name}: over the reception`);
      // Lower bound: Manhattan from the desk to the stairs, plus the way out of the office.
      const floor = Math.abs(s.from.x - stairsTop.x) + Math.abs(s.from.z - stairsTop.z);
      if (len(p) > floor * 1.6 + 30) off.push(`${s.room.name}: ${len(p).toFixed(0)} vs ${floor.toFixed(0)}`);
      // Never walks north of the reception counter's front on the way out.
      if (s.room.cz > hall.cz + hall.d / 2 && p.some((q) => q.z < hall.cz + 2)) off.push(`${s.room.name}: detours to the reception`);
    }
    expect(off).toEqual([]);
  });
});
