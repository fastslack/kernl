/**
 * Animated office fixtures — wall clock + decorative elevator, plus the per-frame
 * driver that animates them. These share module-level mutable state so they live
 * together.
 */

import { rt } from '../runtime.js';
import { applyPBR } from '../office/_materials.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

let clockHourHand: any = null;
let clockMinuteHand: any = null;
let clockSecondHand: any = null;
let elevatorDoor1: any = null;
let elevatorDoor2: any = null;

/** Build a wall clock in the Central Hall */
export function buildWallClock(scene: any, hallCx: number, hallCz: number, hallW: number): void {
  if (!rt.THREE) return;
  const clockX = hallCx;
  const clockY = 2.8;
  const clockZ = hallCz;

  // Clock face (dark disk)
  const faceMat = new rt.THREE.MeshStandardMaterial({ color: 0x0a0e1a, roughness: 0.3, metalness: 0.4 });
  const face = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.9, 0.9, 0.05, 32), faceMat);
  face.rotation.x = Math.PI / 2;
  face.position.set(clockX, clockY, clockZ);
  scene.add(face);

  // Rim (metallic ring)
  const rimMat = new rt.THREE.MeshStandardMaterial({ color: 0x4a5a7a, roughness: 0.2, metalness: 0.7 });
  const rim = new rt.THREE.Mesh(new rt.THREE.TorusGeometry(0.9, 0.05, 8, 32), rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(clockX, clockY, clockZ);
  scene.add(rim);

  // Hour markers (12 small dots)
  const dotMat = new rt.THREE.MeshBasicMaterial({ color: 0x8899bb });
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const r = 0.72;
    const dot = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(i % 3 === 0 ? 0.05 : 0.03, 6, 6), dotMat);
    dot.position.set(
      clockX + Math.sin(angle) * r,
      clockY + Math.cos(angle) * r,
      clockZ - 0.03,
    );
    scene.add(dot);
  }

  // Center pivot
  const pivotMat = new rt.THREE.MeshStandardMaterial({ color: 0xc9a84c, metalness: 0.6, roughness: 0.3 });
  const pivot = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.04, 8, 8), pivotMat);
  pivot.position.set(clockX, clockY, clockZ - 0.04);
  scene.add(pivot);

  // Hour hand
  const hourGeo = new rt.THREE.BoxGeometry(0.04, 0.4, 0.015);
  hourGeo.translate(0, 0.2, 0);
  clockHourHand = new rt.THREE.Mesh(hourGeo, new rt.THREE.MeshStandardMaterial({ color: 0xc0c5d8, metalness: 0.4 }));
  clockHourHand.position.set(clockX, clockY, clockZ - 0.05);
  scene.add(clockHourHand);

  // Minute hand
  const minGeo = new rt.THREE.BoxGeometry(0.03, 0.55, 0.012);
  minGeo.translate(0, 0.275, 0);
  clockMinuteHand = new rt.THREE.Mesh(minGeo, new rt.THREE.MeshStandardMaterial({ color: 0xd0d4e0, metalness: 0.3 }));
  clockMinuteHand.position.set(clockX, clockY, clockZ - 0.06);
  scene.add(clockMinuteHand);

  // Second hand
  const secGeo = new rt.THREE.BoxGeometry(0.012, 0.6, 0.008);
  secGeo.translate(0, 0.3, 0);
  clockSecondHand = new rt.THREE.Mesh(secGeo, new rt.THREE.MeshStandardMaterial({ color: 0xef4444, emissive: new rt.THREE.Color(0xef4444), emissiveIntensity: 0.3 }));
  clockSecondHand.position.set(clockX, clockY, clockZ - 0.07);
  scene.add(clockSecondHand);
}

/** Build a decorative elevator in a corner of the building */
export function buildElevator(
  scene: any,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): void {
  if (!rt.THREE) return;
  // Position: front-right corner of the building
  const ex = bounds.maxX + 1;
  const ez = bounds.minZ - 1;
  const EW = 2.5, ED = 2.0, EH = 4.0;

  // Shaft walls (3 sides — front is open/doors)
  const shaftMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a3050, roughness: 0.5, metalness: 0.2 });
  const backW = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(EW, EH, 0.15), shaftMat);
  backW.position.set(ex, EH / 2, ez - ED / 2); scene.add(backW);
  const leftW = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.15, EH, ED), shaftMat);
  leftW.position.set(ex - EW / 2, EH / 2, ez); scene.add(leftW);
  const rightW = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.15, EH, ED), shaftMat);
  rightW.position.set(ex + EW / 2, EH / 2, ez); scene.add(rightW);

  // Floor inside elevator
  const elevFloor = new rt.THREE.Mesh(
    new rt.THREE.PlaneGeometry(EW, ED),
    new rt.THREE.MeshStandardMaterial({ color: 0x1a2238, roughness: 0.3, metalness: 0.3 }),
  );
  elevFloor.rotation.x = -Math.PI / 2;
  elevFloor.position.set(ex, 0.02, ez);
  scene.add(elevFloor);

  // Ceiling
  const elevCeil = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(EW, 0.1, ED),
    new rt.THREE.MeshStandardMaterial({ color: 0x2a3050, emissive: new rt.THREE.Color(0xffeedd), emissiveIntensity: 0.15 }),
  );
  elevCeil.position.set(ex, EH, ez);
  scene.add(elevCeil);

  // Doors (two sliding panels)
  const doorMat = new rt.THREE.MeshStandardMaterial({ color: 0x4a5a7a, roughness: 0.2, metalness: 0.6 });
  elevatorDoor1 = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(EW / 2 - 0.05, EH - 0.3, 0.06), doorMat);
  elevatorDoor1.position.set(ex - EW / 4, EH / 2 - 0.15, ez + ED / 2);
  scene.add(elevatorDoor1);

  elevatorDoor2 = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(EW / 2 - 0.05, EH - 0.3, 0.06), doorMat);
  elevatorDoor2.position.set(ex + EW / 4, EH / 2 - 0.15, ez + ED / 2);
  scene.add(elevatorDoor2);

  // Door frame — static structural metal (NOT the sliding door panels, which
  // are animated above with doorMat). Subtle RoundedBoxGeometry chamfer
  // (segments=2, radius ≈4% of the 0.12 smallest dim) + PBR metal role.
  const dfMat = new rt.THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.3, metalness: 0.5 });
  applyPBR(dfMat, 'metal');
  const dfTop = new rt.THREE.Mesh(new RoundedBoxGeometry(EW + 0.3, 0.15, 0.12, 2, 0.005), dfMat);
  dfTop.position.set(ex, EH - 0.07, ez + ED / 2); scene.add(dfTop);
  for (const s of [-1, 1]) {
    const dfSide = new rt.THREE.Mesh(new RoundedBoxGeometry(0.12, EH, 0.12, 2, 0.005), dfMat);
    dfSide.position.set(ex + s * (EW / 2 + 0.06), EH / 2, ez + ED / 2); scene.add(dfSide);
  }

  // Call button panel
  const panel = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(0.2, 0.4, 0.04),
    new rt.THREE.MeshStandardMaterial({ color: 0x1a1d2a, roughness: 0.4, metalness: 0.3 }),
  );
  panel.position.set(ex + EW / 2 + 0.2, 1.2, ez + ED / 2);
  scene.add(panel);
  // Buttons (up/down)
  for (let bi = 0; bi < 2; bi++) {
    const btn = new rt.THREE.Mesh(
      new rt.THREE.CircleGeometry(0.04, 8),
      new rt.THREE.MeshStandardMaterial({ color: 0x4a6ab8, emissive: new rt.THREE.Color(0x4a6ab8), emissiveIntensity: 0.3 }),
    );
    btn.position.set(ex + EW / 2 + 0.22, 1.3 - bi * 0.15, ez + ED / 2);
    scene.add(btn);
  }

  // Sign above
  if (rt.CSS2DObject) {
    const signDiv = document.createElement('div');
    signDiv.textContent = 'ELEVATOR';
    signDiv.style.cssText = `font:600 8px 'Syne',sans-serif;color:#4a6ab8;letter-spacing:2px;
      background:rgba(0,0,8,0.6);padding:2px 8px;border-radius:2px;`;
    const lbl = new rt.CSS2DObject(signDiv);
    lbl.position.set(ex, EH + 0.3, ez + ED / 2);
    scene.add(lbl);
  }
}

/** Animate ambient elements each frame */
export function updateAmbiance(timeSec: number): void {
  // Clock hands — real time
  const now = new Date();
  const h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds() + now.getMilliseconds() / 1000;
  if (clockHourHand) clockHourHand.rotation.z = -((h + m / 60) / 12) * Math.PI * 2;
  if (clockMinuteHand) clockMinuteHand.rotation.z = -(m / 60) * Math.PI * 2;
  if (clockSecondHand) clockSecondHand.rotation.z = -(s / 60) * Math.PI * 2;

  // Elevator doors — open/close cycle (12s open, 8s closed)
  if (elevatorDoor1 && elevatorDoor2) {
    const cycle = timeSec % 20;
    const openAmount = cycle < 3 ? cycle / 3 : cycle < 12 ? 1 : cycle < 15 ? 1 - (cycle - 12) / 3 : 0;
    const slide = openAmount * 0.55;
    elevatorDoor1.position.x = elevatorDoor1.userData._baseX ?? (elevatorDoor1.userData._baseX = elevatorDoor1.position.x);
    elevatorDoor2.position.x = elevatorDoor2.userData._baseX ?? (elevatorDoor2.userData._baseX = elevatorDoor2.position.x);
    elevatorDoor1.position.x = elevatorDoor1.userData._baseX - slide;
    elevatorDoor2.position.x = elevatorDoor2.userData._baseX + slide;
  }
}
