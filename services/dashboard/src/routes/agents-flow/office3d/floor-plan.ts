/**
 * Square office building on fixed lots — a central core (reception, the top
 * agent's office, four meeting rooms) and every office on its own plot.
 */

import type { AgentData, ChainData, FlowData, RankData, Vec3, RoomInfo, FloorPlan } from './types.js';
import {
  CORE_CELLS, LOT_CORRIDOR_W, cellRect, colCenterX, colWidth, extentRing, layoutDesks,
  lotsWithin, parseLotId, pickLot, rowCenterZ, rowDepth, takesNoLot, type Lot,
} from '$shared/office-lots.js';
import type { OffGridSite, WorldAabb } from '$shared/world-plugin.js';

export type { Lot };

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
  /** Walkable but not drawn as corridor floor (e.g. a street crossing to a plugin building). */
  outdoor?: boolean;
}

export interface CorridorGrid {
  segments: CorridorSegment[];
  nodes: Vec3[];
  buildingBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const CORRIDOR_W = LOT_CORRIDOR_W;

export interface FloorPlanOptions {
  /** Offices left off the floor entirely — not drawn, desks not placed, lot shown free.
   *  Used while an office waits for its construction crew. */
  hiddenFlowIds?: ReadonlySet<string>;
  /**
   * Building sites of world plugins, by office kind (see $shared/world-plugin.ts).
   * Offices of an off-grid kind (office-lots.ts → takesNoLot) stand in that
   * site; without one yet (plugin still loading) they are left off the floor.
   */
  offGridSites?: (kind: string) => ((bounds: WorldAabb, hCorridorZs: number[]) => OffGridSite) | null | undefined;
}

type Rect = { cx: number; cz: number; w: number; d: number };

/**
 * Lay the floor out on fixed lots (see $shared/office-lots.ts). Every office
 * is drawn on the lot the kernel stored in `flow.lot_id`, so its rectangle
 * never depends on which other offices exist. An office without a lot yet
 * (kernel not migrated, or a race with the kernel's sync) still gets drawn,
 * on the lot the kernel would pick for it.
 */
export function computeFloorPlan(
  agents: AgentData[],
  _chains: ChainData[],
  flows: FlowData[],
  ranks: RankData[] = [],
  opts: FloorPlanOptions = {},
): FloorPlan & {
  corridorGrid: CorridorGrid;
  meetingRooms: Rect[];
  hallExtensions: Rect[];
  freeLots: Lot[];
  /** Sites of world-plugin buildings, by office kind (empty without off-grid offices). */
  offGridSites: Map<string, OffGridSite>;
} {
  const deskPositions = new Map<string, Vec3>();
  const rooms = new Map<string, RoomInfo>();

  if (!agents.length) {
    return {
      deskPositions, rooms, meetingRooms: [], hallExtensions: [], freeLots: [],
      corridor: { centerX: 0, width: CORRIDOR_W, startZ: -10, endZ: 10 },
      corridorGrid: { segments: [], nodes: [], buildingBounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } },
      offGridSites: new Map(),
    };
  }

  // Group by flow. Agents whose `flow_id` doesn't resolve to an active flow
  // are residue of closed offices and get no desk. The top agent sits in
  // the headquarters office (a core cell), never in a flow room.
  const activeFlowIds = new Set(flows.map(f => f.id));
  const hidden = opts.hiddenFlowIds ?? new Set<string>();
  const topRanks = topRankIds(ranks);
  const flowGroups = new Map<string, AgentData[]>();
  for (const a of agents) {
    const fid = a.flow_id;
    if (!fid || !activeFlowIds.has(fid) || hidden.has(fid)) continue;
    if (a.rank_id && topRanks.has(a.rank_id)) continue;
    if (!flowGroups.has(fid)) flowGroups.set(fid, []);
    flowGroups.get(fid)!.push(a);
  }

  // ── Lots ──
  const flowById = new Map(flows.map(f => [f.id, f]));

  // An off-grid office takes no lot: its agents sit in a world plugin's own
  // building, placed once the main building's bounds are known (see below).
  const offGridGroups = new Map<string, AgentData[]>();
  for (const [fid, group] of flowGroups) {
    if (!takesNoLot(flowById.get(fid)?.kind)) continue;
    offGridGroups.set(fid, group);
    flowGroups.delete(fid);
  }
  const lotByFlow = new Map<string, Lot>();
  const taken = new Set<string>();
  // Lots held by hidden offices stay reserved for them: no fallback may take one.
  const reserved = new Set<string>();
  for (const f of flows) {
    const lot = parseLotId(f.lot_id);
    if (!lot) continue;
    if (hidden.has(f.id)) { reserved.add(lot.id); continue; }
    if (flowGroups.has(f.id) && !taken.has(lot.id)) { lotByFlow.set(f.id, lot); taken.add(lot.id); }
  }
  const unplaced = [...flowGroups.entries()]
    .filter(([fid]) => !lotByFlow.has(fid))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [fid, group] of unplaced) {
    const lot = pickLot(new Set([...taken, ...reserved]), group.length, flowById.get(fid)?.kind);
    lotByFlow.set(fid, lot);
    taken.add(lot.id);
  }

  const K = extentRing([...taken, ...reserved]);

  // ── Rooms and desks ──
  for (const [fid, group] of flowGroups) {
    const lot = lotByFlow.get(fid)!;
    const { cx: roomCX, cz: roomCZ, w: roomW, d: roomD } = lot;
    const flow = flowById.get(fid);
    const color = flow?.color || '#4a4f6a';
    const name = flow?.name || `?[${fid.slice(0, 6)}]`;

    // Door faces the hall (origin) — the wall whose midpoint is nearest it.
    const walls = [
      { dir: 'top' as const,    wx: roomCX,             wz: roomCZ + roomD / 2 },
      { dir: 'bottom' as const, wx: roomCX,             wz: roomCZ - roomD / 2 },
      { dir: 'right' as const,  wx: roomCX + roomW / 2, wz: roomCZ },
      { dir: 'left' as const,   wx: roomCX - roomW / 2, wz: roomCZ },
    ];
    let doorDir: 'top' | 'bottom' | 'left' | 'right' = 'bottom';
    let bestDist = Infinity;
    for (const wl of walls) {
      const dist = wl.wx ** 2 + wl.wz ** 2;
      if (dist < bestDist) { bestDist = dist; doorDir = wl.dir; }
    }
    const doorSide: -1 | 1 = doorDir === 'top' ? 1 : -1;
    const doorZ = doorDir === 'top' ? roomCZ + roomD / 2
      : doorDir === 'bottom' ? roomCZ - roomD / 2
      : roomCZ;

    // Z of the corridor the walker steps into outside this door.
    const r = lot.row;
    const southCorr = roomCZ + roomD / 2 + CORRIDOR_W / 2;
    const northCorr = roomCZ - roomD / 2 - CORRIDOR_W / 2;
    let corridorZ: number;
    if (doorDir === 'top') corridorZ = r < K ? southCorr : northCorr;
    else if (doorDir === 'bottom') corridorZ = r > -K ? northCorr : southCorr;
    else corridorZ = r > -K ? northCorr : southCorr;

    let doorCenterX = roomCX, doorCenterZ = doorZ;
    if (doorDir === 'left') { doorCenterX = roomCX - roomW / 2; doorCenterZ = roomCZ; }
    else if (doorDir === 'right') { doorCenterX = roomCX + roomW / 2; doorCenterZ = roomCZ; }

    rooms.set(fid, {
      cx: roomCX, cz: roomCZ, w: roomW, d: roomD, color, name, doorZ, side: doorSide,
      doorDir, corridorZ, doorX: doorCenterX, doorCZ: doorCenterZ, lotId: lot.id,
    } as any);

    const offsets = layoutDesks(group.length, roomW, roomD);
    for (let di = 0; di < group.length; di++) {
      deskPositions.set(group[di].id, { x: roomCX + offsets[di].dx, y: 0, z: roomCZ + offsets[di].dz });
    }
  }

  // ── Core: fixed order [Meeting A, Hall, Meeting B, HQ office, Meeting C, Meeting D] ──
  const meetingRooms: Rect[] = CORE_CELLS.map(c => cellRect(c.col, c.row));
  // The hall's run south to the entrance.
  const hallExtensions: Rect[] = [];
  for (let row = 1; row <= K; row++) hallExtensions.push(cellRect(0, row));

  // A hidden office's lot reads as free: that is where its crew will build.
  const freeLots = lotsWithin(K).filter(l => !taken.has(l.id));

  // ── Corridors ──
  const segments: CorridorSegment[] = [];
  const nodes: Vec3[] = [];
  const bMinX = colCenterX(-K) - colWidth(-K) / 2;
  const bMaxX = colCenterX(K) + colWidth(K) / 2;
  const bMinZ = rowCenterZ(-K) - rowDepth(-K) / 2;
  const bMaxZ = rowCenterZ(K) + rowDepth(K) / 2;

  // Horizontal corridors between rows (full building width).
  for (let row = -K; row < K; row++) {
    const z = rowCenterZ(row) + rowDepth(row) / 2 + CORRIDOR_W / 2;
    segments.push({ x1: bMinX, z1: z, x2: bMaxX, z2: z, width: CORRIDOR_W });
    for (let col = -K; col <= K; col++) nodes.push({ x: colCenterX(col), y: 0, z });
  }
  // Vertical corridors between columns (full building depth).
  for (let col = -K; col < K; col++) {
    const x = colCenterX(col) + colWidth(col) / 2 + CORRIDOR_W / 2;
    segments.push({ x1: x, z1: bMinZ, x2: x, z2: bMaxZ, width: CORRIDOR_W });
    for (let row = -K; row <= K; row++) nodes.push({ x, y: 0, z: rowCenterZ(row) });
  }
  nodes.push({ x: bMinX, y: 0, z: bMinZ });
  nodes.push({ x: bMaxX, y: 0, z: bMinZ });
  nodes.push({ x: bMinX, y: 0, z: bMaxZ });
  nodes.push({ x: bMaxX, y: 0, z: bMaxZ });

  let corridorGrid: CorridorGrid = {
    segments, nodes,
    buildingBounds: { minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ },
  };

  // ── Off-grid offices: each world plugin's building, computed from the main
  //    building's bounds; its corridor link is appended for the walkers. ──
  const offGridSites = new Map<string, OffGridSite>();
  const idsByKind = new Map<string, string[]>();
  const hZs = hCorridorZsOf(corridorGrid);
  for (const [fid, group] of offGridGroups) {
    const flow = flowById.get(fid);
    const kind = flow?.kind ?? '';
    let site = offGridSites.get(kind);
    if (!site) {
      const make = opts.offGridSites?.(kind);
      if (!make) continue;                       // plugin not loaded (yet): off the floor
      site = make(corridorGrid.buildingBounds, hZs);
      offGridSites.set(kind, site);
      corridorGrid = {
        segments: [...corridorGrid.segments, ...site.extraSegments],
        nodes: [...corridorGrid.nodes, ...site.extraNodes],
        buildingBounds: corridorGrid.buildingBounds,
      };
    }
    rooms.set(fid, {
      ...site.room,
      color: flow?.color || '#4a4f6a',
      name: flow?.name || `?[${fid.slice(0, 6)}]`,
      lotId: '',
    } as any);
    if (!idsByKind.has(kind)) idsByKind.set(kind, []);
    idsByKind.get(kind)!.push(...group.map(a => a.id));
  }
  for (const [kind, ids] of idsByKind) {
    for (const [id, p] of offGridSites.get(kind)!.desks(ids)) deskPositions.set(id, p);
  }

  return {
    deskPositions, rooms,
    corridor: { centerX: 0, width: CORRIDOR_W, startZ: bMinZ, endZ: bMaxZ },
    corridorGrid, meetingRooms, hallExtensions, freeLots, offGridSites,
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

/** Z of every horizontal corridor (plugins line their links up with one). */
export function hCorridorZsOf(grid: CorridorGrid): number[] {
  const zs = new Set<number>();
  for (const s of grid.segments) if (Math.abs(s.z1 - s.z2) < 0.1 && Math.abs(s.x1 - s.x2) > 0.1) zs.add(s.z1);
  return [...zs].sort((a, b) => a - b);
}
