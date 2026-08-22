#!/usr/bin/env bun
/**
 * Reproduction for the walker-through-walls bug.
 *
 *   bun run scripts/repro-wall-crossing.ts                  # generated floor
 *   bun run scripts/repro-wall-crossing.ts --graph g.json    # your live floor
 *   bun run scripts/repro-wall-crossing.ts --svg out.svg     # + a drawing
 *
 * Where `g.json` is the body of `GET /api/agents/graph`.
 *
 * ── What it reproduces ────────────────────────────────────────────────────
 * Walkers left their office by moving in X to the door's X FIRST, while still
 * at their desk's Z, and only then sliding along to the door. On a door in a
 * ±Z wall that is correct. On a door in a ±X wall it means stepping into the
 * wall plane at whatever Z the desk happens to sit at — which is almost never
 * inside the 2.5-unit opening — and then walking along the inside of the wall
 * to reach the doorway.
 *
 * The reason this survived several fixes is that it is invisible to the
 * obvious test. The route ends exactly ON the wall plane, so "where does the
 * path cross the boundary?" answers "at the door, correctly" — the crossing is
 * fine, it is the walking *to* the crossing that goes through masonry. So this
 * measures metres travelled inside wall instead, which is the thing you can
 * actually see on screen.
 *
 * Exit code is 1 when any route walks through a wall, so it also works as a
 * check. Prints the same table for the old and the current routing so the
 * difference is the output, not a claim about it.
 */

import { computeFloorPlan } from "../src/routes/agents-flow/office3d/floor-plan.js";
import { nearestCorridorNode } from "../src/routes/agents-flow/office3d/floor-plan.js";
import { doorOpening, exitViaDoor } from "../src/routes/agents-flow/office3d/walkers/pathfinding.js";
import type { RoomInfo, Vec3 } from "../src/routes/agents-flow/office3d/types.js";

/** Half of WALL_T (office/_shared.ts). */
const WALL_HALF = 0.225;

// ── The routing as it was, verbatim ──────────────────────────────────────
// Straight out of sendWalkerToPoint before the fix: no doorDir awareness,
// always X first.
function exitTheOldWay(from: Vec3, room: RoomInfo): Vec3[] {
  const doorX = (room as any).doorX ?? room.cx;
  const doorZ = (room as any).doorCZ ?? room.doorZ;
  return [
    { x: doorX, y: 0, z: from.z },
    { x: doorX, y: 0, z: doorZ },
  ];
}

/** Is this point buried in one of the room's walls (and not in the doorway)? */
function insideWall(p: Vec3, r: RoomInfo): boolean {
  const o = doorOpening(r);
  const onXWall = Math.abs(Math.abs(p.x - r.cx) - r.w / 2) <= WALL_HALF;
  const onZWall = Math.abs(Math.abs(p.z - r.cz) - r.d / 2) <= WALL_HALF;
  const spanZ = p.z >= r.cz - r.d / 2 - WALL_HALF && p.z <= r.cz + r.d / 2 + WALL_HALF;
  const spanX = p.x >= r.cx - r.w / 2 - WALL_HALF && p.x <= r.cx + r.w / 2 + WALL_HALF;
  if (onXWall && spanZ) {
    const inDoorway =
      o.minX === o.maxX &&
      p.z >= o.minZ - 1e-6 && p.z <= o.maxZ + 1e-6 &&
      Math.abs(p.x - o.minX) <= WALL_HALF + 1e-6;
    if (!inDoorway) return true;
  }
  if (onZWall && spanX) {
    const inDoorway =
      o.minZ === o.maxZ &&
      p.x >= o.minX - 1e-6 && p.x <= o.maxX + 1e-6 &&
      Math.abs(p.z - o.minZ) <= WALL_HALF + 1e-6;
    if (!inDoorway) return true;
  }
  return false;
}

/** Distance a polyline spends inside this room's walls. */
function metresInWall(pts: Vec3[], r: RoomInfo): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(2, Math.ceil(len / 0.05));
    for (let s = 0; s < steps; s++) {
      const p = {
        x: a.x + (b.x - a.x) * (s / steps), y: 0,
        z: a.z + (b.z - a.z) * (s / steps),
      };
      const q = {
        x: a.x + (b.x - a.x) * ((s + 1) / steps), y: 0,
        z: a.z + (b.z - a.z) * ((s + 1) / steps),
      };
      if (insideWall(p, r) && insideWall(q, r)) total += Math.hypot(q.x - p.x, q.z - p.z);
    }
  }
  return total;
}

// ── Floor ────────────────────────────────────────────────────────────────

function syntheticGraph(offices = 9, perOffice = 5) {
  const flows = Array.from({ length: offices }, (_, i) => ({
    id: `f${i}`, name: `Office ${i}`, color: "#888", active: 1,
  }));
  const agents = flows.flatMap((f, fi) =>
    Array.from({ length: perOffice }, (_, ai) => ({
      id: `a${fi}-${ai}`, name: `A${fi}-${ai}`, description: "", provider: "",
      model: "", active: 1, builtin_handler: "", flow_id: f.id,
    })),
  );
  return { agents, chains: [], flows, ranks: [] };
}

const argv = process.argv.slice(2);
const graphArg = argv[argv.indexOf("--graph") + 1];
const svgArg = argv.includes("--svg") ? argv[argv.indexOf("--svg") + 1] : null;

const g = argv.includes("--graph")
  ? JSON.parse(await Bun.file(graphArg).text())
  : syntheticGraph();

const fp: any = computeFloorPlan(g.agents, g.chains ?? [], g.flows, g.ranks ?? []);

// ── Measure ──────────────────────────────────────────────────────────────

interface Row {
  agent: string; office: string; doorDir: string; old: number; now: number;
  from: Vec3; oldPath: Vec3[]; newPath: Vec3[]; room: RoomInfo;
}

const rows: Row[] = [];
const agentsByFlow = new Map<string, any[]>();
for (const a of g.agents) {
  if (!agentsByFlow.has(a.flow_id)) agentsByFlow.set(a.flow_id, []);
  agentsByFlow.get(a.flow_id)!.push(a);
}

for (const [flowId, room] of fp.rooms as Map<string, RoomInfo>) {
  for (const a of agentsByFlow.get(flowId) ?? []) {
    const from: Vec3 | undefined = fp.deskPositions.get(a.id);
    if (!from) continue;

    const oldExit = exitTheOldWay(from, room);
    const oldCorr = nearestCorridorNode(oldExit[oldExit.length - 1], fp.corridorGrid);
    const oldPath = [from, ...oldExit, oldCorr];

    const newExit = exitViaDoor(from, room);
    const newCorr = nearestCorridorNode(newExit[newExit.length - 1], fp.corridorGrid);
    const newPath = [from, ...newExit, newCorr];

    rows.push({
      agent: a.name, office: (room as any).name, doorDir: (room as any).doorDir,
      old: metresInWall(oldPath, room), now: metresInWall(newPath, room),
      from, oldPath, newPath, room,
    });
  }
}

const oldBad = rows.filter(r => r.old > 0.15);
const nowBad = rows.filter(r => r.now > 0.15);

console.log(`Floor: ${fp.rooms.size} offices, ${rows.length} desks` +
  (argv.includes("--graph") ? ` (from ${graphArg})` : " (generated)"));
console.log();
console.log("Worst offenders under the OLD routing:");
for (const r of [...oldBad].sort((a, b) => b.old - a.old).slice(0, 12)) {
  console.log(
    `  ${r.agent.slice(0, 22).padEnd(22)} ${r.office.slice(0, 22).padEnd(22)} ` +
    `door=${r.doorDir.padEnd(6)} ${r.old.toFixed(2)} units inside the wall`,
  );
}
console.log();
console.log(`OLD routing: ${oldBad.length}/${rows.length} desks walk through wall`);
console.log(`NOW        : ${nowBad.length}/${rows.length}`);

if (svgArg) {
  // Draw the single worst case, top-down, at 1 unit = 12 px.
  const worst = [...rows].sort((a, b) => b.old - a.old)[0];
  const r = worst.room;
  const pad = 6, S = 12;
  const minX = r.cx - r.w / 2 - pad, maxX = r.cx + r.w / 2 + pad;
  const minZ = r.cz - r.d / 2 - pad, maxZ = r.cz + r.d / 2 + pad;
  const px = (x: number) => (x - minX) * S;
  const pz = (z: number) => (z - minZ) * S;
  const W = (maxX - minX) * S, H = (maxZ - minZ) * S;
  const poly = (p: Vec3[]) => p.map(q => `${px(q.x).toFixed(1)},${pz(q.z).toFixed(1)}`).join(" ");
  const o = doorOpening(r);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}">
<style>
  .wall{fill:none;stroke:#8b96a8;stroke-width:${(WALL_HALF * 2 * S).toFixed(1)}}
  .gap{stroke:#0f1420;stroke-width:${(WALL_HALF * 2 * S + 2).toFixed(1)};stroke-linecap:butt}
  .floor{fill:#161c26}
  .old{fill:none;stroke:#F04770;stroke-width:3;stroke-linejoin:round}
  .new{fill:none;stroke:#3DD68C;stroke-width:3;stroke-linejoin:round}
  .desk{fill:#6E9BF0}
  .t{font:600 13px ui-monospace,monospace;fill:#e3e9f3}
  .s{font:500 11px ui-monospace,monospace;fill:#9aa6b8}
</style>
<rect width="100%" height="100%" fill="#0d1118"/>
<rect class="floor" x="${px(r.cx - r.w / 2).toFixed(1)}" y="${pz(r.cz - r.d / 2).toFixed(1)}" width="${(r.w * S).toFixed(1)}" height="${(r.d * S).toFixed(1)}"/>
<rect class="wall" x="${px(r.cx - r.w / 2).toFixed(1)}" y="${pz(r.cz - r.d / 2).toFixed(1)}" width="${(r.w * S).toFixed(1)}" height="${(r.d * S).toFixed(1)}"/>
<line class="gap" x1="${px(o.minX).toFixed(1)}" y1="${pz(o.minZ).toFixed(1)}" x2="${px(o.maxX).toFixed(1)}" y2="${pz(o.maxZ).toFixed(1)}"/>
<polyline class="old" points="${poly(worst.oldPath)}"/>
<polyline class="new" points="${poly(worst.newPath)}"/>
<circle class="desk" cx="${px(worst.from.x).toFixed(1)}" cy="${pz(worst.from.z).toFixed(1)}" r="5"/>
<text class="t" x="10" y="20">${worst.office} — door ${worst.doorDir}</text>
<text class="s" x="10" y="38">red: old route, ${worst.old.toFixed(2)} units inside the wall</text>
<text class="s" x="10" y="54">green: through the doorway</text>
<text class="s" x="10" y="70">desk ${worst.agent}</text>
</svg>`;
  await Bun.write(svgArg, svg);
  console.log(`\nDrawing: ${svgArg} (worst case — ${worst.office}, ${worst.agent})`);
}

process.exit(oldBad.length > 0 && nowBad.length === 0 ? 0 : nowBad.length > 0 ? 1 : 0);
