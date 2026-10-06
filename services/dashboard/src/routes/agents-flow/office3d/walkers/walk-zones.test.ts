import { describe, it, expect, afterEach } from "bun:test";
import { computeFloorPlan } from "../floor-plan.js";
import { planPointWalk, setWalkZones, segHitsAabb, meetingTableAabb } from "./pathfinding.js";
import { receptionObstacles, receptionPickupPos } from "../office/reception-geometry.js";
import type { AgentData, FlowData, Aabb2D, Vec3 } from "../types.js";

/**
 * The headquarters office and the reception are built outside the flow-room
 * map, so for a long time nothing routed around them: every walker heading to
 * the top agent's office came down the back corridor and walked straight
 * through its north wall (62 of 62 desks on the live floor), and every package
 * pickup cut through the reception's back wall (13 of 13 offices). A walker
 * must NEVER cross a wall — these tests pin that on a floor shaped like the
 * live one.
 */

// 13 offices of mixed size, like the live floor (3–15 agents each).
const SIZES = [15, 7, 8, 3, 5, 9, 3, 3, 3, 4, 3, 5, 4];
const flows: FlowData[] = SIZES.map((_, i) => ({ id: `f${i}`, name: `Office ${i}`, color: "#2563eb", active: 1 }));
const agents: AgentData[] = SIZES.flatMap((n, i) =>
  Array.from({ length: n }, (_, k) => ({
    id: `a${i}-${k}`, name: `a${i}-${k}`, description: "", provider: "", model: "",
    active: 1, builtin_handler: "", flow_id: `f${i}`,
  })),
);
const plan = computeFloorPlan(agents, [], flows);
const hall = plan.meetingRooms[1];
const office = plan.meetingRooms[3];
const officeDoor = { x: office.cx, z: office.cz + office.d / 2 };
const reception = receptionObstacles(hall.cx, hall.cz);
const pickup = receptionPickupPos(hall.cx, hall.cz);

const WALL = 0.225;
const DOOR_HALF = 1.25;
/** The office's four walls, with the 2.5-wide doorway cut out of the south one. */
const officeWalls: Array<Aabb2D & { name: string }> = (() => {
  const n = office.cz - office.d / 2, s = office.cz + office.d / 2;
  const w = office.cx - office.w / 2, e = office.cx + office.w / 2;
  return [
    { name: "north", minX: w, maxX: e, minZ: n - WALL, maxZ: n + WALL },
    { name: "west", minX: w - WALL, maxX: w + WALL, minZ: n, maxZ: s },
    { name: "east", minX: e - WALL, maxX: e + WALL, minZ: n, maxZ: s },
    { name: "south-left", minX: w, maxX: office.cx - DOOR_HALF, minZ: s - WALL, maxZ: s + WALL },
    { name: "south-right", minX: office.cx + DOOR_HALF, maxX: e, minZ: s - WALL, maxZ: s + WALL },
  ];
})();

/** Visitor chairs, mirroring office/my-office.ts: the desk stands against the
 *  back (north) wall and two rows of two chairs face it — so the chairs are on
 *  the far side of the room from the door. */
const officeSeats: Vec3[] = (() => {
  const zBack = office.cz - office.d / 2, zDoor = office.cz + office.d / 2;
  const deskFrontZ = zBack + 2.6 + 1.5 / 2;
  const rowSpace = Math.max(0.95, Math.min(1.3, (zDoor - deskFrontZ - 1.5) / 2));
  const gapX = Math.min(1.1, Math.min(4.4, office.w - 2.2) * 0.28);
  const rows = [deskFrontZ + rowSpace, deskFrontZ + 2 * rowSpace + 0.1];
  return [-gapX, gapX].flatMap((dx) => rows.map((z) => ({ x: office.cx + dx, y: 0, z })));
})();

/** One representative desk per office. */
const sources = flows.map((f) => {
  const a = agents.find((x) => x.flow_id === f.id)!;
  return { from: plan.deskPositions.get(a.id)!, srcRoom: plan.rooms.get(f.id)! };
});

function crossings(path: Vec3[], boxes: Array<Aabb2D & { name?: string }>): string[] {
  const out: string[] = [];
  for (let i = 1; i < path.length; i++)
    for (const b of boxes)
      if (segHitsAabb(path[i - 1], path[i], b)) out.push(`leg ${i} hits ${b.name ?? "box"}`);
  return out;
}

function walk(from: Vec3, srcRoom: any, target: Vec3, extra: Partial<Parameters<typeof planPointWalk>[0]> = {}) {
  return planPointWalk({
    from, targetPoint: target, srcRoom,
    rooms: plan.rooms, corridorGrid: plan.corridorGrid, deskObstacles: [],
    ...extra,
  });
}

describe("walk zones — headquarters office and reception are solid", () => {
  afterEach(() => setWalkZones({}));

  it("enters the headquarters office through its door, from every office, to every chair", () => {
    setWalkZones({ myOffice: { rect: office, door: officeDoor }, reception });
    const offenders: string[] = [];
    for (const [i, s] of sources.entries())
      for (const seat of officeSeats) {
        const hits = crossings(walk(s.from, s.srcRoom, seat), [...officeWalls, ...reception]);
        if (hits.length) offenders.push(`office ${i} → chair (${seat.x},${seat.z}): ${hits.join(", ")}`);
      }
    expect(offenders).toEqual([]);
  });

  it("reaches the reception pickup spot without crossing the counter, columns or back wall", () => {
    setWalkZones({ myOffice: { rect: office, door: officeDoor }, reception });
    const offenders: string[] = [];
    for (const [i, s] of sources.entries()) {
      const hits = crossings(walk(s.from, s.srcRoom, pickup), [...reception, ...officeWalls]);
      if (hits.length) offenders.push(`office ${i}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("never cuts through the headquarters office or the reception on the way to a meeting room", () => {
    setWalkZones({ myOffice: { rect: office, door: officeDoor }, reception });
    const slots = plan.meetingRooms.filter((_, i) => i !== 1 && i !== 3);
    const offenders: string[] = [];
    for (const [si, slot] of slots.entries()) {
      // Door on the wall facing the hall, the same rule meetingRoomDoorPoint uses.
      const door = Math.abs(slot.cz - hall.cz) > Math.abs(slot.cx - hall.cx)
        ? { x: slot.cx, z: slot.cz + (slot.cz < hall.cz ? slot.d / 2 : -slot.d / 2) }
        : { x: slot.cx + (slot.cx < hall.cx ? slot.w / 2 : -slot.w / 2), z: slot.cz };
      const seat = { x: slot.cx, y: 0, z: slot.cz + (door.z > slot.cz ? 1 : -1) * (meetingTableAabb(slot).maxZ - slot.cz + 0.6) };
      for (const [i, s] of sources.entries()) {
        const path = walk(s.from, s.srcRoom, seat, {
          viaPoint: { x: door.x, y: 0, z: door.z },
          meetingRoomObstacles: slots, meetingRoomObstacleExempt: si,
        });
        const hits = crossings(path, [...officeWalls, ...reception]);
        if (hits.length) offenders.push(`office ${i} → meeting ${si}: ${hits.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("without registered zones the walk is unchanged (no zones, no extra obstacles)", () => {
    const s = sources[0];
    const a = walk(s.from, s.srcRoom, pickup);
    setWalkZones({});
    const b = walk(s.from, s.srcRoom, pickup);
    expect(a).toEqual(b);
  });
});
