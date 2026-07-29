import { rt } from '../runtime.js';
import type { RoomInfo } from '../types.js';
import { WALL_H } from './_shared.js';
import { applyPBR, bakeVertexAO } from './_materials.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** Decorate the Communications office: pigeonhole mail wall,
 *  broadcast monitor bank, satellite dish, mail cart with envelopes, plus a
 *  ceiling banner so the room reads as a mission-control comms centre instead
 *  of a generic office. Desks are still laid out in the middle by buildDesks();
 *  everything here hugs the walls and corners so nothing clashes. */
export function buildCommunicationsOffice(scene: any, room: RoomInfo): void {
  const { cx, cz, w, d, color } = room;
  const dd = room.doorDir || (room.side === 1 ? 'top' : 'bottom');
  const accent = new rt.THREE.Color(color);

  // Identify each wall's inside face (X,Z of a point just inside the room on
  // that wall) and the outward normal so we can "hang" things against it.
  interface WallRef {
    id: 'top' | 'bottom' | 'left' | 'right';
    midX: number; midZ: number;
    /** Inward normal (points from wall toward room centre). */
    nx: number; nz: number;
    /** Available run length along the wall (minus side padding). */
    runX: number; runZ: number;
    /** Horizontal angle (around Y) so a prop faces toward the room centre. */
    faceY: number;
  }
  const sidePad = 1.0;
  const innerInset = 0.28; // keep props slightly off the wall panel
  const WALLS: Record<string, WallRef> = {
    top:    { id: 'top',    midX: cx,               midZ: cz + d / 2 - innerInset, nx: 0,  nz: -1, runX: w - sidePad * 2, runZ: 0,             faceY: Math.PI },
    bottom: { id: 'bottom', midX: cx,               midZ: cz - d / 2 + innerInset, nx: 0,  nz:  1, runX: w - sidePad * 2, runZ: 0,             faceY: 0 },
    left:   { id: 'left',   midX: cx - w / 2 + innerInset, midZ: cz,               nx: 1,  nz:  0, runX: 0,               runZ: d - sidePad * 2, faceY: Math.PI / 2 },
    right:  { id: 'right',  midX: cx + w / 2 - innerInset, midZ: cz,               nx: -1, nz:  0, runX: 0,               runZ: d - sidePad * 2, faceY: -Math.PI / 2 },
  };
  const OPPOSITE: Record<string, 'top' | 'bottom' | 'left' | 'right'> = {
    top: 'bottom', bottom: 'top', left: 'right', right: 'left',
  };
  const farWall = WALLS[OPPOSITE[dd]];
  const sideWallIds: Array<'top' | 'bottom' | 'left' | 'right'> =
    (['top', 'bottom', 'left', 'right'] as const).filter(x => x !== dd && x !== OPPOSITE[dd]);
  const monitorWall = WALLS[sideWallIds[0]];

  // ── 1. PIGEONHOLE MAIL WALL — grid of cubbies against the far wall ──
  const wallLen = farWall.id === 'top' || farWall.id === 'bottom' ? w : d;
  const usableLen = Math.max(2, wallLen - 2.2);
  const cubbyW = 0.42, cubbyH = 0.32, cubbyD = 0.3;
  const cols = Math.max(4, Math.floor(usableLen / cubbyW));
  const rows = 4;
  const rackW = cols * cubbyW;
  const rackH = rows * cubbyH;
  const rackBaseY = 0.95; // pigeonholes mounted chest-high
  const rackMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a2218, roughness: 0.75, metalness: 0.05 });
  const divMat  = new rt.THREE.MeshStandardMaterial({ color: 0x4a3a22, roughness: 0.7,  metalness: 0.1 });
  const envMat  = new rt.THREE.MeshStandardMaterial({ color: 0xe8dfc0, roughness: 0.9 });
  const envAccentMat = new rt.THREE.MeshStandardMaterial({ color: accent.clone().lerp(new rt.THREE.Color(0xffffff), 0.35), roughness: 0.8 });
  const isX = farWall.id === 'top' || farWall.id === 'bottom';

  // Backing panel
  const backingGeo = isX
    ? new rt.THREE.BoxGeometry(rackW + 0.12, rackH + 0.12, 0.06)
    : new rt.THREE.BoxGeometry(0.06, rackH + 0.12, rackW + 0.12);
  const backing = new rt.THREE.Mesh(backingGeo, rackMat);
  backing.position.set(farWall.midX, rackBaseY + rackH / 2, farWall.midZ);
  scene.add(backing);

  // Horizontal shelves (rows+1)
  for (let r = 0; r <= rows; r++) {
    const y = rackBaseY + r * cubbyH;
    const shelfGeo = isX
      ? new rt.THREE.BoxGeometry(rackW + 0.08, 0.035, cubbyD)
      : new rt.THREE.BoxGeometry(cubbyD, 0.035, rackW + 0.08);
    const shelf = new rt.THREE.Mesh(shelfGeo, divMat);
    shelf.position.set(
      farWall.midX + (isX ? 0 : farWall.nx * cubbyD / 2),
      y,
      farWall.midZ + (isX ? farWall.nz * cubbyD / 2 : 0),
    );
    scene.add(shelf);
  }
  // Vertical dividers (cols+1)
  for (let c = 0; c <= cols; c++) {
    const off = -rackW / 2 + c * cubbyW;
    const divGeo = isX
      ? new rt.THREE.BoxGeometry(0.03, rackH, cubbyD)
      : new rt.THREE.BoxGeometry(cubbyD, rackH, 0.03);
    const divv = new rt.THREE.Mesh(divGeo, divMat);
    divv.position.set(
      farWall.midX + (isX ? off : farWall.nx * cubbyD / 2),
      rackBaseY + rackH / 2,
      farWall.midZ + (isX ? farWall.nz * cubbyD / 2 : off),
    );
    scene.add(divv);
  }

  // Envelopes tucked into ~55% of the cubbies at varied angles
  const envHash = (c: number, r: number) => ((c * 73856093) ^ (r * 19349663)) & 0xffff;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = envHash(c, r);
      if ((h % 100) > 55) continue;
      const off = -rackW / 2 + (c + 0.5) * cubbyW;
      const y = rackBaseY + r * cubbyH + cubbyH * 0.45;
      const depthOff = cubbyD * 0.55;
      const tilt = ((h >> 4) % 7 - 3) * 0.08;
      const mat = ((h >> 8) % 5 === 0) ? envAccentMat : envMat;
      const env = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(cubbyW * 0.82, cubbyH * 0.65, 0.02), mat);
      env.position.set(
        farWall.midX + (isX ? off : farWall.nx * depthOff),
        y,
        farWall.midZ + (isX ? farWall.nz * depthOff : off),
      );
      env.rotation.y = farWall.faceY + tilt;
      scene.add(env);
    }
  }

  // Small top-shelf label plaque
  const plaqueMat = new rt.THREE.MeshStandardMaterial({
    color: 0x0a0d18, emissive: accent.clone().multiplyScalar(0.4), emissiveIntensity: 0.5, roughness: 0.3,
  });
  const plaqueGeo = isX
    ? new rt.THREE.BoxGeometry(Math.min(2.2, rackW * 0.45), 0.22, 0.04)
    : new rt.THREE.BoxGeometry(0.04, 0.22, Math.min(2.2, rackW * 0.45));
  const plaque = new rt.THREE.Mesh(plaqueGeo, plaqueMat);
  plaque.position.set(
    farWall.midX + (isX ? 0 : farWall.nx * 0.08),
    rackBaseY + rackH + 0.22,
    farWall.midZ + (isX ? farWall.nz * 0.08 : 0),
  );
  scene.add(plaque);

  // ── 2. BROADCAST MONITOR BANK on the side wall ──
  const monWallLen = monitorWall.id === 'top' || monitorWall.id === 'bottom' ? w : d;
  const monIsX = monitorWall.id === 'top' || monitorWall.id === 'bottom';
  const monCount = 3;
  const monW = 1.1, monH = 0.7, monSpacing = 1.35;
  const bankLen = monCount * monSpacing;
  if (monWallLen > bankLen + 1.5) {
    const bankMat = new rt.THREE.MeshStandardMaterial({ color: 0x151a28, roughness: 0.6, metalness: 0.2 });
    applyPBR(bankMat, 'plastic'); // monitor bank casing/frame — dark matte housing
    // Prominent camera-facing console casing → subtle bevel (segments=2,
    // radius bounded by the 0.1 depth so the chamfer never self-intersects).
    const bankGeo = monIsX
      ? new RoundedBoxGeometry(bankLen + 0.4, monH + 0.4, 0.1, 2, 0.03)
      : new RoundedBoxGeometry(0.1, monH + 0.4, bankLen + 0.4, 2, 0.03);
    const bank = new rt.THREE.Mesh(bankGeo, bankMat);
    bank.position.set(monitorWall.midX, 2.0, monitorWall.midZ);
    scene.add(bank);

    // 3 monitors with varied emissive tints (blue news / green ticker / red alert)
    const tints = [0x1e6bff, 0x22cc66, 0xff4a3a];
    for (let i = 0; i < monCount; i++) {
      const off = -((monCount - 1) / 2) * monSpacing + i * monSpacing;
      const screenMat = new rt.THREE.MeshStandardMaterial({
        color: 0x050810, emissive: new rt.THREE.Color(tints[i]), emissiveIntensity: 0.55, roughness: 0.15,
      });
      applyPBR(screenMat, 'screen'); // broadcast monitor screen surface (emissive)
      const screen = new rt.THREE.Mesh(
        monIsX ? new rt.THREE.BoxGeometry(monW, monH, 0.04) : new rt.THREE.BoxGeometry(0.04, monH, monW),
        screenMat,
      );
      screen.position.set(
        monitorWall.midX + (monIsX ? off : monitorWall.nx * 0.08),
        2.0,
        monitorWall.midZ + (monIsX ? monitorWall.nz * 0.08 : off),
      );
      scene.add(screen);
      // Ticker strip along the bottom of each monitor
      const tickerMat = new rt.THREE.MeshBasicMaterial({ color: tints[i], transparent: true, opacity: 0.85 });
      const ticker = new rt.THREE.Mesh(
        monIsX ? new rt.THREE.BoxGeometry(monW * 0.95, 0.07, 0.045) : new rt.THREE.BoxGeometry(0.045, 0.07, monW * 0.95),
        tickerMat,
      );
      ticker.position.set(
        monitorWall.midX + (monIsX ? off : monitorWall.nx * 0.09),
        2.0 - monH / 2 + 0.08,
        monitorWall.midZ + (monIsX ? monitorWall.nz * 0.09 : off),
      );
      scene.add(ticker);
    }
  }

  // ── 3. SATELLITE DISH on a pole — corner near the door-side wall ──
  const doorWall = WALLS[dd];
  const otherSide = WALLS[sideWallIds[1]];
  const dishX = (doorWall.id === 'left' || doorWall.id === 'right')
    ? doorWall.midX + doorWall.nx * 1.2
    : otherSide.midX + otherSide.nx * 1.2;
  const dishZ = (doorWall.id === 'top' || doorWall.id === 'bottom')
    ? doorWall.midZ + doorWall.nz * 1.2
    : otherSide.midZ + otherSide.nz * 1.2;
  const poleMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a2d3a, roughness: 0.4, metalness: 0.5 });
  applyPBR(poleMat, 'metal'); // satellite dish pole/base/horn — structural metal
  const dishMat = new rt.THREE.MeshStandardMaterial({ color: 0xcfd4dd, roughness: 0.35, metalness: 0.6, side: 2 });
  applyPBR(dishMat, 'metal'); // satellite dish — structural metal
  const dishBase = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.22, 0.28, 0.08, 12), poleMat);
  dishBase.position.set(dishX, 0.04, dishZ);
  scene.add(dishBase);
  const dishPole = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.045, 0.045, 2.1, 8), poleMat);
  dishPole.position.set(dishX, 1.1, dishZ);
  scene.add(dishPole);
  const dish = new rt.THREE.Mesh(
    new rt.THREE.SphereGeometry(0.55, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2.8),
    dishMat,
  );
  dish.position.set(dishX, 2.15, dishZ);
  dish.rotation.x = Math.PI;          // open face upward/outward
  dish.rotation.z = 0.45;              // tilt toward the ceiling
  dish.rotation.y = Math.atan2(cx - dishX, cz - dishZ); // aim at room centre
  scene.add(dish);
  // Feed horn at the focal point of the dish
  const horn = new rt.THREE.Mesh(new rt.THREE.ConeGeometry(0.08, 0.25, 8), poleMat);
  horn.position.set(dishX, 2.05, dishZ);
  horn.rotation.x = Math.PI;
  scene.add(horn);
  // Blinking antenna tip (emissive so it pulses in the bloom pass)
  const blink = new rt.THREE.Mesh(
    new rt.THREE.SphereGeometry(0.06, 8, 6),
    new rt.THREE.MeshBasicMaterial({ color: 0xff3322 }),
  );
  blink.position.set(dishX, 2.5, dishZ);
  scene.add(blink);

  // ── 4. MAIL CART in the OPPOSITE near-door corner from the dish (dish sits
  //     on the otherSide wall, cart sits on the monitorWall side). ──
  const cartX = (doorWall.id === 'left' || doorWall.id === 'right')
    ? doorWall.midX + doorWall.nx * 1.4
    : monitorWall.midX + monitorWall.nx * 1.4;
  const cartZ = (doorWall.id === 'top' || doorWall.id === 'bottom')
    ? doorWall.midZ + doorWall.nz * 1.4
    : monitorWall.midZ + monitorWall.nz * 1.4;
  // Guard against the rare case where a very narrow room puts them too close.
  const cartFarEnough = (cartX - dishX) ** 2 + (cartZ - dishZ) ** 2 > 4;
  if (cartFarEnough) {
    const cartFrameMat = new rt.THREE.MeshStandardMaterial({ color: 0x8c8f9a, roughness: 0.55, metalness: 0.4 });
    applyPBR(cartFrameMat, 'metal'); // mail cart frame/rim/handle — structural metal
    const basketMat = new rt.THREE.MeshStandardMaterial({ color: 0x6a4a22, roughness: 0.8 });
    // Basket body — grounded solid prop. Bevel the hard box edges (segments=2)
    // and bake contact-shadow AO at its local bottom. basketMat is dedicated to
    // this single mesh, so enabling vertexColors is safe (no shared geometry).
    const basketGeo = new RoundedBoxGeometry(1.0, 0.45, 0.7, 2, 0.02);
    bakeVertexAO(basketGeo, { floorY: -0.225, reach: 0.16, strength: 0.35 });
    basketMat.vertexColors = true; basketMat.needsUpdate = true;
    const basket = new rt.THREE.Mesh(basketGeo, basketMat);
    basket.position.set(cartX, 0.65, cartZ);
    scene.add(basket);
    // Basket top rim
    const rim = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.05, 0.06, 0.75), cartFrameMat);
    rim.position.set(cartX, 0.9, cartZ);
    scene.add(rim);
    // 4 small wheels
    const wheelMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.8 });
    for (const sx of [-0.4, 0.4]) for (const sz of [-0.28, 0.28]) {
      const wheel = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.11, 0.11, 0.06, 10), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(cartX + sx, 0.11, cartZ + sz);
      scene.add(wheel);
    }
    // Push handle (vertical post + cross bar)
    const handlePost = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.025, 0.025, 0.75, 6), cartFrameMat);
    handlePost.position.set(cartX - 0.45, 1.22, cartZ);
    scene.add(handlePost);
    const handleBar = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.025, 0.025, 0.55, 6), cartFrameMat);
    handleBar.rotation.x = Math.PI / 2;
    handleBar.position.set(cartX - 0.45, 1.6, cartZ);
    scene.add(handleBar);
    // Pile of envelopes poking out of the basket
    for (let i = 0; i < 6; i++) {
      const h2 = envHash(99 + i, i * 7);
      const ex = cartX + (((h2 % 100) / 100) - 0.5) * 0.7;
      const ez = cartZ + ((((h2 >> 6) % 100) / 100) - 0.5) * 0.45;
      const ey = 0.92 + ((h2 >> 12) % 5) * 0.025;
      const rot = (((h2 >> 4) % 100) / 100) * Math.PI;
      const mat = ((h2 >> 3) % 4 === 0) ? envAccentMat : envMat;
      const env = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.3, 0.02, 0.2), mat);
      env.position.set(ex, ey, ez);
      env.rotation.y = rot;
      env.rotation.z = (((h2 >> 2) % 7 - 3) * 0.04);
      scene.add(env);
    }
  }

  // ── 5. Accent ceiling tint — a low-power coloured wash so the room glows
  //     in the flow colour from outside the door. ──
  const accentLight = new rt.THREE.PointLight(accent.getHex(), 0.35, Math.max(w, d) * 0.9);
  accentLight.position.set(cx, WALL_H - 0.4, cz);
  accentLight.decay = 2;
  accentLight.matrixAutoUpdate = false; accentLight.updateMatrix();
  scene.add(accentLight);
}
