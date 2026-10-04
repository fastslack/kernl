/**
 * Construction vehicles — the crew's truck and the agents' car. Built from
 * boxes like the taxi and the mail truck (taxi.ts, delivery.ts): no lights,
 * no shadows, emissive bits only. With rotation.y = 0 the front points -X,
 * so both drive west along the south lane.
 */

import { rt } from '../runtime.js';

export const WHEEL_RADIUS = 0.36;

export interface Vehicle {
  group: any;
  wheels: any[];
  /** The orange beacon on the truck's cab; spun while it drives. */
  beacon?: any;
}

function box(w: number, h: number, d: number, mat: any, x: number, y: number, z: number): any {
  const m = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function addWheels(group: any, xs: number[], halfTrack: number, mat: any): any[] {
  const wheels: any[] = [];
  for (const x of xs) {
    for (const z of [-halfTrack, halfTrack]) {
      const wheel = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.28, 12), mat);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, WHEEL_RADIUS, z);
      group.add(wheel);
      wheels.push(wheel);
    }
  }
  return wheels;
}

/** Flatbed construction truck: yellow cab, open bed with planks and a cement bag pile. */
export function buildConstructionTruck(): Vehicle {
  const T = rt.THREE;
  const group = new T.Group();
  const yellow = new T.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.45, metalness: 0.25 });
  const dark = new T.MeshStandardMaterial({ color: 0x23262e, roughness: 0.7 });
  const glass = new T.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.15, emissive: new T.Color(0x223355), emissiveIntensity: 0.25 });
  const wood = new T.MeshStandardMaterial({ color: 0xb98a52, roughness: 0.9 });
  const bag = new T.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 1 });
  const stripe = new T.MeshBasicMaterial({ color: 0x111111 });
  const head = new T.MeshBasicMaterial({ color: 0xfff4d8 });
  const tail = new T.MeshBasicMaterial({ color: 0xff3a30 });

  // Chassis + cab (front = -X).
  group.add(box(6.4, 0.35, 2.1, dark, 0, 0.62, 0));
  group.add(box(1.9, 1.6, 2.1, yellow, -2.25, 1.6, 0));
  group.add(box(0.06, 0.7, 1.7, glass, -3.21, 1.9, 0));
  for (const z of [-1, 1]) group.add(box(1.0, 0.6, 0.05, glass, -2.3, 1.95, z * 1.06));
  // Hazard stripes on the bumper.
  for (let i = 0; i < 4; i++) group.add(box(0.06, 0.28, 0.32, stripe, -3.22, 0.75, -0.75 + i * 0.5));
  for (const z of [-0.7, 0.7]) group.add(box(0.1, 0.18, 0.28, head, -3.22, 1.05, z));
  for (const z of [-0.8, 0.8]) group.add(box(0.08, 0.16, 0.24, tail, 3.22, 0.9, z));

  // Open bed with side rails.
  group.add(box(4.2, 0.12, 2.1, yellow, 1.0, 0.86, 0));
  for (const z of [-1, 1]) group.add(box(4.2, 0.5, 0.08, yellow, 1.0, 1.15, z * 1.02));
  group.add(box(0.08, 0.5, 2.1, yellow, 3.06, 1.15, 0));
  // Cargo: plank stack and cement bags.
  for (let i = 0; i < 4; i++) group.add(box(3.4, 0.12, 0.9, wood, 0.9, 1.0 + i * 0.13, -0.45));
  for (let i = 0; i < 5; i++) group.add(box(0.7, 0.28, 0.5, bag, 0.2 + (i % 3) * 0.75, 1.07 + Math.floor(i / 3) * 0.3, 0.55));

  // Beacon on the cab roof — emissive, spun by the stage.
  const beacon = new T.Group();
  beacon.position.set(-2.25, 2.5, 0);
  beacon.add(box(0.3, 0.16, 0.3, new T.MeshBasicMaterial({ color: 0xff8a00 }), 0, 0, 0));
  beacon.add(box(0.5, 0.06, 0.08, new T.MeshBasicMaterial({ color: 0xffd08a }), 0, 0.02, 0));
  group.add(beacon);

  const wheels = addWheels(group, [-2.2, 1.0, 2.2], 1.0, dark);
  return { group, wheels, beacon };
}

/** The agents' ride: a sedan for up to 4, a passenger van for more. Tinted with the office colour. */
export function buildAgentsCar(color: string, passengers: number): Vehicle {
  const T = rt.THREE;
  const group = new T.Group();
  const body = new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.4, metalness: 0.35 });
  const glass = new T.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.15, emissive: new T.Color(0x223355), emissiveIntensity: 0.2 });
  const dark = new T.MeshStandardMaterial({ color: 0x111114, roughness: 0.85 });
  const head = new T.MeshBasicMaterial({ color: 0xfff4d8 });
  const van = passengers > 4;

  if (van) {
    group.add(box(5.4, 1.7, 2.0, body, 0, 1.35, 0));
    group.add(box(0.06, 0.7, 1.7, glass, -2.71, 1.75, 0));
    for (const z of [-1, 1]) group.add(box(3.8, 0.55, 0.05, glass, 0.3, 1.8, z * 1.01));
    for (const z of [-0.6, 0.6]) group.add(box(0.1, 0.15, 0.25, head, -2.72, 0.85, z));
  } else {
    group.add(box(4.0, 0.7, 1.7, body, 0, 0.55, 0));
    group.add(box(2.2, 0.7, 1.45, glass, -0.1, 1.15, 0));
    for (const z of [-0.55, 0.55]) group.add(box(0.18, 0.15, 0.18, head, -2.0, 0.6, z));
  }
  const wheels = addWheels(group, van ? [-1.8, 1.8] : [-1.3, 1.3], van ? 0.95 : 0.85, dark);
  return { group, wheels };
}

/** Free a vehicle's GPU resources. */
export function disposeVehicle(v: Vehicle | null): void {
  if (!v) return;
  v.group.parent?.remove(v.group);
  v.group.traverse((c: any) => {
    c.geometry?.dispose?.();
    if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m: any) => m.dispose?.());
  });
}
