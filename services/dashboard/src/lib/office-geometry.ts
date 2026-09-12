/**
 * Where people stand and sit on the 3D floor: meeting-room doors, seats around
 * a conference table, and picking a free visitor chair.
 *
 * Extracted from AgentWorld3D.svelte. These are plain coordinate maths — the
 * walker that actually moves along them stays in the component, which is what
 * lets these be tested at all.
 */

/** A room footprint: centre plus width/depth on the floor plane. */
export interface RoomBox {
  cx: number;
  cz: number;
  w: number;
  d: number;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The wall midpoint closest to the hall — where a walker should enter the
 * room from, so people don't clip through the far wall.
 */
export function meetingRoomDoorPoint(mr: RoomBox, hallCenter: { x: number; z: number }): Point3 {
  const wallCenters = [
    { x: mr.cx,             z: mr.cz + mr.d / 2 },
    { x: mr.cx,             z: mr.cz - mr.d / 2 },
    { x: mr.cx - mr.w / 2,  z: mr.cz },
    { x: mr.cx + mr.w / 2,  z: mr.cz },
  ];
  let best = wallCenters[1];
  let minDist = Infinity;
  for (const wc of wallCenters) {
    const d2 = (wc.x - hallCenter.x) ** 2 + (wc.z - hallCenter.z) ** 2;
    if (d2 < minDist) { minDist = d2; best = wc; }
  }
  return { x: best.x, y: 0, z: best.z };
}

/**
 * Seats around the conference table, head seats first.
 *
 * Callers hand out seats in participant order and the moderator is always
 * participant 0, so whoever chairs the meeting takes seats[0]. With the head
 * seats appended last, the chair sat in the middle of a long side like
 * everyone else and the table had nobody at its head — and for the
 * cross-office coordination path, seats[0] and seats[1] need to be the two
 * heads, which face each other across the table.
 */
export function getMeetingSeatPositions(mr: RoomBox): Point3[] {
  const tableW = Math.min(mr.w * 0.5, 6);
  const tableD = Math.min(mr.d * 0.3, 3);
  const seats: Point3[] = [];
  const numPerSide = Math.max(2, Math.floor(tableW / 1.5));
  seats.push({ x: mr.cx - tableW / 2 - 0.6, y: 0, z: mr.cz });
  seats.push({ x: mr.cx + tableW / 2 + 0.6, y: 0, z: mr.cz });
  // Then along both long sides.
  for (let i = 0; i < numPerSide; i++) {
    const x = mr.cx - tableW / 2 + (tableW / (numPerSide + 1)) * (i + 1);
    seats.push({ x, y: 0, z: mr.cz - tableD / 2 - 0.6 }); // front side
    seats.push({ x, y: 0, z: mr.cz + tableD / 2 + 0.6 }); // back side
  }
  return seats;
}

/** True when both agents exist and belong to the same office. */
export function sameOffice(
  agents: Array<{ id: string; flow_id?: string }>,
  srcId: string,
  tgtId: string,
): boolean {
  const sf = agents.find(a => a.id === srcId)?.flow_id ?? '';
  const tf = agents.find(a => a.id === tgtId)?.flow_id ?? '';
  return !!sf && !!tf && sf === tf;
}

/** Just enough of a walker to tell which seat it is heading for. */
export interface SeatedWalker {
  targetId?: string;
  curve?: Array<{ x: number; z: number }>;
}

/**
 * Pick a free visitor chair (one not already targeted by another walker) so
 * concurrent visitors don't stack on the same seat. Falls back to round-robin
 * when every chair is taken, and returns null when there are no chairs.
 */
export function pickFreeChair(seats: Point3[], walkers: SeatedWalker[]): Point3 | null {
  if (seats.length === 0) return null;
  const taken = new Set<number>();
  for (const w of walkers) {
    if (w.targetId !== 'myoffice' && w.targetId !== 'meeting') continue;
    const curve = w.curve;
    const c = curve?.[curve.length - 1];
    if (!c) continue;
    seats.forEach((s, idx) => {
      if (Math.abs(s.x - c.x) < 0.5 && Math.abs(s.z - c.z) < 0.5) taken.add(idx);
    });
  }
  for (let i = 0; i < seats.length; i++) {
    if (!taken.has(i)) return seats[i];
  }
  return seats[taken.size % seats.length];
}
