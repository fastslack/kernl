/**
 * The construction crew — the stock humanoid (humanoid.ts) in a hi-vis vest,
 * a hard hat and a hammer, driven by the walk and hammer poses.
 */

import { rt } from '../runtime.js';
import { createHumanoid } from '../humanoid.js';
import { computeWalkPose } from '../anim/poses/walk.js';
import { computeHammerPose } from '../anim/poses/hammer.js';
import type { HumanoidParts } from '../types.js';
import { WALKER_SCALE } from '../walkers/spawn.js';

const VEST = '#ff7a1a';
const SKIN_TONES = [0xe8d5c0, 0xc89f7a, 0x9a6b4a, 0xf0dccb];

export interface Builder {
  parts: HumanoidParts;
  /** Per-builder offset so the crew doesn't swing in unison. */
  phase: number;
}

export function createBuilder(index: number): Builder {
  const T = rt.THREE;
  // Same size as the agents walking the floor.
  const parts = createHumanoid(VEST, SKIN_TONES[index % SKIN_TONES.length], WALKER_SCALE, 0x3a2a1a, 0x2f3a52);

  // Hard hat: dome + brim, on the head so it follows the head's pose.
  const hatMat = new T.MeshStandardMaterial({ color: 0xffd21a, roughness: 0.35, metalness: 0.1 });
  const dome = new T.Mesh(new T.SphereGeometry(0.205, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
  dome.position.y = 0.05;
  parts.head.add(dome);
  const brim = new T.Mesh(new T.CylinderGeometry(0.25, 0.25, 0.025, 14), hatMat);
  brim.position.set(0, 0.05, 0.03);
  parts.head.add(brim);

  // Reflective vest stripes across the torso.
  const stripeMat = new T.MeshBasicMaterial({ color: 0xe6f0ff });
  for (const y of [-0.1, 0.12]) {
    const stripe = new T.Mesh(new T.BoxGeometry(0.52, 0.045, 0.32), stripeMat);
    stripe.position.y = y;
    parts.torso.add(stripe);
  }

  // Hammer in the right hand (the hand sits at y = -0.52 on the arm pivot).
  const handle = new T.Mesh(new T.BoxGeometry(0.04, 0.04, 0.42), new T.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 }));
  handle.position.set(0, -0.54, 0.16);
  parts.rightArm.add(handle);
  const headMesh = new T.Mesh(new T.BoxGeometry(0.1, 0.09, 0.16), new T.MeshStandardMaterial({ color: 0x8892a0, roughness: 0.3, metalness: 0.8 }));
  headMesh.position.set(0, -0.54, 0.37);
  headMesh.rotation.x = Math.PI / 2;
  parts.rightArm.add(headMesh);

  parts.group.traverse((c: any) => { if (c.isMesh) c.castShadow = false; });
  return { parts, phase: index * 0.37 };
}

export function poseWalking(b: Builder, timeSec: number): void {
  const p = computeWalkPose(timeSec + b.phase);
  const { parts } = b;
  parts.leftLeg.rotation.x = p.legL;
  parts.rightLeg.rotation.x = p.legR;
  parts.leftArm.rotation.x = p.armL;
  parts.rightArm.rotation.x = p.armR;
  parts.torso.rotation.x = 0;
  parts.torso.rotation.z = p.torsoZ;
  parts.head.rotation.x = 0;
  parts.head.rotation.y = p.headY;
}

export function poseHammering(b: Builder, timeSec: number): void {
  const p = computeHammerPose(timeSec, b.phase);
  const { parts } = b;
  parts.leftLeg.rotation.x = p.legL;
  parts.rightLeg.rotation.x = p.legR;
  parts.leftArm.rotation.x = p.armLX;
  parts.rightArm.rotation.x = p.armRX;
  parts.torso.rotation.x = p.torsoX;
  parts.torso.rotation.z = 0;
  parts.head.rotation.x = p.headX;
  parts.head.rotation.y = 0;
}

export function disposeBuilder(b: Builder): void {
  b.parts.group.parent?.remove(b.parts.group);
  b.parts.group.traverse((c: any) => {
    c.geometry?.dispose?.();
    if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m: any) => m.dispose?.());
  });
}
