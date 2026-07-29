import { rt } from '../runtime.js';
import {
  WALL_H, WALL_T,
  makeSignClickable, addWall, addWallWithDoor,
} from './_shared.js';
import { applyPBR, bakeVertexAO } from './_materials.js';
import { applyWorldTexture, scaleUV } from '../textures.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

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
  const deskCZ = zBack + 1.9;              // desk near the back wall
  const deskFrontZ = deskCZ + deskDepth / 2;
  const cmdCZ = deskCZ - 1.15;             // occupant seat, behind the desk

  // ── Floor: polished dark marble (lifted a touch so the luxury reads under
  // the single warm light instead of going pure black) ──
  const marbleMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a2236, roughness: 0.22, metalness: 0.32 });
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
  const shelfMat = new rt.THREE.MeshStandardMaterial({ color: 0x3a1a08, roughness: 0.4, metalness: 0.05, vertexColors: true });
  const shelfGeo = new RoundedBoxGeometry(0.4, 2.8, 2.5, 2, 0.016);
  bakeVertexAO(shelfGeo, { floorY: -1.4, reach: 0.9, strength: 0.35 });
  const shelfFrame = new rt.THREE.Mesh(shelfGeo, shelfMat);
  shelfFrame.position.set(cx - w / 2 + WALL_T / 2 + 0.22, 1.5, cz - 0.3);
  scene.add(shelfFrame);
  // Book rows (colored blocks) — deterministic sizing so rebuilds are stable.
  const bookColors = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0x16a085, 0xd35400];
  for (let row = 0; row < 4; row++) {
    for (let b = 0; b < 5; b++) {
      const seed = row * 5 + b;
      const bookH = 0.2 + ((seed * 37) % 15) / 100;
      const bookW = 0.08 + ((seed * 53) % 5) / 100;
      const book = new rt.THREE.Mesh(
        new rt.THREE.BoxGeometry(0.15, bookH, bookW),
        new rt.THREE.MeshStandardMaterial({ color: bookColors[seed % bookColors.length], roughness: 0.6 }),
      );
      book.position.set(
        cx - w / 2 + WALL_T / 2 + 0.22,
        0.4 + row * 0.7 + bookH / 2,
        cz - 0.3 + 0.9 - b * 0.35,
      );
      scene.add(book);
    }
  }

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
  for (const [px, pz] of [[cx - w / 2 + 1.2, cz + d / 2 - 1.0], [cx + w / 2 - 1.2, cz - d / 2 + 1.0]]) {
    const pot = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.2, 0.15, 0.4, 8), potMat);
    pot.position.set(px, 0.2, pz);
    scene.add(pot);
    const leaves = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.45, 8, 6), leafMat);
    leaves.position.set(px, 0.75, pz);
    scene.add(leaves);
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

  // ── Large rug under the visitor seating zone (gold-bordered burgundy) ──
  const rugCZ = (deskFrontZ + backRowZ) / 2;
  const rugD = Math.min(backRowZ - deskFrontZ + 1.6, d - 2);
  const rugW = Math.min(deskW + 1.2, w - 1.4);
  const rug = new rt.THREE.Mesh(
    new rt.THREE.PlaneGeometry(rugW, rugD),
    new rt.THREE.MeshStandardMaterial({ color: 0x6a1a2a, roughness: 0.7, metalness: 0 }),
  );
  rug.rotation.x = -Math.PI / 2; rug.position.set(cx, 0.03, rugCZ); rug.receiveShadow = true;
  scene.add(rug);
  const rugBorder = new rt.THREE.Mesh(
    new rt.THREE.PlaneGeometry(rugW + 0.3, rugD + 0.3),
    new rt.THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.5, metalness: 0.3 }),
  );
  rugBorder.rotation.x = -Math.PI / 2; rugBorder.position.set(cx, 0.028, rugCZ);
  scene.add(rugBorder);

  // ── Warm ambient lighting — single PointLight (kept to one for perf) ──
  // Brighter + pulled toward the desk/visitor zone so the executive furniture
  // and the four chairs read as the lit centerpiece of the office.
  const mainLight = new rt.THREE.PointLight(0xffe4b5, 1.7, Math.max(w, d) * 2.4);
  mainLight.position.set(cx, WALL_H - 0.1, deskFrontZ + 0.3);
  mainLight.decay = 2;
  mainLight.matrixAutoUpdate = false; mainLight.updateMatrix();
  scene.add(mainLight);

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
  // Occupant seated behind the desk, facing the door (+Z). Default humanoid
  // forward is -Z, so rotating by π turns him to face the door / visitors.
  const seatPos = { x: cx, y: 0, z: cmdCZ };
  const seatFacingY = Math.PI;
  const headPos = { x: cx, y: 1.7, z: cmdCZ };
  // Visitors face the occupant across the desk.
  const deskFacingPos = { x: cx, y: 1.0, z: cmdCZ };

  return { visitorPos, hitbox, noteDropPos, seatPos, seatFacingY, headPos, visitorChairs, deskFacingPos };
}
