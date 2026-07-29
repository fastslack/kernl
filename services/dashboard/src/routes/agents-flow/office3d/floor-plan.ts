/**
 * Square office building — grid layout with rooms sized by agent count.
 * Central hall, rooms proportioned to their team size.
 */

import type { AgentData, ChainData, FlowData, RankData, Vec3, RoomInfo, FloorPlan } from './types.js';

/** Whichever rank carries the HIGHEST level is the top of the org —
 *  his agent renders inside My Office (a special room), not in the office
 *  grid. The user can rename that rank or its agent freely; we just need
 *  to know which rank_id(s) to keep out of the grid grouping. */
function topRankIds(ranks: RankData[]): Set<string> {
  if (ranks.length === 0) return new Set();
  const maxLevel = ranks.reduce((m, r) => Math.max(m, r.level), -Infinity);
  return new Set(ranks.filter(r => r.level === maxLevel).map(r => r.id));
}

export interface CorridorSegment {
  x1: number; z1: number; x2: number; z2: number; width: number;
}

export interface CorridorGrid {
  segments: CorridorSegment[];
  nodes: Vec3[];
  buildingBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const CORRIDOR_W = 6;
const DESK_SPACING = 4.5;
const ROOM_PAD = 3;

/** Display-name overrides for the 3D office signs. Keys match the exact flow
 *  names stored in the DB; values are the short uppercase label rendered above
 *  the door (≤ 12 chars). Unmapped flow names render with their full original
 *  name, and FIXED_OFFICES / connectivity logic always use the original names.
 *  Operator-specific entries (named projects, client offices) live in this
 *  file's personal override at `assets/personal/dashboard/floor-plan-overrides.ts`
 *  when present — keep this map generic. */
const FLOW_DISPLAY_NAME: Record<string, string> = {
  'Market Analysis':   'MARKETING',
  'Web Scraping':      'SCRAPING',
  // Placeholder office — rendered without a label on the door until the
  // user decides what goes here.
  'New office':        '',
};
function displayFlowName(name: string): string {
  return FLOW_DISPLAY_NAME[name] ?? name;
}

export function computeFloorPlan(
  agents: AgentData[],
  chains: ChainData[],
  flows: FlowData[],
  ranks: RankData[] = [],
): FloorPlan & {
  corridorGrid: CorridorGrid;
  meetingRooms: Array<{ cx: number; cz: number; w: number; d: number }>;
  hallExtensions: Array<{ cx: number; cz: number; w: number; d: number }>;
} {
  const deskPositions = new Map<string, Vec3>();
  const rooms = new Map<string, RoomInfo>();
  const meetingRooms: Array<{ cx: number; cz: number; w: number; d: number }> = [];
  const hallExtensions: Array<{ cx: number; cz: number; w: number; d: number }> = [];

  if (!agents.length) {
    return {
      deskPositions, rooms, meetingRooms, hallExtensions,
      corridor: { centerX: 0, width: CORRIDOR_W, startZ: -10, endZ: 10 },
      corridorGrid: { segments: [], nodes: [], buildingBounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } },
    };
  }

  // Group by flow. Skip agents whose `flow_id` doesn't resolve to one of
  // the active flows we were handed — those agents are residue of closed
  // offices and used to land in a phantom "General" room (the fallback
  // label later in this file). With this filter, closed offices stay
  // closed and the orphaned agents just don't render desks.
  const activeFlowIds = new Set(flows.map(f => f.id));
  // The top agent renders inside My Office (a special room), not in a
  // grid slot. Their flow ends up with 0 agents and is skipped — the room
  // is never built, which is what we want.
  const topRanks = topRankIds(ranks);
  const flowGroups = new Map<string, AgentData[]>();
  for (const a of agents) {
    const fid = a.flow_id;
    if (!fid || !activeFlowIds.has(fid)) continue;
    if (a.rank_id && topRanks.has(a.rank_id)) continue;
    if (!flowGroups.has(fid)) flowGroups.set(fid, []);
    flowGroups.get(fid)!.push(a);
  }

  // Sort by connectivity then size. Chains whose endpoints live in an
  // inactive flow don't contribute weight (their flow won't render).
  const connWeight = new Map<string, number>();
  for (const c of chains) {
    const sf = agents.find(a => a.id === c.source_agent_id)?.flow_id;
    const tf = agents.find(a => a.id === c.target_agent_id)?.flow_id;
    if (sf && activeFlowIds.has(sf)) connWeight.set(sf, (connWeight.get(sf) || 0) + 1);
    if (tf && activeFlowIds.has(tf)) connWeight.set(tf, (connWeight.get(tf) || 0) + 1);
  }
  const sorted = Array.from(flowGroups.entries()).sort((a, b) => {
    const wA = connWeight.get(a[0]) || 0, wB = connWeight.get(b[0]) || 0;
    if (wB !== wA) return wB - wA;
    return b[1].length - a[1].length;
  });

  // ══════════════════════════════════════════════════════════════
  // LAYOUT: Fixed core + dynamic expansion
  //
  // The building always has a FIXED CORE in the center:
  //   - Central Hall (center)
  //   - My Office (below hall)
  //   - Meeting Room A (left of hall)
  //   - Meeting Room B (right of hall)
  //   - Management (below-left, fixed)
  //
  // All other offices expand outward from the core automatically.
  // The grid grows as needed — minimum 3 rows (core needs row -1, 0, +1).
  // ══════════════════════════════════════════════════════════════

  const n = sorted.length;

  // Grid-sizing: the grid must hold EVERY room plus the reserved core. The
  // core is bigger than the original "4 special rooms" count — it's:
  //   • 6 special cells (Central Hall, My Office, Meeting A/B/C/D)
  //   • up to ~5 fixed-office pins (Management, Market Analysis, Web Scraping,
  //     Automations, Communications)
  //   • ~1 hall-extension column funnelling south toward the entrance
  // Underestimating this forced the dynamic assignment to overflow and every
  // extra room collapsed onto (0,0) — visually two rooms superimposed.
  const RESERVED_CORE = 13;

  // Calculate room specs
  interface RoomSpec { flowId: string; agents: AgentData[]; w: number; d: number; }
  const roomSpecs: RoomSpec[] = sorted.map(([fid, ga]) => {
    const deskCols = Math.ceil(Math.sqrt(ga.length));
    const deskRows = Math.ceil(ga.length / deskCols);
    return {
      flowId: fid, agents: ga,
      w: Math.max(10, deskCols * DESK_SPACING + ROOM_PAD * 2),
      d: Math.max(8, deskRows * DESK_SPACING + ROOM_PAD * 2),
    };
  });

  // Grid must hold n office rooms + the reserved core, minimum 3 rows.
  const totalSlots = n + RESERVED_CORE;
  const gridCols = Math.max(3, Math.ceil(Math.sqrt(totalSlots)));
  const gridRows = Math.max(3, Math.ceil(totalSlots / gridCols));

  // ── Fixed core: always in the center of the grid ──
  const centerCol = Math.floor(gridCols / 2);
  const centerRow = Math.floor(gridRows / 2);

  // Special rooms: positions relative to center.
  // The top agent's office sits one cell to the RIGHT of the central
  // axis so the column directly below the hall can stay open and flow as a
  // continuation of the hall down to the building's south entrance.
  const SPECIAL_CELLS = [
    { col: centerCol - 1, row: centerRow },         // [0] Meeting Room A (left of hall)
    { col: centerCol,     row: centerRow },          // [1] Central Hall / Reception (center)
    { col: centerCol + 1, row: centerRow },          // [2] Meeting Room B (right of hall)
    { col: centerCol,     row: centerRow - 1 },      // [3] My Office (north of reception — top agent)
    { col: centerCol - 1, row: centerRow - 1 },      // [4] Meeting Room C (NW — north of Meeting A)
    { col: centerCol + 1, row: centerRow - 1 },      // [5] Meeting Room D (NE — north of Meeting B)
  ];
  const specialSet = new Set(SPECIAL_CELLS.map(c => `${c.col},${c.row}`));

  // Hall-extension cells — the entire centre column from the row below the
  // hall down to the south edge of the grid. These stay empty (no room, no
  // meeting table) so the Central Hall visually flows to the entrance.
  const hallExtensionCells: Array<{ col: number; row: number }> = [];
  for (let r = centerRow + 1; r < gridRows; r++) {
    hallExtensionCells.push({ col: centerCol, row: r });
  }
  const hallExtensionSet = new Set(hallExtensionCells.map(c => `${c.col},${c.row}`));

  // Fixed offices — flows pinned to specific cells (by flow name).
  //   Communications   → below-right (SE), swapped with My Office
  //   Management       → west-of-core on the main row (outer W)
  //   Market Analysis  → east-of-core on the main row (outer E)
  //   Web Scraping     → NW outer (north of Management) — swapped with Automations
  //   Automations      → NE outer (north of Market Analysis)
  // Operator-specific flow pins live in `assets/personal/dashboard/floor-plan-overrides.ts`
  // when present — keep this map generic.
  const FIXED_OFFICES: Record<string, { col: number; row: number }> = {
    'Communications':  { col: centerCol + 1, row: centerRow + 1 },
    'Management':      { col: centerCol - 2, row: centerRow },
    'Market Analysis': { col: centerCol + 2, row: centerRow },
    'Web Scraping':    { col: centerCol - 2, row: centerRow - 1 },
    'Automations':     { col: centerCol + 2, row: centerRow - 1 },
  };
  const fixedOfficeSet = new Set(Object.values(FIXED_OFFICES).map(c => `${c.col},${c.row}`));

  // ── Assign offices to cells ──
  const usedCells = new Set<string>();
  // Reserve special + fixed office cells + hall-extension cells so offices
  // can never claim the axis that funnels traffic to the entrance.
  for (const c of SPECIAL_CELLS) usedCells.add(`${c.col},${c.row}`);
  for (const c of Object.values(FIXED_OFFICES)) usedCells.add(`${c.col},${c.row}`);
  for (const c of hallExtensionCells) usedCells.add(`${c.col},${c.row}`);

  // Build list of free cells, sorted by distance to center (closest first)
  const freeCells: Array<{ col: number; row: number; dist: number }> = [];
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const key = `${c},${r}`;
      if (!usedCells.has(key)) {
        freeCells.push({ col: c, row: r, dist: (c - centerCol) ** 2 + (r - centerRow) ** 2 });
      }
    }
  }
  freeCells.sort((a, b) => a.dist - b.dist); // closest to core first

  // Assign each office: fixed offices first, then dynamic by size (biggest → closest to core).
  //
  // Guards:
  //  • A flow name can appear more than once in the DB (e.g. two "Web Scraping"
  //    rows with different colors). Only the FIRST one claims the pin; any
  //    duplicate falls through to dynamic assignment so they don't overlap.
  //  • If freeCells runs out, we spill to the next unused (col,row) that still
  //    fits in the grid — never the (0,0) fallback which already hosts a room.
  const agentCells: Array<{ col: number; row: number }> = [];
  let freeIdx = 0;
  const claimedFixed = new Set<string>();
  for (const spec of roomSpecs) {
    const flowName = flows.find(f => f.id === spec.flowId)?.name || '';
    const fixed = FIXED_OFFICES[flowName];
    const pinKey = fixed ? `${fixed.col},${fixed.row}` : '';
    const pinAvailable =
      !!fixed &&
      fixed.col >= 0 && fixed.col < gridCols &&
      fixed.row >= 0 && fixed.row < gridRows &&
      !claimedFixed.has(pinKey);

    if (pinAvailable) {
      agentCells.push(fixed);
      claimedFixed.add(pinKey);
      continue;
    }

    // Advance past any freeCells that a previous overflow already consumed.
    while (freeIdx < freeCells.length && usedCells.has(`${freeCells[freeIdx].col},${freeCells[freeIdx].row}`)) {
      freeIdx++;
    }
    if (freeIdx < freeCells.length) {
      const cell = freeCells[freeIdx];
      agentCells.push(cell);
      usedCells.add(`${cell.col},${cell.row}`);
      freeIdx++;
      continue;
    }

    // Last resort: scan the entire grid for ANY still-unused cell before
    // collapsing to (0,0). Guarantees distinct positions even if the grid
    // sizing heuristic underestimated.
    let spill: { col: number; row: number } | null = null;
    outer: for (let r = 0; r < gridRows; r++) {
      for (let c = 0; c < gridCols; c++) {
        const k = `${c},${r}`;
        if (!usedCells.has(k) && !specialSet.has(k) && !hallExtensionSet.has(k)) {
          spill = { col: c, row: r };
          break outer;
        }
      }
    }
    if (spill) {
      agentCells.push(spill);
      usedCells.add(`${spill.col},${spill.row}`);
    } else {
      agentCells.push({ col: 0, row: 0 }); // last-ditch fallback (should be unreachable with the widened RESERVED_CORE)
    }
  }

  // Empty cells → meeting rooms. We restrict this to the fixed core (Meeting
  // A/B/C/D around the Central Hall). Any extra unassigned cell in the grid
  // stays open — rendering another WAR ROOM / STRATEGY / duplicate MEETING
  // ROOM there clutters the floor without serving any walker destination.
  const emptyCells: Array<{ col: number; row: number }> = [
    ...SPECIAL_CELLS.filter(c => c.col < gridCols && c.row < gridRows),
  ];

  // ── Compute column widths / row depths based on actual room assignments ──
  const colWidths: number[] = Array(gridCols).fill(10);
  const rowDepths: number[] = Array(gridRows).fill(8);
  for (let i = 0; i < roomSpecs.length; i++) {
    const { col, row } = agentCells[i];
    if (col >= 0 && col < gridCols && row >= 0 && row < gridRows) {
      colWidths[col] = Math.max(colWidths[col], roomSpecs[i].w);
      rowDepths[row] = Math.max(rowDepths[row], roomSpecs[i].d);
    }
  }

  // Compute X positions (with corridors between columns)
  const colX: number[] = [];
  let cx = 0;
  for (let c = 0; c < gridCols; c++) {
    if (c > 0) cx += CORRIDOR_W;
    cx += colWidths[c] / 2;
    colX.push(cx);
    cx += colWidths[c] / 2;
  }
  const totalW = cx;
  const offsetX = -totalW / 2;
  for (let c = 0; c < gridCols; c++) colX[c] += offsetX;

  // Compute Z positions (with corridors between rows)
  const rowZ: number[] = [];
  let cz = 0;
  for (let r = 0; r < gridRows; r++) {
    if (r > 0) cz += CORRIDOR_W;
    cz += rowDepths[r] / 2;
    rowZ.push(cz);
    cz += rowDepths[r] / 2;
  }
  const totalD = cz;
  const offsetZ = -totalD / 2;
  for (let r = 0; r < gridRows; r++) rowZ[r] += offsetZ;

  // Central Hall position for door orientation
  const hallCX = colX[centerCol];
  const hallCZ = rowZ[centerRow];

  // Place rooms and desks
  for (let i = 0; i < roomSpecs.length; i++) {
    const spec = roomSpecs[i];
    const { col, row } = agentCells[i];
    const roomCX = colX[col];
    const roomCZ = rowZ[row];
    const roomW = colWidths[col];
    const roomD = rowDepths[row];

    // `spec.flowId` is guaranteed to resolve to an active flow (we filtered
    // at the grouping step above). The `|| …` is defensive — if it ever
    // fires, the label exposes the broken flow_id rather than hiding it
    // behind a generic "General".
    const flow = flows.find(f => f.id === spec.flowId);
    const color = flow?.color || '#4a4f6a';
    const name = displayFlowName(flow?.name || `?[${spec.flowId.slice(0, 6)}]`);

    // Door faces toward the central hall — pick the wall closest to the hall.
    const walls = [
      { dir: 'top' as const,    wx: roomCX,             wz: roomCZ + roomD / 2, side: 1 as const  },
      { dir: 'bottom' as const, wx: roomCX,             wz: roomCZ - roomD / 2, side: -1 as const },
      { dir: 'right' as const,  wx: roomCX + roomW / 2, wz: roomCZ,            side: 1 as const   },
      { dir: 'left' as const,   wx: roomCX - roomW / 2, wz: roomCZ,            side: -1 as const  },
    ];
    let bestWall = walls[1]; // default: bottom
    let bestDist = Infinity;
    for (const wl of walls) {
      const dist = (wl.wx - hallCX) ** 2 + (wl.wz - hallCZ) ** 2;
      if (dist < bestDist) { bestDist = dist; bestWall = wl; }
    }
    const doorDir = bestWall.dir;
    // For walker pathfinding, doorSide and doorZ still use Z-axis convention
    const doorSide: -1 | 1 = (doorDir === 'top') ? 1 : -1;
    const doorZ = (doorDir === 'top' || doorDir === 'bottom')
      ? roomCZ + (doorDir === 'top' ? 1 : -1) * roomD / 2
      : roomCZ; // for left/right doors, doorZ = room center (walkers approach via corridor Z)

    // Calculate the exact Z of the corridor outside this door
    let corridorZ = doorZ + (doorDir === 'top' ? 1 : -1) * (CORRIDOR_W / 2);
    if (doorDir === 'top' && row < gridRows - 1) {
      corridorZ = (rowZ[row] + rowDepths[row] / 2 + rowZ[row + 1] - rowDepths[row + 1] / 2) / 2;
    } else if (doorDir === 'bottom' && row > 0) {
      corridorZ = (rowZ[row - 1] + rowDepths[row - 1] / 2 + rowZ[row] - rowDepths[row] / 2) / 2;
    } else if (doorDir === 'left' || doorDir === 'right') {
      // For side doors, use the nearest horizontal corridor Z
      if (row > 0) corridorZ = (rowZ[row - 1] + rowDepths[row - 1] / 2 + rowZ[row] - rowDepths[row] / 2) / 2;
      else if (row < gridRows - 1) corridorZ = (rowZ[row] + rowDepths[row] / 2 + rowZ[row + 1] - rowDepths[row + 1] / 2) / 2;
    } else if (row === gridRows - 1 && gridRows > 1) {
      corridorZ = (rowZ[row - 1] + rowDepths[row - 1] / 2 + rowZ[row] - rowDepths[row] / 2) / 2;
    } else if (row === 0 && gridRows > 1) {
      corridorZ = (rowZ[row] + rowDepths[row] / 2 + rowZ[row + 1] - rowDepths[row + 1] / 2) / 2;
    }

    // Compute exact door center point
    let doorCenterX = roomCX, doorCenterZ = doorZ;
    if (doorDir === 'left') { doorCenterX = roomCX - roomW / 2; doorCenterZ = roomCZ; }
    else if (doorDir === 'right') { doorCenterX = roomCX + roomW / 2; doorCenterZ = roomCZ; }
    else if (doorDir === 'top') { doorCenterX = roomCX; doorCenterZ = roomCZ + roomD / 2; }
    else { doorCenterX = roomCX; doorCenterZ = roomCZ - roomD / 2; }

    rooms.set(spec.flowId, {
      cx: roomCX, cz: roomCZ, w: roomW, d: roomD, color, name, doorZ, side: doorSide,
      doorDir, corridorZ, doorX: doorCenterX, doorCZ: doorCenterZ,
    } as any);

    // Desks
    const deskCols = Math.ceil(Math.sqrt(spec.agents.length));
    const deskRows = Math.ceil(spec.agents.length / deskCols);
    for (let di = 0; di < spec.agents.length; di++) {
      const dc = di % deskCols;
      const dr = Math.floor(di / deskCols);
      deskPositions.set(spec.agents[di].id, {
        x: roomCX + (dc - (deskCols - 1) / 2) * DESK_SPACING,
        y: 0,
        z: roomCZ + (dr - (deskRows - 1) / 2) * DESK_SPACING,
      });
    }
  }

  // Empty cells → meeting rooms (special cells first in their defined order, then extras)
  for (const cell of emptyCells) {
    meetingRooms.push({ cx: colX[cell.col], cz: rowZ[cell.row], w: colWidths[cell.col], d: rowDepths[cell.row] });
  }

  // Hall-extension cells → open marble continuation of the Central Hall.
  for (const cell of hallExtensionCells) {
    if (cell.col >= gridCols || cell.row >= gridRows) continue;
    hallExtensions.push({
      cx: colX[cell.col], cz: rowZ[cell.row],
      w: colWidths[cell.col], d: rowDepths[cell.row],
    });
  }

  // Corridor segments
  const segments: CorridorSegment[] = [];
  const nodes: Vec3[] = [];

  const bMinX = colX[0] - colWidths[0] / 2;
  const bMaxX = colX[gridCols - 1] + colWidths[gridCols - 1] / 2;
  const bMinZ = rowZ[0] - rowDepths[0] / 2;
  const bMaxZ = rowZ[gridRows - 1] + rowDepths[gridRows - 1] / 2;

  // Horizontal corridors between rows (span full building width)
  for (let r = 0; r < gridRows - 1; r++) {
    const z = (rowZ[r] + rowDepths[r] / 2 + rowZ[r + 1] - rowDepths[r + 1] / 2) / 2;
    segments.push({ x1: bMinX, z1: z, x2: bMaxX, z2: z, width: CORRIDOR_W });
    for (let c = 0; c < gridCols; c++) nodes.push({ x: colX[c], y: 0, z });
  }

  // Vertical corridors between columns (span full building height)
  for (let c = 0; c < gridCols - 1; c++) {
    const x = (colX[c] + colWidths[c] / 2 + colX[c + 1] - colWidths[c + 1] / 2) / 2;
    segments.push({ x1: x, z1: bMinZ, x2: x, z2: bMaxZ, width: CORRIDOR_W });
    for (let r = 0; r < gridRows; r++) nodes.push({ x, y: 0, z: rowZ[r] });
  }

  // No perimeter corridors — rooms on the edges face inward only

  // Nodes at corridor intersections + building edges for pathfinding
  nodes.push({ x: bMinX, y: 0, z: bMinZ });
  nodes.push({ x: bMaxX, y: 0, z: bMinZ });
  nodes.push({ x: bMinX, y: 0, z: bMaxZ });
  nodes.push({ x: bMaxX, y: 0, z: bMaxZ });

  if (segments.length === 0) {
    segments.push({ x1: bMinX, z1: 0, x2: bMaxX, z2: 0, width: CORRIDOR_W });
  }

  const corridorGrid: CorridorGrid = {
    segments, nodes,
    buildingBounds: { minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ },
  };

  return {
    deskPositions, rooms,
    corridor: { centerX: 0, width: CORRIDOR_W, startZ: bMinZ, endZ: bMaxZ },
    corridorGrid, meetingRooms, hallExtensions,
  };
}

export function nearestCorridorNode(point: Vec3, grid: CorridorGrid): Vec3 {
  let best = grid.nodes[0] || { x: 0, y: 0, z: 0 };
  let bestD = Infinity;
  for (const n of grid.nodes) {
    const d = (n.x - point.x) ** 2 + (n.z - point.z) ** 2;
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}
