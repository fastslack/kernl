// office3d/office/room-decor.ts
// What furnishes an office beyond its desks: a rug in the office's colour, plants, one piece of furniture against a
// side wall. All of it (and the small fixed parts rooms.ts adds) merges into ONE vertex-coloured mesh per office that
// casts no shadow, so a furnished office takes fewer draw calls than the bare one did.
//
// The mesh stands at the room's centre, so the construction stage pops it in place like any other 'decor' child.
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rt } from '../runtime.js';
import { getPlankFloorTexture, PLANK_TILE, scaleUV } from '../textures.js';

export type DoorDir = 'top' | 'bottom' | 'left' | 'right';
export type PieceKind = 'credenza' | 'bookcase' | 'sofa';

/** A place in the room, from its centre. */
export interface DecorPlant { dx: number; dz: number; size: number }
export interface DecorPiece { kind: PieceKind; a: number; b: number; len: number; deep: number }
export interface RoomDecorLayout {
  door: DoorDir;
  /** Size along the door's wall, and depth away from it. */
  A: number;
  B: number;
  plants: DecorPlant[];
  /** In the wall frame: `a` along the door's wall, `b` away from it. Null in a room too small for it. */
  piece: DecorPiece | null;
  rug: { w: number; d: number };
}

const PIECES: PieceKind[] = ['credenza', 'bookcase', 'sofa'];
const DEEP: Record<PieceKind, number> = { credenza: 0.7, bookcase: 0.5, sofa: 1.0 };
/** Half the wall's thickness, and the gap left to it. */
const WALL_FACE = 0.225 + 0.05;
const CORNER = 1.0;
const MIN_FOR_PIECE = 9;

const WALL_SHADE = 0.62, SHADE_REACH = 1.5;

/** An office's floor: a grid with one ring of vertices near the walls, darkened at the wall. */
export function shadedFloor(w: number, d: number): any {
  const T = rt.THREE;
  const geo = new T.PlaneGeometry(w, d, 3, 3);
  const r = Math.min(SHADE_REACH, Math.min(w, d) / 3);
  const xs = [-w / 2, -w / 2 + r, w / 2 - r, w / 2], ys = [d / 2, d / 2 - r, -d / 2 + r, -d / 2];
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const color = new Float32Array(pos.count * 3);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const k = j * 4 + i;
    pos.setXY(k, xs[i], ys[j]);
    uv.setXY(k, (xs[i] + w / 2) / w, (ys[j] + d / 2) / d);
    const inner = i > 0 && i < 3 && j > 0 && j < 3;
    color[k * 3] = color[k * 3 + 1] = color[k * 3 + 2] = inner ? 1 : WALL_SHADE;
  }
  geo.setAttribute('color', new T.BufferAttribute(color, 3));
  scaleUV(geo, w / PLANK_TILE, d / PLANK_TILE);
  return geo;
}

/** The plank floor's material (vertex-shaded along the walls). */
export function plankFloorMaterial(): any {
  return new rt.THREE.MeshStandardMaterial({ map: getPlankFloorTexture(), roughness: 0.72, metalness: 0, vertexColors: true });
}

/** The wall frame (a along the door's wall, b away from it) to offsets from the room's centre. */
export function toRoom(door: DoorDir, w: number, d: number, a: number, b: number): { dx: number; dz: number } {
  switch (door) {
    case 'top': return { dx: a, dz: d / 2 - b };
    case 'bottom': return { dx: a, dz: -d / 2 + b };
    case 'left': return { dx: -w / 2 + b, dz: a };
    case 'right': return { dx: w / 2 - b, dz: a };
  }
}

/** Everything hugs the walls: the desks keep the middle of the room, the door and the lamp's corner stay clear. */
export function roomDecorLayout(w: number, d: number, door: DoorDir, variant: number): RoomDecorLayout {
  const alongZ = door === 'left' || door === 'right';
  const A = alongZ ? d : w, B = alongZ ? w : d;
  const at = (a: number, b: number, size: number): DecorPlant => ({ ...toRoom(door, w, d, a, b), size });
  const plants = [
    at(A / 2 - CORNER, B - CORNER, 1.1),      // the back corner the floor lamp leaves free
    at(-(A / 2 - CORNER), CORNER, 0.8),       // either side of the door
    at(A / 2 - CORNER, CORNER, 0.8),
  ];
  let piece: DecorPiece | null = null;
  if (Math.min(A, B) >= MIN_FOR_PIECE) {
    const kind = PIECES[((variant % PIECES.length) + PIECES.length) % PIECES.length];
    const deep = DEEP[kind];
    piece = { kind, deep, len: Math.min(4.2, Math.max(2.2, B * 0.36)), a: A / 2 - WALL_FACE - deep / 2, b: B * 0.52 };
  }
  return { door, A, B, plants, piece, rug: { w: Math.max(1, w - 3.4), d: Math.max(1, d - 3.4) } };
}

const hex = (c: string | number) => new rt.THREE.Color(c);

/** Geometries of one office, each painted its colour; `mesh()` merges them. */
export class RoomPieces {
  private list: any[] = [];

  add(color: any, geoIn: any, x = 0, y = 0, z = 0): void {
    const T = rt.THREE;
    const geo = geoIn.index ? geoIn.toNonIndexed() : geoIn;
    if (geo !== geoIn) geoIn.dispose();
    const n = geo.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = color.r; a[i * 3 + 1] = color.g; a[i * 3 + 2] = color.b; }
    geo.setAttribute('color', new T.BufferAttribute(a, 3));
    geo.translate(x, y, z);
    this.list.push(geo);
  }
  box(color: any, w: number, h: number, d: number, x: number, y: number, z: number): void {
    this.add(color, new rt.THREE.BoxGeometry(w, h, d), x, y, z);
  }
  cyl(color: any, top: number, bottom: number, h: number, seg: number, x: number, y: number, z: number): void {
    this.add(color, new rt.THREE.CylinderGeometry(top, bottom, h, seg), x, y, z);
  }
  /** A flat rectangle facing up. */
  flat(color: any, w: number, d: number, x: number, y: number, z: number): void {
    const g = new rt.THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    this.add(color, g, x, y, z);
  }
  mesh(mat: any): any {
    const merged = mergeGeometries(this.list, false);
    for (const g of this.list) g.dispose();
    this.list = [];
    const m = new rt.THREE.Mesh(merged, mat);
    m.receiveShadow = true;
    return m;
  }
}

function prng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rug, plants and the wall piece of a room, as offsets from its centre. `color` is the office's. */
export function furnishRoom(p: RoomPieces, w: number, d: number, door: DoorDir, color: string, variant: number): void {
  const T = rt.THREE;
  const layout = roomDecorLayout(w, d, door, variant);
  const rand = prng(variant * 97 + 13);

  // ── Rug: the field and four strips round it, one height (nothing stacks, nothing flickers) ──
  const RUG_Y = 0.03, B = 0.22;
  const { w: rw, d: rd } = layout.rug;
  const base = new T.Color(color);
  // Muted on purpose: the agents wear the office's colour and must stand out against it.
  p.flat(base.clone().lerp(hex(0x262a33), 0.86), rw - 2 * B, rd - 2 * B, 0, RUG_Y, 0);
  const edge = base.clone().lerp(hex(0xffffff), 0.28);
  for (const s of [-1, 1]) {
    p.flat(edge, rw, B, 0, RUG_Y, s * (rd - B) / 2);
    p.flat(edge, B, rd - 2 * B, s * (rw - B) / 2, RUG_Y, 0);
  }

  // ── Plants: pot on its saucer, leafy clumps ──
  const greens = [0x2f7d46, 0x3f9455, 0x256b3c, 0x4da05c].map(hex);
  for (const pl of layout.plants) {
    const s = pl.size;
    p.cyl(hex(0x6e3f26), 0.42 * s, 0.42 * s, 0.03, 10, pl.dx, 0.04, pl.dz);
    p.cyl(hex(0xa65a35), 0.34 * s, 0.25 * s, 0.55 * s, 8, pl.dx, 0.055 + 0.275 * s, pl.dz);
    const clumps = s > 1 ? 5 : 3;
    for (let k = 0; k < clumps; k++) {
      const ang = (k / clumps) * Math.PI * 2 + rand(), r = k === 0 ? 0 : 0.28 * s;
      const g = new T.IcosahedronGeometry((0.32 + rand() * 0.14) * s * (k === 0 ? 1.15 : 1), 0);
      g.scale(1, 1.25, 1);
      g.rotateY(rand() * 3);
      p.add(greens[k % greens.length], g, pl.dx + Math.cos(ang) * r, (k === 0 ? 1.4 : 1 + rand() * 0.2) * s, pl.dz + Math.sin(ang) * r);
    }
  }

  // ── The piece against the side wall ──
  const pc = layout.piece;
  if (!pc) return;
  const alongZ = door === 'left' || door === 'right';
  // A box in the wall frame: `sa` across the wall's normal axis… placed by toRoom, sizes swapped when the frame is.
  const place = (c: any, a: number, y: number, b: number, sa: number, h: number, sb: number) => {
    const o = toRoom(door, w, d, a, b);
    p.box(c, alongZ ? sb : sa, h, alongZ ? sa : sb, o.dx, y, o.dz);
  };
  const walnut = hex(0x5a3a24), light = hex(0xd9c7a8), dark = hex(0x2a2d33);
  const { a, b, len, deep } = pc;
  if (pc.kind === 'credenza') {
    place(walnut, a, 0.42, b, deep, 0.84, len);
    place(light, a, 0.87, b, deep + 0.06, 0.05, len + 0.06);
    place(dark, a, 1.1, b - len * 0.28, 0.4, 0.42, 0.5);
    [0xe8e4dc, 0xc94f4f, 0x3a6df0].forEach((m, i) => {
      const o = toRoom(door, w, d, a - 0.05, b + 0.1 + i * 0.4);
      p.cyl(hex(m), 0.06, 0.05, 0.13, 7, o.dx, 0.96, o.dz);
    });
  } else if (pc.kind === 'bookcase') {
    place(walnut, a + 0.03, 1, b, deep - 0.06, 2, len);
    const spines = [0xc94f4f, 0x3a6df0, 0xe0b341, 0x2fae7a, 0x7b5cf0].map((m) => hex(m).multiplyScalar(0.62));
    const face = a - deep / 2 + 0.03;
    for (let row = 0; row < 4; row++) {
      place(light, face + 0.02, 0.22 + row * 0.47, b, 0.1, 0.04, len - 0.1);
      let s = b - len / 2 + 0.1;
      while (s < b + len / 2 - 0.45) {
        const sw = 0.4 + rand() * 0.5;
        if (rand() > 0.14) {
          const h = 0.22 + rand() * 0.16;
          place(spines[Math.floor(rand() * spines.length)], face + 0.01, 0.24 + row * 0.47 + h / 2, s + sw / 2, 0.08, h, sw - 0.03);
        }
        s += sw;
      }
    }
  } else {
    const teal = base.clone().lerp(hex(0x2f7f86), 0.7), darker = teal.clone().multiplyScalar(0.8);
    place(darker, a, 0.22, b, deep, 0.44, len);
    place(teal, a + deep / 2 - 0.13, 0.55, b, 0.26, 1.1, len);
    for (const s of [-1, 1]) {
      place(teal, a, 0.42, b + s * (len / 2 - 0.13), deep, 0.84, 0.26);
      place(teal, a - 0.1, 0.54, b + s * (len / 4 - 0.07), deep - 0.32, 0.2, len / 2 - 0.3);
    }
    place(hex(0xd9a441), a + 0.12, 0.84, b - len / 4, 0.22, 0.42, 0.5);
  }
}
