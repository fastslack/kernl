/**
 * Sitting humanoid pool — collapses N seated worker humanoids (typically
 * 60-200) into 13 shared InstancedMesh draw calls.
 *
 * The original code created a 14-mesh Group per sitting worker. With 69
 * agents that meant ~966 individual meshes / draw calls / materials, all
 * walked twice per frame (shadow pass + screen pass). InstancedMesh keeps
 * one geometry + one material per body part and animates via per-instance
 * Matrix4 updates uploaded as a single buffer.
 *
 * Walkers (the moving humanoids) stay on the old per-mesh code path —
 * they're <30 simultaneous, animate across many states, and their Group
 * hierarchy makes per-mesh animation easier to reason about.
 */

import { computeSittingPose, SITTING_LEG_FLEX, type SittingMode } from './anim/poses/sitting.js';
import { applyPBR } from './office/_materials.js';
import { rt } from './runtime.js';

let THREE: any;
export function initHumanoidPool(three: any) { THREE = three; }

// ── Geometry sizes (mirror humanoid.ts) ────────────────────────────────
const G = {
  torso:   { w: 0.5,  h: 0.6, d: 0.3 },
  head:    { r: 0.18, segs: 10 },
  hair:    { r: 0.19, ws: 8, hs: 6 },
  neck:    { rTop: 0.06, rBot: 0.08, h: 0.15, segs: 6 },
  arm:     { r: 0.06, h: 0.45, caps: 4, rad: 8 },
  hand:    { r: 0.05, segs: 6 },
  pants:   { w: 0.5,  h: 0.2, d: 0.3 },
  leg:     { r: 0.07, h: 0.5, caps: 4, rad: 8 },
  shoe:    { w: 0.1,  h: 0.06, d: 0.18 },
};

// Local pivot offsets — relative to the humanoid origin (feet at y=0).
const O = {
  torso:    [0, 1.05, 0],
  tie:      [0, 1.07, 0.16],     // chest accent (slightly forward)
  head:     [0, 1.55, 0],
  hair:     [0, 1.57, 0],
  neck:     [0, 1.38, 0],
  leftArmPivot:  [-0.32, 1.28, 0],
  rightArmPivot: [ 0.32, 1.28, 0],
  arm:      [0, -0.28, 0],   // arm offset from its pivot
  hand:     [0, -0.52, 0],   // hand offset from arm pivot
  pants:    [0, 0.7, 0],
  leftLegPivot:  [-0.12, 0.62, 0],
  rightLegPivot: [ 0.12, 0.62, 0],
  leg:      [0, -0.30, 0],
  shoe:     [0, -0.56, 0.03],
  // Eye offsets are HEAD-local — composed against the head rotation matrix
  // each frame so they track headX/headY look-around.
  leftEye:  [-0.06, 0.02, 0.155],
  rightEye: [ 0.06, 0.02, 0.155],
} as const;

type Vec3 = [number, number, number];

interface SlotState {
  inUse: boolean;
  hidden: boolean;     // walker checked-out: matrix is zero-scale
  worldX: number;
  worldY: number;
  worldZ: number;
  rotY: number;        // facing direction
  scale: number;
  phase: number;       // animation desync per slot
  // Anim state — drives idle / running / spoken-to / stretching vs sitting still
  isRunning: boolean;
  isBeingSpokenTo: boolean;
  isStretching: boolean;
  // Colors per slot
  clothesColor: any;   // THREE.Color
  skinColor: any;
  hairColor: any;
  pantsColor: any;
  tieColor: any;
  shoeColor: any;
}

export interface SittingHumanoidPool {
  capacity: number;
  add(opts: {
    pos: Vec3;
    rotY: number;
    scale?: number;
    color: number | string;
    skinColor?: number;
    /** Hair color override; falls back to a tone derived from clothes when undefined. */
    hairColor?: number;
    /** Pants color override; defaults to charcoal when undefined. */
    pantsColor?: number;
    phase?: number;
  }): number;                                                         // returns slot id
  remove(slot: number): void;
  setHidden(slot: number, hidden: boolean): void;
  setAnimMode(slot: number, isRunning: boolean, isBeingSpokenTo: boolean, isStretching?: boolean): void;
  /**
   * Update per-instance matrices. If `frustum` is supplied, slots whose
   * world position is outside the camera frustum get hidden (zero-scale
   * matrix) and skip all rotation math. The cull radius (default 4 units)
   * widens the test by the humanoid's bounding sphere so culling doesn't
   * pop near the screen edge.
   */
  update(timeSec: number, frustum?: { containsPoint(p: any): boolean }, cullRadius?: number): void;
  /** Toggle anim updates for slots whose desk is offscreen. */
  setSlotVisible(slot: number, visible: boolean): void;
  dispose(): void;
}

/**
 * Build a pool of N sitting-humanoid slots and add 13 shared InstancedMesh
 * objects to the scene. Returns the pool API.
 */
export function createSittingHumanoidPool(scene: any, capacity: number): SittingHumanoidPool {
  // ── Shared geometries (created once) ──────────────────────────────────
  const torsoGeo = new THREE.BoxGeometry(G.torso.w, G.torso.h, G.torso.d);
  // Slightly elongated head so the silhouette reads as "head" not "ball".
  // Scaling vertices is a one-time op; no per-frame cost.
  const headGeo  = new THREE.SphereGeometry(G.head.r, G.head.segs, G.head.segs);
  headGeo.scale(1, 1.08, 1);
  const hairGeo  = new THREE.SphereGeometry(G.hair.r, G.hair.ws, G.hair.hs, 0, Math.PI * 2, 0, Math.PI * 0.6);
  const neckGeo  = new THREE.CylinderGeometry(G.neck.rTop, G.neck.rBot, G.neck.h, G.neck.segs);
  const armGeo   = new THREE.CapsuleGeometry(G.arm.r, G.arm.h, G.arm.caps, G.arm.rad);
  const handGeo  = new THREE.SphereGeometry(G.hand.r, G.hand.segs, G.hand.segs);
  const pantsGeo = new THREE.BoxGeometry(G.pants.w, G.pants.h, G.pants.d);
  const legGeo   = new THREE.CapsuleGeometry(G.leg.r, G.leg.h, G.leg.caps, G.leg.rad);
  const shoeGeo  = new THREE.BoxGeometry(G.shoe.w, G.shoe.h, G.shoe.d);
  // Tiny dark dots for eyes — basic shading is plenty, no need for PBR.
  const eyeGeo   = new THREE.SphereGeometry(0.022, 5, 5);
  // Tie — small vertical accent on the chest.
  const tieGeo   = new THREE.BoxGeometry(0.06, 0.32, 0.02);

  // ── Materials (vertexColors=true so each instance picks its own color) ──
  const matSkin    = new THREE.MeshStandardMaterial({ roughness: 0.8, vertexColors: false });
  applyPBR(matSkin, 'skin');
  if (!matSkin.emissive || matSkin.emissive.getHex() === 0x000000) {
    matSkin.emissive = new rt.THREE.Color(0x2a1410);
    matSkin.emissiveIntensity = 0.06;
  }
  const matClothes = new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.05, vertexColors: false });
  applyPBR(matClothes, 'cloth');
  const matHair    = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: false });
  applyPBR(matHair, 'cloth');
  const matPants   = new THREE.MeshStandardMaterial({ roughness: 0.8, vertexColors: false });
  applyPBR(matPants, 'cloth');
  const matShoe    = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, vertexColors: false });
  const matEye     = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, vertexColors: false });
  const matTie     = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1, vertexColors: false });
  applyPBR(matTie, 'cloth');

  // ── Build the 13 InstancedMesh slots ──────────────────────────────────
  function inst(geo: any, mat: any, withColor = true) {
    const m = new THREE.InstancedMesh(geo, mat, capacity);
    m.frustumCulled = false;          // we manage visibility ourselves
    m.castShadow = true;
    m.receiveShadow = false;          // bodies don't need to receive their own shadows
    if (withColor) {
      // Per-instance color attribute. THREE handles vertexColors-aware shading
      // when the material can use it; with InstancedMesh + setColorAt, the
      // color buffer wins for instance tinting on Standard materials.
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    }
    scene.add(m);
    return m;
  }

  const torsoIM = inst(torsoGeo, matClothes);
  const headIM  = inst(headGeo,  matSkin);
  const hairIM  = inst(hairGeo,  matHair);
  const neckIM  = inst(neckGeo,  matSkin);
  const lArmIM  = inst(armGeo,   matClothes);
  const rArmIM  = inst(armGeo,   matClothes);
  const lHandIM = inst(handGeo,  matSkin);
  const rHandIM = inst(handGeo,  matSkin);
  const pantsIM = inst(pantsGeo, matPants);
  const lLegIM  = inst(legGeo,   matPants);
  const rLegIM  = inst(legGeo,   matPants);
  const lShoeIM = inst(shoeGeo,  matShoe, false);
  const rShoeIM = inst(shoeGeo,  matShoe, false);
  // New parts: eyes (no per-instance color — all dark) + tie (tinted to clothes).
  const lEyeIM  = inst(eyeGeo,   matEye, false);
  const rEyeIM  = inst(eyeGeo,   matEye, false);
  const tieIM   = inst(tieGeo,   matTie);

  const allParts = [
    torsoIM, headIM, hairIM, neckIM,
    lArmIM, rArmIM, lHandIM, rHandIM,
    pantsIM, lLegIM, rLegIM, lShoeIM, rShoeIM,
    lEyeIM, rEyeIM, tieIM,
  ];

  const slots: SlotState[] = new Array(capacity);
  for (let i = 0; i < capacity; i++) slots[i] = emptySlot();

  // Hide everything to start (scale-zero matrix everywhere).
  const tmpHidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const im of allParts) {
    for (let i = 0; i < capacity; i++) im.setMatrixAt(i, tmpHidden);
    im.instanceMatrix.needsUpdate = true;
  }

  // Reusable temporaries — avoid per-frame allocation.
  const m4 = new THREE.Matrix4();
  const m4eye = new THREE.Matrix4();   // eye position composes against the head transform
  const tParent = new THREE.Matrix4();
  const tLocal  = new THREE.Matrix4();
  const tRot    = new THREE.Matrix4();
  const tPivot  = new THREE.Matrix4();
  const tArmRot = new THREE.Matrix4();
  const tLegRot = new THREE.Matrix4();
  const tHeadRot= new THREE.Matrix4();
  const tHead   = new THREE.Matrix4();   // composed head transform (translation+rotation)
  const eulHead = new THREE.Euler();
  const v3      = new THREE.Vector3();
  const hidden  = new THREE.Matrix4().makeScale(0, 0, 0);

  function setColorOnInstance(im: any, slot: number, color: any) {
    if (!im.instanceColor) return;
    const arr = im.instanceColor.array as Float32Array;
    const off = slot * 3;
    arr[off]     = color.r;
    arr[off + 1] = color.g;
    arr[off + 2] = color.b;
    im.instanceColor.needsUpdate = true;
  }

  let nextFreeHint = 0;

  function findFreeSlot(): number {
    // Linear scan from nextFreeHint; rolls over once.
    for (let k = 0; k < capacity; k++) {
      const i = (nextFreeHint + k) % capacity;
      if (!slots[i].inUse) {
        nextFreeHint = (i + 1) % capacity;
        return i;
      }
    }
    return -1;
  }

  function emptySlot(): SlotState {
    return {
      inUse: false, hidden: true,
      worldX: 0, worldY: 0, worldZ: 0, rotY: 0, scale: 1, phase: 0,
      isRunning: false, isBeingSpokenTo: false, isStretching: false,
      clothesColor: new THREE.Color(0x888888),
      skinColor: new THREE.Color(0xe8d5c0),
      hairColor: new THREE.Color(0x222222),
      pantsColor: new THREE.Color(0x2a2d3a),
      tieColor: new THREE.Color(0x442222),
      shoeColor: new THREE.Color(0x1a1a1a),
    };
  }

  return {
    capacity,

    add(opts) {
      const slot = findFreeSlot();
      if (slot < 0) throw new Error('humanoid pool full');
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
      // Hair: explicit override (from per-agent palette) > clothes×0.3 fallback.
      if (opts.hairColor !== undefined) s.hairColor.set(opts.hairColor);
      else s.hairColor.copy(s.clothesColor).multiplyScalar(0.3);
      s.skinColor.set(opts.skinColor ?? 0xe8d5c0);
      s.pantsColor.set(opts.pantsColor ?? 0x2a2d3a);
      // Tie: tinted from clothes so it stays color-coded (×0.45 = darker shade).
      s.tieColor.copy(s.clothesColor).multiplyScalar(0.45);
      // Static colors: paint once on add. Animation only writes matrices.
      setColorOnInstance(torsoIM, slot, s.clothesColor);
      setColorOnInstance(headIM,  slot, s.skinColor);
      setColorOnInstance(hairIM,  slot, s.hairColor);
      setColorOnInstance(neckIM,  slot, s.skinColor);
      // Arms use clothes×0.8 (matches old logic)
      const armCol = s.clothesColor.clone().multiplyScalar(0.8);
      setColorOnInstance(lArmIM, slot, armCol);
      setColorOnInstance(rArmIM, slot, armCol);
      setColorOnInstance(lHandIM, slot, s.skinColor);
      setColorOnInstance(rHandIM, slot, s.skinColor);
      setColorOnInstance(pantsIM, slot, s.pantsColor);
      setColorOnInstance(lLegIM,  slot, s.pantsColor);
      setColorOnInstance(rLegIM,  slot, s.pantsColor);
      setColorOnInstance(tieIM,   slot, s.tieColor);
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

    update(timeSec, frustum, cullRadius = 2.5) {
      const tmpV = v3;
      // Per-frame matrix updates for every in-use slot. Hidden slots (or
      // off-frustum slots, when a frustum is provided) get a zero-scale
      // matrix so they consume zero raster cost AND we skip the heavy
      // matrix math below.
      for (let i = 0; i < capacity; i++) {
        const s = slots[i];
        if (!s.inUse || s.hidden) {
          if (s.inUse && s.hidden) {
            for (const im of allParts) im.setMatrixAt(i, hidden);
          }
          continue;
        }
        if (frustum) {
          // Cheap point-in-frustum check at the humanoid's torso. The
          // cullRadius parameter trades pop-in for skip count: 2.5u is
          // enough that the humanoid never disappears mid-screen.
          tmpV.set(s.worldX, s.worldY + 1.05, s.worldZ);
          if (!frustum.containsPoint(tmpV)) {
            for (const im of allParts) im.setMatrixAt(i, hidden);
            continue;
          }
        }

        // Parent transform: position + Y rotation + uniform scale.
        // Rotation Y → cos/sin once.
        const cy = Math.cos(s.rotY), sy = Math.sin(s.rotY);
        // We compose tParent manually instead of compose() to avoid Quaternion
        // allocation — the parent only has Y rotation.
        const sc = s.scale;
        tParent.set(
          cy * sc, 0,        sy * sc, s.worldX,
          0,       sc,       0,       s.worldY,
          -sy * sc, 0,       cy * sc, s.worldZ,
          0,       0,        0,       1,
        );

        // Body part rotations — single source of truth in anim/poses/sitting.ts.
        // Both this pool path and the per-mesh path in humanoid.ts call the
        // same function; tweak the cadence/curve there and both update.
        // Priority: spoken-to > stretching > running > idle.
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
        // Constant flex for the seated pose (mirrors furniture.ts).
        const legR = SITTING_LEG_FLEX;

        // Static parts (no per-frame rotation): torso, hair, neck, pants, tie
        torsoIM.setMatrixAt(i, m4.makeTranslation(O.torso[0], O.torso[1], O.torso[2]).premultiply(tParent));
        hairIM.setMatrixAt (i, m4.makeTranslation(O.hair[0],  O.hair[1],  O.hair[2]).premultiply(tParent));
        neckIM.setMatrixAt (i, m4.makeTranslation(O.neck[0],  O.neck[1],  O.neck[2]).premultiply(tParent));
        pantsIM.setMatrixAt(i, m4.makeTranslation(O.pants[0], O.pants[1], O.pants[2]).premultiply(tParent));
        tieIM.setMatrixAt  (i, m4.makeTranslation(O.tie[0],   O.tie[1],   O.tie[2]).premultiply(tParent));

        // Head with X+Y rotation. Save the composed head transform so the eyes
        // can compose against it (eyes follow head look-around for free).
        eulHead.set(headRX, headRY, 0);
        tHeadRot.makeRotationFromEuler(eulHead);
        tHead.makeTranslation(O.head[0], O.head[1], O.head[2]).multiply(tHeadRot);
        headIM.setMatrixAt(i, m4.copy(tHead).premultiply(tParent));

        // Eyes — head-local position composed against the head transform,
        // then against the parent. Two tiny dots that turn with the head.
        m4eye.makeTranslation(O.leftEye[0], O.leftEye[1], O.leftEye[2]).premultiply(tHead);
        lEyeIM.setMatrixAt(i, m4eye.premultiply(tParent));
        m4eye.makeTranslation(O.rightEye[0], O.rightEye[1], O.rightEye[2]).premultiply(tHead);
        rEyeIM.setMatrixAt(i, m4eye.premultiply(tParent));

        // Arm pivots: rotate around X, then place arm and hand offsets
        tArmRot.makeRotationX(armLR);
        // Left arm
        tPivot.makeTranslation(O.leftArmPivot[0], O.leftArmPivot[1], O.leftArmPivot[2]).multiply(tArmRot);
        tLocal.makeTranslation(O.arm[0], O.arm[1], O.arm[2]).premultiply(tPivot);
        lArmIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tLocal.makeTranslation(O.hand[0], O.hand[1], O.hand[2]).premultiply(tPivot);
        lHandIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        // Right arm
        tArmRot.makeRotationX(armRR);
        tPivot.makeTranslation(O.rightArmPivot[0], O.rightArmPivot[1], O.rightArmPivot[2]).multiply(tArmRot);
        tLocal.makeTranslation(O.arm[0], O.arm[1], O.arm[2]).premultiply(tPivot);
        rArmIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tLocal.makeTranslation(O.hand[0], O.hand[1], O.hand[2]).premultiply(tPivot);
        rHandIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));

        // Leg pivots: same idea but legR is constant for sitting pose
        tLegRot.makeRotationX(legR);
        // Left leg + shoe
        tPivot.makeTranslation(O.leftLegPivot[0], O.leftLegPivot[1], O.leftLegPivot[2]).multiply(tLegRot);
        tLocal.makeTranslation(O.leg[0], O.leg[1], O.leg[2]).premultiply(tPivot);
        lLegIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        tLocal.makeTranslation(O.shoe[0], O.shoe[1], O.shoe[2]).premultiply(tPivot);
        lShoeIM.setMatrixAt(i, m4.copy(tLocal).premultiply(tParent));
        // Right leg + shoe
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
      // Geometries and materials are shared module-level — disposed only
      // if you want to fully tear down; for now leave them GC-managed.
    },
  };
}
