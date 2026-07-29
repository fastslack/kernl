import { rt } from '../runtime.js';
import { WALL_H, makeSignClickable } from './_shared.js';
import { applyPBR, bakeVertexAO } from './_materials.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface ReceptionAnchors {
  dropPos: { x: number; y: number; z: number };        // counter top (package visual position)
  frontPos: { x: number; y: number; z: number };       // where the recipient walker stands (interior side)
  driverFrontPos: { x: number; y: number; z: number }; // where the delivery driver stands (door side)
}

/** Build an imposing hotel-style reception that faces the main entrance doors.
 *  The counter is placed at `counterCZ` (typically the former Central Hall
 *  centre), with the full marble lobby stretching south from it to the doors.
 *  Returns anchor points for delivery drop-off (driver approaches from the
 *  door side, facing the counter front) and recipient pickup (office walkers
 *  approach from the interior side, behind the counter). */
export function buildReception(
  scene: any,
  cx: number,
  counterCZ: number,
): ReceptionAnchors {
  // Reception faces SOUTH (toward the glass doors) — visitors arriving through
  // the entrance look down the lobby and see the counter ahead of them.
  const counterZ = counterCZ;
  const counterH = 1.15;
  const counterW = 10.0;
  const counterD = 1.6;

  // ── Counter body (front panel — faces SOUTH / toward the doors) ──
  const panelMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a2035, roughness: 0.35, metalness: 0.4 });
  applyPBR(panelMat, 'metal'); // reception counter front panel — structural metal
  // panelMat is dedicated to this counter front panel only (verified) → safe
  // to enable vertexColors. Bake contact-shadow AO at the panel's local bottom
  // (-counterH/2) so it darkens where it meets the marble floor. Subtle
  // RoundedBoxGeometry chamfer (segments=2) softens the long hard edge.
  panelMat.vertexColors = true;
  panelMat.needsUpdate = true;
  const panelGeo = new RoundedBoxGeometry(counterW, counterH, 0.15, 2, 0.02);
  bakeVertexAO(panelGeo, { floorY: -counterH / 2, reach: counterH * 0.35, strength: 0.35 });
  const panel = new rt.THREE.Mesh(
    panelGeo,
    panelMat,
  );
  panel.position.set(cx, counterH / 2, counterZ + counterD / 2 - 0.075);
  panel.castShadow = true;
  panel.receiveShadow = true;
  scene.add(panel);

  // ── Lower gold inlay band across the front ──
  const goldMat = new rt.THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.3, metalness: 0.7 });
  applyPBR(goldMat, 'trim'); // gold inlay/rims/columns/crown/fluting/bell/sconces — accent trim
  const inlay = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(counterW - 0.2, 0.15, 0.02), goldMat);
  inlay.position.set(cx, counterH - 0.45, counterZ + counterD / 2 - 0.02);
  scene.add(inlay);
  // Dense vertical fluting (short gold strips) for a grander look
  const fluteCount = 10;
  for (let i = 0; i < fluteCount; i++) {
    const fx = cx - counterW / 2 + 0.6 + i * ((counterW - 1.2) / (fluteCount - 1));
    const flute = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.03, counterH * 0.55, 0.02), goldMat);
    flute.position.set(fx, counterH * 0.3, counterZ + counterD / 2 - 0.01);
    scene.add(flute);
  }

  // ── Counter top slab (polished marble with gold rim) ──
  const topMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a3555, roughness: 0.15, metalness: 0.6 });
  // Polished marble counter top — prominent camera-facing slab. Subtle
  // RoundedBoxGeometry chamfer (segments=2) rounds the edges for a finished
  // stone look. No vertexColors here (floats at counter height, not grounded).
  const top = new rt.THREE.Mesh(
    new RoundedBoxGeometry(counterW + 0.3, 0.1, counterD + 0.2, 2, 0.02),
    topMat,
  );
  top.position.set(cx, counterH + 0.05, counterZ);
  top.receiveShadow = true;
  scene.add(top);
  // Gold rim around the counter top
  for (const dx of [-counterW / 2 - 0.15, counterW / 2 + 0.15]) {
    const rim = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.04, 0.12, counterD + 0.22), goldMat);
    rim.position.set(cx + dx, counterH + 0.05, counterZ);
    scene.add(rim);
  }
  for (const dz of [-counterD / 2 - 0.1, counterD / 2 + 0.1]) {
    const rim = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(counterW + 0.32, 0.12, 0.04), goldMat);
    rim.position.set(cx, counterH + 0.05, counterZ + dz);
    scene.add(rim);
  }

  // ── Flanking gold columns (hotel entrance feel) ──
  const columnMat = new rt.THREE.MeshStandardMaterial({ color: 0xb89648, roughness: 0.3, metalness: 0.7 });
  applyPBR(columnMat, 'trim'); // gold column shaft/capital — accent trim
  const columnBaseMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a3050, roughness: 0.4, metalness: 0.3 });
  const colH = WALL_H - 0.1;
  for (const side of [-1, 1]) {
    const colX = cx + side * (counterW / 2 + 0.9);
    // Base plinth
    const base = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.7, 0.2, 0.7), columnBaseMat);
    base.position.set(colX, 0.1, counterZ);
    scene.add(base);
    // Shaft
    const shaft = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.22, 0.26, colH - 0.5, 16), columnMat);
    shaft.position.set(colX, (colH - 0.5) / 2 + 0.2, counterZ);
    scene.add(shaft);
    // Capital
    const cap = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.6, 0.22, 0.6), columnMat);
    cap.position.set(colX, colH - 0.18, counterZ);
    scene.add(cap);
  }

  // ── Tall back wall (behind counter, facing the doors over the top) ──
  // 2.5u gap from the counter — enough for the receptionist to stand comfort-
  // ably without crowding the wall, but tight enough to read as one room.
  // NOTE: ambiance.ts:buildActivityBoard uses the SAME gap (2.5) for its
  //       backWallSouthFaceZ. Keep them in sync.
  const WALL_GAP_BEHIND_COUNTER = 2.5;
  const backWallZ = counterZ - counterD / 2 - WALL_GAP_BEHIND_COUNTER;
  const backMat = new rt.THREE.MeshStandardMaterial({ color: 0x1d2540, roughness: 0.55, metalness: 0.2 });
  const backH = WALL_H - 0.5;
  const back = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(counterW + 0.8, backH, 0.1),
    backMat,
  );
  back.position.set(cx, backH / 2, backWallZ);
  scene.add(back);
  // Horizontal gold divider on the back wall
  const divider = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(counterW + 0.6, 0.08, 0.06), goldMat);
  divider.position.set(cx, 2.0, backWallZ + 0.04);
  scene.add(divider);
  // Upper crown strip
  const crown = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(counterW + 1.2, 0.15, 0.15), goldMat);
  crown.position.set(cx, backH - 0.05, backWallZ);
  scene.add(crown);

  // ── RECEPTION sign on the back wall — matches the style of office signs ──
  const signDiv = document.createElement('div');
  signDiv.textContent = 'RECEPTION';
  signDiv.style.cssText =
    `font:700 11px 'Syne',sans-serif;color:#c9a84c;letter-spacing:3px;` +
    `text-shadow:0 0 12px #c9a84c80, 0 0 4px #c9a84c40;` +
    `background:rgba(0,0,8,0.7);padding:3px 14px;border-radius:2px;`;
  makeSignClickable(signDiv, { cx, cz: counterZ, w: counterW, d: counterD + 2, name: 'RECEPTION' });
  const lbl = new rt.CSS2DObject(signDiv);
  lbl.position.set(cx, 2.55, backWallZ + 0.06);
  scene.add(lbl);

  // ── Wall-mounted tactical displays — two flanking screens that frame the
  // central ACTIVITY board (rendered by ambiance.ts:buildActivityBoard at
  // exactly y=1.95, w=2.4, h=1.2). Match its size + height so the three
  // screens form a single video-wall row.
  const wallScreenMat = new rt.THREE.MeshStandardMaterial({
    color: 0x0a0f1c,
    emissive: new rt.THREE.Color(0x2288ff),
    emissiveIntensity: 0.6,
    roughness: 0.15, metalness: 0.25,
  });
  applyPBR(wallScreenMat, 'screen'); // flanking wall tactical display — screen surface (emissive)
  const SCREEN_W = 2.4, SCREEN_H = 1.2;
  const SCREEN_Y = 1.95;
  // ~0.8u gap from the central activity board (centred at cx, width 2.4 →
  // half = 1.2; flanking screens at cx ± (1.2 + 0.4 + 1.2) = cx ± 2.8).
  for (const dx of [-2.8, 2.8]) {
    // Frame — slightly bigger gold rectangle behind the screen.
    const frame = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(SCREEN_W + 0.14, SCREEN_H + 0.14, 0.04),
      goldMat,
    );
    frame.position.set(cx + dx, SCREEN_Y, backWallZ + 0.07);
    scene.add(frame);
    // Screen panel — emissive cyan/blue glow.
    const screen = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(SCREEN_W, SCREEN_H, 0.05), wallScreenMat);
    screen.position.set(cx + dx, SCREEN_Y, backWallZ + 0.10);
    scene.add(screen);
    // Subtle scanline / divider strip across the middle for a CRT vibe.
    const scan = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(SCREEN_W * 0.95, 0.02, 0.02),
      new rt.THREE.MeshStandardMaterial({
        color: 0x88ccff, emissive: new rt.THREE.Color(0x88ccff), emissiveIntensity: 0.8,
      }),
    );
    scan.position.set(cx + dx, SCREEN_Y, backWallZ + 0.13);
    scene.add(scan);
  }

  // ── Two monitors angled on the counter (one per station) ──
  const monMat = new rt.THREE.MeshStandardMaterial({
    color: 0x0a0f1c, emissive: new rt.THREE.Color(0x2288ff), emissiveIntensity: 0.35,
    roughness: 0.15, metalness: 0.2,
  });
  applyPBR(monMat, 'screen'); // counter station monitor — screen surface (emissive)
  for (const dx of [-counterW / 2 + 1.4, counterW / 2 - 1.4]) {
    const mon = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.55, 0.35, 0.04), monMat);
    mon.position.set(cx + dx, counterH + 0.3, counterZ - 0.2);
    scene.add(mon);
    // Stand
    const standMat = new rt.THREE.MeshStandardMaterial({ color: 0x3a3a4a });
    applyPBR(standMat, 'plastic'); // counter monitor stand — plastic
    const stand = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.05, 0.18, 0.05), standMat);
    stand.position.set(cx + dx, counterH + 0.18, counterZ - 0.2);
    scene.add(stand);
  }

  // ── Central concierge bell on the counter top (polished gold dome) ──
  const bell = new rt.THREE.Mesh(
    new rt.THREE.SphereGeometry(0.11, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    goldMat,
  );
  bell.position.set(cx, counterH + 0.1, counterZ + 0.3);
  scene.add(bell);

  // ── Ceiling spot over the desk (emissive, no PointLight) ──
  const spotMat = new rt.THREE.MeshBasicMaterial({ color: 0xffeedd, transparent: true, opacity: 0.45 });
  const spot = new rt.THREE.Mesh(new rt.THREE.CircleGeometry(1.8, 20), spotMat);
  spot.rotation.x = Math.PI / 2;
  spot.position.set(cx, WALL_H - 0.02, counterZ);
  scene.add(spot);

  // ── Side planters with topiaries flanking the front (guides visitors) ──
  const potMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a3050, roughness: 0.5, metalness: 0.3 });
  const leafMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a6e2a, roughness: 0.75 });
  for (const side of [-1, 1]) {
    const px = cx + side * (counterW / 2 + 0.3);
    const pz = counterZ + counterD / 2 + 0.8;
    const pot = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.22, 0.2, 0.45, 10), potMat);
    pot.position.set(px, 0.225, pz);
    scene.add(pot);
    const foliage = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.35, 10, 8), leafMat);
    foliage.position.set(px, 0.85, pz);
    scene.add(foliage);
  }

  // ── Executive office chair for the receptionist ─────────────
  // 5-spoke wheeled base + telescoping post + leather seat + tall back. The
  // base sits at the receptionist's x,z so they're visually planted on it.
  const seatZ = counterZ - counterD / 2 - 0.6;
  const leatherMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.45, metalness: 0.1 });
  const chrome = new rt.THREE.MeshStandardMaterial({ color: 0x4a4d58, roughness: 0.35, metalness: 0.8 });
  applyPBR(chrome, 'metal'); // chair chrome base/post/spokes/castors — structural metal
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    // Spoke
    const spoke = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.32, 0.05, 0.06), chrome);
    spoke.position.set(cx + Math.cos(a) * 0.16, 0.08, seatZ + Math.sin(a) * 0.16);
    spoke.rotation.y = a;
    scene.add(spoke);
    // Castor wheel
    const castor = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.045, 6, 6), chrome);
    castor.position.set(cx + Math.cos(a) * 0.32, 0.045, seatZ + Math.sin(a) * 0.32);
    scene.add(castor);
  }
  // Central post
  const chairPost = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.045, 0.045, 0.42, 10), chrome);
  chairPost.position.set(cx, 0.32, seatZ);
  scene.add(chairPost);
  // Seat cushion (leather)
  const seatCushion = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, 0.1, 0.46), leatherMat);
  seatCushion.position.set(cx, 0.55, seatZ);
  seatCushion.castShadow = true;
  scene.add(seatCushion);
  // Tall backrest with slight recline, gold piping along the top edge
  const chairBack = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.52, 0.85, 0.09), leatherMat);
  chairBack.position.set(cx, 1.05, seatZ - 0.22);
  chairBack.rotation.x = -0.06;
  scene.add(chairBack);
  const chairPiping = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.55, 0.04, 0.04), goldMat);
  chairPiping.position.set(cx, 1.48, seatZ - 0.22);
  scene.add(chairPiping);

  // ── Receptionist (seated humanoid) ───────────────────────────
  const receptionist = new rt.THREE.Group();
  const uniformMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a3555, roughness: 0.7, metalness: 0.05 });
  const skinMat = new rt.THREE.MeshStandardMaterial({ color: 0xe8d5c0, roughness: 0.8 });
  const darkMat = new rt.THREE.MeshStandardMaterial({ color: 0x141820, roughness: 0.85 });
  const trouserMat = new rt.THREE.MeshStandardMaterial({ color: 0x141820, roughness: 0.85 });

  // Torso + tie accent
  const rTorso = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, 0.6, 0.3), uniformMat);
  rTorso.position.y = 1.05; receptionist.add(rTorso);
  const rTieMat = new rt.THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.35, metalness: 0.5 });
  applyPBR(rTieMat, 'trim'); // receptionist gold tie accent — trim
  const rTie = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(0.06, 0.32, 0.02),
    rTieMat,
  );
  rTie.position.set(0, 1.07, 0.16); receptionist.add(rTie);

  // Pants + sitting legs (flexed -1.5 rad like every other seated worker)
  const rPants = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, 0.2, 0.3), trouserMat);
  rPants.position.y = 0.7; receptionist.add(rPants);
  const legGeo = new rt.THREE.CapsuleGeometry(0.07, 0.5, 4, 8);
  const shoeGeo = new rt.THREE.BoxGeometry(0.1, 0.06, 0.18);
  const shoeMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
  for (const side of [-1, 1]) {
    const legPivot = new rt.THREE.Group();
    legPivot.position.set(side * 0.12, 0.62, 0);
    legPivot.rotation.x = -1.5;
    const leg = new rt.THREE.Mesh(legGeo, trouserMat);
    leg.position.y = -0.3; legPivot.add(leg);
    const shoe = new rt.THREE.Mesh(shoeGeo, shoeMat);
    shoe.position.set(0, -0.56, 0.03); legPivot.add(shoe);
    receptionist.add(legPivot);
  }

  // Neck + head + hair
  const rNeck = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.06, 0.08, 0.15, 6), skinMat);
  rNeck.position.y = 1.38; receptionist.add(rNeck);
  const rHeadGeo = new rt.THREE.SphereGeometry(0.18, 10, 10);
  rHeadGeo.scale(1, 1.08, 1);
  const rHead = new rt.THREE.Mesh(rHeadGeo, skinMat);
  rHead.position.y = 1.55; receptionist.add(rHead);
  const rHair = new rt.THREE.Mesh(
    new rt.THREE.SphereGeometry(0.2, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.65),
    darkMat,
  );
  rHair.position.y = 1.58; receptionist.add(rHair);
  // Eyes (head-local)
  const eyeGeo = new rt.THREE.SphereGeometry(0.022, 5, 5);
  const eyeMat = new rt.THREE.MeshBasicMaterial({ color: 0x1a1a1a });
  const lEye = new rt.THREE.Mesh(eyeGeo, eyeMat); lEye.position.set(-0.06, 0.02, 0.155); rHead.add(lEye);
  const rEye = new rt.THREE.Mesh(eyeGeo, eyeMat); rEye.position.set( 0.06, 0.02, 0.155); rHead.add(rEye);

  // Brass name tag on the chest
  const tagMat = new rt.THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.3, metalness: 0.7 });
  applyPBR(tagMat, 'trim'); // brass name tag — trim
  const tag = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(0.18, 0.05, 0.02),
    tagMat,
  );
  tag.position.set(0.14, 1.2, 0.16); receptionist.add(tag);

  // Arms — upper arm resting forward (as if hands on counter), forearm reaching
  // toward the counter top.
  const armMat = new rt.THREE.MeshStandardMaterial({ color: 0x264366, roughness: 0.7 });
  for (const side of [-1, 1]) {
    const shoulder = new rt.THREE.Mesh(new rt.THREE.CapsuleGeometry(0.06, 0.35, 4, 8), armMat);
    shoulder.position.set(side * 0.3, 1.12, 0.05);
    shoulder.rotation.z = side * 0.1;
    receptionist.add(shoulder);
    const fore = new rt.THREE.Mesh(new rt.THREE.CapsuleGeometry(0.05, 0.32, 4, 8), skinMat);
    fore.position.set(side * 0.35, 0.95, 0.2);
    fore.rotation.x = Math.PI / 2;
    receptionist.add(fore);
  }

  // Seated on the chair behind the counter — group y=0 so feet rest where
  // shoe boxes naturally fall.
  receptionist.position.set(cx, 0, seatZ);
  receptionist.rotation.y = 0; // facing +Z (south) toward the main entrance
  scene.add(receptionist);

  // ─────────────────────────────────────────────────────────────
  // ── Luxury / glamour layer ──
  // Pendant chandelier, velvet rope stanchions, marble floor inlay, counter
  // ornament + flowers, wall sconces flanking the video wall. None of these
  // are functional, all are emissive-aware so they look right under bloom.
  // ─────────────────────────────────────────────────────────────

  // ── Crystal pendant chandelier above the counter ──
  // Chain runs from ceiling to a chrome stem, ending in a fluted gold sphere
  // and a ring of tear-drop crystals.
  const chainMat = new rt.THREE.MeshStandardMaterial({ color: 0x4a3a14, roughness: 0.45, metalness: 0.7 });
  applyPBR(chainMat, 'trim'); // chandelier gold chain — accent trim
  const chain = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.014, 0.014, 1.4, 6), chainMat);
  chain.position.set(cx, WALL_H - 0.7, counterZ);
  scene.add(chain);
  const chandBody = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.18, 14, 10), goldMat);
  chandBody.position.set(cx, WALL_H - 1.45, counterZ);
  scene.add(chandBody);
  // Glowing core
  const chandGlow = new rt.THREE.Mesh(
    new rt.THREE.SphereGeometry(0.1, 10, 8),
    new rt.THREE.MeshStandardMaterial({
      color: 0xffeec8, emissive: new rt.THREE.Color(0xffd28a), emissiveIntensity: 1.4,
      roughness: 0.2, metalness: 0.1,
    }),
  );
  chandGlow.position.set(cx, WALL_H - 1.45, counterZ);
  scene.add(chandGlow);
  // 8 crystal tear-drops hanging from the body
  const crystalMat = new rt.THREE.MeshStandardMaterial({
    color: 0xffe4a0, transparent: true, opacity: 0.85,
    roughness: 0.05, metalness: 0.1,
    emissive: new rt.THREE.Color(0xffd28a), emissiveIntensity: 0.3,
  });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const cr = new rt.THREE.Mesh(new rt.THREE.ConeGeometry(0.04, 0.13, 6), crystalMat);
    cr.position.set(cx + Math.cos(a) * 0.22, WALL_H - 1.62, counterZ + Math.sin(a) * 0.22);
    cr.rotation.x = Math.PI; // tip pointing DOWN
    scene.add(cr);
  }

  // ── Velvet rope stanchions flanking the front of the counter ──
  // Two short brass posts ~1.8u apart, joined by a maroon velvet rope sag.
  const ropeMat = new rt.THREE.MeshStandardMaterial({ color: 0x5a0e1a, roughness: 0.95, metalness: 0.0 });
  const stanchionXs = [cx - counterW / 2 + 1.2, cx + counterW / 2 - 1.2];
  const stanchionZ = counterZ + counterD / 2 + 1.4;
  for (const sx of stanchionXs) {
    const post = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.045, 0.06, 0.85, 10), goldMat);
    post.position.set(sx, 0.425, stanchionZ);
    scene.add(post);
    // Domed cap
    const cap = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.07, 10, 8), goldMat);
    cap.position.set(sx, 0.87, stanchionZ);
    scene.add(cap);
    // Square base
    const base = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.11, 0.13, 0.05, 12), goldMat);
    base.position.set(sx, 0.025, stanchionZ);
    scene.add(base);
  }
  // Velvet rope between the two posts (slight sag via Y position lower than caps)
  const ropeLen = stanchionXs[1] - stanchionXs[0];
  const rope = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.025, 0.025, ropeLen, 8), ropeMat);
  rope.position.set(cx, 0.78, stanchionZ);
  rope.rotation.z = Math.PI / 2;
  scene.add(rope);

  // ── Gold inlay strip on the marble floor in front of the counter ──
  const floorInlay = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(counterW + 0.4, 0.005, 0.08),
    goldMat,
  );
  floorInlay.position.set(cx, 0.003, counterZ + counterD / 2 + 0.7);
  scene.add(floorInlay);
  // A second, shorter parallel strip — double-line gives a designer feel.
  const floorInlay2 = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(counterW + 0.4, 0.005, 0.04),
    goldMat,
  );
  floorInlay2.position.set(cx, 0.003, counterZ + counterD / 2 + 0.95);
  scene.add(floorInlay2);

  // ── Tall ornamental vase + sculpted flowers on the counter top ──
  // Off-centered so it doesn't block the bell. Black marble base with gold trim.
  const vaseX = cx + counterW / 2 - 1.8;
  const vaseBaseMat = new rt.THREE.MeshStandardMaterial({ color: 0x0a0e1a, roughness: 0.15, metalness: 0.4 });
  const vase = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.09, 0.13, 0.42, 14), vaseBaseMat);
  vase.position.set(vaseX, counterH + 0.31, counterZ);
  scene.add(vase);
  const vaseRim = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.095, 0.095, 0.025, 14), goldMat);
  vaseRim.position.set(vaseX, counterH + 0.52, counterZ);
  scene.add(vaseRim);
  // Bouquet: 4 small spheres at varying heights, warm petals
  const petalMat = new rt.THREE.MeshStandardMaterial({
    color: 0xd8b25a, roughness: 0.75,
    emissive: new rt.THREE.Color(0x4a3a20), emissiveIntensity: 0.2,
  });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const petal = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.05 + Math.random() * 0.02, 8, 6), petalMat);
    petal.position.set(
      vaseX + Math.cos(a) * 0.05,
      counterH + 0.6 + Math.random() * 0.06,
      counterZ + Math.sin(a) * 0.05,
    );
    scene.add(petal);
  }
  // A single tall stem in the centre for height
  const stemMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a4a2a, roughness: 0.85 });
  const stem = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.008, 0.008, 0.22, 6), stemMat);
  stem.position.set(vaseX, counterH + 0.62, counterZ);
  scene.add(stem);

  // ── Wall sconces flanking the video wall (warm uplights) ──
  const sconceMat = new rt.THREE.MeshStandardMaterial({
    color: 0xb89648, roughness: 0.4, metalness: 0.6,
  });
  applyPBR(sconceMat, 'trim'); // gold wall sconce mounting plate — accent trim
  const sconceGlowMat = new rt.THREE.MeshStandardMaterial({
    color: 0xffeec8, emissive: new rt.THREE.Color(0xffd28a), emissiveIntensity: 1.2,
  });
  for (const dx of [-counterW / 2 - 0.6, counterW / 2 + 0.6]) {
    // Mounting plate
    const plate = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.12, 0.18, 0.04), sconceMat);
    plate.position.set(cx + dx, 1.95, backWallZ + 0.07);
    scene.add(plate);
    // Up-pointing cone of light
    const cone = new rt.THREE.Mesh(new rt.THREE.ConeGeometry(0.11, 0.22, 10, 1, true), sconceGlowMat);
    cone.position.set(cx + dx, 2.18, backWallZ + 0.13);
    scene.add(cone);
  }

  // ── Marble floor accent panel directly under the counter ──
  // Slightly raised polished marble inlay (visual platform for the counter).
  // polygonOffset pulls it toward the camera in depth space so it always wins
  // over the lobby marble slab it sits flush against (top face ~0.01u apart),
  // avoiding z-fighting under the counter when the camera pulls back.
  const platformMat = new rt.THREE.MeshStandardMaterial({
    color: 0x2a3555, roughness: 0.05, metalness: 0.4,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  const platform = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(counterW + 0.6, 0.04, counterD + WALL_GAP_BEHIND_COUNTER + 1.0),
    platformMat,
  );
  platform.position.set(cx, 0.02, counterZ - WALL_GAP_BEHIND_COUNTER / 2);
  scene.add(platform);

  return {
    // Drop point = centre of counter top (visible from both sides)
    dropPos: { x: cx, y: counterH + 0.2, z: counterZ },
    // Recipient walker stops on the INTERIOR side (north of counter)
    frontPos: { x: cx, y: 0, z: counterZ - counterD / 2 - 1.1 },
    // Delivery driver stops on the DOOR side (south of counter), facing the front
    driverFrontPos: { x: cx, y: 0, z: counterZ + counterD / 2 + 1.1 },
  };
}
