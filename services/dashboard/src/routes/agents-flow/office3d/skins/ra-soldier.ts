/**
 * Red Alert Infantry skin — self-contained M1-helmet / canvas-backpack /
 * rifle-toting soldier. Mirrors the office-worker structure (same animation
 * surface: head/torso/leftArm/rightArm/leftLeg/rightLeg) so the shared pose
 * functions in anim/poses still drive the limbs.
 *
 * Geometry diffs vs office-worker:
 *   - "hair" → helmet dome (tighter half-sphere) + flat brim (head-child)
 *   - "tie" → wide leather belt at the waist
 *   - +backpack (Box behind torso)
 *   - chunkier combat boots
 *   - walkers carry a rifle slung diagonally across the chest
 *   - military palette (olive drab / khaki / steel / sage)
 *
 * Performance vs office-worker pool: same 13 base IMs + 2 eye IMs + 3 new
 * (helmet brim, belt, backpack), for 18 IMs total (vs 16 in office-worker).
 */

import type { SkinDefinition, SkinPalette, SkinCreateOpts } from './skin-types.js';
import type { HumanoidParts } from '../types.js';
import type { SittingHumanoidPool } from '../humanoid-pool.js';
import { computeSittingPose, SITTING_LEG_FLEX, type SittingMode } from '../anim/poses/sitting.js';
import { applyPBR } from '../office/_materials.js';
import { rt } from '../runtime.js';

let THREE: any = null;

// ── Military palette ─────────────────────────────────────────────────
const SOLDIER_SKIN_TONES = [0xf5e0cc, 0xe8d5c0, 0xd4a87c, 0xa67c5b, 0x6b4a2e];
const HELMET_TONES = [
  0x3d4a2c, // olive drab (Allied)
  0x2a3540, // dark steel (Soviet SSh-40)
  0x4a4030, // dusty brown
  0x5a5d3a, // sage green
  0x3a3a30, // dark khaki
];
const PANTS_TONES = [0x3d4a2c, 0x4a4530, 0x3a3a3a, 0x2a2d2a];

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function pickPalette(seed: string): SkinPalette {
  const h = djb2(seed || 'default');
  return {
    skin:  SOLDIER_SKIN_TONES[h % SOLDIER_SKIN_TONES.length],
    hair:  HELMET_TONES[(h >>> 8)  % HELMET_TONES.length],
    pants: PANTS_TONES[(h >>> 16) % PANTS_TONES.length],
  };
}

// ── Geometry + offsets ──────────────────────────────────────────────
const G = {
  torso:   { w: 0.5,  h: 0.6, d: 0.3 },
  head:    { r: 0.18, segs: 10 },
  helmet:  { r: 0.20, ws: 12, hs: 6 },
  brim:    { r: 0.225, h: 0.025, segs: 12 },
  neck:    { rTop: 0.06, rBot: 0.08, h: 0.15, segs: 6 },
  arm:     { r: 0.06, h: 0.45, caps: 4, rad: 8 },
  hand:    { r: 0.05, segs: 6 },
  pants:   { w: 0.5,  h: 0.2, d: 0.3 },
  leg:     { r: 0.07, h: 0.5, caps: 4, rad: 8 },
  shoe:    { w: 0.12, h: 0.10, d: 0.20 },
  belt:    { w: 0.52, h: 0.08, d: 0.32 },
  pack:    { w: 0.34, h: 0.40, d: 0.16 },
};

const O = {
  torso:    [0, 1.05, 0],
  belt:     [0, 0.83, 0],
  pack:     [0, 1.05, -0.22],
  head:     [0, 1.55, 0],
  neck:     [0, 1.38, 0],
  leftArmPivot:  [-0.32, 1.28, 0],
  rightArmPivot: [ 0.32, 1.28, 0],
  arm:      [0, -0.28, 0],
  hand:     [0, -0.52, 0],
  pants:    [0, 0.7, 0],
  leftLegPivot:  [-0.12, 0.62, 0],
  rightLegPivot: [ 0.12, 0.62, 0],
  leg:      [0, -0.30, 0],
  shoe:     [0, -0.56, 0.03],
  // Head-local
  leftEye:  [-0.06, 0.0, 0.155],
  rightEye: [ 0.06, 0.0, 0.155],
  brim:     [0, 0.04, 0],
  dome:     [0, 0.06, 0],
} as const;

function meshAt(geo: any, mat: any, x: number, y: number, z: number): any {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

// ── Per-mesh soldier (walkers + fallback) ───────────────────────────
function createSoldier(opts: SkinCreateOpts): HumanoidParts {
  if (!THREE) throw new Error('[ra-soldier] init(THREE) must be called first');
  const col = new THREE.Color(opts.flowColor);
  const group = new THREE.Group();
  group.scale.setScalar(opts.scale ?? 1);

  const helmetCol = new THREE.Color(opts.palette.hair);
  const pantsCol  = new THREE.Color(opts.palette.pants);

  // Torso — flow color keeps team identity readable.
  const torsoMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, metalness: 0.0 });
  applyPBR(torsoMat, 'cloth');
  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(G.torso.w, G.torso.h, G.torso.d),
    torsoMat,
  );
  torso.position.y = O.torso[1];
  group.add(torso);

  // Belt — wide leather strap at the waist (hard accessory: left as-is).
  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(G.belt.w, G.belt.h, G.belt.d),
    new THREE.MeshStandardMaterial({ color: 0x3a2810, roughness: 0.55, metalness: 0.1 }),
  );
  belt.position.y = O.belt[1];
  group.add(belt);

  // Backpack — canvas pack on the back.
  const packMat = new THREE.MeshStandardMaterial({ color: 0x4a4520, roughness: 0.95 });
  applyPBR(packMat, 'cloth');
  const backpack = new THREE.Mesh(
    new THREE.BoxGeometry(G.pack.w, G.pack.h, G.pack.d),
    packMat,
  );
  backpack.position.set(O.pack[0], O.pack[1], O.pack[2]);
  group.add(backpack);

  // Head + eyes + helmet
  const headGeo = new THREE.SphereGeometry(G.head.r, G.head.segs, G.head.segs);
  headGeo.scale(1, 1.08, 1);
  const headMat = new THREE.MeshStandardMaterial({ color: opts.palette.skin, roughness: 0.8 });
  applyPBR(headMat, 'skin');
  if (!headMat.emissive || headMat.emissive.getHex() === 0x000000) {
    headMat.emissive = new rt.THREE.Color(0x2a1410);
    headMat.emissiveIntensity = 0.06;
  }
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = O.head[1];
  group.add(head);

  const eyeGeo = new THREE.SphereGeometry(0.022, 5, 5);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
  head.add(meshAt(eyeGeo, eyeMat, O.leftEye[0], O.leftEye[1], O.leftEye[2]));
  head.add(meshAt(eyeGeo, eyeMat, O.rightEye[0], O.rightEye[1], O.rightEye[2]));

  const helmetMat = new THREE.MeshStandardMaterial({ color: helmetCol, roughness: 0.6, metalness: 0.25 });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(G.helmet.r, G.helmet.ws, G.helmet.hs, 0, Math.PI * 2, 0, Math.PI * 0.5),
    helmetMat,
  );
  dome.position.y = O.dome[1];
  head.add(dome);
  const brim = new THREE.Mesh(
    new THREE.CylinderGeometry(G.brim.r, G.brim.r, G.brim.h, G.brim.segs),
    helmetMat,
  );
  brim.position.y = O.brim[1];
  head.add(brim);

  // Neck
  const neckMat = new THREE.MeshStandardMaterial({ color: opts.palette.skin });
  applyPBR(neckMat, 'skin');
  if (!neckMat.emissive || neckMat.emissive.getHex() === 0x000000) {
    neckMat.emissive = new rt.THREE.Color(0x2a1410);
    neckMat.emissiveIntensity = 0.06;
  }
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(G.neck.rTop, G.neck.rBot, G.neck.h, G.neck.segs),
    neckMat,
  );
  neck.position.y = O.neck[1];
  group.add(neck);

  // Arms
  const armGeo = new THREE.CapsuleGeometry(G.arm.r, G.arm.h, G.arm.caps, G.arm.rad);
  const armMat = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.8), roughness: 0.7 });
  applyPBR(armMat, 'cloth');
  const handGeo = new THREE.SphereGeometry(G.hand.r, G.hand.segs, G.hand.segs);
  const handMat = new THREE.MeshStandardMaterial({ color: opts.palette.skin });
  applyPBR(handMat, 'skin');
  if (!handMat.emissive || handMat.emissive.getHex() === 0x000000) {
    handMat.emissive = new rt.THREE.Color(0x2a1410);
    handMat.emissiveIntensity = 0.06;
  }

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(O.leftArmPivot[0], O.leftArmPivot[1], O.leftArmPivot[2]);
  leftArmPivot.add(meshAt(armGeo, armMat, O.arm[0], O.arm[1], O.arm[2]));
  leftArmPivot.add(meshAt(handGeo, handMat, O.hand[0], O.hand[1], O.hand[2]));
  group.add(leftArmPivot);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(O.rightArmPivot[0], O.rightArmPivot[1], O.rightArmPivot[2]);
  rightArmPivot.add(meshAt(armGeo, armMat, O.arm[0], O.arm[1], O.arm[2]));
  rightArmPivot.add(meshAt(handGeo, handMat, O.hand[0], O.hand[1], O.hand[2]));
  group.add(rightArmPivot);

  // Pants
  const pantsMat = new THREE.MeshStandardMaterial({ color: pantsCol, roughness: 0.8 });
  applyPBR(pantsMat, 'cloth');
  const pants = new THREE.Mesh(
    new THREE.BoxGeometry(G.pants.w, G.pants.h, G.pants.d),
    pantsMat,
  );
  pants.position.y = O.pants[1];
  group.add(pants);

  // Legs + combat boots
  const legGeo = new THREE.CapsuleGeometry(G.leg.r, G.leg.h, G.leg.caps, G.leg.rad);
  const legMat = new THREE.MeshStandardMaterial({ color: pantsCol, roughness: 0.8 });
  applyPBR(legMat, 'cloth');
  const shoeGeo = new THREE.BoxGeometry(G.shoe.w, G.shoe.h, G.shoe.d);
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0e, roughness: 0.85 });

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(O.leftLegPivot[0], O.leftLegPivot[1], O.leftLegPivot[2]);
  leftLegPivot.add(meshAt(legGeo, legMat, O.leg[0], O.leg[1], O.leg[2]));
  leftLegPivot.add(meshAt(shoeGeo, shoeMat, O.shoe[0], O.shoe[1], O.shoe[2]));
  group.add(leftLegPivot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(O.rightLegPivot[0], O.rightLegPivot[1], O.rightLegPivot[2]);
  rightLegPivot.add(meshAt(legGeo, legMat, O.leg[0], O.leg[1], O.leg[2]));
  rightLegPivot.add(meshAt(shoeGeo, shoeMat, O.shoe[0], O.shoe[1], O.shoe[2]));
  group.add(rightLegPivot);

  // Rifle — walkers only. Attached to the torso so arms stay free to swing.
  if (opts.walker) {
    const rifleMat = new THREE.MeshStandardMaterial({ color: 0x2a1f12, roughness: 0.55, metalness: 0.3 });
    const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.6), rifleMat);
    rifle.position.set(0.04, -0.02, 0.18);
    rifle.rotation.x = 0.35;
    rifle.rotation.y = -0.4;
    torso.add(rifle);
    const stock = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.07, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.8 }),
    );
    stock.position.z = -0.22;
    rifle.add(stock);
  }

  return {
    group, head, torso,
    leftArm: leftArmPivot, rightArm: rightArmPivot,
    leftLeg: leftLegPivot, rightLeg: rightLegPivot,
  };
}

// ── InstancedMesh pool for seated soldiers ──────────────────────────
interface SoldierSlot {
  inUse: boolean; hidden: boolean;
  worldX: number; worldY: number; worldZ: number;
  rotY: number; scale: number; phase: number;
  isRunning: boolean; isBeingSpokenTo: boolean; isStretching: boolean;
  clothesColor: any; skinColor: any; helmetColor: any; pantsColor: any;
}

function createSoldierPool(scene: any, capacity: number): SittingHumanoidPool {
  if (!THREE) throw new Error('[ra-soldier] init(THREE) must be called first');

  // Geometries
  const torsoGeo  = new THREE.BoxGeometry(G.torso.w, G.torso.h, G.torso.d);
  const headGeo   = new THREE.SphereGeometry(G.head.r, G.head.segs, G.head.segs);
  headGeo.scale(1, 1.08, 1);
  const helmetGeo = new THREE.SphereGeometry(G.helmet.r, G.helmet.ws, G.helmet.hs, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const brimGeo   = new THREE.CylinderGeometry(G.brim.r, G.brim.r, G.brim.h, G.brim.segs);
  const neckGeo   = new THREE.CylinderGeometry(G.neck.rTop, G.neck.rBot, G.neck.h, G.neck.segs);
  const armGeo    = new THREE.CapsuleGeometry(G.arm.r, G.arm.h, G.arm.caps, G.arm.rad);
  const handGeo   = new THREE.SphereGeometry(G.hand.r, G.hand.segs, G.hand.segs);
  const pantsGeo  = new THREE.BoxGeometry(G.pants.w, G.pants.h, G.pants.d);
  const legGeo    = new THREE.CapsuleGeometry(G.leg.r, G.leg.h, G.leg.caps, G.leg.rad);
  const shoeGeo   = new THREE.BoxGeometry(G.shoe.w, G.shoe.h, G.shoe.d);
  const eyeGeo    = new THREE.SphereGeometry(0.022, 5, 5);
  const beltGeo   = new THREE.BoxGeometry(G.belt.w, G.belt.h, G.belt.d);
  const packGeo   = new THREE.BoxGeometry(G.pack.w, G.pack.h, G.pack.d);

  // Materials
  const matSkin    = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  applyPBR(matSkin, 'skin');
  if (!matSkin.emissive || matSkin.emissive.getHex() === 0x000000) {
    matSkin.emissive = new rt.THREE.Color(0x2a1410);
    matSkin.emissiveIntensity = 0.06;
  }
  const matClothes = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  applyPBR(matClothes, 'cloth');
  const matHelmet  = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.25 });
  const matPants   = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  applyPBR(matPants, 'cloth');
  const matShoe    = new THREE.MeshStandardMaterial({ color: 0x2a1a0e, roughness: 0.85 });
  const matEye     = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
  const matBelt    = new THREE.MeshStandardMaterial({ color: 0x3a2810, roughness: 0.55, metalness: 0.1 });
  const matPack    = new THREE.MeshStandardMaterial({ color: 0x4a4520, roughness: 0.95 });
  applyPBR(matPack, 'cloth');

  function inst(geo: any, mat: any, withColor = true): any {
    const m = new THREE.InstancedMesh(geo, mat, capacity);
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = false;
    if (withColor) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    }
    scene.add(m);
    return m;
  }

  const torsoIM  = inst(torsoGeo,  matClothes);
  const headIM   = inst(headGeo,   matSkin);
  const helmetIM = inst(helmetGeo, matHelmet);
  const brimIM   = inst(brimGeo,   matHelmet);
  const neckIM   = inst(neckGeo,   matSkin);
  const lArmIM   = inst(armGeo,    matClothes);
  const rArmIM   = inst(armGeo,    matClothes);
  const lHandIM  = inst(handGeo,   matSkin);
  const rHandIM  = inst(handGeo,   matSkin);
  const pantsIM  = inst(pantsGeo,  matPants);
  const lLegIM   = inst(legGeo,    matPants);
  const rLegIM   = inst(legGeo,    matPants);
  const lShoeIM  = inst(shoeGeo,   matShoe, false);
  const rShoeIM  = inst(shoeGeo,   matShoe, false);
  const lEyeIM   = inst(eyeGeo,    matEye,  false);
  const rEyeIM   = inst(eyeGeo,    matEye,  false);
  const beltIM   = inst(beltGeo,   matBelt, false);
  const packIM   = inst(packGeo,   matPack, false);

  const allParts = [
    torsoIM, headIM, helmetIM, brimIM, neckIM,
    lArmIM, rArmIM, lHandIM, rHandIM,
    pantsIM, lLegIM, rLegIM, lShoeIM, rShoeIM,
    lEyeIM, rEyeIM, beltIM, packIM,
  ];

  function emptySlot(): SoldierSlot {
    return {
      inUse: false, hidden: true,
      worldX: 0, worldY: 0, worldZ: 0, rotY: 0, scale: 1, phase: 0,
      isRunning: false, isBeingSpokenTo: false, isStretching: false,
      clothesColor: new THREE.Color(0x888888),
      skinColor:    new THREE.Color(0xe8d5c0),
      helmetColor:  new THREE.Color(0x3d4a2c),
      pantsColor:   new THREE.Color(0x3d4a2c),
    };
  }

  const slots: SoldierSlot[] = new Array(capacity);
  for (let i = 0; i < capacity; i++) slots[i] = emptySlot();
  const tmpHidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const im of allParts) {
    for (let i = 0; i < capacity; i++) im.setMatrixAt(i, tmpHidden);
    im.instanceMatrix.needsUpdate = true;
  }

  // Reusable temporaries
  const m4 = new THREE.Matrix4();
  const m4eye = new THREE.Matrix4();
  const tParent = new THREE.Matrix4();
  const tLocal  = new THREE.Matrix4();
  const tPivot  = new THREE.Matrix4();
  const tArmRot = new THREE.Matrix4();
  const tLegRot = new THREE.Matrix4();
  const tHeadRot = new THREE.Matrix4();
  const tHead   = new THREE.Matrix4();
  const eulHead = new THREE.Euler();
  const v3 = new THREE.Vector3();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  function setColorOnInstance(im: any, slot: number, color: any): void {
    if (!im.instanceColor) return;
    const arr = im.instanceColor.array as Float32Array;
    const off = slot * 3;
    arr[off] = color.r; arr[off + 1] = color.g; arr[off + 2] = color.b;
    im.instanceColor.needsUpdate = true;
  }

  let nextFreeHint = 0;
  function findFreeSlot(): number {
    for (let k = 0; k < capacity; k++) {
      const i = (nextFreeHint + k) % capacity;
      if (!slots[i].inUse) {
        nextFreeHint = (i + 1) % capacity;
        return i;
      }
    }
    return -1;
  }

  return {
    capacity,

    add(opts) {
      const slot = findFreeSlot();
      if (slot < 0) throw new Error('soldier pool full');
      const s = slots[slot];
      s.inUse = true; s.hidden = false;
      s.worldX = opts.pos[0]; s.worldY = opts.pos[1]; s.worldZ = opts.pos[2];
      s.rotY = opts.rotY;
      s.scale = opts.scale ?? 1;
      s.phase = opts.phase ?? 0;
      s.isRunning = false;
      s.isBeingSpokenTo = false;
      s.isStretching = false;
      s.clothesColor.set(opts.color);
      s.skinColor.set(opts.skinColor ?? 0xe8d5c0);
      // `hairColor` from the shared pool API → helmet color in this skin.
      s.helmetColor.set(opts.hairColor ?? 0x3d4a2c);
      s.pantsColor.set(opts.pantsColor ?? 0x3d4a2c);

      setColorOnInstance(torsoIM, slot, s.clothesColor);
      setColorOnInstance(headIM,  slot, s.skinColor);
      setColorOnInstance(helmetIM, slot, s.helmetColor);
      setColorOnInstance(brimIM,  slot, s.helmetColor);
      setColorOnInstance(neckIM,  slot, s.skinColor);
      const armCol = s.clothesColor.clone().multiplyScalar(0.8);
      setColorOnInstance(lArmIM, slot, armCol);
      setColorOnInstance(rArmIM, slot, armCol);
      setColorOnInstance(lHandIM, slot, s.skinColor);
      setColorOnInstance(rHandIM, slot, s.skinColor);
      setColorOnInstance(pantsIM, slot, s.pantsColor);
      setColorOnInstance(lLegIM,  slot, s.pantsColor);
      setColorOnInstance(rLegIM,  slot, s.pantsColor);
      return slot;
    },

    remove(slot) {
      if (slot < 0 || slot >= capacity) return;
      slots[slot].inUse = false;
      slots[slot].hidden = true;
      for (const im of allParts) {
        im.setMatrixAt(slot, hidden);
        im.instanceMatrix.needsUpdate = true;
      }
    },

    setHidden(slot, isHidden) {
      if (slot < 0 || slot >= capacity) return;
      slots[slot].hidden = isHidden;
    },

    setSlotVisible(slot, visible) {
      this.setHidden(slot, !visible);
    },

    setAnimMode(slot, isRunning, isBeingSpokenTo, isStretching = false) {
      const s = slots[slot];
      if (!s) return;
      s.isRunning = isRunning;
      s.isBeingSpokenTo = isBeingSpokenTo;
      s.isStretching = isStretching;
    },

    update(timeSec, frustum, _cullRadius = 2.5) {
      const tmpV = v3;
      for (let i = 0; i < capacity; i++) {
        const s = slots[i];
        if (!s.inUse || s.hidden) {
          if (s.inUse && s.hidden) {
            for (const im of allParts) im.setMatrixAt(i, hidden);
          }
          continue;
        }
        if (frustum) {
          tmpV.set(s.worldX, s.worldY + 1.05, s.worldZ);
          if (!frustum.containsPoint(tmpV)) {
            for (const im of allParts) im.setMatrixAt(i, hidden);
            continue;
          }
        }

        // Parent transform (position + rotY + uniform scale)
        const cy = Math.cos(s.rotY), sy = Math.sin(s.rotY);
        const sc = s.scale;
        tParent.set(
          cy * sc, 0, sy * sc, s.worldX,
          0,       sc, 0,      s.worldY,
          -sy * sc, 0, cy * sc, s.worldZ,
          0, 0, 0, 1,
        );

        // Pose from shared sitting module
        const mode: SittingMode =
          s.isBeingSpokenTo ? 'spoken-to' :
          s.isStretching   ? 'stretching' :
          s.isRunning      ? 'running' :
          'idle';
        const pose = computeSittingPose(mode, timeSec, s.phase);
        const armLR = pose.armL;
        const armRR = pose.armR;
        const headRX = pose.headX;
        const headRY = pose.headY;
        const legR = SITTING_LEG_FLEX;

        // Static parts
        torsoIM.setMatrixAt(i, m4.makeTranslation(O.torso[0], O.torso[1], O.torso[2]).premultiply(tParent));
        neckIM.setMatrixAt (i, m4.makeTranslation(O.neck[0],  O.neck[1],  O.neck[2]).premultiply(tParent));
        pantsIM.setMatrixAt(i, m4.makeTranslation(O.pants[0], O.pants[1], O.pants[2]).premultiply(tParent));
        beltIM.setMatrixAt (i, m4.makeTranslation(O.belt[0],  O.belt[1],  O.belt[2]).premultiply(tParent));
        packIM.setMatrixAt (i, m4.makeTranslation(O.pack[0],  O.pack[1],  O.pack[2]).premultiply(tParent));

        // Head + rotation, saved into tHead so the children compose against it.
        eulHead.set(headRX, headRY, 0);
        tHeadRot.makeRotationFromEuler(eulHead);
        tHead.makeTranslation(O.head[0], O.head[1], O.head[2]).multiply(tHeadRot);
        headIM.setMatrixAt(i, m4.copy(tHead).premultiply(tParent));

        // Eyes (head-local)
        m4eye.makeTranslation(O.leftEye[0], O.leftEye[1], O.leftEye[2]).premultiply(tHead);
        lEyeIM.setMatrixAt(i, m4eye.premultiply(tParent));
        m4eye.makeTranslation(O.rightEye[0], O.rightEye[1], O.rightEye[2]).premultiply(tHead);
        rEyeIM.setMatrixAt(i, m4eye.premultiply(tParent));

        // Helmet dome + brim (head-local — track head look-around)
        m4eye.makeTranslation(O.dome[0], O.dome[1], O.dome[2]).premultiply(tHead);
        helmetIM.setMatrixAt(i, m4eye.premultiply(tParent));
        m4eye.makeTranslation(O.brim[0], O.brim[1], O.brim[2]).premultiply(tHead);
        brimIM.setMatrixAt(i, m4eye.premultiply(tParent));

        // Arms
        tArmRot.makeRotationX(armLR);
        tPivot.makeTranslation(O.leftArmPivot[0], O.leftArmPivot[1], O.leftArmPivot[2]).multiply(tArmRot);
        tLocal.makeTranslation(O.arm[0], O.arm[1], O.arm[2]).premultiply(tPivot);
        lArmIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tLocal.makeTranslation(O.hand[0], O.hand[1], O.hand[2]).premultiply(tPivot);
        lHandIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tArmRot.makeRotationX(armRR);
        tPivot.makeTranslation(O.rightArmPivot[0], O.rightArmPivot[1], O.rightArmPivot[2]).multiply(tArmRot);
        tLocal.makeTranslation(O.arm[0], O.arm[1], O.arm[2]).premultiply(tPivot);
        rArmIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tLocal.makeTranslation(O.hand[0], O.hand[1], O.hand[2]).premultiply(tPivot);
        rHandIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));

        // Legs
        tLegRot.makeRotationX(legR);
        tPivot.makeTranslation(O.leftLegPivot[0], O.leftLegPivot[1], O.leftLegPivot[2]).multiply(tLegRot);
        tLocal.makeTranslation(O.leg[0], O.leg[1], O.leg[2]).premultiply(tPivot);
        lLegIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tLocal.makeTranslation(O.shoe[0], O.shoe[1], O.shoe[2]).premultiply(tPivot);
        lShoeIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tPivot.makeTranslation(O.rightLegPivot[0], O.rightLegPivot[1], O.rightLegPivot[2]).multiply(tLegRot);
        tLocal.makeTranslation(O.leg[0], O.leg[1], O.leg[2]).premultiply(tPivot);
        rLegIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tLocal.makeTranslation(O.shoe[0], O.shoe[1], O.shoe[2]).premultiply(tPivot);
        rShoeIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
      }
      for (const im of allParts) im.instanceMatrix.needsUpdate = true;
    },

    dispose() {
      for (const im of allParts) {
        scene.remove(im);
        im.dispose();
      }
    },
  };
}

export const raSoldierSkin: SkinDefinition = {
  manifest: {
    id: 'ra-soldier',
    name: 'Red Alert Infantry',
    description: 'M1 helmet, leather belt, canvas backpack, rifle slung across the chest.',
    author: 'core',
    version: '1.0.0',
    category: 'humanoid',
  },

  init(three: any) {
    THREE = three;
  },

  createHumanoid: createSoldier,
  createPool: createSoldierPool,
  pickPalette,
};
