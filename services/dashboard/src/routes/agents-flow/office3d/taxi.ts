/**
 * Taxi animation — a small sedan that drops a new agent off at the building's
 * front entrance. Drives in along the south lane, parks at the staircase,
 * fires `onParked` so the host can spawn the agent walker (carrying the agent
 * out of the car visually), then drives off west. Independent of the package-
 * delivery truck so the two can run concurrently.
 *
 * Resource-conscious — one shared sedan mesh hidden between trips, no
 * PointLights (headlights are emissive), no shadows, no per-frame allocation.
 */

import type { Vec3 } from './types.js';

let THREE: any;

export function initTaxi(three: any): void {
  THREE = three;
}

export interface TaxiContext {
  /** X centre of the staircase / entrance (taxi stops here). */
  entryCX: number;
  /** Z of the pedestrian sidewalk (bottom of the stairs — passenger's first foot down). */
  pedOuterZ1: number;
  /** Y drop from plinth (y=0) to asphalt — taxi rides at this depth. */
  streetDrop: number;
  /** Z centre of the south street lane the taxi drives on. */
  southLaneZ: number;
}

export interface TaxiArrivalOpts {
  /** Tint applied to the sedan body (helps tie it to the arriving agent). */
  bodyColor?: string;
  /** Fired once the taxi has come to a complete stop next to the staircase.
   *  Receives the passenger drop-off point (street level, between car and
   *  staircase) so the host can spawn the agent walker there. */
  onParked: (dropOff: Vec3) => void;
  /** How long the taxi waits at the curb before driving off. Default 1.6s
   *  for a drop-off; pickup callers should pass ~10s so the walker has time
   *  to leave the building and reach the door before the car leaves. */
  parkedDuration?: number;
}

type Phase = 'arriving' | 'parked' | 'leaving' | 'done';

interface ActiveTaxi {
  group: any;
  wheels: any[];
  phase: Phase;
  phaseTime: number;
  /** Stop X — slightly east of entryCX so the passenger door faces the stairs. */
  stopX: number;
  /** West/east offscreen end-points. */
  startX: number;
  endX: number;
  parkedFired: boolean;
  onParked: (dropOff: Vec3) => void;
  dropOffPoint: Vec3;
  /** Per-taxi parked window (overrides PARKED_DURATION default). */
  parkedDuration: number;
}

const TAXI_SPEED = 8.0;          // units / sec along the lane
const PARKED_DURATION = 1.6;     // seconds the taxi waits at the stop
const OFFSCREEN_MARGIN = 55;     // how far east/west the taxi spawns/exits
const WHEEL_RADIUS = 0.32;

let ctx: TaxiContext | null = null;
const active: ActiveTaxi[] = [];

export function initTaxiScene(c: TaxiContext): void {
  ctx = c;
}

/** Build a small sedan mesh — body + cabin + 4 wheels + headlight pair. */
function buildTaxiMesh(bodyColor: string): { group: any; wheels: any[] } {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(bodyColor),
    roughness: 0.4, metalness: 0.35,
  });
  const cabinMat = new THREE.MeshStandardMaterial({
    color: 0x1a2030, roughness: 0.15, metalness: 0.2,
    emissive: new THREE.Color(0x223355), emissiveIntensity: 0.2,
    transparent: true, opacity: 0.85,
  });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.85 });
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff4d8 });
  const taillightMat = new THREE.MeshBasicMaterial({ color: 0xff3a30 });

  // Lower body — long box. With rotation.y = 0 the car's "front" points -X.
  const lower = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.7, 1.7), bodyMat);
  lower.position.set(0, 0.55, 0);
  group.add(lower);

  // Cabin (raised, tinted glass)
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.45), cabinMat);
  cabin.position.set(-0.1, 1.15, 0);
  group.add(cabin);

  // Hood + trunk colour strip on body sides for visual interest
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0x0d0f18, roughness: 0.6 });
  for (const sx of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.05, 0.04), stripeMat);
    stripe.position.set(0, 0.95, sx * 0.86);
    group.add(stripe);
  }

  // Headlights (front = -X)
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.15, 0.18), headlightMat);
    hl.position.set(-2.0, 0.6, sx * 0.55);
    group.add(hl);
  }
  // Taillights (rear = +X)
  for (const sx of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.22), taillightMat);
    tl.position.set(2.0, 0.55, sx * 0.55);
    group.add(tl);
  }

  // 4 wheels — cylinders tilted so axis is along Z (perpendicular to travel).
  const wheels: any[] = [];
  for (const [wx, wz] of [[-1.3, -0.85], [-1.3, 0.85], [1.3, -0.85], [1.3, 0.85]] as Array<[number, number]>) {
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.25, 12),
      wheelMat,
    );
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(wx, WHEEL_RADIUS, wz);
    group.add(wheel);
    wheels.push(wheel);
  }

  return { group, wheels };
}

/** Spawn a taxi that drives in, parks, and drives off — independent of the
 *  package-delivery system. Multiple taxis can run concurrently (e.g. if the
 *  user approves a batch of pending agents at once). */
export function enqueueTaxi(scene: any, opts: TaxiArrivalOpts): void {
  if (!THREE || !ctx || !scene) return;

  const { group, wheels } = buildTaxiMesh(opts.bodyColor ?? '#f4c542');
  const y = -ctx.streetDrop;
  const startX = ctx.entryCX + OFFSCREEN_MARGIN;
  const endX = ctx.entryCX - OFFSCREEN_MARGIN;
  // Park slightly east of the staircase so the passenger door (north side of
  // the cabin) faces the stairs. With rotation.y = 0 the cabin centre is at
  // local x = -0.1, so a small +0.6 offset puts the door even with the stairs.
  const stopX = ctx.entryCX + 0.6;
  group.position.set(startX, y, ctx.southLaneZ);
  group.rotation.y = 0; // front (-X) points west → drives west, like the delivery truck
  scene.add(group);

  // Passenger drops off on the NORTH side of the taxi (toward the stairs).
  // Half-width of the cabin is 0.725; stand the agent at z = southLaneZ - 1.2
  // so they're clearly in front of the door, not phasing through the car.
  const dropOffPoint: Vec3 = {
    x: stopX,
    y: -ctx.streetDrop,
    z: ctx.southLaneZ - 1.4,
  };

  active.push({
    group, wheels,
    phase: 'arriving',
    phaseTime: 0,
    stopX, startX, endX,
    parkedFired: false,
    onParked: opts.onParked,
    dropOffPoint,
    parkedDuration: opts.parkedDuration ?? PARKED_DURATION,
  });
}

/** Drive every active taxi forward. Call once per animation frame. */
export function updateTaxis(scene: any, deltaSec: number): void {
  if (!THREE) return;
  for (let i = active.length - 1; i >= 0; i--) {
    const t = active[i];
    t.phaseTime += deltaSec;
    const wheelSpin = TAXI_SPEED * deltaSec / WHEEL_RADIUS;

    if (t.phase === 'arriving') {
      // Drive west toward the stop.
      t.group.position.x -= TAXI_SPEED * deltaSec;
      for (const w of t.wheels) w.rotation.y -= wheelSpin;
      if (t.group.position.x <= t.stopX) {
        t.group.position.x = t.stopX;
        t.phase = 'parked';
        t.phaseTime = 0;
      }
    } else if (t.phase === 'parked') {
      // Fire onParked once. The host spawns the agent walker which will visibly
      // step out from beside the car and head for the stairs.
      if (!t.parkedFired) {
        t.parkedFired = true;
        try { t.onParked(t.dropOffPoint); }
        catch { /* swallow — animation glue must never break the loop */ }
      }
      if (t.phaseTime >= t.parkedDuration) {
        t.phase = 'leaving';
        t.phaseTime = 0;
      }
    } else if (t.phase === 'leaving') {
      t.group.position.x -= TAXI_SPEED * deltaSec;
      for (const w of t.wheels) w.rotation.y -= wheelSpin;
      if (t.group.position.x <= t.endX) {
        t.phase = 'done';
      }
    } else if (t.phase === 'done') {
      scene.remove(t.group);
      t.group.traverse((c: any) => {
        c.geometry?.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach((m: any) => m.dispose?.());
          else c.material.dispose?.();
        }
      });
      active.splice(i, 1);
    }
  }
}

/** Forcibly dispose every taxi (called on scene rebuild teardown). */
export function resetTaxis(scene: any): void {
  for (const t of active) {
    if (t.group?.parent) scene?.remove?.(t.group);
    t.group?.traverse?.((c: any) => {
      c.geometry?.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m: any) => m.dispose?.());
        else c.material.dispose?.();
      }
    });
  }
  active.length = 0;
}
