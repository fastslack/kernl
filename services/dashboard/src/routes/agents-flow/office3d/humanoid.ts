/** Create and animate detailed humanoid figures.
 *
 *  Pose math lives in `anim/poses/*` so the same curves drive both this
 *  per-mesh path AND the InstancedMesh pool in humanoid-pool.ts. Tweak the
 *  cadence/swing in one place and both paths update together.
 */

import type { HumanoidParts, Walker } from './types.js';
import { computeWalkPose, computeRunPose } from './anim/poses/walk.js';
import { computeSittingPose, type SittingMode } from './anim/poses/sitting.js';
import { computeTalkingPose } from './anim/poses/talking.js';
import { applyPBR } from './office/_materials.js';
import { rt } from './runtime.js';

let THREE: any;

export function initHumanoid(three: any) { THREE = three; }

/** Create mesh and set its position (position is read-only in Three.js) */
function meshAt(geo: any, mat: any, x: number, y: number, z: number): any {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

/**
 * Build a low-poly humanoid with torso, head, hair, neck, arms (with hands),
 * legs (with shoes), pants, eyes and tie. Each limb is on a pivot for
 * animation. `hairColor` / `pantsColor` are optional — when undefined we fall
 * back to a tone derived from `color` (so old callers keep working).
 */
export function createHumanoid(
  color: string,
  skinColor: number = 0xe8d5c0,
  scale: number = 1,
  hairColor?: number,
  pantsColor?: number,
): HumanoidParts {
  const col = new THREE.Color(color);
  const group = new THREE.Group();
  group.scale.setScalar(scale);

  const hairCol  = hairColor  !== undefined ? new THREE.Color(hairColor)  : col.clone().multiplyScalar(0.3);
  const pantsCol = pantsColor !== undefined ? new THREE.Color(pantsColor) : new THREE.Color(0x2a2d3a);

  // Torso
  const torsoMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.65, metalness: 0.05 });
  applyPBR(torsoMat, 'cloth');
  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.6, 0.3),
    torsoMat,
  );
  torso.position.y = 1.05;
  group.add(torso);

  // Tie — small darkened-clothes accent on the chest. Reads as "office worker"
  // from a glance; tinted from the flow color so it stays color-coded.
  const tieCol = col.clone().multiplyScalar(0.45);
  const tieMat = new THREE.MeshStandardMaterial({ color: tieCol, roughness: 0.5, metalness: 0.1 });
  applyPBR(tieMat, 'cloth');
  const tie = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.32, 0.02),
    tieMat,
  );
  tie.position.set(0, 1.07, 0.16);
  group.add(tie);

  // Head — slightly elongated (scale.y bake during geometry creation cost-free)
  // so the silhouette reads as a head rather than a ball.
  const headGeo = new THREE.SphereGeometry(0.18, 10, 10);
  headGeo.scale(1, 1.08, 1);
  const headMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.8 });
  applyPBR(headMat, 'skin');
  if (!headMat.emissive || headMat.emissive.getHex() === 0x000000) {
    headMat.emissive = new rt.THREE.Color(0x2a1410);
    headMat.emissiveIntensity = 0.06;
  }
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = 1.55;
  group.add(head);

  // Eyes — two tiny dark dots on the front of the head. MeshBasic so they
  // don't need lighting; they're so small that any lit shading would noise.
  // Children of `head` so they follow head rotation (look-around in poses).
  const eyeGeo = new THREE.SphereGeometry(0.022, 5, 5);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
  const leftEye = meshAt(eyeGeo, eyeMat, -0.06, 0.02, 0.155);
  const rightEye = meshAt(eyeGeo, eyeMat, 0.06, 0.02, 0.155);
  head.add(leftEye);
  head.add(rightEye);

  // Hair
  const hairMat = new THREE.MeshStandardMaterial({ color: hairCol, roughness: 0.9 });
  applyPBR(hairMat, 'cloth');
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.19, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6),
    hairMat,
  );
  hair.position.y = 1.57;
  group.add(hair);

  // Neck
  const neckMat = new THREE.MeshStandardMaterial({ color: skinColor });
  applyPBR(neckMat, 'skin');
  if (!neckMat.emissive || neckMat.emissive.getHex() === 0x000000) {
    neckMat.emissive = new rt.THREE.Color(0x2a1410);
    neckMat.emissiveIntensity = 0.06;
  }
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 0.15, 6),
    neckMat,
  );
  neck.position.y = 1.38;
  group.add(neck);

  // Arms
  const armGeo = new THREE.CapsuleGeometry(0.06, 0.45, 4, 8);
  const armMat = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.8), roughness: 0.7 });
  applyPBR(armMat, 'cloth');
  const handGeo = new THREE.SphereGeometry(0.05, 6, 6);
  const handMat = new THREE.MeshStandardMaterial({ color: skinColor });
  applyPBR(handMat, 'skin');
  if (!handMat.emissive || handMat.emissive.getHex() === 0x000000) {
    handMat.emissive = new rt.THREE.Color(0x2a1410);
    handMat.emissiveIntensity = 0.06;
  }

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(-0.32, 1.28, 0);
  leftArmPivot.add(meshAt(armGeo, armMat, 0, -0.28, 0));
  leftArmPivot.add(meshAt(handGeo, handMat, 0, -0.52, 0));
  group.add(leftArmPivot);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(0.32, 1.28, 0);
  rightArmPivot.add(meshAt(armGeo, armMat, 0, -0.28, 0));
  rightArmPivot.add(meshAt(handGeo, handMat, 0, -0.52, 0));
  group.add(rightArmPivot);

  // Pants
  const pantsMat = new THREE.MeshStandardMaterial({ color: pantsCol, roughness: 0.8 });
  applyPBR(pantsMat, 'cloth');
  const pants = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.2, 0.3),
    pantsMat,
  );
  pants.position.y = 0.7;
  group.add(pants);

  // Legs
  const legGeo = new THREE.CapsuleGeometry(0.07, 0.5, 4, 8);
  const legMat = new THREE.MeshStandardMaterial({ color: pantsCol, roughness: 0.8 });
  applyPBR(legMat, 'cloth');
  const shoeGeo = new THREE.BoxGeometry(0.1, 0.06, 0.18);
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(-0.12, 0.62, 0);
  leftLegPivot.add(meshAt(legGeo, legMat, 0, -0.3, 0));
  leftLegPivot.add(meshAt(shoeGeo, shoeMat, 0, -0.56, 0.03));
  group.add(leftLegPivot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(0.12, 0.62, 0);
  rightLegPivot.add(meshAt(legGeo, legMat, 0, -0.3, 0));
  rightLegPivot.add(meshAt(shoeGeo, shoeMat, 0, -0.56, 0.03));
  group.add(rightLegPivot);

  return { group, head, torso, leftArm: leftArmPivot, rightArm: rightArmPivot, leftLeg: leftLegPivot, rightLeg: rightLegPivot };
}

/** Apply a walking pose to a Walker each frame. timeSec is accumulated real seconds. */
export function animateWalk(w: Walker, _deltaSec?: number) {
  const p = computeWalkPose(w.timeSec ?? w.age);
  w.leftLeg.rotation.x = p.legL;
  w.rightLeg.rotation.x = p.legR;
  w.leftArm.rotation.x = p.armL;
  w.rightArm.rotation.x = p.armR;
  w.group.position.y = p.bobY;
  w.torso.rotation.z = p.torsoZ;
  w.head.rotation.y = p.headY;
}

/** Apply a running pose to a Walker — faster cadence, wider stride, forward lean. */
export function animateRun(w: Walker, _deltaSec?: number) {
  const p = computeRunPose(w.timeSec ?? w.age);
  w.leftLeg.rotation.x = p.legL;
  w.rightLeg.rotation.x = p.legR;
  w.leftArm.rotation.x = p.armL;
  w.rightArm.rotation.x = p.armR;
  w.group.position.y = p.bobY;
  w.torso.rotation.x = p.torsoX;
  w.torso.rotation.z = p.torsoZ;
  w.head.rotation.x = p.headX;
  w.head.rotation.y = p.headY;
}

/** Apply a seated pose to a worker. The flags select the pose mode (priority:
 *  spoken-to > stretching > running > idle); timeSec is accumulated real
 *  seconds for frame-rate independence. */
export function animateSitting(
  parts: { head: any; leftArm: any; rightArm: any },
  timeSec: number,
  phase: number,
  isRunning: boolean,
  isBeingSpokenTo: boolean = false,
  isStretching: boolean = false,
) {
  const mode: SittingMode =
    isBeingSpokenTo ? 'spoken-to' :
    isStretching   ? 'stretching' :
    isRunning      ? 'running' :
    'idle';
  const p = computeSittingPose(mode, timeSec, phase);
  parts.leftArm.rotation.x = p.armL;
  parts.rightArm.rotation.x = p.armR;
  parts.head.rotation.x = p.headX;
  parts.head.rotation.y = p.headY;
}

/** Apply a talking pose to a standing humanoid mid-conversation. */
export function animateTalking(
  parts: { head: any; torso: any; leftArm: any; rightArm: any; leftLeg: any; rightLeg: any },
  elapsedSec: number,
  phase: number,
) {
  const p = computeTalkingPose(elapsedSec, phase);
  parts.leftLeg.rotation.x = p.legL;
  parts.rightLeg.rotation.x = p.legR;
  parts.leftArm.rotation.x = p.armLX;
  parts.rightArm.rotation.x = p.armRX;
  parts.rightArm.rotation.z = p.armRZ;
  parts.head.rotation.x = p.headX;
  parts.head.rotation.y = p.headY;
  parts.torso.rotation.z = p.torsoZ;
}
