import { describe, it, expect } from "bun:test";
import {
  exitViaDoor,
  enterViaDoor,
  doorOpening,
  segHitsAabb,
  roomAabbs,
  DOOR_HALF,
} from "./pathfinding.js";
import type { RoomInfo, Vec3 } from "../types.js";

/**
 * Rooms in the real floor plan put the door on ANY of the four walls — the
 * live layout is 3 left, 3 right, 3 top. A router that only handles ±Z doors
 * walks two thirds of the building through solid wall, which is the bug this
 * file exists to keep fixed.
 */
function room(doorDir: "left" | "right" | "top" | "bottom"): RoomInfo {
  const cx = -30, cz = 29, w = 19.5, d = 19.5;
  const doorX = doorDir === "left" ? cx - w / 2 : doorDir === "right" ? cx + w / 2 : cx;
  const doorCZ = doorDir === "top" ? cz + d / 2 : doorDir === "bottom" ? cz - d / 2 : cz;
  return {
    cx, cz, w, d, color: "#fff", name: "T", doorZ: doorCZ, side: 1,
    doorDir, doorX, doorCZ,
  } as unknown as RoomInfo;
}

/** Where the polyline crosses the room boundary, or null if it never does. */
function boundaryCrossing(pts: Vec3[], r: RoomInfo): Vec3 | null {
  const minX = r.cx - r.w / 2, maxX = r.cx + r.w / 2;
  const minZ = r.cz - r.d / 2, maxZ = r.cz + r.d / 2;
  const inside = (p: Vec3) =>
    p.x >= minX - 1e-6 && p.x <= maxX + 1e-6 && p.z >= minZ - 1e-6 && p.z <= maxZ + 1e-6;
  for (let i = 1; i < pts.length; i++) {
    if (inside(pts[i - 1]) && !inside(pts[i])) {
      // Walk the segment to find the exact boundary point.
      const a = pts[i - 1], b = pts[i];
      let lo = 0, hi = 1;
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        const p = { x: a.x + (b.x - a.x) * mid, y: 0, z: a.z + (b.z - a.z) * mid };
        if (inside(p)) lo = mid; else hi = mid;
      }
      return { x: a.x + (b.x - a.x) * lo, y: 0, z: a.z + (b.z - a.z) * lo };
    }
  }
  return null;
}

describe("exitViaDoor", () => {
  // Desk offsets that matter: the real DevOps Office puts its 5 desks at
  // z = cz ± 2.25, and the door opening is only ±1.25 wide. Every one of
  // those desks is outside the opening, so an X-first exit leaves through
  // solid wall — this is the exact case the bug reproduced on.
  const deskOffsets = [-2.25, 2.25, -6, 6, 0];

  for (const dir of ["left", "right", "top", "bottom"] as const) {
    for (const off of deskOffsets) {
      it(`leaves through the opening — door ${dir}, desk offset ${off}`, () => {
        const r = room(dir);
        const from: Vec3 =
          dir === "left" || dir === "right"
            ? { x: r.cx + off, y: 0, z: r.cz + off }
            : { x: r.cx + off, y: 0, z: r.cz + off };

        const pts = [from, ...exitViaDoor(from, r)];
        const cross = boundaryCrossing(pts, r);
        expect(cross).not.toBeNull();

        const open = doorOpening(r);
        if (dir === "left" || dir === "right") {
          // Must cross the ±X wall, and do it inside the door's Z span.
          expect(Math.abs(cross!.x - (r as any).doorX)).toBeLessThan(0.01);
          expect(cross!.z).toBeGreaterThanOrEqual(open.minZ - 1e-6);
          expect(cross!.z).toBeLessThanOrEqual(open.maxZ + 1e-6);
        } else {
          expect(Math.abs(cross!.z - (r as any).doorCZ)).toBeLessThan(0.01);
          expect(cross!.x).toBeGreaterThanOrEqual(open.minX - 1e-6);
          expect(cross!.x).toBeLessThanOrEqual(open.maxX + 1e-6);
        }
      });
    }
  }

  it("ends outside the room so the corridor leg starts clear of the wall", () => {
    const r = room("right");
    const from: Vec3 = { x: r.cx, y: 0, z: r.cz + 2.25 };
    const pts = exitViaDoor(from, r);
    const last = pts[pts.length - 1];
    expect(last.x).toBeGreaterThan(r.cx + r.w / 2);
  });
});

describe("enterViaDoor", () => {
  for (const dir of ["left", "right", "top", "bottom"] as const) {
    it(`enters through the opening — door ${dir}`, () => {
      const r = room(dir);
      const seat: Vec3 = { x: r.cx - 3, y: 0, z: r.cz + 4 };
      const pts = [...enterViaDoor(seat, r), seat];
      // Reverse of an exit: the first point is outside, the last is the seat.
      const reversed = [...pts].reverse();
      const cross = boundaryCrossing(reversed, r);
      expect(cross).not.toBeNull();
      const open = doorOpening(r);
      if (dir === "left" || dir === "right") {
        expect(cross!.z).toBeGreaterThanOrEqual(open.minZ - 1e-6);
        expect(cross!.z).toBeLessThanOrEqual(open.maxZ + 1e-6);
      } else {
        expect(cross!.x).toBeGreaterThanOrEqual(open.minX - 1e-6);
        expect(cross!.x).toBeLessThanOrEqual(open.maxX + 1e-6);
      }
    });
  }
});

describe("doorOpening", () => {
  it("is as wide as the gap the wall builder actually cuts", () => {
    const r = room("right");
    const open = doorOpening(r);
    expect(open.maxZ - open.minZ).toBeCloseTo(DOOR_HALF * 2, 6);
  });
});

describe("segHitsAabb", () => {
  it("catches a segment crossing a neighbouring room", () => {
    const rooms = new Map<string, RoomInfo>([["a", room("right")]]);
    const boxes = roomAabbs(rooms, new Set());
    // Straight through the middle of the room.
    const hit = segHitsAabb({ x: -60, y: 0, z: 29 }, { x: 0, y: 0, z: 29 }, boxes[0]);
    expect(hit).toBe(true);
  });

  it("clears a segment that runs outside the room", () => {
    const rooms = new Map<string, RoomInfo>([["a", room("right")]]);
    const boxes = roomAabbs(rooms, new Set());
    const clear = segHitsAabb({ x: -60, y: 0, z: 60 }, { x: 0, y: 0, z: 60 }, boxes[0]);
    expect(clear).toBe(false);
  });
});

// ── Integration: a whole generated floor, not a hand-made room ────────────
//
// The unit tests above pin the door geometry. This one pins the thing the
// user actually sees: walk every office to every other office and assert no
// segment of any route passes through a wall it shouldn't. Built from
// computeFloorPlan so the layout — including which wall each door lands on —
// is the real generator's output, not a fixture that could drift away from it.

import { computeFloorPlan } from "../floor-plan.js";
import { buildPath } from "./pathfinding.js";

function syntheticFloor(officeCount: number, perOffice: number) {
  const flows = Array.from({ length: officeCount }, (_, i) => ({
    id: `f${i}`, name: `Office ${i}`, color: "#888", active: 1,
  }));
  const agents = flows.flatMap((f, fi) =>
    Array.from({ length: perOffice }, (_, ai) => ({
      id: `a${fi}-${ai}`, name: `A${fi}${ai}`, description: "",
      provider: "", model: "", active: 1, builtin_handler: "", flow_id: f.id,
    })),
  );
  return computeFloorPlan(agents as any, [], flows as any, []);
}

describe("buildPath on a generated floor", () => {
  const fp: any = syntheticFloor(9, 5);
  const roomList: RoomInfo[] = [...fp.rooms.values()];

  it("generates a layout with doors on more than one wall", () => {
    const dirs = new Set(roomList.map(r => (r as any).doorDir));
    expect(dirs.size).toBeGreaterThan(1);
  });

  it("never crosses a wall of a room it is not going to or coming from", () => {
    const offenders: string[] = [];
    const flowIds = [...fp.rooms.keys()];

    for (const srcFlow of flowIds) {
      for (const tgtFlow of flowIds) {
        if (srcFlow === tgtFlow) continue;
        const srcRoom = fp.rooms.get(srcFlow)!;
        const tgtRoom = fp.rooms.get(tgtFlow)!;
        const from = [...fp.deskPositions.entries()]
          .find(([id]) => id.startsWith(`a${flowIds.indexOf(srcFlow)}-`))?.[1];
        const to = [...fp.deskPositions.entries()]
          .find(([id]) => id.startsWith(`a${flowIds.indexOf(tgtFlow)}-`))?.[1];
        if (!from || !to) continue;

        const boxes = roomAabbs(fp.rooms, new Set([srcRoom, tgtRoom]));
        const path = buildPath(from, to, srcRoom, tgtRoom, fp.corridorGrid, boxes);

        for (let i = 1; i < path.length; i++) {
          const bad = boxes.find(b => segHitsAabb(path[i - 1], path[i], b));
          if (bad) {
            offenders.push(
              `${(srcRoom as any).name} → ${(tgtRoom as any).name}: segment ` +
              `(${path[i - 1].x.toFixed(1)},${path[i - 1].z.toFixed(1)})→` +
              `(${path[i].x.toFixed(1)},${path[i].z.toFixed(1)})`,
            );
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves each office through its own doorway", () => {
    const offenders: string[] = [];
    const flowIds = [...fp.rooms.keys()];

    for (let i = 0; i < flowIds.length; i++) {
      const srcRoom = fp.rooms.get(flowIds[i])!;
      const tgtRoom = fp.rooms.get(flowIds[(i + 1) % flowIds.length])!;
      for (const [id, from] of fp.deskPositions as Map<string, Vec3>) {
        if (!id.startsWith(`a${i}-`)) continue;
        const to = [...fp.deskPositions.entries()]
          .find(([tid]) => tid.startsWith(`a${(i + 1) % flowIds.length}-`))?.[1];
        if (!to) continue;

        const boxes = roomAabbs(fp.rooms, new Set([srcRoom, tgtRoom]));
        const path = buildPath(from, to, srcRoom, tgtRoom, fp.corridorGrid, boxes);
        const cross = boundaryCrossing(path, srcRoom);
        if (!cross) { offenders.push(`${id}: never left ${(srcRoom as any).name}`); continue; }

        const open = doorOpening(srcRoom);
        const inGap =
          cross.x >= open.minX - 0.05 && cross.x <= open.maxX + 0.05 &&
          cross.z >= open.minZ - 0.05 && cross.z <= open.maxZ + 0.05;
        if (!inGap) {
          offenders.push(
            `${id} left ${(srcRoom as any).name} (door ${(srcRoom as any).doorDir}) ` +
            `at (${cross.x.toFixed(2)},${cross.z.toFixed(2)}), opening is ` +
            `x[${open.minX.toFixed(2)},${open.maxX.toFixed(2)}] z[${open.minZ.toFixed(2)},${open.maxZ.toFixed(2)}]`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── The assertion with teeth ──────────────────────────────────────────────
//
// Checking only WHERE a path crosses the boundary is not enough, and that is
// how this bug survived six fixes: the old route ended exactly ON the wall
// plane, so a crossing test saw nothing wrong. What it actually did was walk
// the agent sideways to the wall at its own desk's Z — standing inside solid
// wall — and then slide ALONG the inside of that wall until it reached the
// door. Measured on a generated floor: 20 of 45 exits spent up to 1.2 units
// inside the wall. So assert on distance travelled through wall, not on
// crossing points.

const WALL_HALF_T = 0.225;

/** Is this point inside solid wall — near a wall plane, outside the opening? */
function insideWall(p: Vec3, r: RoomInfo): boolean {
  const o = doorOpening(r);
  const onXWall = Math.abs(Math.abs(p.x - r.cx) - r.w / 2) <= WALL_HALF_T;
  const onZWall = Math.abs(Math.abs(p.z - r.cz) - r.d / 2) <= WALL_HALF_T;
  const spanZ = p.z >= r.cz - r.d / 2 - WALL_HALF_T && p.z <= r.cz + r.d / 2 + WALL_HALF_T;
  const spanX = p.x >= r.cx - r.w / 2 - WALL_HALF_T && p.x <= r.cx + r.w / 2 + WALL_HALF_T;
  if (onXWall && spanZ) {
    const throughGap =
      o.minX === o.maxX &&
      p.z >= o.minZ - 1e-6 && p.z <= o.maxZ + 1e-6 &&
      Math.abs(p.x - o.minX) <= WALL_HALF_T + 1e-6;
    if (!throughGap) return true;
  }
  if (onZWall && spanX) {
    const throughGap =
      o.minZ === o.maxZ &&
      p.x >= o.minX - 1e-6 && p.x <= o.maxX + 1e-6 &&
      Math.abs(p.z - o.minZ) <= WALL_HALF_T + 1e-6;
    if (!throughGap) return true;
  }
  return false;
}

/** Distance the polyline spends buried in this room's walls. */
function metresInsideWall(pts: Vec3[], r: RoomInfo): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(2, Math.ceil(len / 0.1));
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = (s + 1) / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: 0, z: a.z + (b.z - a.z) * t };
      const q = { x: a.x + (b.x - a.x) * t2, y: 0, z: a.z + (b.z - a.z) * t2 };
      if (insideWall(p, r) && insideWall(q, r)) total += Math.hypot(q.x - p.x, q.z - p.z);
    }
  }
  return total;
}

describe("no walker walks through masonry", () => {
  const fp: any = syntheticFloor(9, 5);

  it("every desk in every office reaches the corridor without entering a wall", () => {
    const offenders: string[] = [];
    const flowIds = [...fp.rooms.keys()];

    for (let i = 0; i < flowIds.length; i++) {
      const r: RoomInfo = fp.rooms.get(flowIds[i])!;
      for (const [id, from] of fp.deskPositions as Map<string, Vec3>) {
        if (!id.startsWith(`a${i}-`)) continue;
        const path = [from, ...exitViaDoor(from, r)];
        const buried = metresInsideWall(path, r);
        if (buried > 0.15) {
          offenders.push(
            `${id} out of ${(r as any).name} (door ${(r as any).doorDir}): ` +
            `${buried.toFixed(2)} units inside the wall`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("and the same holds coming back in", () => {
    const offenders: string[] = [];
    const flowIds = [...fp.rooms.keys()];

    for (let i = 0; i < flowIds.length; i++) {
      const r: RoomInfo = fp.rooms.get(flowIds[i])!;
      for (const [id, to] of fp.deskPositions as Map<string, Vec3>) {
        if (!id.startsWith(`a${i}-`)) continue;
        const path = [...enterViaDoor(to, r), to];
        const buried = metresInsideWall(path, r);
        if (buried > 0.15) {
          offenders.push(
            `${id} into ${(r as any).name} (door ${(r as any).doorDir}): ` +
            `${buried.toFixed(2)} units inside the wall`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── Meeting rooms ─────────────────────────────────────────────────────────
//
// The offices were fixed first and the meeting rooms were missed, which is
// the worse half: a meeting is the thing on screen worth watching, and every
// attendee of every meeting walks into one. They are not in the `rooms` map,
// so none of the door-aware routing reached them — the walker got the raw
// door midpoint and then struck out diagonally for its chair, scraping the
// inside of the wall on the way past. 38 of 40 seats on the live floor.

import { rectAsRoom } from "./pathfinding.js";

describe("meeting rooms are rooms too", () => {
  const slots = [
    { cx: -30, cz: 5, w: 19.5, d: 15 },
    { cx: 21, cz: 5, w: 19.5, d: 15 },
    { cx: -30, cz: -21, w: 19.5, d: 24 },
    { cx: 21, cz: -21, w: 19.5, d: 24 },
  ];

  /** Mirrors AgentWorld3D.getMeetingSeatPositions. */
  function seatsOf(mr: { cx: number; cz: number; w: number; d: number }): Vec3[] {
    const tableW = Math.min(mr.w * 0.5, 6);
    const tableD = Math.min(mr.d * 0.3, 3);
    const out: Vec3[] = [];
    const n = Math.max(2, Math.floor(tableW / 1.5));
    for (let i = 0; i < n; i++) {
      const x = mr.cx - tableW / 2 + (tableW / (n + 1)) * (i + 1);
      out.push({ x, y: 0, z: mr.cz - tableD / 2 - 0.6 });
      out.push({ x, y: 0, z: mr.cz + tableD / 2 + 0.6 });
    }
    out.push({ x: mr.cx - tableW / 2 - 0.6, y: 0, z: mr.cz });
    out.push({ x: mr.cx + tableW / 2 + 0.6, y: 0, z: mr.cz });
    return out;
  }

  for (const wall of ["left", "right", "top", "bottom"] as const) {
    it(`every seat is reached through the doorway — door on the ${wall} wall`, () => {
      const offenders: string[] = [];
      for (const slot of slots) {
        const door =
          wall === "left" ? { x: slot.cx - slot.w / 2, z: slot.cz }
          : wall === "right" ? { x: slot.cx + slot.w / 2, z: slot.cz }
          : wall === "top" ? { x: slot.cx, z: slot.cz + slot.d / 2 }
          : { x: slot.cx, z: slot.cz - slot.d / 2 };
        const roomLike = rectAsRoom(slot, door);
        for (const seat of seatsOf(slot)) {
          const path = [...enterViaDoor(seat, roomLike), seat];
          const buried = metresInsideWall(path, roomLike);
          if (buried > 0.15) {
            offenders.push(
              `seat (${seat.x.toFixed(1)},${seat.z.toFixed(1)}) in room ` +
              `(${slot.cx},${slot.cz}): ${buried.toFixed(2)} units inside the wall`,
            );
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("puts the doorway on the wall the door point actually sits on", () => {
    const slot = slots[0];
    expect((rectAsRoom(slot, { x: slot.cx + slot.w / 2, z: slot.cz }) as any).doorDir).toBe("right");
    expect((rectAsRoom(slot, { x: slot.cx, z: slot.cz + slot.d / 2 }) as any).doorDir).toBe("top");
    expect((rectAsRoom(slot, { x: slot.cx - slot.w / 2, z: slot.cz }) as any).doorDir).toBe("left");
    expect((rectAsRoom(slot, { x: slot.cx, z: slot.cz - slot.d / 2 }) as any).doorDir).toBe("bottom");
  });
});

// ── The table is solid ────────────────────────────────────────────────────
//
// Walkers went door → chair in a straight line, and for any chair on the far
// side that line crosses the table top. Nothing ever put the table in an
// obstacle list — only desks, office walls and OTHER meeting rooms were in
// there — so the middle of the room was open floor as far as the router knew.

import { meetingTableAabb, avoidDesks } from "./pathfinding.js";

describe("nobody walks over the conference table", () => {
  const slot = { cx: -30, cz: 4.5, w: 19.5, d: 15 };

  function seatsOfSlot(mr: { cx: number; cz: number; w: number; d: number }): Vec3[] {
    const tableW = Math.min(mr.w * 0.5, 6);
    const tableD = Math.min(mr.d * 0.3, 3);
    const out: Vec3[] = [];
    const n = Math.max(2, Math.floor(tableW / 1.5));
    out.push({ x: mr.cx - tableW / 2 - 0.6, y: 0, z: mr.cz });
    out.push({ x: mr.cx + tableW / 2 + 0.6, y: 0, z: mr.cz });
    for (let i = 0; i < n; i++) {
      const x = mr.cx - tableW / 2 + (tableW / (n + 1)) * (i + 1);
      out.push({ x, y: 0, z: mr.cz - tableD / 2 - 0.6 });
      out.push({ x, y: 0, z: mr.cz + tableD / 2 + 0.6 });
    }
    return out;
  }

  it("keeps every chair outside the table box (so seats stay legal endpoints)", () => {
    const box = meetingTableAabb(slot, 0);
    for (const s of seatsOfSlot(slot)) {
      const inside = s.x > box.minX && s.x < box.maxX && s.z > box.minZ && s.z < box.maxZ;
      expect(inside).toBe(false);
    }
  });

  for (const wall of ["left", "right", "top", "bottom"] as const) {
    it(`routes around the table to every chair — door on the ${wall} wall`, () => {
      const door =
        wall === "left" ? { x: slot.cx - slot.w / 2, z: slot.cz }
        : wall === "right" ? { x: slot.cx + slot.w / 2, z: slot.cz }
        : wall === "top" ? { x: slot.cx, z: slot.cz + slot.d / 2 }
        : { x: slot.cx, z: slot.cz - slot.d / 2 };
      const roomLike = rectAsRoom(slot, door);
      const table = meetingTableAabb(slot);
      const offenders: string[] = [];

      for (const seat of seatsOfSlot(slot)) {
        const legs = enterViaDoor(seat, roomLike, { stopInsideDoor: true });
        const routed = avoidDesks([...legs, seat], [table]);
        for (let i = 1; i < routed.length; i++) {
          if (segHitsAabb(routed[i - 1], routed[i], table)) {
            offenders.push(
              `seat (${seat.x.toFixed(1)},${seat.z.toFixed(1)}) crosses the table ` +
              `on leg ${i} of ${routed.length - 1}`,
            );
            break;
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
