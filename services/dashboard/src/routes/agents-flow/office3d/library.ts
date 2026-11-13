// office3d/library.ts
// B2 · The experience library: a pavilion on a free lot where every lesson an
// agent keeps is a book on that agent's bookcase. Book height is the lesson's
// confidence, its colour its kind; dust (a grey, matte cover) gathers while no
// run carries it; a retired lesson lies on the floor in front of its case.
//
// `show(at)` sets the library to any moment (LearningLibrary.svelte scrubs it
// week by week — B1); books ease to their new state in `tick`. `highlight()`
// lights the books of one lineage (A2) and dims the rest.

import { rt } from './runtime.js';
import { textSprite, disposeObj } from './hologram.js';
import { bookAt, type Library } from '$lib/learning-library.js';

export interface LibraryHandle {
  group: any;
  show(at: number): void;
  highlight(ids: Set<string> | null): void;
  tick(dt: number, t: number): void;
  dispose(): void;
}

const KIND: Record<string, number> = { avoid: 0xff5a5a, prefer: 0x45e08a, insight: 0xffc94d, pattern: 0x6aa8ff };
const DUST = 0x6f6a62;
const SHELF_W = 3.2;      // a bookcase
const SHELF_H = 0.85;     // one shelf
const SHELVES = 4;
const BOOK_W = 0.11;
const PER_SHELF = 24;

interface BookMesh {
  id: string;
  mesh: any;
  base: number;          // kind colour
  spine: number;         // width, as a multiple of BOOK_W
  slot: { x: number; y: number };
  floor: { x: number; z: number; rot: number };
  cur: { h: number; fall: number; vis: number; dust: number };
  want: { h: number; fall: number; vis: number; dust: number };
}

/** `face`: the direction (x, z) the bookcases turn to — toward the camera, so books are seen from the front. */
export function buildLibrary(scene: any, lot: { cx: number; cz: number; w: number; d: number }, lib: Library, face: { x: number; z: number } = { x: 0, z: 1 }): LibraryHandle {
  const T = rt.THREE;
  const root = new T.Group();
  root.name = 'experience-library';
  root.position.set(lot.cx, 0, lot.cz);
  scene.add(root);

  // The pavilion: a warm floor, a low glowing kerb, a sign.
  const floor = new T.Mesh(
    new T.BoxGeometry(lot.w * 0.92, 0.08, lot.d * 0.92),
    new T.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.85, metalness: 0.05 }),
  );
  floor.position.y = 0.04;
  root.add(floor);
  const kerbMat = new T.MeshBasicMaterial({ color: 0xa66bff, transparent: true, opacity: 0.55 });
  const kerb = new T.Mesh(new T.TorusGeometry(1, 0.03, 6, 4), kerbMat);
  kerb.rotation.x = Math.PI / 2;
  kerb.rotation.z = Math.PI / 4;
  kerb.scale.set(lot.w * 0.92 / Math.SQRT2, lot.d * 0.92 / Math.SQRT2, 1);
  kerb.position.y = 0.1;
  root.add(kerb);

  const shelves = lib.agents.filter((a) => a.books.length > 0).slice(0, 12);
  const cols = Math.max(1, Math.min(3, Math.floor((lot.w * 0.85) / (SHELF_W + 1.4))));
  const rows = Math.ceil(shelves.length / cols);
  const rowGap = Math.min(4.2, (lot.d * 0.8) / Math.max(1, rows));

  const sign = textSprite([
    { text: 'EXPERIENCE LIBRARY', color: '#d9c2ff', size: 40, bold: true },
    { text: `${shelves.length} agents · ${shelves.reduce((s, a) => s + a.books.length, 0)} lessons · the agents' experience graph on Relate`, color: '#9fb4c8', size: 22 },
  ], 1.5);
  const fl = Math.hypot(face.x, face.z) || 1;
  const fx = face.x / fl, fz = face.z / fl;
  // At the back of the pavilion, as seen from where the cases face.
  sign.position.set(-fx * lot.d * 0.38, SHELVES * SHELF_H + 2.6, -fz * lot.d * 0.38);
  root.add(sign);

  const caseMat = new T.MeshStandardMaterial({ color: 0x4a3324, roughness: 0.7, metalness: 0.05 });
  const bookGeo = new T.BoxGeometry(BOOK_W, 1, 0.36);
  bookGeo.translate(0, 0.5, 0); // grows up from its shelf
  const books: BookMesh[] = [];

  shelves.forEach((agent, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = (col - (cols - 1) / 2) * (SHELF_W + 1.4);
    const z = (row - (rows - 1) / 2) * rowGap;
    const bc = new T.Group();
    // The grid is laid out facing +z, then turned with the cases toward the viewer.
    const ang = Math.atan2(fx, fz);
    const rx = x * Math.cos(ang) + z * Math.sin(ang);
    const rz = -x * Math.sin(ang) + z * Math.cos(ang);
    bc.position.set(rx, 0.08, rz);
    bc.rotation.y = ang;
    root.add(bc);
    // Frame: back, two sides, shelf boards.
    const back = new T.Mesh(new T.BoxGeometry(SHELF_W, SHELVES * SHELF_H + 0.1, 0.06), caseMat);
    back.position.set(0, (SHELVES * SHELF_H + 0.1) / 2, -0.22);
    bc.add(back);
    for (const sx of [-1, 1]) {
      const side = new T.Mesh(new T.BoxGeometry(0.06, SHELVES * SHELF_H + 0.1, 0.5), caseMat);
      side.position.set(sx * SHELF_W / 2, (SHELVES * SHELF_H + 0.1) / 2, 0);
      bc.add(side);
    }
    for (let s = 0; s <= SHELVES; s++) {
      const board = new T.Mesh(new T.BoxGeometry(SHELF_W, 0.05, 0.5), caseMat);
      board.position.set(0, s * SHELF_H, 0);
      bc.add(board);
    }
    const plate = textSprite([{ text: agent.name, color: '#ffffff', size: 30, bold: true }], 0.55);
    plate.position.set(0, SHELVES * SHELF_H + 0.55, 0.1);
    bc.add(plate);

    // Strongest lessons on the top shelf, left to right; a short collection
    // spreads over the shelves with thicker spines instead of crowding one.
    const sorted = [...agent.books].sort((a, b) => b.confidence - a.confidence).slice(0, PER_SHELF * SHELVES);
    const perShelf = Math.min(PER_SHELF, Math.max(5, Math.ceil(sorted.length / SHELVES)));
    const spine = Math.min(0.24, (SHELF_W - 0.3) / perShelf - 0.012);
    sorted.forEach((b, k) => {
      const shelf = SHELVES - 1 - Math.floor(k / perShelf);
      const slot = k % perShelf;
      const base = KIND[b.type] ?? KIND.insight;
      const mat = new T.MeshStandardMaterial({ color: base, roughness: 0.55, metalness: 0.05, emissive: base, emissiveIntensity: 0.12 });
      const mesh = new T.Mesh(bookGeo, mat);
      const sx = -SHELF_W / 2 + 0.12 + slot * (spine + 0.012) + spine / 2;
      const sy = shelf * SHELF_H + 0.03;
      mesh.position.set(sx, sy, 0);
      mesh.scale.set(1, 0.001, 1);
      mesh.userData.learningId = b.id;
      bc.add(mesh);
      books.push({
        id: b.id, mesh, base, spine: spine / BOOK_W,
        slot: { x: sx, y: sy },
        floor: { x: sx * 0.9 + (Math.random() - 0.5) * 0.3, z: 0.55 + Math.random() * 0.5, rot: (Math.random() - 0.5) * 1.2 },
        cur: { h: 0, fall: 0, vis: 0, dust: 0 },
        want: { h: 0, fall: 0, vis: 0, dust: 0 },
      });
    });
  });

  const byId = new Map(books.map((b) => [b.id, b]));
  const bookData = new Map(lib.agents.flatMap((a) => a.books.map((b) => [b.id, b] as const)));
  let lit: Set<string> | null = null;
  const tmpColor = new T.Color();
  const dustColor = new T.Color(DUST);

  function show(at: number): void {
    for (const b of books) {
      const data = bookData.get(b.id);
      if (!data) continue;
      const s = bookAt(data, lib.timelines[b.id], at);
      b.want.vis = s.present ? 1 : 0;
      b.want.h = 0.22 + 0.58 * Math.max(0, Math.min(1, s.confidence));
      b.want.fall = s.retired ? 1 : 0;
      b.want.dust = s.dust;
    }
  }

  function paint(b: BookMesh): void {
    const m = b.mesh.material;
    tmpColor.setHex(b.base).lerp(dustColor, b.cur.fall > 0.5 ? 0.8 : b.cur.dust * 0.75);
    const dim = lit && !lit.has(b.id) ? 0.25 : 1;
    m.color.copy(tmpColor).multiplyScalar(dim);
    m.emissive.copy(tmpColor);
    m.emissiveIntensity = lit?.has(b.id) ? 0.9 : 0.12 * dim * (1 - b.cur.dust * 0.8);
  }

  function tick(dt: number, t: number): void {
    const k = Math.min(1, dt * 4);
    for (const b of books) {
      const c = b.cur, w = b.want;
      c.vis += (w.vis - c.vis) * k;
      c.h += (w.h - c.h) * k;
      c.fall += (w.fall - c.fall) * k;
      c.dust += (w.dust - c.dust) * k;
      const pulse = lit?.has(b.id) ? 1 + 0.06 * Math.sin(t * 6) : 1;
      b.mesh.visible = c.vis > 0.02;
      b.mesh.scale.set(pulse * b.spine, Math.max(0.001, c.h * c.vis), pulse);
      // A retired book tips over and slides to the floor in front of its case.
      b.mesh.position.x = b.slot.x + (b.floor.x - b.slot.x) * c.fall;
      b.mesh.position.y = b.slot.y * (1 - c.fall) + 0.06 * c.fall;
      b.mesh.position.z = b.floor.z * c.fall;
      b.mesh.rotation.z = (Math.PI / 2) * c.fall;
      b.mesh.rotation.y = b.floor.rot * c.fall;
      paint(b);
    }
    kerbMat.opacity = 0.4 + 0.2 * Math.sin(t * 1.4);
  }

  return {
    group: root,
    show,
    highlight(ids) { lit = ids && ids.size ? ids : null; },
    tick,
    dispose() {
      scene.remove(root);
      disposeObj(root);
      byId.clear();
    },
  };
}
