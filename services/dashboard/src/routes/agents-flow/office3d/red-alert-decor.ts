/**
 * Red Alert / OpenRA-style decor — additive visual props that nod to the
 * tremendous C&C aesthetic without touching the existing building geometry,
 * lighting, or materials. Everything in this file is pure decoration:
 *
 *   - buildRadarDish    rotating parabolic dome + concrete pole + blinking
 *                       red beacon. Goes on top of the central hall.
 *   - buildSandbagBarrier InstancedMesh row of tan sandbags with stacked
 *                       second row + per-instance color jitter. Flanks the
 *                       main entrance like a Soviet checkpoint.
 *   - buildCrates       InstancedMesh of wooden crates scattered along the
 *                       streets. Per-instance rotation + tone variation.
 *
 * Performance: each barrier and crate cluster is a single InstancedMesh (one
 * draw call per group), and the radar dish is ~5 meshes. Adding the lot
 * costs ~7 draw calls total.
 */

import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { applyPBR } from './office/_materials.js';

let THREE: any;
export function initRedAlertDecor(three: any): void { THREE = three; }

export interface RadarDishHandle {
  /** Root group attached to the parent (typically `staticGroup`). */
  group: any;
  /** Pivot under the dish — rotate this Y to spin the dome. */
  dishPivot: any;
  /** Light material — drive `emissiveIntensity` for the blinking beacon. */
  lightMat: any;
  dispose(): void;
}

/**
 * Build a parabolic radar dish on top of a concrete pole, with a red blinking
 * navigation beacon. The dish itself sits on a small `dishPivot` Group so the
 * caller can spin it (typically `dishPivot.rotation.y += dt * speed`).
 */
export function buildRadarDish(
  parent: any,
  position: { x: number; y?: number; z: number },
  opts: { dishRadius?: number; poleHeight?: number; tiltRad?: number } = {},
): RadarDishHandle {
  if (!THREE) throw new Error('[red-alert-decor] initRedAlertDecor(THREE) must run first');
  const baseY = position.y ?? 0;
  const poleH = opts.poleHeight ?? 1.8;
  const dishR = opts.dishRadius ?? 0.4;
  const tilt  = opts.tiltRad ?? -Math.PI / 3;

  const group = new THREE.Group();
  group.position.set(position.x, baseY, position.z);

  // Concrete pole — dark grey, slightly metallic so it picks up bloom lighting.
  const poleGeo = new THREE.CylinderGeometry(0.1, 0.15, poleH, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x404548, roughness: 0.7, metalness: 0.4 });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = poleH / 2;
  pole.castShadow = true;
  group.add(pole);

  // Top platform — small disc where the dish base sits.
  const platGeo = new THREE.CylinderGeometry(0.18, 0.22, 0.08, 8);
  const platMat = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.5, metalness: 0.55 });
  const platform = new THREE.Mesh(platGeo, platMat);
  platform.position.y = poleH + 0.04;
  group.add(platform);

  // Dish pivot — caller rotates this around Y to spin the dome.
  const dishPivot = new THREE.Group();
  dishPivot.position.y = poleH + 0.1;
  group.add(dishPivot);

  // Parabolic-ish dome — half-sphere tilted up.
  const dishGeo = new THREE.SphereGeometry(dishR, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const dishMat = new THREE.MeshStandardMaterial({
    color: 0xb0b6be, roughness: 0.4, metalness: 0.55,
    side: THREE.DoubleSide,
  });
  const dish = new THREE.Mesh(dishGeo, dishMat);
  dish.rotation.x = tilt;
  dish.position.y = 0.05;
  dish.castShadow = true;
  dishPivot.add(dish);

  // Transmitter spike — small cylinder pointing along the dish's facing axis.
  const transGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.28, 6);
  const transMat = new THREE.MeshStandardMaterial({ color: 0x808890, roughness: 0.3, metalness: 0.7 });
  const trans = new THREE.Mesh(transGeo, transMat);
  // Place at the dish's focal point + rotate same as dish.
  trans.position.set(0, 0.14, -dishR * 0.55);
  trans.rotation.x = tilt;
  dishPivot.add(trans);

  // Red navigation beacon on the very top of the pole — pulses via material.
  const lightGeo = new THREE.SphereGeometry(0.07, 8, 6);
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xff2020,
    emissive: new THREE.Color(0xff3030),
    emissiveIntensity: 0.9,
  });
  const light = new THREE.Mesh(lightGeo, lightMat);
  light.position.y = poleH + 0.13;
  group.add(light);

  parent.add(group);

  return {
    group, dishPivot, lightMat,
    dispose() {
      if (group.parent) group.parent.remove(group);
      group.traverse((c: any) => {
        c.geometry?.dispose();
        const m = c.material;
        if (Array.isArray(m)) m.forEach(x => x.dispose());
        else if (m) m.dispose();
      });
    },
  };
}

/**
 * Build a sandbag wall stretching from `from` to `to`. A single InstancedMesh
 * holds N tan boxes in a bottom row plus an optional second row stacked half-
 * offset (toggled with `opts.stacked`). Per-instance color jitter keeps the
 * wall from looking like a stamped photocopy.
 */
export function buildSandbagBarrier(
  parent: any,
  from: { x: number; z: number },
  to:   { x: number; z: number },
  opts: { stacked?: boolean; spacing?: number; tone?: number } = {},
): any {
  if (!THREE) throw new Error('[red-alert-decor] initRedAlertDecor(THREE) must run first');
  const spacing = opts.spacing ?? 0.55;
  const stacked = opts.stacked !== false;
  const tone = opts.tone ?? 0xa08050;

  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.1) return null;
  const count = Math.max(2, Math.floor(len / spacing));
  const totalInstances = count * (stacked ? 2 : 1);

  // Subtle RoundedBoxGeometry chamfer (segments=2, radius ≈5% of the 0.25
  // smallest dim) reads as soft cloth bags. Shared geometry → batching intact.
  // No baked vertex-AO here: instanceColor already drives per-bag tone and
  // vertexColors would conflict with it.
  const sandbagGeo = new RoundedBoxGeometry(0.5, 0.25, 0.4, 2, 0.012);
  const sandbagMat = new THREE.MeshStandardMaterial({ color: tone, roughness: 0.95, metalness: 0 });
  applyPBR(sandbagMat, 'cloth'); // tan canvas sandbags — cloth role
  const im = new THREE.InstancedMesh(sandbagGeo, sandbagMat, totalInstances);
  im.castShadow = true;
  im.receiveShadow = true;
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(totalInstances * 3), 3);

  const angle = Math.atan2(dx, dz);
  const m4 = new THREE.Matrix4();
  const base = new THREE.Color(tone);
  const tmp  = new THREE.Color();
  // Perpendicular offset for the stacked row — half a bag's width sideways.
  const perpX =  Math.cos(angle) * 0.04;
  const perpZ = -Math.sin(angle) * 0.04;

  let idx = 0;
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const x = from.x + dx * t;
    const z = from.z + dz * t;

    // Bottom row
    m4.makeRotationY(angle);
    m4.setPosition(x, 0.125, z);
    im.setMatrixAt(idx, m4);
    tmp.copy(base).multiplyScalar(0.82 + Math.random() * 0.35);
    im.setColorAt(idx, tmp);
    idx++;

    if (stacked) {
      m4.makeRotationY(angle);
      m4.setPosition(x + perpX, 0.375, z + perpZ);
      im.setMatrixAt(idx, m4);
      tmp.copy(base).multiplyScalar(0.82 + Math.random() * 0.35);
      im.setColorAt(idx, tmp);
      idx++;
    }
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  parent.add(im);
  return im;
}

/**
 * Build a cluster of wooden crates at the given positions. Single
 * InstancedMesh with per-instance rotation + tone jitter so a row of crates
 * doesn't read as identical clones.
 */
export function buildCrates(
  parent: any,
  positions: Array<{ x: number; z: number; rotY?: number; tilt?: number }>,
  opts: { size?: number; tone?: number } = {},
): any {
  if (!THREE) throw new Error('[red-alert-decor] initRedAlertDecor(THREE) must run first');
  if (positions.length === 0) return null;
  const size = opts.size ?? 0.45;
  const tone = opts.tone ?? 0x8b6534;

  // Subtle RoundedBoxGeometry chamfer (segments=2, radius ≈5% of size) softens
  // the crate edges. Shared geometry → single draw call preserved. No baked
  // vertex-AO: instanceColor already drives per-crate tone (vertexColors would
  // conflict). Wood tone has no fitting PBR role preset → material untouched.
  const crateGeo = new RoundedBoxGeometry(size, size, size, 2, size * 0.05);
  const crateMat = new THREE.MeshStandardMaterial({ color: tone, roughness: 0.9, metalness: 0 });
  const im = new THREE.InstancedMesh(crateGeo, crateMat, positions.length);
  im.castShadow = true;
  im.receiveShadow = true;
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(positions.length * 3), 3);

  const m4 = new THREE.Matrix4();
  const base = new THREE.Color(tone);
  const tmp  = new THREE.Color();

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    m4.makeRotationY(p.rotY ?? 0);
    if (p.tilt) {
      // Slight forward tilt so the crate looks dropped, not placed
      const tiltMat = new THREE.Matrix4().makeRotationX(p.tilt);
      m4.multiply(tiltMat);
    }
    m4.setPosition(p.x, size / 2, p.z);
    im.setMatrixAt(i, m4);
    tmp.copy(base).multiplyScalar(0.78 + Math.random() * 0.4);
    im.setColorAt(i, tmp);
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  parent.add(im);
  return im;
}
