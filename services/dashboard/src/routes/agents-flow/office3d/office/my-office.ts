import { rt } from '../runtime.js';
import {
  WALL_H, WALL_T,
  makeSignClickable, addWall, addWallWithDoor,
} from './_shared.js';
import { applyPBR, bakeVertexAO } from './_materials.js';
import { applyWorldTexture, scaleUV } from '../textures.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addMyOfficeLights, addMyOfficeProps } from './my-office-lights.js';

/**
 * Static props merged per material: every piece added here costs vertices,
 * not draw calls. The office is drawn twice a frame (shadow + screen) and
 * almost nothing in it moves, so one mesh per material is the cheap way to
 * add detail. `color` paints the piece through vertex colours, which lets one
 * material carry many tints (book spines, a painting's bands).
 */
function propBatch(colored = false) {
  const parts: any[] = [];
  const tint = new rt.THREE.Color();
  return {
    add(geo: any, x: number, y: number, z: number, opts: {
      ry?: number; rx?: number; rz?: number; color?: number;
      /** Per-vertex colour from the vertex's local position, before placing. */
      paint?: (px: number, py: number, pz: number) => number;
    } = {}) {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      geo.dispose();
      const local = opts.paint ? g.attributes.position.array.slice() : null;
      if (opts.rx) g.rotateX(opts.rx);
      if (opts.rz) g.rotateZ(opts.rz);
      if (opts.ry) g.rotateY(opts.ry);
      g.translate(x, y, z);
      if (colored) {
        tint.set(opts.color ?? 0xffffff);
        const n = g.attributes.position.count;
        const c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          if (local && opts.paint) tint.set(opts.paint(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]));
          c[i * 3] = tint.r; c[i * 3 + 1] = tint.g; c[i * 3 + 2] = tint.b;
        }
        g.setAttribute('color', new rt.THREE.BufferAttribute(c, 3));
      }
      parts.push(g);
    },
    /** One mesh for everything added, or null when nothing was. */
    flush(scene: any, mat: any, shadows = false): any {
      if (parts.length === 0) return null;
      const merged = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      parts.length = 0;
      if (!merged) return null;
      const mesh = new rt.THREE.Mesh(merged, mat);
      mesh.castShadow = shadows; mesh.receiveShadow = shadows;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      scene.add(mesh);
      return mesh;
    },
  };
}

/** Build the user's personal executive office. The door sign defaults to a
 *  generic label; callers should pass the top rank's name (uppercased)
 *  so renaming the rank in the dashboard re-labels the door automatically. */
export function buildMyOffice(
  scene: any,
  room: { cx: number; cz: number; w: number; d: number },
  officeName: string = 'MY OFFICE',
): {
  visitorPos: { x: number; y: number; z: number };
  hitbox: any;
  /** World-space point on the desk surface where dropped notes pile up — front
   *  edge of the desk so a visitor sitting across hands it over. */
  noteDropPos: { x: number; y: number; z: number };
  /** Floor-level point under the executive chair — this is where the
   *  the top agent's seated humanoid is placed (behind the desk). */
  seatPos: { x: number; y: number; z: number };
  /** Y-axis rotation (radians) for the seated occupant so they face the door
   *  (+Z) and any visitor sitting across the desk. */
  seatFacingY: number;
  /** World-space point above the occupant's head — anchor for the
   *  COMANDANTE tag and the gold halo. */
  headPos: { x: number; y: number; z: number };
  /** The 4 visitor chair seat positions in front of the desk. Walkers visiting
   *  the office (reports, meetings held here) sit in these instead of piling
   *  onto one point on the floor. */
  visitorChairs: Array<{ x: number; y: number; z: number }>;
  /** Point a seated visitor should face — the desk / occupant. */
  deskFacingPos: { x: number; y: number; z: number };
  /** Midpoint of the doorway (south wall). Walkers must come in through it. */
  doorPos: { x: number; z: number };
} {
  const { cx, cz, w, d } = room;

  // ── Coordinate frame ──────────────────────────────────────────────────────
  // Back wall (no door) = -Z / north. Door wall (toward the hall) = +Z / south.
  // The executive desk sits near the back wall and FACES THE DOOR; the occupant
  // sits behind it (between desk and back wall) looking at whoever walks in.
  const zBack = cz - d / 2;
  const zDoor = cz + d / 2;

  const deskW = Math.min(4.4, w - 2.2);   // big, imposing — clamped to the room
  const deskDepth = 1.5;
  const deskTopY = 0.92;                   // taller than a worker desk → authority
  // Desk pulled off the back wall so the occupant has room behind the chair
  // instead of sitting pressed against the window and the flags.
  const deskCZ = zBack + 2.6;
  const deskFrontZ = deskCZ + deskDepth / 2;
  const cmdCZ = deskCZ - 1.3;              // occupant seat, behind the desk

  // ── Floor: polished dark marble (lifted a touch so the luxury reads under
  // the single warm light instead of going pure black) ──
  // Bottom of the floor stack: the rugs lie on it, each layer biased in depth
  // (see floorRug) so they never z-fight with it when the camera pulls back.
  const marbleMat = new rt.THREE.MeshStandardMaterial({
    color: 0x2a2236, roughness: 0.22, metalness: 0.32,
    polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: 0,
  });
  applyWorldTexture(marbleMat, 'marble');
  const marbleGeo = new rt.THREE.PlaneGeometry(w, d);
  scaleUV(marbleGeo, w / 11, d / 11);
  const marble = new rt.THREE.Mesh(marbleGeo, marbleMat);
  marble.rotation.x = -Math.PI / 2; marble.position.set(cx, 0.02, cz);
  marble.receiveShadow = true;
  scene.add(marble);

  // ── Walls with gold trim ──
  const wallMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a3050, roughness: 0.6, metalness: 0.1 });
  const wallBright = new rt.THREE.MeshStandardMaterial({ color: 0x3d4868, roughness: 0.5 });
  const goldTrim = new rt.THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.3, metalness: 0.6 });
  applyPBR(goldTrim, 'trim'); // gold baseboard / window frame / accents — accent trim
  addWall(scene, cx, cz - d / 2, w, true, wallMat, wallBright);  // back wall (north, no door)
  addWallWithDoor(scene, cx, cz + d / 2, w, true, 2.5, wallMat, wallBright, new rt.THREE.Color(0xc9a84c)); // front door (south, toward the hall)
  addWall(scene, cx - w / 2, cz, d, false, wallMat, wallBright); // left
  addWall(scene, cx + w / 2, cz, d, false, wallMat, wallBright); // right

  // Gold baseboard trim on back wall
  const baseboard = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(w - 0.5, 0.12, 0.08), goldTrim);
  baseboard.position.set(cx, 0.06, cz - d / 2 + WALL_T / 2 + 0.02);
  scene.add(baseboard);

  // ── Shared furniture materials ──
  const mahogany = new rt.THREE.MeshStandardMaterial({ color: 0x3a1a08, roughness: 0.32, metalness: 0.12 });
  applyWorldTexture(mahogany, 'wood', { normalScale: 0.18 });
  const leatherDark = new rt.THREE.MeshStandardMaterial({ color: 0x1a0a02, roughness: 0.5, metalness: 0.05 });
  applyPBR(leatherDark, 'cloth');
  const leatherGreen = new rt.THREE.MeshStandardMaterial({ color: 0x123a26, roughness: 0.45, metalness: 0.05 }); // desk inlay
  applyPBR(leatherGreen, 'cloth');
  const legMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a0e02, metalness: 0.5, roughness: 0.4 });
  applyPBR(legMat, 'metal');
  const steelMat = new rt.THREE.MeshStandardMaterial({ color: 0x1f2230, roughness: 0.4, metalness: 0.7 });
  applyPBR(steelMat, 'metal');

  // ── Executive desk (large pedestal desk, faces the door) ──────────────────
  // Desk top — big chamfered slab.
  const deskTopGeo = new RoundedBoxGeometry(deskW, 0.12, deskDepth, 2, 0.03);
  const deskTop = new rt.THREE.Mesh(deskTopGeo, mahogany);
  deskTop.position.set(cx, deskTopY, deskCZ);
  deskTop.castShadow = true; deskTop.receiveShadow = true;
  scene.add(deskTop);
  // Tooled leather inlay on the writing surface.
  const inlay = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(deskW - 0.6, 0.02, deskDepth - 0.45),
    leatherGreen,
  );
  inlay.position.set(cx, deskTopY + 0.07, deskCZ);
  scene.add(inlay);
  // Gold edge lip around the writing surface (four thin bars).
  for (const [bw, bd, ox, oz] of [
    [deskW, 0.05, 0, deskDepth / 2 - 0.03],
    [deskW, 0.05, 0, -(deskDepth / 2 - 0.03)],
    [0.05, deskDepth, deskW / 2 - 0.03, 0],
    [0.05, deskDepth, -(deskW / 2 - 0.03), 0],
  ] as [number, number, number, number][]) {
    const lip = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(bw, 0.04, bd), goldTrim);
    lip.position.set(cx + ox, deskTopY + 0.075, deskCZ + oz);
    scene.add(lip);
  }
  // Side pedestals (drawer columns) + a front modesty panel between them.
  const pedW = 0.78, pedH = deskTopY - 0.12;
  for (const s of [-1, 1]) {
    const ped = new rt.THREE.Mesh(new RoundedBoxGeometry(pedW, pedH, deskDepth - 0.18, 2, 0.02), mahogany);
    ped.position.set(cx + s * (deskW / 2 - pedW / 2 - 0.04), pedH / 2, deskCZ);
    ped.castShadow = true;
    scene.add(ped);
    // Three drawer handles per pedestal (gold).
    for (let r = 0; r < 3; r++) {
      const handle = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.22, 0.035, 0.04), goldTrim);
      handle.position.set(
        cx + s * (deskW / 2 - pedW / 2 - 0.04),
        0.28 + r * 0.24,
        deskFrontZ - 0.02,
      );
      scene.add(handle);
    }
  }
  // Front modesty panel (visitor side) with a gold accent strip.
  const panelH = pedH - 0.06;
  const panel = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(deskW - pedW * 2 - 0.1, panelH, 0.06), mahogany);
  panel.position.set(cx, panelH / 2 + 0.04, deskFrontZ - 0.03);
  scene.add(panel);
  // Gold nameplate plaque on the desk front, facing visitors.
  const plaque = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.3, 0.2, 0.03), goldTrim);
  plaque.position.set(cx, deskTopY - 0.28, deskFrontZ + 0.01);
  scene.add(plaque);

  // Monitor on the desk, screen facing the occupant (-Z, toward the back wall).
  const monMat = new rt.THREE.MeshStandardMaterial({
    color: 0x080810, emissive: new rt.THREE.Color(0x3366cc), emissiveIntensity: 0.35, roughness: 0.1,
  });
  applyPBR(monMat, 'screen');
  const monitor = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.3, 0.78, 0.05), monMat);
  monitor.position.set(cx + deskW * 0.18, deskTopY + 0.5, deskCZ - 0.25);
  scene.add(monitor);
  const stand = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.04, 0.09, 0.22, 8), legMat);
  stand.position.set(cx + deskW * 0.18, deskTopY + 0.12, deskCZ - 0.25);
  scene.add(stand);

  // Brass desk lamp on the far corner.
  const lampArm = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), goldTrim);
  lampArm.position.set(cx - deskW * 0.34, deskTopY + 0.22, deskCZ - 0.2);
  scene.add(lampArm);
  const lampShade = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.12, 0.16, 0.12, 10, 1, true), goldTrim);
  lampShade.position.set(cx - deskW * 0.34, deskTopY + 0.44, deskCZ - 0.2);
  scene.add(lampShade);
  const lampGlow = new rt.THREE.Mesh(
    new rt.THREE.SphereGeometry(0.1, 8, 8),
    new rt.THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.65 }),
  );
  lampGlow.position.set(cx - deskW * 0.34, deskTopY + 0.4, deskCZ - 0.2);
  scene.add(lampGlow);

  // ── Chair builder (occupant + visitors share this) ───────────────────────
  // faceDir: +1 → occupant faces +Z (back panel on the -Z side);
  //          -1 → occupant faces -Z (back panel on the +Z side).
  const SEAT_Y = 0.47; // matches meeting-room chairs so seated walkers line up
  function buildChair(px: number, pz: number, faceDir: number, mat: any, tall: boolean): void {
    const seat = new rt.THREE.Mesh(new RoundedBoxGeometry(0.6, 0.1, 0.58, 2, 0.03), mat);
    seat.position.set(px, SEAT_Y, pz); seat.castShadow = true; seat.receiveShadow = true;
    scene.add(seat);
    const backH = tall ? 1.05 : 0.66;
    const back = new rt.THREE.Mesh(new RoundedBoxGeometry(0.6, backH, 0.1, 2, 0.03), mat);
    back.position.set(px, SEAT_Y + backH / 2, pz - faceDir * 0.27); back.castShadow = true;
    scene.add(back);
    // Armrests
    for (const s of [-1, 1]) {
      const arm = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.07, 0.07, 0.5), mat);
      arm.position.set(px + s * 0.33, SEAT_Y + 0.2, pz);
      scene.add(arm);
    }
    // Pedestal post + 5-spoke base (simplified to a disc)
    const post = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.045, 0.045, SEAT_Y - 0.18, 8), legMat);
    post.position.set(px, (SEAT_Y - 0.18) / 2 + 0.09, pz);
    scene.add(post);
    const base = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.3, 0.3, 0.04, 14), legMat);
    base.position.set(px, 0.04, pz);
    scene.add(base);
  }

  // The occupant's tall executive chair, behind the desk, facing the door (+Z).
  buildChair(cx, cmdCZ, +1, leatherDark, true);

  // ── Visitor chairs — 4, in front of the desk, facing the desk (-Z) ────────
  const seatGapX = Math.min(1.1, deskW * 0.28);
  // Fit two rows between the desk front and the door (keep clearance at both).
  const rowSpace = Math.max(0.95, Math.min(1.3, (zDoor - deskFrontZ - 1.5) / 2));
  const frontRowZ = deskFrontZ + rowSpace;
  const backRowZ = frontRowZ + rowSpace + 0.1;
  const visitorChairs = [
    { x: cx - seatGapX, y: 0, z: frontRowZ },
    { x: cx + seatGapX, y: 0, z: frontRowZ },
    { x: cx - seatGapX, y: 0, z: backRowZ },
    { x: cx + seatGapX, y: 0, z: backRowZ },
  ];
  const visitorLeather = new rt.THREE.MeshStandardMaterial({ color: 0x3a2018, roughness: 0.5, metalness: 0.05 });
  applyPBR(visitorLeather, 'cloth');
  for (const seat of visitorChairs) {
    buildChair(seat.x, seat.z, -1, visitorLeather, false);
  }

  // ── Bookshelf (left wall) ──
  // An open case — back panel, two sides, five boards — so the books read.
  // It used to be one solid 0.4-deep block with the books sunk inside it,
  // which drew as a plain brown slab from every angle.
  const shelfZ = cz - 0.3;
  const shelfInX = cx - w / 2 + WALL_T / 2;
  const caseParts = propBatch();
  caseParts.add(new rt.THREE.BoxGeometry(0.05, 2.8, 2.5), shelfInX + 0.025, 1.5, shelfZ);
  for (const s of [-1, 1]) caseParts.add(new rt.THREE.BoxGeometry(0.44, 2.8, 0.06), shelfInX + 0.22, 1.5, shelfZ + s * 1.22);
  for (const by of [0.12, 0.38, 1.08, 1.78, 2.48, 2.88]) {
    caseParts.add(new rt.THREE.BoxGeometry(0.44, 0.04, 2.44), shelfInX + 0.22, by, shelfZ);
  }
  caseParts.add(new rt.THREE.BoxGeometry(0.06, 0.26, 2.44), shelfInX + 0.41, 0.24, shelfZ);  // plinth front
  caseParts.flush(scene, mahogany, true);
  // Book rows — one merged, vertex-coloured mesh. Deterministic sizing so
  // rebuilds are stable.
  const bookColors = [0x8a2a22, 0x1f4f7a, 0x2c5e3a, 0xb07a24, 0x5a2e6e, 0x1d5e56, 0x9a4a1a, 0x2a2a3a];
  const books = propBatch(true);
  const shelfX = shelfInX + 0.22;
  for (let row = 0; row < 4; row++) {
    let z = shelfZ + 1.08;
    for (let b = 0; b < 9; b++) {
      const seed = row * 9 + b;
      const bookH = 0.24 + ((seed * 37) % 17) / 100;
      const bookW = 0.07 + ((seed * 53) % 6) / 100;
      // Every so often a book leans on its neighbour, and a gap breaks a row.
      const lean = seed % 7 === 3 ? 0.18 : 0;
      if (seed % 11 === 5) z -= 0.18;
      books.add(new rt.THREE.BoxGeometry(0.2, bookH, bookW), shelfX, 0.4 + row * 0.7 + bookH / 2, z - bookW / 2,
        { rx: lean, color: bookColors[(seed * 3) % bookColors.length] });
      z -= bookW + 0.012;
      if (z < shelfZ - 1.05) break;
    }
  }
  books.flush(scene, new rt.THREE.MeshStandardMaterial({ roughness: 0.75, vertexColors: true }));

  // ── Leather sofa (right wall) ──
  const sofaMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a0a02, roughness: 0.55, metalness: 0.05, vertexColors: true });
  applyPBR(sofaMat, 'cloth');
  const sofaSeatGeo = new RoundedBoxGeometry(0.7, 0.35, 2.2, 2, 0.05);
  bakeVertexAO(sofaSeatGeo, { floorY: -0.175, reach: 0.1, strength: 0.35 });
  const sofaSeat = new rt.THREE.Mesh(sofaSeatGeo, sofaMat);
  sofaSeat.position.set(cx + w / 2 - WALL_T / 2 - 0.55, 0.35, cz + 0.2);
  scene.add(sofaSeat);
  const sofaBackGeo = new rt.THREE.BoxGeometry(0.12, 0.6, 2.2);
  bakeVertexAO(sofaBackGeo, { floorY: -0.3, reach: 0.18, strength: 0.35 });
  const sofaBack = new rt.THREE.Mesh(sofaBackGeo, sofaMat);
  sofaBack.position.set(cx + w / 2 - WALL_T / 2 - 0.22, 0.65, cz + 0.2);
  scene.add(sofaBack);
  const sofaArmGeo = new rt.THREE.BoxGeometry(0.7, 0.5, 0.12);
  bakeVertexAO(sofaArmGeo, { floorY: -0.25, reach: 0.15, strength: 0.35 });
  for (const end of [-1, 1]) {
    const sofaArm = new rt.THREE.Mesh(sofaArmGeo, sofaMat);
    sofaArm.position.set(cx + w / 2 - WALL_T / 2 - 0.55, 0.47, cz + 0.2 - end * 1.1);
    scene.add(sofaArm);
  }

  // ── Plants (2x potted) ──
  const potMat = new rt.THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 0.6 });
  applyPBR(potMat, 'plastic');
  const leafMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a6e2a, roughness: 0.7 });
  const plantSpots: Array<{ x: number; z: number; stand: any[] }> = [];
  for (const [px, pz] of [[cx - w / 2 + 1.2, cz + d / 2 - 1.0], [cx + w / 2 - 1.2, cz - d / 2 + 1.0]]) {
    const pot = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.2, 0.15, 0.4, 8), potMat);
    pot.position.set(px, 0.2, pz);
    scene.add(pot);
    const leaves = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.45, 8, 6), leafMat);
    leaves.position.set(px, 0.75, pz);
    scene.add(leaves);
    plantSpots.push({ x: px, z: pz, stand: [pot, leaves] });
  }

  // ── Large window (back wall, backlit glow) — at the occupant's back ──
  const windowW = Math.min(w * 0.4, 3.0);
  const windowMat = new rt.THREE.MeshStandardMaterial({
    color: 0x101830, emissive: new rt.THREE.Color(0x1a3060), emissiveIntensity: 0.4,
    roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.85,
  });
  const windowMesh = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(windowW, 1.8, 0.04), windowMat);
  windowMesh.position.set(cx, 2.0, cz - d / 2 + WALL_T / 2 + 0.01);
  scene.add(windowMesh);
  const frameMat = goldTrim;
  for (const [fw, fh, fx, fy] of [
    [windowW + 0.15, 0.06, 0, 1.1], [windowW + 0.15, 0.06, 0, 2.9],
    [0.06, 1.8, -windowW / 2 - 0.05, 2.0], [0.06, 1.8, windowW / 2 + 0.05, 2.0],
  ] as [number, number, number, number][]) {
    const frame = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(fw, fh, 0.08), frameMat);
    frame.position.set(cx + fx, fy, cz - d / 2 + WALL_T / 2 + 0.02);
    scene.add(frame);
  }

  // ── Details ───────────────────────────────────────────────────────────
  // Everything below is merged into one mesh per material (propBatch), so the
  // whole set adds five draw calls; the merged book rows above saved more
  // than that. Nothing here sits on the walker lane: visitors come straight
  // in along x = cx and turn along the chair rows, so props stay against the
  // walls, behind the desk, or beside it.
  const xL = cx - w / 2 + WALL_T / 2;      // inner face of each wall
  const xR = cx + w / 2 - WALL_T / 2;
  const zB = zBack + WALL_T / 2;
  const wood = propBatch();
  const gold = propBatch();
  const dark = propBatch();
  const tinted = propBatch(true);
  const glow = propBatch();
  const T = rt.THREE;
  const deskSurfY = deskTopY + 0.08;

  // Flags flanking the window, behind the occupant — the room's rank.
  for (const s of [-1, 1]) {
    const fx = cx + s * (windowW / 2 + 0.55);
    const fz = zB + 0.35;
    gold.add(new T.CylinderGeometry(0.18, 0.2, 0.06, 14), fx, 0.03, fz);
    gold.add(new T.CylinderGeometry(0.022, 0.022, 2.3, 6), fx, 1.18, fz);
    gold.add(new T.SphereGeometry(0.06, 8, 6), fx, 2.36, fz);
    // The banner hangs on the window side, a little slack.
    const bx = fx - s * 0.33;
    tinted.add(new T.BoxGeometry(0.6, 1.0, 0.02), bx, 1.72, fz, { rz: s * 0.05, color: s < 0 ? 0x6a1a2a : 0x1e2a5a });
    tinted.add(new T.BoxGeometry(0.16, 0.16, 0.025), bx, 1.8, fz, { ry: 0, rz: Math.PI / 4, color: 0xc9a84c });
    gold.add(new T.BoxGeometry(0.62, 0.05, 0.03), bx, 1.21, fz, { rz: s * 0.05 });
  }

  // Sideboard in the back-left corner: decanter, two glasses, a trophy.
  const sbW = Math.min(1.6, (cx - windowW / 2 - 1.0) - (xL + 0.15));
  if (sbW > 0.8) {
    const sbX = xL + 0.15 + sbW / 2;
    const sbZ = zB + 0.25;
    wood.add(new RoundedBoxGeometry(sbW, 0.78, 0.46, 2, 0.02), sbX, 0.43, sbZ);
    dark.add(new T.BoxGeometry(sbW - 0.06, 0.04, 0.4), sbX, 0.02, sbZ);
    for (const dx of [-sbW / 4, sbW / 4]) gold.add(new T.BoxGeometry(0.16, 0.03, 0.03), sbX + dx, 0.62, sbZ + 0.24);
    const topY = 0.82;
    tinted.add(new T.CylinderGeometry(0.07, 0.09, 0.24, 10), sbX - sbW * 0.25, topY + 0.12, sbZ, { color: 0x8a4a14 });
    gold.add(new T.SphereGeometry(0.035, 8, 6), sbX - sbW * 0.25, topY + 0.27, sbZ);
    for (const dx of [0, 0.13]) tinted.add(new T.CylinderGeometry(0.035, 0.028, 0.09, 8), sbX - sbW * 0.05 + dx, topY + 0.045, sbZ + 0.05, { color: 0x9ab0c0 });
    gold.add(new T.CylinderGeometry(0.06, 0.08, 0.05, 10), sbX + sbW * 0.3, topY + 0.025, sbZ);
    gold.add(new T.CylinderGeometry(0.02, 0.02, 0.12, 6), sbX + sbW * 0.3, topY + 0.11, sbZ);
    gold.add(new T.CylinderGeometry(0.09, 0.04, 0.12, 10, 1, true), sbX + sbW * 0.3, topY + 0.23, sbZ);
  }

  // Globe on a stand beside the desk, on the occupant's left.
  {
    const gx = cx - deskW / 2 - 0.75;
    const gz = deskCZ - 0.1;
    const gy = 1.0;
    wood.add(new T.CylinderGeometry(0.26, 0.3, 0.06, 14), gx, 0.03, gz);
    wood.add(new T.CylinderGeometry(0.045, 0.06, 0.6, 8), gx, 0.36, gz);
    gold.add(new T.TorusGeometry(0.37, 0.014, 6, 36), gx, gy, gz, { rz: 0.41 });
    gold.add(new T.TorusGeometry(0.36, 0.012, 6, 36), gx, gy, gz, { rx: Math.PI / 2 });
    // Oceans and continents from a few summed sines over the sphere — no
    // texture, and the same globe every rebuild.
    const land = (px: number, py: number, pz: number) => {
      const r = Math.hypot(px, py, pz) || 1;
      const x = px / r, y = py / r, z = pz / r;
      const n = Math.sin(x * 4.1 + 1.3) * Math.cos(z * 3.7) + Math.sin(y * 5.3 + x * 2.1) * 0.6 + Math.cos(z * 6.2 - y * 1.7) * 0.35;
      if (Math.abs(y) > 0.9) return 0xd8dde0;   // ice caps
      return n > 0.45 ? (n > 0.95 ? 0x8a7244 : 0x5f7438) : 0x1d4466;
    };
    tinted.add(new T.SphereGeometry(0.33, 24, 16), gx, gy, gz, { rz: 0.41, paint: land });
  }

  // The monitor's back shell, on the visitors' side: the screen glows toward
  // the occupant only, instead of reading as a blue sign from the door.
  dark.add(new T.BoxGeometry(1.34, 0.82, 0.04), cx + deskW * 0.18, deskTopY + 0.5, deskCZ - 0.25 + 0.045);
  dark.add(new T.BoxGeometry(0.5, 0.3, 0.06), cx + deskW * 0.18, deskTopY + 0.5, deskCZ - 0.25 + 0.09);

  // Desk accessories: keyboard on the occupant's side, phone, pen cup,
  // folders and a photo turned toward him.
  dark.add(new T.BoxGeometry(0.56, 0.025, 0.17), cx + deskW * 0.18, deskSurfY + 0.012, deskCZ - 0.55);
  dark.add(new T.BoxGeometry(0.22, 0.06, 0.18), cx + deskW * 0.4, deskSurfY + 0.03, deskCZ - 0.15, { ry: -0.3 });
  dark.add(new T.BoxGeometry(0.06, 0.04, 0.2), cx + deskW * 0.4 - 0.04, deskSurfY + 0.08, deskCZ - 0.15, { ry: -0.3 });
  gold.add(new T.CylinderGeometry(0.045, 0.04, 0.12, 10), cx - deskW * 0.28, deskSurfY + 0.06, deskCZ - 0.4);
  for (const [dx, rz] of [[-0.01, 0.2], [0.012, -0.15]] as [number, number][]) {
    dark.add(new T.CylinderGeometry(0.008, 0.008, 0.18, 4), cx - deskW * 0.28 + dx, deskSurfY + 0.15, deskCZ - 0.4, { rz });
  }
  [0xe6dcc4, 0x8a2a22, 0x1f4f7a].forEach((col, i) => {
    tinted.add(new T.BoxGeometry(0.34, 0.018, 0.25), cx - deskW * 0.06, deskSurfY + 0.01 + i * 0.019, deskCZ - 0.42,
      { ry: (i - 1) * 0.09, color: col });
  });
  gold.add(new T.BoxGeometry(0.2, 0.15, 0.02), cx + deskW * 0.02, deskSurfY + 0.08, deskCZ - 0.15, { rx: 0.22 });
  tinted.add(new T.BoxGeometry(0.15, 0.1, 0.005), cx + deskW * 0.02, deskSurfY + 0.08, deskCZ - 0.162, { rx: 0.22, color: 0x6f8aa0 });

  // Lounge by the sofa: area rug, coffee table, floor lamp, and a painting.
  {
    const sofaZ = cz + 0.2;
    const visitorRugEdge = cx + Math.min(deskW + 1.2, w - 1.4) / 2;
    const loungeW = Math.min(2.6, xR - visitorRugEdge - 0.35);
    if (loungeW > 1.5) {
      const lx = xR - loungeW / 2 - 0.05;
      floorRug(scene, lx, sofaZ, loungeW, 3.0, 0x1c2442, 0x8a6a32, 0.08);
    }
    const tx = xR - 1.55;
    wood.add(new RoundedBoxGeometry(0.72, 0.06, 1.25, 2, 0.02), tx, 0.42, sofaZ);
    for (const [ox, oz] of [[-0.3, -0.55], [0.3, -0.55], [-0.3, 0.55], [0.3, 0.55]] as [number, number][]) {
      gold.add(new T.CylinderGeometry(0.02, 0.02, 0.39, 6), tx + ox, 0.2, sofaZ + oz);
    }
    [0x2c5e3a, 0xb07a24].forEach((col, i) => {
      tinted.add(new T.BoxGeometry(0.3, 0.045, 0.22), tx, 0.475 + i * 0.046, sofaZ - 0.25, { ry: i * 0.25, color: col });
    });
    gold.add(new T.CylinderGeometry(0.13, 0.07, 0.07, 14, 1, true), tx, 0.485, sofaZ + 0.3);

    const lampZ = sofaZ + 1.55;
    const lampX = xR - 0.42;
    gold.add(new T.CylinderGeometry(0.16, 0.18, 0.04, 12), lampX, 0.02, lampZ);
    gold.add(new T.CylinderGeometry(0.018, 0.018, 1.55, 6), lampX, 0.8, lampZ);
    tinted.add(new T.CylinderGeometry(0.16, 0.24, 0.3, 14, 1, true), lampX, 1.68, lampZ, { color: 0xe8d6a8 });
    glow.add(new T.SphereGeometry(0.11, 8, 6), lampX, 1.62, lampZ);

    // Dusk over hills, in horizontal bands — the canvas sits proud of the
    // wall, the gold frame around it.
    const px = xR - 0.04;
    const pw = 1.7, ph = 1.05, py = 2.1;
    gold.add(new T.BoxGeometry(0.05, ph + 0.12, pw + 0.12), px, py, sofaZ);
    const bands = [0x1b1f3a, 0x2d2a52, 0x553060, 0x8a3c50, 0xc0643a, 0xe09a4a];
    const bandH = (ph * 0.68) / bands.length;
    bands.forEach((col, i) => {
      tinted.add(new T.BoxGeometry(0.02, bandH, pw), px - 0.03, py + ph / 2 - bandH * (i + 0.5), sofaZ, { color: col });
    });
    tinted.add(new T.CylinderGeometry(0.12, 0.12, 0.02, 16), px - 0.035, py - ph * 0.12, sofaZ + 0.35, { rz: Math.PI / 2, color: 0xf6c870 });
    tinted.add(new T.BoxGeometry(0.02, ph * 0.32, pw), px - 0.036, py - ph / 2 + ph * 0.16, sofaZ, { color: 0x14121e });
    tinted.add(new T.BoxGeometry(0.02, ph * 0.12, pw * 0.55), px - 0.04, py - ph / 2 + ph * 0.34, sofaZ - pw * 0.2, { color: 0x14121e });
  }

  // Reading chair by the bookshelf, turned toward the room, with a side
  // table. Parts are offset first and then turned about the chair's centre.
  {
    const leather = propBatch();
    const rx0 = xL + 1.35, rz0 = shelfZ + 1.95, ry = 2.2;
    const part = (geo: any, ox: number, oy: number, oz: number) => { geo.translate(ox, oy, oz); return geo; };
    leather.add(part(new RoundedBoxGeometry(0.8, 0.22, 0.75, 2, 0.06), 0, 0.33, 0), rx0, 0, rz0, { ry });
    leather.add(part(new RoundedBoxGeometry(0.8, 0.62, 0.18, 2, 0.06), 0, 0.68, -0.3), rx0, 0, rz0, { ry });
    for (const sx of [-1, 1]) leather.add(part(new RoundedBoxGeometry(0.16, 0.42, 0.72, 2, 0.05), sx * 0.4, 0.46, 0), rx0, 0, rz0, { ry });
    leather.flush(scene, leatherDark, true);
    for (const [ox, oz] of [[-0.3, -0.28], [0.3, -0.28], [-0.3, 0.28], [0.3, 0.28]] as [number, number][]) {
      gold.add(part(new T.CylinderGeometry(0.025, 0.02, 0.22, 6), ox, 0.11, oz), rx0, 0, rz0, { ry });
    }
    const stX = rx0 + 0.15, stZ = rz0 - 0.85;
    wood.add(new T.CylinderGeometry(0.24, 0.24, 0.04, 16), stX, 0.56, stZ);
    wood.add(new T.CylinderGeometry(0.035, 0.05, 0.54, 8), stX, 0.28, stZ);
    wood.add(new T.CylinderGeometry(0.16, 0.18, 0.03, 14), stX, 0.015, stZ);
    tinted.add(new T.BoxGeometry(0.22, 0.04, 0.16), stX - 0.02, 0.6, stZ + 0.02, { ry: 0.5, color: 0x8a2a22 });
    tinted.add(new T.CylinderGeometry(0.04, 0.035, 0.08, 10), stX + 0.1, 0.62, stZ - 0.06, { color: 0xe8e0cc });
  }

  wood.flush(scene, mahogany, true);
  gold.flush(scene, goldTrim);
  dark.flush(scene, steelMat);
  tinted.flush(scene, new T.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, vertexColors: true }), true);
  glow.flush(scene, new T.MeshBasicMaterial({ color: 0xffd890, transparent: true, opacity: 0.7 }));

  // ── Large rug under the visitor seating zone (burgundy, gold binding) ──
  const rugCZ = (deskFrontZ + backRowZ) / 2;
  const rugD = Math.min(backRowZ - deskFrontZ + 1.6, d - 2);
  const rugW = Math.min(deskW + 1.2, w - 1.4);
  floorRug(scene, cx, rugCZ, rugW, rugD, 0x6a1a2a, 0x8a6a32, 0.15);

  // ── Warm ambient lighting — single PointLight (kept to one for perf) ──
  // Brighter + pulled toward the desk/visitor zone so the executive furniture
  // and the four chairs read as the lit centerpiece of the office.
  const mainLight = new rt.THREE.PointLight(0xffe4b5, 3.4, Math.max(w, d) * 2.4);
  mainLight.position.set(cx, WALL_H - 0.1, deskFrontZ + 0.3);
  mainLight.decay = 2;
  mainLight.matrixAutoUpdate = false; mainLight.updateMatrix();
  scene.add(mainLight);

  // Lamps and window that actually light the room (realism layer only).
  addMyOfficeLights(scene, { deskLamp: lampGlow.position, floorLamp: { x: xR - 0.42, y: 1.62, z: cz + 1.75 }, windowMesh });
  addMyOfficeProps(scene, { plants: plantSpots, bust: { x: shelfInX + 0.22, y: 2.9, z: shelfZ } });

  // ── Name sign (above the door, facing the hall) ──
  const signDiv = document.createElement('div');
  signDiv.textContent = officeName;
  signDiv.style.cssText = `font:700 11px 'Syne',sans-serif;color:#c9a84c;letter-spacing:3px;
    text-shadow:0 0 12px #c9a84c, 0 0 4px #fff8;background:rgba(0,0,8,0.8);padding:4px 16px;border-radius:3px;
    border:1px solid rgba(201,168,76,0.4);`;
  makeSignClickable(signDiv, { cx, cz, w, d, name: officeName });
  const lbl = new rt.CSS2DObject(signDiv);
  lbl.position.set(cx, WALL_H + 0.5, cz + d / 2);
  scene.add(lbl);

  // Invisible hitbox covering the entire office — for click detection
  const hitbox = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(w * 0.8, 3.0, d * 0.8),
    new rt.THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  hitbox.position.set(cx, 1.5, cz);
  hitbox.renderOrder = -1;
  hitbox.userData.isMyOffice = true;
  scene.add(hitbox);

  // ── Anchors returned to the caller ────────────────────────────────────────
  // Legacy single visitor point — desk-front center (used by data-packet arcs).
  const visitorPos = { x: cx, y: 0, z: frontRowZ };
  // Note pile on the desk front edge, left of center (clear of the monitor).
  const noteDropPos = { x: cx - deskW * 0.22, y: deskTopY + 0.1, z: deskCZ + 0.25 };
  // Occupant seated behind the desk, facing the door (+Z). The humanoid's
  // front is already +Z (its tie sits at z=+0.16, and walkers face with
  // atan2(dx, dz)), so no turn: π put his back to the desk and the visitors.
  // The rank-and-file desks use π because they sit on the desk's +Z side.
  const seatPos = { x: cx, y: 0, z: cmdCZ };
  const seatFacingY = 0;
  const headPos = { x: cx, y: 1.7, z: cmdCZ };
  // Visitors face the occupant across the desk.
  const deskFacingPos = { x: cx, y: 1.0, z: cmdCZ };

  const doorPos = { x: cx, z: zDoor };
  return { visitorPos, hitbox, noteDropPos, seatPos, seatFacingY, headPos, visitorChairs, deskFacingPos, doorPos };
}

/**
 * A rug lying on the office floor: a woven, matte field inside a binding of
 * `border` width. Rug and floor are a few millimetres apart, which the depth
 * buffer cannot tell apart once the camera pulls back — the layers z-fought
 * into stripes. polygonOffset biases each layer in depth space instead, so the
 * floor < binding < field order holds at any zoom.
 */
function floorRug(
  scene: any, x: number, z: number, w: number, d: number,
  field: number, binding: number, border: number,
): void {
  const layer = (color: number, lw: number, ld: number, y: number, units: number) => {
    const mat = new rt.THREE.MeshStandardMaterial({
      color, polygonOffset: true, polygonOffsetFactor: units / 2, polygonOffsetUnits: units,
    });
    applyPBR(mat, 'carpet');
    applyWorldTexture(mat, 'carpet');
    const geo = new rt.THREE.PlaneGeometry(lw, ld);
    scaleUV(geo, lw / 1.5, ld / 1.5);
    const mesh = new rt.THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };
  layer(binding, w + border * 2, d + border * 2, 0.028, -2);
  layer(field, w, d, 0.03, -4);
}
