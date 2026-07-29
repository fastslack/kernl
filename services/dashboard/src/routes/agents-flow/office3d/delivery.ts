/**
 * Delivery animation — trucks arriving at the front entrance, a driver that
 * carries a package to reception, and a recipient walker sent from their desk
 * to collect it. One active delivery at a time; subsequent requests queue.
 *
 * Designed to be resource-conscious:
 *   - Truck + driver meshes are created once and reused (hidden between deliveries).
 *   - Only one active truck + driver in the scene at any time.
 *   - No PointLights on the truck — headlights are emissive materials.
 *   - Linear interpolation along pre-computed waypoint lists; no pathfinding.
 */

import type { Vec3 } from './types.js';
import { pathLength, interpolatePath, pathDirection } from './anim/path.js';
import { computeCarrierPose } from './anim/poses/walk.js';

let THREE: any;
let CSS2DObject: any;

export function initDelivery(three: any, css2d: any) {
  THREE = three;
  CSS2DObject = css2d;
}

export interface DeliveryInfo {
  flowId: string;         // recipient flow id (for pickup walker)
  flowColor: string;      // CSS colour string (hex)
  label: string;          // short label shown on the package (e.g. "MAIL")
  packageColor?: number;  // package tint (defaults to flowColor)
}

export interface DeliveryContext {
  entryCX: number;        // X centre of staircase / entrance
  plinthOuterZ1: number;  // Z of the top of the staircase (plinth edge)
  pedOuterZ1: number;     // Z at the bottom of the staircase (pedestrian sidewalk)
  southLaneZ: number;     // Z centre of the south street lane (truck stops here)
  plinthDrop: number;     // Y drop from plinth (y=0) to street (y=-plinthDrop)
  streetDrop: number;     // Y drop from plinth to asphalt (slightly more)
  receptionDrop: Vec3;        // Counter position where package is placed
  receptionFront: Vec3;       // Recipient walker's target (interior side of counter)
  receptionDriverFront: Vec3; // Delivery driver's stop point (door side of counter)
  // Called by the delivery system when the package has been placed on the
  // counter and the driver has left. The host should send a walker from the
  // recipient flow's nearest agent to `receptionFront`. When that walker
  // arrives, call `markPackagePickedUp(flowId)` below.
  sendRecipientWalker: (info: DeliveryInfo) => void;
}

type Phase =
  | 'idle'
  | 'truck_arriving'
  | 'driver_out_of_truck'
  | 'driver_walking_in'
  | 'driver_dropping'
  | 'driver_walking_out'
  | 'truck_leaving'
  | 'awaiting_pickup';

interface ActiveDelivery {
  info: DeliveryInfo;
  phase: Phase;
  phaseTime: number;
  // Package mesh reparented along the lifecycle:
  //   truck cargo → driver hand → counter drop → removed on pickup
  pkg: any;
  pkgLabel: any | null;
  // Pre-computed waypoint lists (position) with total length in seconds.
  inboundPath: Vec3[];
  outboundPath: Vec3[];
  inboundLen: number;
  outboundLen: number;
}

let queue: DeliveryInfo[] = [];
let active: ActiveDelivery | null = null;

// Cached, reusable assets
let truck: any = null;
let truckWheels: any[] = [];
let truckCargoAnchor: any = null;   // where the package sits while inside the truck
let driver: any = null;             // humanoid group
let driverParts: { leftLeg: any; rightLeg: any; leftArm: any; rightArm: any; hand: any } | null = null;
let animTime = 0;

let ctx: DeliveryContext | null = null;

// Speeds / durations (tuned for visibility without feeling slow)
const TRUCK_SPEED = 6.5;      // units / sec along the street
const DRIVER_SPEED = 4.2;     // units / sec along the path
const DROP_DURATION = 1.2;    // seconds at the counter
const PICKUP_TIMEOUT = 45;    // safety: if no pickup after 45s, clear package

/** Build the reusable truck + driver meshes once. Truck is parked off-screen. */
export function initDeliveryScene(scene: any, context: DeliveryContext): void {
  if (!THREE) return;
  ctx = context;
  if (truck) return; // already built

  // ═════ Truck ═════
  truck = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd8d5cc, roughness: 0.5, metalness: 0.25 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x2a3555, roughness: 0.5, metalness: 0.25 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x1a2030, roughness: 0.1, metalness: 0.2,
    emissive: new THREE.Color(0x223355), emissiveIntensity: 0.25,
    transparent: true, opacity: 0.75,
  });
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff4d8 });
  const taillightMat = new THREE.MeshBasicMaterial({ color: 0xff3a30 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.75 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x6a7080, roughness: 0.3, metalness: 0.7 });

  // Cargo box (rear)
  const cargo = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.2, 2.4), bodyMat);
  cargo.position.set(0.6, 1.3, 0);
  cargo.castShadow = true; cargo.receiveShadow = true;
  truck.add(cargo);

  // Rear doors (darker accent strip)
  const rearDoors = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.9, 2.0), accentMat);
  rearDoors.position.set(2.35, 1.3, 0);
  truck.add(rearDoors);
  // Handle
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.35), rimMat);
  handle.position.set(2.4, 1.2, 0);
  truck.add(handle);

  // Side logo strip
  for (const side of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.35, 0.02), accentMat);
    stripe.position.set(0.6, 1.7, side * 1.205);
    truck.add(stripe);
    const stripeLowr = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.08, 0.02), new THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.35, metalness: 0.6 }));
    stripeLowr.position.set(0.6, 1.3, side * 1.21);
    truck.add(stripeLowr);
  }

  // Cab
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.5, 2.2), bodyMat);
  cab.position.set(-1.4, 0.95, 0);
  cab.castShadow = true;
  truck.add(cab);

  // Cab windscreen (angled)
  const ws = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 1.9), glassMat);
  ws.position.set(-2.25, 1.3, 0);
  ws.rotation.z = -0.2;
  truck.add(ws);

  // Side windows
  for (const side of [-1, 1]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.65, 0.04), glassMat);
    sw.position.set(-1.4, 1.3, side * 1.12);
    truck.add(sw);
  }

  // Headlights
  for (const side of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.3), headlightMat);
    hl.position.set(-2.3, 0.7, side * 0.7);
    truck.add(hl);
  }
  // Taillights
  for (const side of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.25), taillightMat);
    tl.position.set(2.32, 0.8, side * 0.9);
    truck.add(tl);
  }

  // Bumper
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 2.0), accentMat);
  bumper.position.set(-2.35, 0.3, 0);
  truck.add(bumper);

  // Wheels (4) — tracked for rotation animation
  truckWheels = [];
  const wheelR = 0.35, wheelW = 0.3;
  const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 14);
  const rimGeo = new THREE.CylinderGeometry(wheelR * 0.55, wheelR * 0.55, wheelW + 0.02, 8);
  for (const dx of [-1.4, 1.3]) {
    for (const dz of [-1.05, 1.05]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(dx, wheelR, dz);
      truck.add(wheel);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.set(dx, wheelR, dz);
      truck.add(rim);
      truckWheels.push(wheel, rim);
    }
  }

  // Anchor for the package while inside the truck (pinned to cargo interior)
  truckCargoAnchor = new THREE.Object3D();
  truckCargoAnchor.position.set(0.6, 1.5, 0);
  truck.add(truckCargoAnchor);

  truck.visible = false;
  scene.add(truck);

  // ═════ Driver (simple humanoid built inline to avoid circular import) ═════
  driver = new THREE.Group();
  const uniformCol = new THREE.Color(0x3a5f8a);
  const skinCol = 0xe8d5c0;
  const uniformMat = new THREE.MeshStandardMaterial({ color: uniformCol, roughness: 0.7 });
  const skinMat = new THREE.MeshStandardMaterial({ color: skinCol, roughness: 0.8 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: 0x2a2d3a, roughness: 0.85 });

  const dTorso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.3), uniformMat);
  dTorso.position.y = 1.05; driver.add(dTorso);
  // Cap
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.08, 12), new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.5 }));
  cap.position.y = 1.7; driver.add(cap);
  const capBrim = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.05), new THREE.MeshStandardMaterial({ color: 0x1a2030 }));
  capBrim.position.set(0, 1.68, 0.2); driver.add(capBrim);
  const dHead = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), skinMat);
  dHead.position.y = 1.55; driver.add(dHead);
  const dPants = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.3), pantsMat);
  dPants.position.y = 0.7; driver.add(dPants);

  const armGeo = new THREE.CapsuleGeometry(0.06, 0.45, 4, 8);
  const handGeo = new THREE.SphereGeometry(0.05, 6, 6);
  const legGeo = new THREE.CapsuleGeometry(0.07, 0.5, 4, 8);
  const shoeGeo = new THREE.BoxGeometry(0.1, 0.06, 0.18);
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(-0.32, 1.28, 0);
  const leftArm = new THREE.Mesh(armGeo, uniformMat); leftArm.position.y = -0.28; leftArmPivot.add(leftArm);
  const leftHand = new THREE.Mesh(handGeo, skinMat); leftHand.position.y = -0.52; leftArmPivot.add(leftHand);
  driver.add(leftArmPivot);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(0.32, 1.28, 0);
  const rightArm = new THREE.Mesh(armGeo, uniformMat); rightArm.position.y = -0.28; rightArmPivot.add(rightArm);
  const rightHand = new THREE.Mesh(handGeo, skinMat); rightHand.position.y = -0.52; rightArmPivot.add(rightHand);
  driver.add(rightArmPivot);
  // Held-package anchor follows the right hand
  const holdAnchor = new THREE.Object3D();
  holdAnchor.position.set(0, -0.52, 0.15);
  rightArmPivot.add(holdAnchor);

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(-0.12, 0.62, 0);
  const leftLeg = new THREE.Mesh(legGeo, pantsMat); leftLeg.position.y = -0.3; leftLegPivot.add(leftLeg);
  const leftShoe = new THREE.Mesh(shoeGeo, shoeMat); leftShoe.position.set(0, -0.56, 0.03); leftLegPivot.add(leftShoe);
  driver.add(leftLegPivot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(0.12, 0.62, 0);
  const rightLeg = new THREE.Mesh(legGeo, pantsMat); rightLeg.position.y = -0.3; rightLegPivot.add(rightLeg);
  const rightShoe = new THREE.Mesh(shoeGeo, shoeMat); rightShoe.position.set(0, -0.56, 0.03); rightLegPivot.add(rightShoe);
  driver.add(rightLegPivot);

  driverParts = { leftLeg: leftLegPivot, rightLeg: rightLegPivot, leftArm: leftArmPivot, rightArm: rightArmPivot, hand: holdAnchor };
  driver.visible = false;
  scene.add(driver);
}

export function enqueueDelivery(info: DeliveryInfo): void {
  queue.push(info);
}

/** Clear in-flight state — call on scene rebuild. */
export function resetDelivery(): void {
  queue = [];
  if (active) {
    if (active.pkg?.parent) active.pkg.parent.remove(active.pkg);
    active.pkg?.geometry?.dispose(); active.pkg?.material?.dispose();
    if (active.pkgLabel?.element) active.pkgLabel.element.remove();
    if (active.pkgLabel?.parent) active.pkgLabel.parent.remove(active.pkgLabel);
  }
  active = null;
  if (truck) truck.visible = false;
  if (driver) driver.visible = false;
}

/** Called by the host when the recipient walker has arrived at reception. */
export function markPackagePickedUp(flowId: string): void {
  if (!active) return;
  if (active.info.flowId !== flowId) return;
  if (active.phase !== 'awaiting_pickup') return;
  // Remove package mesh from the counter
  if (active.pkg?.parent) active.pkg.parent.remove(active.pkg);
  active.pkg?.geometry?.dispose(); active.pkg?.material?.dispose();
  if (active.pkgLabel?.element) active.pkgLabel.element.remove();
  if (active.pkgLabel?.parent) active.pkgLabel.parent.remove(active.pkgLabel);
  active = null;
}

function createPackage(info: DeliveryInfo): { mesh: any; label: any } {
  const parsed = parseInt(info.flowColor.replace('#', ''), 16);
  const colorNum = info.packageColor ?? (Number.isFinite(parsed) && parsed > 0 ? parsed : 0xc9a84c);
  const col = new THREE.Color(colorNum);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.3, 0.3),
    new THREE.MeshStandardMaterial({
      color: col, roughness: 0.7, metalness: 0.1,
      emissive: col.clone().multiplyScalar(0.35), emissiveIntensity: 0.4,
    }),
  );
  // Brown paper tape accents
  const tapeMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.9 });
  for (const dy of [0, 1]) {
    const tape = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.32), tapeMat);
    tape.position.y = dy === 0 ? 0 : 0;
    tape.rotation.x = dy * Math.PI / 2;
    mesh.add(tape);
  }

  // Floating label above the package
  const div = document.createElement('div');
  div.textContent = info.label.toUpperCase();
  div.style.cssText =
    `font:700 8px 'Manrope',sans-serif;color:${info.flowColor};letter-spacing:2px;` +
    `text-shadow:0 0 6px ${info.flowColor}aa;background:rgba(8,10,20,0.7);` +
    `padding:2px 6px;border-radius:2px;`;
  const label = CSS2DObject ? new CSS2DObject(div) : null;
  if (label) label.position.set(0, 0.4, 0);
  return { mesh, label };
}

function buildInboundPath(): Vec3[] {
  if (!ctx) return [];
  const { entryCX, plinthOuterZ1, pedOuterZ1, streetDrop, receptionDriverFront, southLaneZ } = ctx;
  // Truck parks facing west (cab at -X end), driver exits on the north side
  // of the cab (toward the building), walks straight north to the staircase,
  // up the steps onto the plinth, through the main doors, and up to the
  // counter's south face (door side of the reception).
  const truckSide  = { x: entryCX,              y: -streetDrop, z: southLaneZ - 1.6 };
  const stairBottom = { x: entryCX,             y: -streetDrop, z: pedOuterZ1 - 0.2 };
  const plinthTop  = { x: entryCX,              y: 0,           z: plinthOuterZ1 - 0.2 };
  const atCounter  = { x: receptionDriverFront.x, y: 0,         z: receptionDriverFront.z };
  return [truckSide, stairBottom, plinthTop, atCounter];
}

/** Position + heading along a path at progress t. Heading is the Y-axis angle. */
function interpAlong(path: Vec3[], t: number): { pos: Vec3; heading: number } {
  return {
    pos: interpolatePath(path, t),
    heading: pathDirection(path, t),
  };
}

/** Drive the delivery driver's body via the shared carrier pose. The driver
 *  walks while carrying the package — right arm pinned to chest. */
function animateWalk(dt: number, running: boolean = false) {
  if (!driverParts) return;
  animTime += dt;
  const p = computeCarrierPose(animTime, running);
  driverParts.leftLeg.rotation.x = p.legL;
  driverParts.rightLeg.rotation.x = p.legR;
  driverParts.leftArm.rotation.x = p.armL;
  driverParts.rightArm.rotation.x = p.armR;
}

function resetDriverPose() {
  if (!driverParts) return;
  driverParts.leftLeg.rotation.x = 0;
  driverParts.rightLeg.rotation.x = 0;
  driverParts.leftArm.rotation.x = 0;
  driverParts.rightArm.rotation.x = -0.9; // keep holding package
}

function reparentPackageTo(pkg: any, label: any | null, parent: any, localPos: Vec3) {
  if (!pkg) return;
  if (pkg.parent) pkg.parent.remove(pkg);
  parent.add(pkg);
  pkg.position.set(localPos.x, localPos.y, localPos.z);
  if (label) {
    if (label.parent) label.parent.remove(label);
    pkg.add(label);
  }
}

export function updateDelivery(scene: any, deltaSec: number): void {
  if (!THREE || !ctx || !truck || !driver) return;

  // Promote queued delivery if nothing active
  if (!active && queue.length > 0) {
    const info = queue.shift()!;
    const { mesh: pkg, label } = createPackage(info);
    const inboundPath = buildInboundPath();
    const outboundPath = [...inboundPath].reverse();
    active = {
      info,
      phase: 'truck_arriving',
      phaseTime: 0,
      pkg,
      pkgLabel: label,
      inboundPath,
      outboundPath,
      inboundLen: pathLength(inboundPath),
      outboundLen: pathLength(outboundPath),
    };
    // Truck is modelled with the cab at local -X (forward) and cargo at local
    // +X (rear). With rotation.y = 0 the cab already points -X, so driving the
    // truck westward along -X moves it forward. Spawn offscreen east.
    const startX = ctx.entryCX + 80;
    truck.position.set(startX, -ctx.streetDrop, ctx.southLaneZ);
    truck.rotation.y = 0;
    truck.visible = true;
    // Package starts inside the truck cargo
    reparentPackageTo(active.pkg, active.pkgLabel, truckCargoAnchor, { x: 0, y: 0, z: 0 });
    driver.visible = false;
  }

  if (!active) return;
  active.phaseTime += deltaSec;

  // Rotate wheels whenever the truck is moving. Wheels are tilted so their
  // cylinder axis is along Z (perpendicular to travel); rotating around their
  // LOCAL Y axis spins them as the truck rolls forward.
  const wheelAngularVel = TRUCK_SPEED / 0.35; // v / r
  const spinAxis = THREE ? new THREE.Vector3(0, 1, 0) : null;
  const spinAllWheels = (dt: number, dir: number) => {
    if (!spinAxis) return;
    const angle = dt * wheelAngularVel * dir;
    for (const w of truckWheels) w.rotateOnAxis(spinAxis, angle);
  };

  switch (active.phase) {
    case 'truck_arriving': {
      // Stop with the cab roughly aligned with the staircase (cab is at local -1.4).
      const stopX = ctx.entryCX + 1.4;
      const dir = -1; // moving west (forward, since cab points -X)
      truck.position.x += dir * TRUCK_SPEED * deltaSec;
      spinAllWheels(deltaSec, dir);
      if (truck.position.x <= stopX) {
        truck.position.x = stopX;
        active.phase = 'driver_out_of_truck';
        active.phaseTime = 0;
      }
      break;
    }

    case 'driver_out_of_truck': {
      // Teleport driver next to the truck, facing the staircase
      const exitPos = active.inboundPath[0];
      driver.position.set(exitPos.x, exitPos.y, exitPos.z);
      driver.rotation.y = Math.atan2(ctx.entryCX - exitPos.x, ctx.plinthOuterZ1 - exitPos.z);
      driver.visible = true;
      // Move package into driver's right hand
      reparentPackageTo(active.pkg, active.pkgLabel, driverParts!.hand, { x: 0, y: 0, z: 0 });
      active.phase = 'driver_walking_in';
      active.phaseTime = 0;
      break;
    }

    case 'driver_walking_in': {
      const t = active.phaseTime * DRIVER_SPEED / Math.max(active.inboundLen, 1);
      const { pos, heading } = interpAlong(active.inboundPath, t);
      driver.position.set(pos.x, pos.y, pos.z);
      driver.rotation.y = heading;
      animateWalk(deltaSec);
      if (t >= 1) {
        resetDriverPose();
        active.phase = 'driver_dropping';
        active.phaseTime = 0;
      }
      break;
    }

    case 'driver_dropping': {
      if (active.phaseTime >= DROP_DURATION * 0.5 && active.pkg.parent !== scene) {
        // Lift package out of the hand and drop onto the counter in world space
        const { receptionDrop } = ctx;
        if (active.pkg.parent) active.pkg.parent.remove(active.pkg);
        scene.add(active.pkg);
        active.pkg.position.set(receptionDrop.x, receptionDrop.y, receptionDrop.z);
        if (active.pkgLabel) {
          if (active.pkgLabel.parent) active.pkgLabel.parent.remove(active.pkgLabel);
          active.pkg.add(active.pkgLabel);
        }
      }
      if (active.phaseTime >= DROP_DURATION) {
        active.phase = 'driver_walking_out';
        active.phaseTime = 0;
      }
      break;
    }

    case 'driver_walking_out': {
      const t = active.phaseTime * DRIVER_SPEED / Math.max(active.outboundLen, 1);
      const { pos, heading } = interpAlong(active.outboundPath, t);
      driver.position.set(pos.x, pos.y, pos.z);
      driver.rotation.y = heading;
      animateWalk(deltaSec);
      if (t >= 1) {
        driver.visible = false;
        active.phase = 'truck_leaving';
        active.phaseTime = 0;
      }
      break;
    }

    case 'truck_leaving': {
      // Continue west offscreen
      const dir = -1;
      truck.position.x += dir * TRUCK_SPEED * deltaSec;
      spinAllWheels(deltaSec, dir);
      if (truck.position.x < ctx.entryCX - 80) {
        truck.visible = false;
        // Signal host to send the recipient walker (once)
        ctx.sendRecipientWalker(active.info);
        active.phase = 'awaiting_pickup';
        active.phaseTime = 0;
      }
      break;
    }

    case 'awaiting_pickup': {
      // Package sits on counter; subtle pulse to draw the eye
      if (active.pkg?.material) {
        const pulse = 0.35 + Math.sin(active.phaseTime * 3) * 0.15;
        active.pkg.material.emissiveIntensity = pulse;
      }
      // Safety: if nobody picks up, clear state so the queue isn't blocked.
      if (active.phaseTime > PICKUP_TIMEOUT) {
        markPackagePickedUp(active.info.flowId);
      }
      break;
    }

    default: break;
  }
}
