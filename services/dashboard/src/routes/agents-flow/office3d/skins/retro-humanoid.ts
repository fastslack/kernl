/** Create and animate pixel-grid humanoid figures.
 *
 *  Pose math lives in `anim/poses/*` so the same curves drive both this
 *  per-mesh path AND the InstancedMesh pool in humanoid-pool.ts. Tweak the
 *  cadence/swing in one place and both paths update together.
 */

import type { HumanoidParts, Walker } from '../types.js';
import { retroBodyGeometries } from '../retro-character.js';

let THREE: any;

export function initRetroHumanoid(three: any) { THREE = three; }

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
export function createRetroHumanoid(
  color: string,
  skinColor: number = 0xe8d5c0,
  scale: number = 1,
  hairColor?: number,
  pantsColor?: number,
): HumanoidParts {
  const col = new THREE.Color(color);
  const geo = retroBodyGeometries(THREE);
  const group = new THREE.Group();
  group.scale.setScalar(scale);

  const hairCol  = hairColor  !== undefined ? new THREE.Color(hairColor)  : col.clone().multiplyScalar(0.3);
  const pantsCol = pantsColor !== undefined ? new THREE.Color(pantsColor) : new THREE.Color(0x2a2d3a);

  // Torso
  const torsoMat = new THREE.MeshLambertMaterial({ color: col });
  const torso = new THREE.Mesh(
    geo.torso,
    torsoMat,
  );
  torso.position.y = 1.05;
  group.add(torso);

  // Tie — small darkened-clothes accent on the chest. Reads as "office worker"
  // from a glance; tinted from the flow color so it stays color-coded.
  const tieCol = col.clone().multiplyScalar(0.45);
  const tieMat = new THREE.MeshLambertMaterial({ color: tieCol });
  const tie = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.32, 0.02),
    tieMat,
  );
  tie.position.set(0, 1.07, 0.16);
  group.add(tie);

  // Stepped pixel silhouette, with square facial details.
  const headGeo = geo.head;
  const headMat = new THREE.MeshLambertMaterial({ color: skinColor });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = 1.55;
  group.add(head);
  head.userData.animationStyle = 'retro';

  // Eyes — two tiny dark dots on the front of the head. MeshBasic so they
  // don't need lighting; they're so small that any lit shading would noise.
  // Children of `head` so they follow head rotation (look-around in poses).
  const eyeGeo = geo.eye;
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
  const leftEye = meshAt(eyeGeo, eyeMat, -0.06, 0.02, 0.13);
  const rightEye = meshAt(eyeGeo, eyeMat, 0.06, 0.02, 0.13);
  head.add(leftEye);
  head.add(rightEye);

  // Hair
  const hairMat = new THREE.MeshLambertMaterial({ color: hairCol });
  const hair = new THREE.Mesh(
    geo.hair,
    hairMat,
  );
  hair.position.y = 1.57;
  group.add(hair);

  // Neck
  const neckMat = new THREE.MeshLambertMaterial({ color: skinColor });
  const neck = new THREE.Mesh(
    geo.neck,
    neckMat,
  );
  neck.position.y = 1.38;
  group.add(neck);

  // Arms
  const armGeo = geo.arm;
  const armMat = new THREE.MeshLambertMaterial({ color: col.clone().multiplyScalar(0.8) });
  const handGeo = geo.hand;
  const handMat = new THREE.MeshLambertMaterial({ color: skinColor });

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
  const pantsMat = new THREE.MeshLambertMaterial({ color: pantsCol });
  const pants = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.2, 0.3),
    pantsMat,
  );
  pants.position.y = 0.7;
  group.add(pants);

  // Legs
  const legGeo = geo.leg;
  const legMat = new THREE.MeshLambertMaterial({ color: pantsCol });
  const shoeGeo = geo.shoe;
  const shoeMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });

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

