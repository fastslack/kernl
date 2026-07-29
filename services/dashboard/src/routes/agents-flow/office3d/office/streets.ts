import type { CorridorGrid } from '../floor-plan.js';
import { rt } from '../runtime.js';
import { CORRIDOR_CARPET } from './_shared.js';
import { applyPBR, bakeVertexAO } from './_materials.js';
import { applyWorldTexture, scaleUV } from '../textures.js';

/**
 * Realistic streetscape with a single front-entrance staircase.
 *
 * Elevation model:
 *   Building floor  = y=0
 *   Sidewalk top    = y=0  (flush with the building)
 *   Street asphalt  = y=-STREET_DROP (a bit below — creates the curb)
 *
 * Only the SOUTH side (+Z) has a staircase from sidewalk → street. The other
 * three sides are sealed with a retaining wall + coping strip, so agents
 * walking out would visually be on an island above the road.
 *
 * Details: slab joints on the sidewalk, zebra crosswalk at the foot of the
 * stairs, railings on the steps, planters flanking the entrance, 4 corner
 * street lamps with warm point-lights.
 */
export function buildStreets(
  scene: any,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  entrance?: { cx: number; width: number },
) {
  const PLINTH_W   = 5.0;        // raised plinth around the building ("cantero")
  const PED_W      = 5.5;        // pedestrian sidewalk at street level (wider for breathing room)
  const STREET_W   = 12;         // asphalt lane-pair width
  const PLINTH_DROP = 0.7;       // drop from plinth top (y=0) to pedestrian sidewalk (y=-0.7)
  const CURB_H     = 0.2;        // pedestrian sidewalk above asphalt → street-side curb
  const STREET_DROP = PLINTH_DROP + CURB_H; // 0.9 — plinth top to asphalt
  const COPING_H   = 0.12;       // top lip of the plinth retaining wall
  // Staircase width defaults to a wide entrance; when an `entrance` hint is
  // provided (e.g. central hall width), expand to match so the stair reads
  // as the natural extension of the hall.
  const STAIR_W    = entrance?.width ? Math.max(7.5, entrance.width) : 7.5;
  const STAIR_STEPS = 5;         // number of steps
  const STEP_RUN   = 0.55;       // horizontal depth per step
  const STEP_RISE  = PLINTH_DROP / STAIR_STEPS;

  const { minX, maxX, minZ, maxZ } = bounds;
  // Plinth ring (around building, at y=0)
  const plinthOuterX0 = minX - PLINTH_W;
  const plinthOuterX1 = maxX + PLINTH_W;
  const plinthOuterZ0 = minZ - PLINTH_W;
  const plinthOuterZ1 = maxZ + PLINTH_W;
  // Pedestrian sidewalk ring (around plinth, at y=-PLINTH_DROP)
  const pedOuterX0 = plinthOuterX0 - PED_W;
  const pedOuterX1 = plinthOuterX1 + PED_W;
  const pedOuterZ0 = plinthOuterZ0 - PED_W;
  const pedOuterZ1 = plinthOuterZ1 + PED_W;
  // Asphalt / street (beyond pedestrian sidewalk, at y=-STREET_DROP)
  const streetOuterX0 = pedOuterX0 - STREET_W;
  const streetOuterX1 = pedOuterX1 + STREET_W;
  const streetOuterZ0 = pedOuterZ0 - STREET_W;
  const streetOuterZ1 = pedOuterZ1 + STREET_W;

  // South (+Z) entrance — staircase centered on either the hall (when hint
  // supplied) or the building midpoint. Clamp to the plinth footprint so the
  // railings/cheeks never overshoot the corners.
  const rawEntryCX = entrance?.cx ?? (plinthOuterX0 + plinthOuterX1) / 2;
  const halfStair = STAIR_W / 2;
  const entryCX = Math.max(
    plinthOuterX0 + halfStair + 0.25,
    Math.min(plinthOuterX1 - halfStair - 0.25, rawEntryCX),
  );
  const entryX0 = entryCX - halfStair;
  const entryX1 = entryCX + halfStair;

  // ── Materials ─────────────────────────────────────
  const asphaltMat = new rt.THREE.MeshStandardMaterial({
    color: 0x14151c, roughness: 0.96, metalness: 0,
  });
  // Plinth deck (around building, same elevation as floor)
  const plinthMat = new rt.THREE.MeshStandardMaterial({
    color: 0x5a5f6c, roughness: 0.88, metalness: 0.03,
  });
  // Pedestrian sidewalk — real street-level walkway
  const pedSidewalkMat = new rt.THREE.MeshStandardMaterial({
    color: 0x787d87, roughness: 0.9, metalness: 0.02,
  });
  const sidewalkJointMat = new rt.THREE.MeshStandardMaterial({
    color: 0x3a3d44, roughness: 0.95, metalness: 0,
  });
  // Curb (raised lip between pedestrian sidewalk and asphalt)
  const curbMat = new rt.THREE.MeshStandardMaterial({
    color: 0xa8adb5, roughness: 0.85, metalness: 0.04,
  });
  const wallMat = new rt.THREE.MeshStandardMaterial({
    color: 0x3d4250, roughness: 0.9, metalness: 0.02,
  });
  const copingMat = new rt.THREE.MeshStandardMaterial({
    color: 0x9aa0ac, roughness: 0.8, metalness: 0.05,
  });
  const stepTreadMat = new rt.THREE.MeshStandardMaterial({
    color: 0x7a8090, roughness: 0.82, metalness: 0.04,
  });
  const stepRiserMat = new rt.THREE.MeshStandardMaterial({
    color: 0x4a4e58, roughness: 0.9, metalness: 0.02,
  });
  const dashMat = new rt.THREE.MeshStandardMaterial({
    color: 0xf4c440, roughness: 0.55, metalness: 0.05,
    emissive: 0x6a4e10, emissiveIntensity: 0.18,
  });
  const zebraMat = new rt.THREE.MeshStandardMaterial({
    color: 0xe8e8ea, roughness: 0.7, metalness: 0,
    emissive: 0x222222, emissiveIntensity: 0.05,
  });
  const railingMat = new rt.THREE.MeshStandardMaterial({
    color: 0x1f2230, roughness: 0.4, metalness: 0.75,
  });
  const planterMat = new rt.THREE.MeshStandardMaterial({
    color: 0x2e2a26, roughness: 0.88, metalness: 0,
  });
  const foliageMat = new rt.THREE.MeshStandardMaterial({
    color: 0x3d5a3a, roughness: 0.85, metalness: 0,
  });

  // ── PBR roles for large/structural surfaces (color unchanged) ──
  applyPBR(asphaltMat, 'asphalt');
  applyPBR(plinthMat, 'concrete');
  applyPBR(pedSidewalkMat, 'concrete');
  applyPBR(curbMat, 'concrete');
  applyPBR(copingMat, 'concrete');
  // ── PBR roles for street props (color unchanged) ──
  applyPBR(stepTreadMat, 'concrete');   // step treads read as poured concrete
  applyPBR(stepRiserMat, 'concrete');   // step risers
  applyPBR(railingMat, 'metal');        // steel stair railing posts + top rail
  applyPBR(planterMat, 'concrete');     // planter pot is a concrete/stone vessel
  applyPBR(foliageMat, 'cloth');        // diffuse, non-metal foliage

  // ── Procedural surface detail (map + normalMap, generated once) ──
  applyWorldTexture(asphaltMat, 'asphalt');
  applyWorldTexture(plinthMat, 'concrete');
  applyWorldTexture(pedSidewalkMat, 'concrete');
  applyWorldTexture(curbMat, 'concrete');
  applyWorldTexture(copingMat, 'concrete');
  applyWorldTexture(stepTreadMat, 'concrete');

  // ── Asphalt pad (y below sidewalk) ────────────────
  const padW = streetOuterX1 - streetOuterX0;
  const padD = streetOuterZ1 - streetOuterZ0;
  const padGeo = new rt.THREE.PlaneGeometry(padW, padD);
  scaleUV(padGeo, padW / 14, padD / 14); // 1 asphalt tile ≈ 14u — repeat invisible at street scale
  const pad = new rt.THREE.Mesh(padGeo, asphaltMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set((streetOuterX0 + streetOuterX1) / 2, -STREET_DROP, (streetOuterZ0 + streetOuterZ1) / 2);
  pad.receiveShadow = true;
  scene.add(pad);

  // ── Sidewalk ring (flush with building floor) ─────
  const addPlane = (x0: number, z0: number, x1: number, z1: number, y: number, mat: any) => {
    const w = Math.abs(x1 - x0), d = Math.abs(z1 - z0);
    if (w < 0.01 || d < 0.01) return;
    const g = new rt.THREE.PlaneGeometry(w, d);
    scaleUV(g, w / 8, d / 8); // constant concrete texel density across ring slabs
    const m = new rt.THREE.Mesh(g, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.receiveShadow = true;
    scene.add(m);
  };
  // ── Plinth deck (top of the "cantero", flush with building floor) ──
  addPlane(plinthOuterX0, plinthOuterZ0, plinthOuterX1, minZ, -0.01, plinthMat); // N
  addPlane(plinthOuterX0, maxZ, plinthOuterX1, plinthOuterZ1, -0.01, plinthMat); // S
  addPlane(plinthOuterX0, minZ, minX, maxZ, -0.01, plinthMat);                   // W
  addPlane(maxX, minZ, plinthOuterX1, maxZ, -0.01, plinthMat);                   // E

  // Plinth slab joint lines — thin dark strips every ~1.8u.
  const SLAB = 1.8;
  const addJointH = (z: number, x0: number, x1: number, y: number) =>
    addPlane(x0, z - 0.02, x1, z + 0.02, y, sidewalkJointMat);
  const addJointV = (x: number, z0: number, z1: number, y: number) =>
    addPlane(x - 0.02, z0, x + 0.02, z1, y, sidewalkJointMat);
  for (let x = plinthOuterX0 + SLAB; x < plinthOuterX1; x += SLAB) {
    addJointV(x, plinthOuterZ0, minZ, 0.005);
    addJointV(x, maxZ, plinthOuterZ1, 0.005);
  }
  for (let z = minZ + SLAB; z < maxZ; z += SLAB) {
    addJointH(z, plinthOuterX0, minX, 0.005);
    addJointH(z, maxX, plinthOuterX1, 0.005);
  }
  // Outer edge lines on the plinth for definition
  addJointH(plinthOuterZ0, plinthOuterX0, plinthOuterX1, 0.005);
  addJointH(plinthOuterZ1, plinthOuterX0, plinthOuterX1, 0.005);
  addJointV(plinthOuterX0, plinthOuterZ0, plinthOuterZ1, 0.005);
  addJointV(plinthOuterX1, plinthOuterZ0, plinthOuterZ1, 0.005);

  // ── Pedestrian sidewalk ring (at street level, between plinth and asphalt) ──
  const PED_Y = -PLINTH_DROP + 0.005; // just above the curb top
  addPlane(pedOuterX0, pedOuterZ0, pedOuterX1, plinthOuterZ0, PED_Y, pedSidewalkMat); // N
  addPlane(pedOuterX0, plinthOuterZ1, pedOuterX1, pedOuterZ1, PED_Y, pedSidewalkMat); // S
  addPlane(pedOuterX0, plinthOuterZ0, plinthOuterX0, plinthOuterZ1, PED_Y, pedSidewalkMat); // W
  addPlane(plinthOuterX1, plinthOuterZ0, pedOuterX1, plinthOuterZ1, PED_Y, pedSidewalkMat); // E

  // Pedestrian sidewalk joints (thicker grid — real sidewalks have bigger slabs)
  const PED_SLAB = 2.2;
  for (let x = pedOuterX0 + PED_SLAB; x < pedOuterX1; x += PED_SLAB) {
    addJointV(x, pedOuterZ0, plinthOuterZ0, PED_Y + 0.005);
    addJointV(x, plinthOuterZ1, pedOuterZ1, PED_Y + 0.005);
  }
  for (let z = plinthOuterZ0 + PED_SLAB; z < plinthOuterZ1; z += PED_SLAB) {
    addJointH(z, pedOuterX0, plinthOuterX0, PED_Y + 0.005);
    addJointH(z, plinthOuterX1, pedOuterX1, PED_Y + 0.005);
  }
  // Outer/inner edge lines
  addJointH(pedOuterZ0, pedOuterX0, pedOuterX1, PED_Y + 0.005);
  addJointH(pedOuterZ1, pedOuterX0, pedOuterX1, PED_Y + 0.005);
  addJointV(pedOuterX0, pedOuterZ0, pedOuterZ1, PED_Y + 0.005);
  addJointV(pedOuterX1, pedOuterZ0, pedOuterZ1, PED_Y + 0.005);

  // ── Curb (raised concrete lip between pedestrian sidewalk and asphalt) ──
  // A continuous BoxGeometry around the full perimeter of the pedestrian ring,
  // with its top flush with the sidewalk (y = -PLINTH_DROP) and bottom at the
  // asphalt level (y = -STREET_DROP).
  const curbY = -(PLINTH_DROP + CURB_H) / 2; // center = midpoint of curb thickness
  const curbBarH = CURB_H + 0.02;
  const addCurb = (cx: number, cz: number, w: number, d: number) => {
    const bar = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(w, curbBarH, d), curbMat);
    bar.position.set(cx, curbY, cz);
    bar.castShadow = true;
    bar.receiveShadow = true;
    scene.add(bar);
  };
  const CURB_T = 0.25; // curb thickness (x/z)
  const pedW = pedOuterX1 - pedOuterX0;
  const pedD = pedOuterZ1 - pedOuterZ0;
  // North
  addCurb((pedOuterX0 + pedOuterX1) / 2, pedOuterZ0 + CURB_T / 2, pedW, CURB_T);
  // South (split around the crosswalk — so the curb has a gap where the
  // pedestrians cross).
  {
    const cxLeftW = (entryCX - STAIR_W / 2 - 0.6) - pedOuterX0;
    const cxRightW = pedOuterX1 - (entryCX + STAIR_W / 2 + 0.6);
    if (cxLeftW > 0.1) {
      addCurb(pedOuterX0 + cxLeftW / 2, pedOuterZ1 - CURB_T / 2, cxLeftW, CURB_T);
    }
    if (cxRightW > 0.1) {
      addCurb(pedOuterX1 - cxRightW / 2, pedOuterZ1 - CURB_T / 2, cxRightW, CURB_T);
    }
  }
  // West + East
  addCurb(pedOuterX0 + CURB_T / 2, (pedOuterZ0 + pedOuterZ1) / 2, CURB_T, pedD);
  addCurb(pedOuterX1 - CURB_T / 2, (pedOuterZ0 + pedOuterZ1) / 2, CURB_T, pedD);

  // ── Plinth retaining wall (from plinth top y=0 down to pedestrian sidewalk y=-PLINTH_DROP) ──
  const addPlinthWall = (x: number, z: number, w: number, d: number) => {
    const h = PLINTH_DROP;
    const box = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(w, h, d), wallMat);
    box.position.set(x, -h / 2, z);
    box.castShadow = true;
    box.receiveShadow = true;
    scene.add(box);
    // Coping (light lip on top)
    const cop = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(w + 0.1, COPING_H, d + 0.1), copingMat);
    cop.position.set(x, COPING_H / 2 - 0.001, z);
    cop.castShadow = true;
    scene.add(cop);
  };
  // North (full)
  addPlinthWall((plinthOuterX0 + plinthOuterX1) / 2, plinthOuterZ0 - 0.15, plinthOuterX1 - plinthOuterX0, 0.3);
  // West (full)
  addPlinthWall(plinthOuterX0 - 0.15, (plinthOuterZ0 + plinthOuterZ1) / 2, 0.3, plinthOuterZ1 - plinthOuterZ0);
  // East (full)
  addPlinthWall(plinthOuterX1 + 0.15, (plinthOuterZ0 + plinthOuterZ1) / 2, 0.3, plinthOuterZ1 - plinthOuterZ0);
  // South — split around the entrance
  const southZ = plinthOuterZ1 + 0.15;
  const leftW  = entryX0 - plinthOuterX0;
  const rightW = plinthOuterX1 - entryX1;
  if (leftW > 0.1) addPlinthWall(plinthOuterX0 + leftW / 2, southZ, leftW, 0.3);
  if (rightW > 0.1) addPlinthWall(entryX1 + rightW / 2, southZ, rightW, 0.3);

  // ── Entrance staircase (plinth y=0 → pedestrian sidewalk y=-PLINTH_DROP) ──
  const stairFrontZ = plinthOuterZ1; // inner edge of stairs = plinth edge
  // Both stepTreadMat and stepRiserMat are dedicated to these step blocks only,
  // so vertex-color AO is safe (every geo using the mat is baked below).
  const TREAD_H = 0.06;
  stepTreadMat.vertexColors = true;
  stepRiserMat.vertexColors = true;
  for (let i = 0; i < STAIR_STEPS; i++) {
    const y = -(i + 1) * STEP_RISE;
    const z = stairFrontZ + (i + 0.5) * STEP_RUN;
    // Tread (horizontal) — grounded solid block; contact-shade its underside.
    const treadGeo = new rt.THREE.BoxGeometry(STAIR_W, TREAD_H, STEP_RUN);
    bakeVertexAO(treadGeo, { floorY: -TREAD_H / 2, reach: TREAD_H * 0.3, strength: 0.35 });
    const tread = new rt.THREE.Mesh(treadGeo, stepTreadMat);
    tread.position.set(entryCX, y + 0.03, z);
    tread.castShadow = true;
    tread.receiveShadow = true;
    scene.add(tread);
    // Riser (vertical face to the step above) — contact-shade its base.
    const riserGeo = new rt.THREE.BoxGeometry(STAIR_W, STEP_RISE, 0.04);
    bakeVertexAO(riserGeo, { floorY: -STEP_RISE / 2, reach: STEP_RISE * 0.3, strength: 0.35 });
    const riser = new rt.THREE.Mesh(riserGeo, stepRiserMat);
    riser.position.set(entryCX, y + STEP_RISE / 2, z - STEP_RUN / 2);
    riser.castShadow = true;
    scene.add(riser);
  }
  // Side cheek walls — short walls flanking the staircase, only down to the
  // pedestrian sidewalk level (not to the asphalt).
  const stairDepth = STAIR_STEPS * STEP_RUN;
  const cheekW = 0.25;
  for (const side of [-1, 1]) {
    const cheekCX = entryCX + side * (STAIR_W / 2 + cheekW / 2);
    const cheekCZ = stairFrontZ + stairDepth / 2;
    const cheek = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(cheekW, PLINTH_DROP, stairDepth),
      wallMat,
    );
    cheek.position.set(cheekCX, -PLINTH_DROP / 2, cheekCZ);
    cheek.castShadow = true;
    cheek.receiveShadow = true;
    scene.add(cheek);
    const cheekCop = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(cheekW + 0.06, COPING_H, stairDepth + 0.06),
      copingMat,
    );
    cheekCop.position.set(cheekCX, COPING_H / 2 - 0.001, cheekCZ);
    scene.add(cheekCop);
  }

  // ── Stair railings (posts + top rail each side) ──
  for (const side of [-1, 1]) {
    const railX = entryCX + side * (STAIR_W / 2 + 0.35);
    const postN = 3;
    for (let p = 0; p <= postN; p++) {
      const pt = p / postN;
      const z = stairFrontZ + pt * stairDepth;
      const y = -pt * PLINTH_DROP;
      const post = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.03, 0.03, 1.0, 8), railingMat);
      post.position.set(railX, y + 0.5, z);
      post.castShadow = false;
      scene.add(post);
    }
    // Top rail approximated as a tilted cylinder along the stair slope
    const railLen = Math.hypot(stairDepth, PLINTH_DROP) + 0.2;
    const rail = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.035, 0.035, railLen, 8), railingMat);
    rail.position.set(railX, -PLINTH_DROP / 2 + 0.95, stairFrontZ + stairDepth / 2);
    rail.rotation.x = Math.atan2(PLINTH_DROP, stairDepth);
    rail.castShadow = false;
    scene.add(rail);
  }

  // ── Planters flanking the top of the staircase (on the plinth) ──
  // planterMat is dedicated to the pots only → vertex-color AO is safe.
  const POT_H = 0.55;
  planterMat.vertexColors = true;
  for (const side of [-1, 1]) {
    const px = entryCX + side * (STAIR_W / 2 + 1.0);
    const pz = plinthOuterZ1 - 0.45;
    const potGeo = new rt.THREE.CylinderGeometry(0.45, 0.4, POT_H, 16);
    bakeVertexAO(potGeo, { floorY: -POT_H / 2, reach: POT_H * 0.3, strength: 0.35 });
    const pot = new rt.THREE.Mesh(potGeo, planterMat);
    pot.position.set(px, 0.275, pz);
    pot.castShadow = false;
    pot.receiveShadow = true;
    scene.add(pot);
    // Dirt top
    const dirt = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.42, 0.42, 0.04, 16),
      new rt.THREE.MeshStandardMaterial({ color: 0x2a1f17, roughness: 1 }));
    dirt.position.set(px, 0.57, pz);
    scene.add(dirt);
    // Foliage — 3 stacked spheres for a small bush
    for (const [ox, oy, oz, r] of [[0, 0.95, 0, 0.42], [0.25, 1.15, -0.15, 0.3], [-0.2, 1.1, 0.2, 0.28]] as [number, number, number, number][]) {
      const bush = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(r, 10, 8), foliageMat);
      bush.position.set(px + ox, oy, pz + oz);
      bush.castShadow = false;
      scene.add(bush);
    }
  }

  // ── Crosswalk on the asphalt, in front of the pedestrian sidewalk curb gap ──
  // Starts just outside the south curb gap and extends toward the far side of
  // the south street lane.
  const crossZ0 = pedOuterZ1 + 0.05;
  const crossZ1 = streetOuterZ1 - STREET_W * 0.2;
  const crossW = STAIR_W * 1.0;
  const stripeCount = 6;
  const stripeGap = (crossZ1 - crossZ0) / (stripeCount * 2 - 1);
  for (let i = 0; i < stripeCount; i++) {
    const sz = crossZ0 + stripeGap * (i * 2) + stripeGap / 2;
    const stripe = new rt.THREE.Mesh(new rt.THREE.PlaneGeometry(crossW, stripeGap), zebraMat);
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(entryCX, -STREET_DROP + 0.005, sz);
    scene.add(stripe);
  }

  // ── Yellow center lines on the 4 streets (no intersections painted) ──
  const DASH_LEN = 1.4, DASH_GAP = 1.1;
  const nLaneCZ = (pedOuterZ0 + streetOuterZ0) / 2;
  const sLaneCZ = (pedOuterZ1 + streetOuterZ1) / 2;
  const wLaneCX = (pedOuterX0 + streetOuterX0) / 2;
  const eLaneCX = (pedOuterX1 + streetOuterX1) / 2;
  const paintDashedLine = (x0: number, z0: number, x1: number, z1: number) => {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    const step = DASH_LEN + DASH_GAP;
    const n = Math.max(1, Math.floor(len / step));
    const ux = dx / len, uz = dz / len;
    const isH = Math.abs(dx) > Math.abs(dz);
    for (let i = 0; i < n; i++) {
      const t = i * step + DASH_GAP / 2;
      const cx = x0 + ux * (t + DASH_LEN / 2);
      const cz = z0 + uz * (t + DASH_LEN / 2);
      const g = isH ? new rt.THREE.PlaneGeometry(DASH_LEN, 0.22) : new rt.THREE.PlaneGeometry(0.22, DASH_LEN);
      const m = new rt.THREE.Mesh(g, dashMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(cx, -STREET_DROP + 0.004, cz);
      scene.add(m);
    }
  };
  const cornerPad = STREET_W / 2;
  // Skip the south lane dashes around the crosswalk
  paintDashedLine(pedOuterX0 + cornerPad, nLaneCZ, pedOuterX1 - cornerPad, nLaneCZ);
  paintDashedLine(pedOuterX0 + cornerPad, sLaneCZ, entryCX - STAIR_W / 2 - 1.5, sLaneCZ);
  paintDashedLine(entryCX + STAIR_W / 2 + 1.5, sLaneCZ, pedOuterX1 - cornerPad, sLaneCZ);
  paintDashedLine(wLaneCX, pedOuterZ0 + cornerPad, wLaneCX, pedOuterZ1 - cornerPad);
  paintDashedLine(eLaneCX, pedOuterZ0 + cornerPad, eLaneCX, pedOuterZ1 - cornerPad);

  // ── Street lamps at the 4 outer corners of the block (on pedestrian sidewalk) ──
  const cornerSpots: Array<[number, number]> = [
    [pedOuterX0 + 0.9, pedOuterZ0 + 0.9],
    [pedOuterX1 - 0.9, pedOuterZ0 + 0.9],
    [pedOuterX0 + 0.9, pedOuterZ1 - 0.9],
    [pedOuterX1 - 0.9, pedOuterZ1 - 0.9],
  ];
  const poleMat = new rt.THREE.MeshStandardMaterial({ color: 0x242834, roughness: 0.5, metalness: 0.6 });
  applyPBR(poleMat, 'metal');  // cast-metal lamp base + pole
  const lampMat = new rt.THREE.MeshStandardMaterial({
    color: 0xffe8a8, emissive: 0xffc866, emissiveIntensity: 1.25,
    roughness: 0.3, metalness: 0.1,
  });
  // Lamps sit on the pedestrian sidewalk (y=-PLINTH_DROP). Adjust Y offsets.
  const lampBaseY = -PLINTH_DROP + 0.07;
  const lampPoleY = -PLINTH_DROP + 2.35;
  const lampHeadY = -PLINTH_DROP + 4.55;
  const lampLightY = -PLINTH_DROP + 4.3;
  for (const [cx, cz] of cornerSpots) {
    const base = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.18, 0.22, 0.14, 12), poleMat);
    base.position.set(cx, lampBaseY, cz);
    base.castShadow = false;
    scene.add(base);
    const pole = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.07, 0.1, 4.5, 10), poleMat);
    pole.position.set(cx, lampPoleY, cz);
    pole.castShadow = false;
    scene.add(pole);
    const head = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.24, 14, 12), lampMat);
    head.position.set(cx, lampHeadY, cz);
    scene.add(head);
    const pl = new rt.THREE.PointLight(0xffc98a, 0.9, 16, 1.4);
    pl.position.set(cx, lampLightY, cz);
    pl.matrixAutoUpdate = false; pl.updateMatrix();
    scene.add(pl);
  }

  // ── Entrance portal: glass double doors at the TOP of the staircase ──
  // Sits on the sidewalk, just before the stairs begin, facing outward (+Z).
  // Agents would conceptually walk out through it and descend to the street.
  const PORTAL_H = 3.0;          // door-frame height
  const DOOR_H   = 2.6;          // glass door panel height
  const FRAME_W  = 0.28;         // column / frame thickness
  const FRAME_D  = 0.5;          // how deep the frame juts (Z direction)
  const portalZ  = plinthOuterZ1 - 0.35;  // sits on the plinth, just inboard of the stairs
  const frameMat = new rt.THREE.MeshStandardMaterial({
    color: 0x2a2e38, roughness: 0.35, metalness: 0.85,
  });
  const glassMat = new rt.THREE.MeshStandardMaterial({
    color: 0x9ed6e8, roughness: 0.08, metalness: 0.25,
    transparent: true, opacity: 0.35,
    emissive: 0x6a9aaa, emissiveIntensity: 0.1,
    depthWrite: false, // don't mask content behind the glass
  });
  const handleMat = new rt.THREE.MeshStandardMaterial({
    color: 0xd8b870, roughness: 0.3, metalness: 0.9,
  });

  // Left + right columns
  for (const colX of [entryCX - STAIR_W / 2 + FRAME_W / 2, entryCX + STAIR_W / 2 - FRAME_W / 2]) {
    const col = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(FRAME_W, PORTAL_H, FRAME_D), frameMat);
    col.position.set(colX, PORTAL_H / 2, portalZ);
    col.castShadow = false;
    col.receiveShadow = true;
    scene.add(col);
  }
  // Lintel (top beam)
  const lintel = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(STAIR_W, 0.42, FRAME_D + 0.05),
    frameMat,
  );
  lintel.position.set(entryCX, PORTAL_H - 0.21, portalZ);
  lintel.castShadow = false;
  scene.add(lintel);

  // Canopy — flat overhang jutting outward (toward the street)
  const canopy = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(STAIR_W + 1.2, 0.12, 2.0),
    new rt.THREE.MeshStandardMaterial({ color: 0x1c2030, roughness: 0.5, metalness: 0.4 }),
  );
  canopy.position.set(entryCX, PORTAL_H + 0.18, portalZ + 1.0);
  canopy.castShadow = false;
  scene.add(canopy);
  // 2 tensor rods from the lintel up to the canopy edge
  for (const s of [-1, 1]) {
    const rod = new rt.THREE.Mesh(
      new rt.THREE.CylinderGeometry(0.04, 0.04, 1.2, 6),
      frameMat,
    );
    rod.position.set(entryCX + s * (STAIR_W / 2 - 0.5), PORTAL_H + 0.1, portalZ + 0.5);
    rod.rotation.x = Math.PI / 4;
    scene.add(rod);
  }

  // Two double doors (4 panels) — hinged at the sides, closed for now.
  const doorPanelW = (STAIR_W - FRAME_W * 2) / 4;
  const doorThick  = 0.06;
  const doorY      = DOOR_H / 2;
  // Panels from left to right, each at its own X center
  for (let i = 0; i < 4; i++) {
    const x0 = entryCX - STAIR_W / 2 + FRAME_W;
    const panelCX = x0 + doorPanelW * (i + 0.5);
    const panel = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(doorPanelW - 0.03, DOOR_H, doorThick),
      glassMat,
    );
    panel.position.set(panelCX, doorY, portalZ);
    panel.castShadow = false; // glass — don't block light
    scene.add(panel);
    // Thin frame around each panel
    const top = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(doorPanelW - 0.02, 0.08, doorThick + 0.02),
      frameMat,
    );
    top.position.set(panelCX, DOOR_H - 0.04, portalZ);
    scene.add(top);
    const bot = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(doorPanelW - 0.02, 0.12, doorThick + 0.02),
      frameMat,
    );
    bot.position.set(panelCX, 0.06, portalZ);
    scene.add(bot);
    // Vertical mullion on the hinge side
    const hingeSide = (i % 2 === 0) ? -1 : 1;
    const mullion = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(0.04, DOOR_H, doorThick + 0.02),
      frameMat,
    );
    mullion.position.set(panelCX + hingeSide * (doorPanelW / 2 - 0.02), doorY, portalZ);
    scene.add(mullion);
    // Brass handle on the opening side
    const handle = new rt.THREE.Mesh(
      new rt.THREE.CylinderGeometry(0.025, 0.025, 0.25, 8),
      handleMat,
    );
    handle.rotation.z = Math.PI / 2;
    const handleSide = -hingeSide; // opposite of hinge
    handle.position.set(panelCX + handleSide * (doorPanelW / 2 - 0.18), 1.1, portalZ + doorThick / 2 + 0.02);
    scene.add(handle);
  }

  // Small warm pendant light above the doors (uplighting effect)
  const pendantMat = new rt.THREE.MeshStandardMaterial({
    color: 0xffe8a8, emissive: 0xffb044, emissiveIntensity: 1.4,
    roughness: 0.3, metalness: 0.1,
  });
  for (const s of [-1, 1]) {
    const pendant = new rt.THREE.Mesh(
      new rt.THREE.SphereGeometry(0.15, 10, 8),
      pendantMat,
    );
    pendant.position.set(entryCX + s * (STAIR_W / 4), PORTAL_H + 0.12, portalZ + 0.3);
    scene.add(pendant);
    const pl = new rt.THREE.PointLight(0xffb870, 0.6, 8, 1.5);
    pl.position.set(entryCX + s * (STAIR_W / 4), PORTAL_H + 0.05, portalZ + 0.3);
    pl.matrixAutoUpdate = false; pl.updateMatrix();
    scene.add(pl);
  }

}

export function buildCorridorGrid(scene: any, grid: CorridorGrid) {
  for (const seg of grid.segments) {
    const isH = Math.abs(seg.z1 - seg.z2) < 0.1;
    const len = isH ? Math.abs(seg.x2 - seg.x1) : Math.abs(seg.z2 - seg.z1);
    const cx = isH ? (seg.x1 + seg.x2) / 2 : seg.x1;
    const cz = isH ? seg.z1 : (seg.z1 + seg.z2) / 2;

    // Polished corridor floor — slight reflectivity
    const fGeo = isH ? new rt.THREE.PlaneGeometry(len, seg.width) : new rt.THREE.PlaneGeometry(seg.width, len);
    const corridorMat = new rt.THREE.MeshStandardMaterial({
      color: CORRIDOR_CARPET, roughness: 0.6, metalness: 0.05,
    });
    applyPBR(corridorMat, 'carpet');
    applyWorldTexture(corridorMat, 'carpet');
    // PlaneGeometry(u, v) → tiles follow each constructor axis (1 tile ≈ 6u).
    if (isH) scaleUV(fGeo, len / 6, seg.width / 6);
    else scaleUV(fGeo, seg.width / 6, len / 6);
    const f = new rt.THREE.Mesh(fGeo, corridorMat);
    f.rotation.x = -Math.PI / 2; f.position.set(cx, 0.01, cz); f.receiveShadow = true;
    scene.add(f);

    // Baseboard strips along corridor edges
    const baseH = 0.12, baseT = 0.04;
    const baseMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a3555, roughness: 0.5, metalness: 0.2 });
    if (isH) {
      for (const zOff of [-seg.width / 2, seg.width / 2]) {
        const bb = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(len, baseH, baseT), baseMat);
        bb.position.set(cx, baseH / 2, cz + zOff);
        scene.add(bb);
      }
    } else {
      for (const xOff of [-seg.width / 2, seg.width / 2]) {
        const bb = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(baseT, baseH, len), baseMat);
        bb.position.set(cx + xOff, baseH / 2, cz);
        scene.add(bb);
      }
    }
  }
}

export function buildCorridor(_s: any, _c: any) {}
