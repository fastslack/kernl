/**
 * Ambient details for the 3D office — decorative elements that bring life to the building.
 * Water coolers, ground fog, stars, perimeter walkway + glass curtain wall.
 */

import { rt } from '../runtime.js';
import { applyPBR, bakeVertexAO } from '../office/_materials.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** Add ambient details to corridors and common areas */
export function buildAmbiance(
  scene: any,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  _corridorNodes: Array<{ x: number; y: number; z: number }>,
  entrance?: { cx: number; width: number },
): void {
  if (!rt.THREE) return;

  const { minX, maxX, minZ, maxZ } = bounds;

  // ── Water cooler at 2 spots (along the top perimeter) ──
  // Plastic dispenser body — PBR plastic role; vertexColors on for baked
  // contact-shadow AO (every geometry using coolerMat is baked below).
  const coolerMat = new rt.THREE.MeshStandardMaterial({ color: 0xd0d4e0, roughness: 0.3, metalness: 0.2 });
  applyPBR(coolerMat, 'plastic');
  coolerMat.vertexColors = true;
  coolerMat.needsUpdate = true;
  const coolerBottleMat = new rt.THREE.MeshStandardMaterial({
    color: 0x88bbee, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.6,
  });
  const coolerSpots: Array<{ x: number; z: number }> = [
    { x: minX + 4, z: minZ - 1.5 },
    { x: minX + 22, z: minZ - 1.5 },
  ];
  for (const sp of coolerSpots) {
    // Base — subtle RoundedBoxGeometry chamfer (segments=2, radius ≈4% of the
    // 0.35 smallest dim) + baked contact AO darkening the bottom. floorY is the
    // box's local bottom (-0.4); reach ≈32% of the 0.8 height.
    const baseGeo = new RoundedBoxGeometry(0.4, 0.8, 0.35, 2, 0.014);
    bakeVertexAO(baseGeo, { floorY: -0.4, reach: 0.26, strength: 0.35 });
    const base = new rt.THREE.Mesh(baseGeo, coolerMat);
    base.position.set(sp.x + 3, 0.4, sp.z);
    scene.add(base);
    // Bottle
    const bottle = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.12, 0.14, 0.45, 8), coolerBottleMat);
    bottle.position.set(sp.x + 3, 0.95, sp.z);
    scene.add(bottle);
  }


  // (ceiling pipes removed — they cluttered the front with no functionality)

  // ── Subtle ground fog plane ──
  // `depthWrite:false` is critical — without it, this transparent plane writes
  // to the depth buffer and masks anything behind it (streets, sidewalks,
  // anything at y < 0.005). Also made slightly smaller so it only covers the
  // building footprint, not the street area outside it.
  const fogPlane = new rt.THREE.Mesh(
    new rt.THREE.PlaneGeometry(maxX - minX, maxZ - minZ),
    new rt.THREE.MeshBasicMaterial({
      color: 0x1a2040, transparent: true, opacity: 0.08, side: 2,
      depthWrite: false,
    }),
  );
  fogPlane.rotation.x = -Math.PI / 2;
  fogPlane.position.set((minX + maxX) / 2, 0.005, (minZ + maxZ) / 2);
  scene.add(fogPlane);

  // Exterior star dots removed — they read as confusing "rank-insignia
  // ghosts" near agent labels at certain camera angles.

  // ══════════════════════════════════════════════════
  // PERIMETER WALKWAY + GLASS CURTAIN WALL
  // ══════════════════════════════════════════════════
  buildPerimeter(scene, bounds, entrance);
}

/** Build the exterior perimeter: walkway floor + glass curtain wall with window frames */
function buildPerimeter(
  scene: any,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  entrance?: { cx: number; width: number },
): void {
  const { minX, maxX, minZ, maxZ } = bounds;
  const WALK_W = 4;       // walkway width
  const WALL_H = 3.8;     // exterior wall height
  const WIN_H = 2.4;      // glass pane height
  const WIN_SILL = 0.6;   // sill height from floor
  const WIN_W = 3.0;      // glass pane width
  const WIN_GAP = 0.8;    // gap between windows (frame pillar width)
  const FRAME_T = 0.08;   // frame thickness
  const GLASS_T = 0.03;   // glass thickness

  // Materials
  const floorMat = new rt.THREE.MeshStandardMaterial({ color: 0x283848, roughness: 0.6, metalness: 0.05 });
  const wallMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a3555, roughness: 0.7, metalness: 0.1 });
  const frameMat = new rt.THREE.MeshStandardMaterial({ color: 0x4a5a7a, roughness: 0.3, metalness: 0.5 });
  applyPBR(frameMat, 'metal'); // window mullion/frame bars — structural metal
  // Physical glass — uses transmission for realistic see-through with refraction
  let glassMat: any;
  let glassReflectMat: any;
  try {
    glassMat = new rt.THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.05, metalness: 0.0,
      transmission: 0.92, ior: 1.5, thickness: 0.1,
      transparent: true, opacity: 1, side: 2,
      envMapIntensity: 1.5,
    });
    glassReflectMat = new rt.THREE.MeshPhysicalMaterial({
      color: 0xddeeff, roughness: 0.0, metalness: 0.1,
      transmission: 0.7, ior: 1.52, thickness: 0.05,
      transparent: true, opacity: 1, side: 2,
      envMapIntensity: 2.0,
    });
  } catch {
    // Fallback for GPUs that don't support MeshPhysicalMaterial well
    glassMat = new rt.THREE.MeshStandardMaterial({
      color: 0x88bbee, roughness: 0.05, metalness: 0.2,
      transparent: true, opacity: 0.18, side: 2,
    });
    // Cheap fake glass — curtain-wall pane. opacity 0.18 already in 0.12–0.25 → keep.
    applyPBR(glassMat, 'glass');
    glassMat.transparent = true; glassMat.opacity = 0.18; glassMat.needsUpdate = true;
    glassReflectMat = new rt.THREE.MeshStandardMaterial({
      color: 0xaaccff, roughness: 0.0, metalness: 0.6,
      transparent: true, opacity: 0.08, side: 2,
    });
    // Faint reflection overlay companion to glassMat — keep its intentional
    // 0.08 sheen opacity (bumping it would double up with the pane below).
    applyPBR(glassReflectMat, 'glass');
    glassReflectMat.transparent = true; glassReflectMat.needsUpdate = true;
  }
  const sillMat = new rt.THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.4, metalness: 0.3 });
  applyPBR(sillMat, 'metal'); // window sill / threshold — structural metal
  const baseMat = new rt.THREE.MeshStandardMaterial({ color: 0x222840, roughness: 0.6 });

  // 4 sides: top (-Z), bottom (+Z), left (-X), right (+X)
  const sides: Array<{
    fx: number; fz: number; fw: number; fd: number; // floor
    wx: number; wz: number; wLen: number; isX: boolean; dir: number; // wall
  }> = [
    // Top side (min Z)
    { fx: (minX + maxX) / 2, fz: minZ - WALK_W / 2, fw: maxX - minX + WALK_W * 2, fd: WALK_W,
      wx: (minX + maxX) / 2, wz: minZ - WALK_W, wLen: maxX - minX + WALK_W * 2, isX: true, dir: 1 },
    // Bottom side (max Z)
    { fx: (minX + maxX) / 2, fz: maxZ + WALK_W / 2, fw: maxX - minX + WALK_W * 2, fd: WALK_W,
      wx: (minX + maxX) / 2, wz: maxZ + WALK_W, wLen: maxX - minX + WALK_W * 2, isX: true, dir: -1 },
    // Left side (min X)
    { fx: minX - WALK_W / 2, fz: (minZ + maxZ) / 2, fw: WALK_W, fd: maxZ - minZ,
      wx: minX - WALK_W, wz: (minZ + maxZ) / 2, wLen: maxZ - minZ, isX: false, dir: 1 },
    // Right side (max X)
    { fx: maxX + WALK_W / 2, fz: (minZ + maxZ) / 2, fw: WALK_W, fd: maxZ - minZ,
      wx: maxX + WALK_W, wz: (minZ + maxZ) / 2, wLen: maxZ - minZ, isX: false, dir: -1 },
  ];

  const doorSpan = entrance ? Math.max(7.5, entrance.width) : 0;

  for (const s of sides) {
    const isEntranceSide = s.isX && s.dir === -1 && !!entrance;
    const entrX0 = entrance ? entrance.cx - doorSpan / 2 : 0;
    const entrX1 = entrance ? entrance.cx + doorSpan / 2 : 0;

    // ── Walkway floor ──
    const floor = new rt.THREE.Mesh(
      new rt.THREE.PlaneGeometry(s.fw, s.fd),
      floorMat,
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(s.fx, 0.01, s.fz);
    floor.receiveShadow = true;
    scene.add(floor);

    // ── Floor edge strip (subtle accent line) ──
    const edgeW = s.isX ? s.fw : 0.08;
    const edgeD = s.isX ? 0.08 : s.fd;
    const edge = new rt.THREE.Mesh(
      new rt.THREE.PlaneGeometry(edgeW, edgeD),
      new rt.THREE.MeshBasicMaterial({ color: 0x4a6ab8, transparent: true, opacity: 0.25 }),
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(s.fx, 0.015, s.fz);
    scene.add(edge);

    // ── Base wall (below sill) — split around entrance doors on south side ──
    if (isEntranceSide) {
      const wx0 = s.wx - s.wLen / 2;
      const wx1 = s.wx + s.wLen / 2;
      const leftLen = entrX0 - wx0;
      if (leftLen > 0.1) {
        const m = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(leftLen, WIN_SILL, 0.2), baseMat);
        m.position.set(wx0 + leftLen / 2, WIN_SILL / 2, s.wz);
        scene.add(m);
      }
      const rightLen = wx1 - entrX1;
      if (rightLen > 0.1) {
        const m = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(rightLen, WIN_SILL, 0.2), baseMat);
        m.position.set(entrX1 + rightLen / 2, WIN_SILL / 2, s.wz);
        scene.add(m);
      }
    } else {
      const baseGeo = s.isX
        ? new rt.THREE.BoxGeometry(s.wLen, WIN_SILL, 0.2)
        : new rt.THREE.BoxGeometry(0.2, WIN_SILL, s.wLen);
      const base = new rt.THREE.Mesh(baseGeo, baseMat);
      base.position.set(s.wx, WIN_SILL / 2, s.wz);
      scene.add(base);
    }

    // ── Top wall (above windows) ──
    const topH = WALL_H - WIN_SILL - WIN_H;
    if (topH > 0.1) {
      const topGeo = s.isX
        ? new rt.THREE.BoxGeometry(s.wLen, topH, 0.2)
        : new rt.THREE.BoxGeometry(0.2, topH, s.wLen);
      const top = new rt.THREE.Mesh(topGeo, wallMat);
      top.position.set(s.wx, WIN_SILL + WIN_H + topH / 2, s.wz);
      scene.add(top);
    }

    // ── Glass windows with frames ──
    const totalSpan = s.wLen;
    const cellW = WIN_W + WIN_GAP;
    const numWins = Math.floor(totalSpan / cellW);
    const startOffset = -(numWins - 1) * cellW / 2;

    for (let i = 0; i < numWins; i++) {
      const offset = startOffset + i * cellW;
      const px = s.isX ? s.wx + offset : s.wx;
      const pz = s.isX ? s.wz : s.wz + offset;

      // ── Door (full-height double glass leaves) where the staircase lands ──
      if (isEntranceSide && px >= entrX0 && px <= entrX1) {
        const doorH = WIN_SILL + WIN_H;
        const leafW = (WIN_W / 2) - FRAME_T;
        for (const leaf of [-1, 1]) {
          const leafX = px + leaf * (WIN_W / 4);
          const doorGeo = new rt.THREE.BoxGeometry(leafW, doorH - FRAME_T * 2, GLASS_T);
          const d = new rt.THREE.Mesh(doorGeo, glassMat);
          d.position.set(leafX, doorH / 2, pz);
          scene.add(d);
          const r = new rt.THREE.Mesh(doorGeo, glassReflectMat);
          r.position.set(leafX, doorH / 2 + 0.01, pz + s.dir * 0.02);
          scene.add(r);
        }
        // Outer + center mullions (full height)
        for (const side of [-1, 0, 1]) {
          const mull = new rt.THREE.Mesh(
            new rt.THREE.BoxGeometry(FRAME_T, doorH, FRAME_T * 2),
            frameMat,
          );
          mull.position.set(px + side * WIN_W / 2, doorH / 2, pz);
          scene.add(mull);
        }
        // Top transom
        const topTran = new rt.THREE.Mesh(
          new rt.THREE.BoxGeometry(WIN_W + FRAME_T * 2, FRAME_T, FRAME_T * 2),
          frameMat,
        );
        topTran.position.set(px, doorH, pz);
        scene.add(topTran);
        // Bottom threshold
        const threshold = new rt.THREE.Mesh(
          new rt.THREE.BoxGeometry(WIN_W + FRAME_T * 2, FRAME_T * 0.6, 0.18),
          sillMat,
        );
        threshold.position.set(px, FRAME_T * 0.3, pz);
        scene.add(threshold);
        // Gold handles on inner edges of the two leaves
        const handleMat = new rt.THREE.MeshStandardMaterial({
          color: 0xc9a84c, roughness: 0.3, metalness: 0.7,
        });
        applyPBR(handleMat, 'trim'); // gold door handle — accent trim
        for (const leaf of [-1, 1]) {
          const h = new rt.THREE.Mesh(
            new rt.THREE.CylinderGeometry(0.025, 0.025, 0.35, 8),
            handleMat,
          );
          h.position.set(px + leaf * 0.18, 1.1, pz + s.dir * 0.05);
          scene.add(h);
        }
        continue;
      }

      // Glass pane
      const glassGeo = s.isX
        ? new rt.THREE.BoxGeometry(WIN_W, WIN_H, GLASS_T)
        : new rt.THREE.BoxGeometry(GLASS_T, WIN_H, WIN_W);
      const glass = new rt.THREE.Mesh(glassGeo, glassMat);
      glass.position.set(px, WIN_SILL + WIN_H / 2, pz);
      scene.add(glass);

      // Reflection layer (subtle second pane for depth)
      const reflect = new rt.THREE.Mesh(glassGeo, glassReflectMat);
      reflect.position.set(
        px + (s.isX ? 0 : s.dir * 0.02),
        WIN_SILL + WIN_H / 2 + 0.01,
        pz + (s.isX ? s.dir * 0.02 : 0),
      );
      scene.add(reflect);

      // ── Window frame (4 bars) ──
      // Vertical mullions (left + right)
      for (const side of [-1, 1]) {
        const mullGeo = s.isX
          ? new rt.THREE.BoxGeometry(FRAME_T, WIN_H + FRAME_T, FRAME_T * 2)
          : new rt.THREE.BoxGeometry(FRAME_T * 2, WIN_H + FRAME_T, FRAME_T);
        const mull = new rt.THREE.Mesh(mullGeo, frameMat);
        const mx = s.isX ? px + side * WIN_W / 2 : px;
        const mz = s.isX ? pz : pz + side * WIN_W / 2;
        mull.position.set(mx, WIN_SILL + WIN_H / 2, mz);
        scene.add(mull);
      }
      // Horizontal transoms (top + bottom)
      for (const vpos of [WIN_SILL, WIN_SILL + WIN_H]) {
        const tranGeo = s.isX
          ? new rt.THREE.BoxGeometry(WIN_W + FRAME_T * 2, FRAME_T, FRAME_T * 2)
          : new rt.THREE.BoxGeometry(FRAME_T * 2, FRAME_T, WIN_W + FRAME_T * 2);
        const tran = new rt.THREE.Mesh(tranGeo, frameMat);
        tran.position.set(px, vpos, pz);
        scene.add(tran);
      }
      // Center horizontal divider (cross bar)
      const midGeo = s.isX
        ? new rt.THREE.BoxGeometry(WIN_W, FRAME_T * 0.6, FRAME_T * 1.5)
        : new rt.THREE.BoxGeometry(FRAME_T * 1.5, FRAME_T * 0.6, WIN_W);
      const mid = new rt.THREE.Mesh(midGeo, frameMat);
      mid.position.set(px, WIN_SILL + WIN_H * 0.55, pz);
      scene.add(mid);

      // Sill ledge (small shelf under window)
      const sillGeo = s.isX
        ? new rt.THREE.BoxGeometry(WIN_W + 0.2, 0.06, 0.25)
        : new rt.THREE.BoxGeometry(0.25, 0.06, WIN_W + 0.2);
      const sill = new rt.THREE.Mesh(sillGeo, sillMat);
      sill.position.set(px, WIN_SILL, pz);
      scene.add(sill);
    }

    // ── Frame pillars between windows ──
    for (let i = 0; i <= numWins; i++) {
      const offset = startOffset + i * cellW - cellW / 2;
      if (i === 0) continue; // skip before first window
      const px = s.isX ? s.wx + offset + WIN_W / 2 + WIN_GAP / 2 : s.wx;
      const pz = s.isX ? s.wz : s.wz + offset + WIN_W / 2 + WIN_GAP / 2;
      if (i >= numWins) continue;

      const pillarGeo = s.isX
        ? new rt.THREE.BoxGeometry(WIN_GAP * 0.6, WALL_H, 0.22)
        : new rt.THREE.BoxGeometry(0.22, WALL_H, WIN_GAP * 0.6);
      const pillar = new rt.THREE.Mesh(pillarGeo, wallMat);
      pillar.position.set(px, WALL_H / 2, pz);
      scene.add(pillar);
    }
  }

  // ── Corner gap fillers — close the open ends of the left/right walls ──
  // The left/right walls span only [minZ..maxZ], leaving a WALK_W-long gap at
  // each end between them and the top/bottom walls. Fill those 4 gaps with
  // solid wall segments so the curtain wall fully wraps the building.
  for (const fx of [minX - WALK_W, maxX + WALK_W]) {
    for (const fz of [minZ - WALK_W / 2, maxZ + WALK_W / 2]) {
      const filler = new rt.THREE.Mesh(
        new rt.THREE.BoxGeometry(0.2, WALL_H, WALK_W),
        wallMat,
      );
      filler.position.set(fx, WALL_H / 2, fz);
      scene.add(filler);
    }
  }

  // ── Corner columns (where two walls meet) ──
  const cornerMat = new rt.THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.4, metalness: 0.3 });
  applyPBR(cornerMat, 'metal'); // curtain-wall corner mullion column — structural metal
  const corners = [
    [minX - WALK_W, minZ - WALK_W],
    [maxX + WALK_W, minZ - WALK_W],
    [minX - WALK_W, maxZ + WALK_W],
    [maxX + WALK_W, maxZ + WALK_W],
  ];
  for (const [cx, cz] of corners) {
    const col = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, WALL_H + 0.15, 0.5), cornerMat);
    col.position.set(cx, WALL_H / 2, cz);
    scene.add(col);
    // Corner cap
    const cap = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(0.7, 0.12, 0.7),
      new rt.THREE.MeshStandardMaterial({ color: 0x4a6ab8, roughness: 0.3, metalness: 0.4 }),
    );
    cap.position.set(cx, WALL_H + 0.06, cz);
    scene.add(cap);
  }
}
