/**
 * Office lots — the fixed plots every office is built on.
 *
 * The floor is a grid of cells around a fixed core (reception, the top
 * agent's office and four meeting rooms). Every column has a fixed width and
 * every row a fixed depth, chosen by index alone, so a cell's rectangle never
 * depends on which offices exist: adding, growing or deleting an office never
 * moves another one. The kernel stores each office's cell as `lot_id` and the
 * dashboard draws the office on that rectangle.
 *
 * Shared by the kernel (lot assignment, agents/services/flows-service.ts) and
 * the dashboard (floor plan, office3d/floor-plan.ts), so both compute the same
 * geometry from the same code.
 *
 * Coordinates: cell (0,0) is the reception hall, centred on x=0, z=0. Column
 * indices grow east (+x), row indices grow south (+z), toward the entrance.
 */

export const LOT_CORRIDOR_W = 6;
export const DESK_SPACING = 4.5;
export const ROOM_PAD = 3;

/** Lots are generated out to this ring at most — far beyond any real office count. */
const MAX_RING = 40;

const SIDE_WIDTHS = [19.5, 15, 24];
const ROW_DEPTHS = [24, 19.5, 15];

export interface Lot {
  /** `"col,row"` — what the kernel stores in `agent_flows.lot_id`. */
  id: string;
  col: number;
  row: number;
  /** Rectangle centre and size, in world units. */
  cx: number;
  cz: number;
  w: number;
  d: number;
  /** Chebyshev distance from the hall: lots are taken ring by ring. */
  ring: number;
  /** Most desks the lot holds at full spacing. */
  capacity: number;
}

/** Fixed width of grid column `col`. */
export function colWidth(col: number): number {
  const a = Math.abs(col);
  if (a === 0) return 19.5;
  if (a === 1) return 24;
  return SIDE_WIDTHS[(a - 2) % SIDE_WIDTHS.length];
}

/** Fixed depth of grid row `row`. Rows 0 (hall) and -1 (top office) are the core. */
export function rowDepth(row: number): number {
  if (row === 0 || row === -1) return 15;
  const k = row > 0 ? row - 1 : -row - 2;
  return ROW_DEPTHS[k % ROW_DEPTHS.length];
}

function axisCenter(index: number, size: (i: number) => number): number {
  if (index === 0) return 0;
  const sign = Math.sign(index);
  let pos = size(0) / 2;
  for (let i = 1; i < Math.abs(index); i++) pos += LOT_CORRIDOR_W + size(sign * i);
  return sign * (pos + LOT_CORRIDOR_W + size(index) / 2);
}

export function colCenterX(col: number): number {
  return axisCenter(col, colWidth);
}

export function rowCenterZ(row: number): number {
  return axisCenter(row, rowDepth);
}

/** Cells that never hold an office: the core, and the hall's run south to the entrance. */
export function isReservedCell(col: number, row: number): boolean {
  if (Math.abs(col) <= 1 && (row === 0 || row === -1)) return true;
  return col === 0 && row >= 1;
}

/** The core cells, in the order the dashboard has always consumed them. */
export const CORE_CELLS: ReadonlyArray<{ col: number; row: number; role: string }> = [
  { col: -1, row: 0, role: 'meeting-a' },
  { col: 0, row: 0, role: 'hall' },
  { col: 1, row: 0, role: 'meeting-b' },
  { col: 0, row: -1, role: 'top-office' },
  { col: -1, row: -1, role: 'meeting-c' },
  { col: 1, row: -1, role: 'meeting-d' },
];

/** Desk grid for `n` agents at full spacing: as square as possible. */
function squareGrid(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/** Largest agent count whose square desk grid fits a `w` x `d` room. */
export function lotCapacity(w: number, d: number): number {
  let n = 1;
  for (;;) {
    const g = squareGrid(n + 1);
    if (g.cols * DESK_SPACING + ROOM_PAD * 2 > w || g.rows * DESK_SPACING + ROOM_PAD * 2 > d) return n;
    n++;
  }
}

export function cellRect(col: number, row: number): { cx: number; cz: number; w: number; d: number } {
  return { cx: colCenterX(col), cz: rowCenterZ(row), w: colWidth(col), d: rowDepth(row) };
}

export function lotAt(col: number, row: number): Lot | null {
  if (isReservedCell(col, row)) return null;
  const r = cellRect(col, row);
  return {
    id: `${col},${row}`, col, row, ...r,
    ring: Math.max(Math.abs(col), Math.abs(row)),
    capacity: lotCapacity(r.w, r.d),
  };
}

export function parseLotId(id: string | null | undefined): Lot | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(String(id ?? '').trim());
  if (!m) return null;
  return lotAt(Number(m[1]), Number(m[2]));
}

/** Every lot of one ring, nearest the hall first (ties: north before south, west before east). */
export function lotsInRing(ring: number): Lot[] {
  const out: Lot[] = [];
  for (let row = -ring; row <= ring; row++) {
    for (let col = -ring; col <= ring; col++) {
      if (Math.max(Math.abs(col), Math.abs(row)) !== ring) continue;
      const lot = lotAt(col, row);
      if (lot) out.push(lot);
    }
  }
  return out.sort((a, b) => (a.col ** 2 + a.row ** 2) - (b.col ** 2 + b.row ** 2) || a.row - b.row || a.col - b.col);
}

/** Office kinds an extension draws in a building of its own (world plugins, `offGrid`). */
const offGridKinds = new Set<string>();

/** Register kinds that take no lot (kernel: from extension manifests; dashboard: from /api/manifest). */
export function registerOffGridKinds(kinds: Iterable<string>): void {
  for (const k of kinds) offGridKinds.add(k);
}

/** Offices that never take a lot: an extension stands them in their own building. */
export function takesNoLot(kind: string | null | undefined): boolean {
  return !!kind && offGridKinds.has(kind);
}

/** Offices whose themed interior (racks, studio) needs more than the smallest lot. */
export function needsRoomyLot(kind: string | null | undefined): boolean {
  return kind === 'devops' || kind === 'communications';
}

export function lotFits(lot: Lot, agentCount: number, kind?: string | null): boolean {
  if (lot.capacity < agentCount) return false;
  if (needsRoomyLot(kind) && lot.w * lot.d < 19.5 * 15) return false;
  return true;
}

/**
 * The lot a new office of `agentCount` agents should take: the nearest free
 * lot that fits. An office bigger than any lot takes the nearest free lot of
 * the largest capacity, and its desks compact (see layoutDesks).
 */
export function pickLot(taken: ReadonlySet<string>, agentCount: number, kind?: string | null): Lot {
  let fallback: Lot | null = null;
  for (let ring = 1; ring <= MAX_RING; ring++) {
    for (const lot of lotsInRing(ring)) {
      if (taken.has(lot.id)) continue;
      if (lotFits(lot, agentCount, kind)) return lot;
      if (!fallback || lot.capacity > fallback.capacity) fallback = lot;
    }
  }
  return fallback!;
}

/** Outermost ring the floor shows: at least 2, and always out to the farthest office. */
export function extentRing(occupied: Iterable<string>): number {
  let k = 2;
  for (const id of occupied) {
    const lot = parseLotId(id);
    if (lot) k = Math.max(k, lot.ring);
  }
  return k;
}

/** Every lot inside rings 1..k. */
export function lotsWithin(k: number): Lot[] {
  const out: Lot[] = [];
  for (let ring = 1; ring <= k; ring++) out.push(...lotsInRing(ring));
  return out;
}

/**
 * Desk offsets from the room centre for `n` agents in a `w` x `d` room.
 * Full 4.5u spacing in a square grid when it fits; otherwise as many columns
 * as fit and the spacing shrinks so every desk stays inside the walls.
 */
export function layoutDesks(n: number, w: number, d: number): Array<{ dx: number; dz: number }> {
  if (n <= 0) return [];
  let { cols, rows } = squareGrid(n);
  const maxCols = Math.max(1, Math.floor((w - ROOM_PAD * 2) / DESK_SPACING));
  if (cols > maxCols) {
    cols = maxCols;
    rows = Math.ceil(n / cols);
  }
  const sx = Math.min(DESK_SPACING, cols > 1 ? (w - ROOM_PAD * 2) / cols : DESK_SPACING);
  const sz = Math.min(DESK_SPACING, (d - ROOM_PAD * 2) / rows);
  const out: Array<{ dx: number; dz: number }> = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ dx: (c - (cols - 1) / 2) * sx, dz: (r - (rows - 1) / 2) * sz });
  }
  return out;
}
