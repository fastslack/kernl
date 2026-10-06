/**
 * Demolition stage — draws what the demolition director (demolition.ts) is
 * running: the same truck and crew as a construction, dynamite against the
 * walls, burning fuses, the blast (a small fireball, a few wall chunks, smoke)
 * and the dust settling. Recomputed from phase + progress each frame, like
 * the construction stage; only the debris and smoke carry their own motion.
 *
 * Kept cheap on purpose: no light is added (a new light recompiles every lit
 * material in the scene — a visible hitch), a few dozen particles at most,
 * and geometries/materials shared across charges and chunks.
 */

import { rt } from '../runtime.js';
import type { RoomInfo, Vec3 } from '../types.js';
import type { CorridorGrid } from '../floor-plan.js';
import type { StreetContext } from './stage.js';
import type { ActiveDemolition, DemolitionPhase } from './demolition.js';
import { buildConstructionTruck, disposeVehicle, WHEEL_RADIUS, type Vehicle } from './vehicles.js';
import { createBuilder, disposeBuilder, poseHammering, poseWalking, type Builder } from './crew.js';
import { crewRoute, workSpots, type WorkSpot } from './route.js';
import { buildCumDist, interpolatePath, pathDirection, pathLength } from '../anim/path.js';
import { clamp01, easeOutCubic } from '../anim/easing.js';

type Rect = { cx: number; cz: number; w: number; d: number };

export interface DemolitionStageContext {
  scene: any;
  room(flowId: string): RoomInfo | undefined;
  /** The office's tagged groups (room shell + themed interior). */
  roomGroups(flowId: string): any[];
  street(): StreetContext | null;
  routing(): { rooms: Map<string, RoomInfo>; grid: CorridorGrid; coreRooms: ReadonlyArray<Rect> } | null;
  setDurations(flowId: string, d: Partial<Record<DemolitionPhase, number>>): void;
  /** Hide the office's desks and seated agents — they go up with the walls. */
  hideInterior(flowId: string): void;
  /** Point the camera at (x, z), close enough to take in `span` units. Skipped while the user steers. */
  frame(x: number, z: number, span: number): void;
}

const CREW_SIZE = 4;
const CREW_SPEED = 18;
const LEAVE_SPEED = 9;
const LEAVE_SECONDS = 3;
const VEHICLE_MARGIN = 60;
const GRAVITY = 22;
/** Most wall chunks one wall may throw, and the whole blast's budget. */
const CHUNKS_PER_WALL = 3;
const MAX_CHUNKS = 24;
const STICK_RED = 0xc8102e;

interface CrewMember {
  b: Builder;
  spot: WorkSpot;
  path: Vec3[];
  cum: number[];
  len: number;
  opacity: number;
}

/** One bundle of three sticks taped together, with a fuse and its burning tip. */
interface Charge { group: any; tip: any; at: Vec3; owner: number }

interface Particle {
  mesh: any;
  vx: number; vy: number; vz: number;
  /** Spin, radians per second. */
  rx: number; rz: number;
  life: number;
  maxLife: number;
  kind: 'chunk' | 'spark' | 'smoke' | 'fire';
  grow?: number;
}

interface Job {
  flowId: string;
  truck: Vehicle;
  crew: CrewMember[];
  charges: Charge[];
  truckStopX: number;
  startX: number;
  endX: number;
  laneY: number;
  maxLen: number;
  framedLot: boolean;
  blown: boolean;
  room: RoomInfo;
}

function spinWheels(v: Vehicle, dx: number): void {
  const a = dx / WHEEL_RADIUS;
  for (const w of v.wheels) w.rotation.y += a;
}

export function createDemolitionStage(ctx: DemolitionStageContext) {
  let job: Job | null = null;
  const particles: Particle[] = [];
  const leaving: Array<{ v: Vehicle; endX: number }> = [];
  // Shared geometry; materials are cached per colour.
  let cube: any = null;
  let ball: any = null;
  const mats = new Map<string, any>();

  function mat(color: number, opts: { basic?: boolean; transparent?: boolean } = {}): any {
    const key = `${color}:${opts.basic ? 'b' : 's'}:${opts.transparent ? 't' : 'o'}`;
    let m = mats.get(key);
    if (!m) {
      const T = rt.THREE;
      m = opts.basic
        ? new T.MeshBasicMaterial({ color, transparent: !!opts.transparent, depthWrite: !opts.transparent })
        : new T.MeshStandardMaterial({ color, roughness: 0.85, transparent: !!opts.transparent });
      mats.set(key, m);
    }
    return m;
  }

  function spawn(p: Omit<Particle, 'mesh' | 'maxLife'> & { at: Vec3; size: number; color: number; geo: 'cube' | 'ball'; own?: boolean }): void {
    const T = rt.THREE;
    cube ??= new T.BoxGeometry(1, 1, 1);
    ball ??= new T.SphereGeometry(1, 8, 6);
    // Smoke and fire fade one by one, so each needs its own material instance.
    const m = p.own
      ? new T.MeshBasicMaterial({ color: p.color, transparent: true, depthWrite: false, opacity: p.kind === 'fire' ? 0.95 : 0.55 })
      : mat(p.color, { basic: p.kind === 'spark' });
    const mesh = new T.Mesh(p.geo === 'cube' ? cube : ball, m);
    mesh.position.set(p.at.x, p.at.y, p.at.z);
    mesh.scale.setScalar(p.size);
    if (p.kind === 'chunk') mesh.scale.set(p.size, p.size * (0.5 + Math.random() * 0.7), p.size * (0.6 + Math.random() * 0.8));
    ctx.scene.add(mesh);
    particles.push({ mesh, vx: p.vx, vy: p.vy, vz: p.vz, rx: p.rx, rz: p.rz, life: p.life, maxLife: p.life, kind: p.kind, grow: p.grow });
  }

  function updateParticles(dt: number): void {
    for (let i = particles.length - 1; i >= 0; i--) {
      const s = particles[i];
      s.life -= dt;
      const m = s.mesh;
      if (s.kind === 'smoke' || s.kind === 'fire') {
        // Puffs drift up, swell and thin out.
        m.position.x += s.vx * dt;
        m.position.y += s.vy * dt;
        m.position.z += s.vz * dt;
        s.vx *= 0.97; s.vz *= 0.97; s.vy *= 0.985;
        m.scale.multiplyScalar(1 + (s.grow ?? 0.4) * dt);
        const k = clamp01(s.life / s.maxLife);
        m.material.opacity = (s.kind === 'fire' ? 0.95 : 0.55) * k;
      } else {
        s.vy -= GRAVITY * dt;
        m.position.x += s.vx * dt;
        m.position.y += s.vy * dt;
        m.position.z += s.vz * dt;
        m.rotation.x += s.rx * dt;
        m.rotation.z += s.rz * dt;
        const floor = s.kind === 'chunk' ? m.scale.y / 2 : 0;
        if (m.position.y < floor) {
          // Chunks hit the floor, bounce a little and come to rest.
          m.position.y = floor;
          s.vy = Math.abs(s.vy) * 0.25;
          s.vx *= 0.55; s.vz *= 0.55; s.rx *= 0.5; s.rz *= 0.5;
        }
        // The last stretch of a chunk's life it sinks into the dust.
        if (s.kind === 'chunk' && s.life < 1.2) m.position.y -= dt * 0.6;
      }
      if (s.life <= 0) {
        ctx.scene.remove(m);
        if (s.kind === 'smoke' || s.kind === 'fire') m.material.dispose();
        particles.splice(i, 1);
      }
    }
  }

  /** Geometry and materials every charge shares — built once, freed in dispose(). */
  let chargeKit: { stick: any; tape: any; fuse: any; tip: any; red: any; black: any; brown: any; glow: any } | null = null;

  function buildCharge(at: Vec3, facing: number, owner: number): Charge {
    const T = rt.THREE;
    chargeKit ??= {
      stick: new T.CylinderGeometry(0.075, 0.075, 0.62, 8),
      tape: new T.CylinderGeometry(0.2, 0.2, 0.08, 8),
      fuse: new T.CylinderGeometry(0.015, 0.015, 0.35, 4),
      tip: new T.SphereGeometry(0.06, 6, 4),
      red: new T.MeshStandardMaterial({ color: STICK_RED, roughness: 0.6, emissive: new T.Color(0x400008), emissiveIntensity: 0.6 }),
      black: new T.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 }),
      brown: new T.MeshStandardMaterial({ color: 0x3a2a1a }),
      glow: new T.MeshBasicMaterial({ color: 0xffd36b }),
    };
    const k = chargeKit;
    const group = new T.Group();
    for (const [dx, dz] of [[-0.09, 0], [0.09, 0], [0, 0.11]]) {
      const s = new T.Mesh(k.stick, k.red);
      s.position.set(dx, 0.31, dz);
      group.add(s);
    }
    const tape = new T.Mesh(k.tape, k.black);
    tape.position.y = 0.36;
    group.add(tape);
    const fuse = new T.Mesh(k.fuse, k.brown);
    fuse.position.set(0, 0.78, 0);
    fuse.rotation.z = 0.35;
    group.add(fuse);
    const tip = new T.Mesh(k.tip, k.glow);
    tip.position.set(-0.06, 0.95, 0);
    tip.visible = false;
    group.add(tip);
    group.position.set(at.x, 0, at.z);
    group.rotation.y = facing;
    group.visible = false;
    ctx.scene.add(group);
    return { group, tip, at, owner };
  }

  function start(flowId: string): Job | null {
    const room = ctx.room(flowId);
    const street = ctx.street();
    const routing = ctx.routing();
    if (!room || !street || !routing) return null;

    const laneY = -street.streetDrop;
    const startX = street.entryCX + VEHICLE_MARGIN;
    const endX = street.entryCX - VEHICLE_MARGIN;
    const truckStopX = street.entryCX - 4;
    const truck = buildConstructionTruck();
    truck.group.position.set(startX, laneY, street.southLaneZ);
    ctx.scene.add(truck.group);

    const entrance = { x: street.entryCX, y: 0, z: routing.grid.buildingBounds.maxZ - 1 };
    const spots = workSpots(room);
    const crew: CrewMember[] = [];
    const charges: Charge[] = [];
    for (let i = 0; i < CREW_SIZE; i++) {
      const spot = spots[i % spots.length];
      const jitter = (i - (CREW_SIZE - 1) / 2) * 0.7;
      const outdoor: Vec3[] = [
        { x: truckStopX + 1.5 + jitter, y: laneY, z: street.southLaneZ - 1.6 },
        { x: street.entryCX + jitter, y: laneY, z: street.pedOuterZ1 - 0.3 },
        { x: street.entryCX + jitter, y: 0, z: street.plinthOuterZ1 - 0.3 },
        { x: entrance.x + jitter, y: 0, z: entrance.z },
      ];
      const inside = crewRoute({ ...outdoor[3] }, spot.pos, room, routing.rooms, routing.grid, routing.coreRooms);
      const path = [...outdoor, ...inside.slice(1)];
      const b = createBuilder(i);
      b.parts.group.visible = false;
      ctx.scene.add(b.parts.group);
      crew.push({ b, spot, path, cum: buildCumDist(path), len: pathLength(path), opacity: 1 });
      // Two bundles per wall, either side of where the builder kneels, right against the wall.
      const fx = Math.sin(spot.facing), fz = Math.cos(spot.facing);
      const tx = Math.cos(spot.facing), tz = -Math.sin(spot.facing);
      for (const side of [-1, 1]) {
        charges.push(buildCharge({
          x: spot.pos.x + fx * 0.95 + tx * side * 1.3,
          y: 0,
          z: spot.pos.z + fz * 0.95 + tz * side * 1.3,
        }, spot.facing, i));
      }
    }
    const maxLen = Math.max(...crew.map(c => c.len));
    const walk = Math.min(10, Math.max(2.5, maxLen / CREW_SPEED));
    ctx.setDurations(flowId, { 'walk-in': walk, 'walk-out': LEAVE_SECONDS });
    ctx.frame(street.entryCX, street.southLaneZ - 8, 34);
    return {
      flowId, truck, crew, charges, truckStopX, startX, endX, laneY, maxLen,
      framedLot: false, blown: false, room,
    };
  }

  function setOpacity(c: CrewMember, o: number): void {
    if (c.opacity === o) return;
    c.opacity = o;
    c.b.parts.group.traverse((m: any) => {
      if (!m.material) return;
      m.material.transparent = o < 1;
      m.material.opacity = o;
    });
    c.b.parts.group.visible = o > 0.01;
  }

  function placeCrew(j: Job, phase: DemolitionPhase, p: number, time: number): void {
    for (const c of j.crew) {
      const g = c.b.parts.group;
      if (phase === 'truck-in' || phase === 'countdown' || phase === 'boom' || phase === 'dust') { g.visible = false; continue; }
      g.visible = true;
      if (phase === 'plant') {
        g.position.set(c.spot.pos.x, 0, c.spot.pos.z);
        g.rotation.y = c.spot.facing;
        // Slow, careful taping — the hammer pose at a third of the pace.
        poseHammering(c.b, time * 0.35);
        continue;
      }
      if (phase === 'walk-out') {
        // Back out the way they came, at a run, fading as they reach the corridor.
        const t = 1 - clamp01((p * LEAVE_SECONDS * LEAVE_SPEED) / c.len);
        const pos = interpolatePath(c.path, t, c.cum);
        g.position.set(pos.x, pos.y ?? 0, pos.z);
        g.rotation.y = pathDirection(c.path, t, c.cum) + Math.PI;
        poseWalking(c.b, time * 2.2);
        setOpacity(c, 1 - clamp01((p - 0.55) / 0.45));
        continue;
      }
      setOpacity(c, 1);
      const along = clamp01((p * j.maxLen) / c.len);
      const pos = interpolatePath(c.path, along, c.cum);
      g.position.set(pos.x, pos.y ?? 0, pos.z);
      if (along >= 1) {
        g.rotation.y = c.spot.facing;
      } else {
        g.rotation.y = pathDirection(c.path, along, c.cum);
        poseWalking(c.b, time * 1.6);
      }
    }
  }

  function placeCharges(j: Job, phase: DemolitionPhase, p: number, time: number): void {
    for (let i = 0; i < j.charges.length; i++) {
      const ch = j.charges[i];
      if (phase === 'truck-in' || phase === 'walk-in' || phase === 'boom' || phase === 'dust') {
        ch.group.visible = false;
        continue;
      }
      // Each builder sets their two bundles one after the other during the plant.
      const at = phase === 'plant' ? clamp01((p - 0.15 - (i % 2) * 0.35) / 0.25) : 1;
      ch.group.visible = at > 0;
      ch.group.scale.setScalar(Math.max(0.01, easeOutCubic(at)));
      const burning = phase === 'countdown';
      ch.tip.visible = burning && Math.sin(time * 40 + i) > -0.3;
      if (burning && Math.random() < 0.12) {
        const wp = new rt.THREE.Vector3();
        ch.tip.getWorldPosition(wp);
        spawn({
          at: { x: wp.x, y: wp.y, z: wp.z }, size: 0.05, color: 0xffb347, geo: 'cube', kind: 'spark',
          vx: (Math.random() - 0.5) * 2.4, vy: 1 + Math.random() * 2, vz: (Math.random() - 0.5) * 2.4,
          rx: 0, rz: 0, life: 0.25,
        });
      }
    }
  }

  /** The office goes up: a few wall chunks, a small fireball, a puff of smoke — then the lot is empty. */
  function blow(j: Job): void {
    j.blown = true;
    const T = rt.THREE;
    const { cx, cz, w, d } = j.room;
    const box = new T.Box3();
    const size = new T.Vector3();
    const tmp = new T.Color();
    let chunks = 0;
    for (const g of ctx.roomGroups(j.flowId)) {
      g.traverse((c: any) => {
        if (!c.isMesh || !c.visible || chunks >= MAX_CHUNKS) return;
        if ((c.userData.part ?? g.userData.part) !== 'wall') return;
        box.setFromObject(c);
        box.getSize(size);
        const color = Array.isArray(c.material) ? c.material[0]?.color : c.material?.color;
        const hex = color ? tmp.copy(color).getHex() : 0x4a6ab8;
        for (let k = 0; k < CHUNKS_PER_WALL && chunks < MAX_CHUNKS; k++, chunks++) {
          const at = {
            x: box.min.x + Math.random() * size.x,
            y: box.min.y + Math.random() * size.y,
            z: box.min.z + Math.random() * size.z,
          };
          const ox = at.x - cx, oz = at.z - cz;
          const len = Math.hypot(ox, oz) || 1;
          const speed = 2.5 + Math.random() * 3;
          spawn({
            at, size: 0.3 + Math.random() * 0.35, color: hex, geo: 'cube', kind: 'chunk',
            vx: (ox / len) * speed, vy: 4 + Math.random() * 4, vz: (oz / len) * speed,
            rx: (Math.random() - 0.5) * 10, rz: (Math.random() - 0.5) * 10,
            life: 3 + Math.random(),
          });
        }
      });
    }
    hideOffice(j.flowId);
    for (const ch of j.charges) ch.group.visible = false;

    // A handful of furniture splinters.
    for (let k = 0; k < 6; k++) {
      const at = { x: cx + (Math.random() - 0.5) * w * 0.6, y: 0.5, z: cz + (Math.random() - 0.5) * d * 0.6 };
      spawn({
        at, size: 0.15 + Math.random() * 0.2, color: k % 2 ? 0x8892a0 : 0x8a6038, geo: 'cube', kind: 'chunk',
        vx: (at.x - cx) * 0.8, vy: 4 + Math.random() * 4, vz: (at.z - cz) * 0.8,
        rx: (Math.random() - 0.5) * 12, rz: (Math.random() - 0.5) * 12, life: 2.5 + Math.random(),
      });
    }
    // Small fireball: three glowing balls that swell and fade in under a second.
    const r = Math.min(Math.max(w, d), 14);
    for (let k = 0; k < 3; k++) {
      spawn({
        at: { x: cx + (Math.random() - 0.5) * 1.5, y: 1 + k * 0.6, z: cz + (Math.random() - 0.5) * 1.5 },
        size: r * 0.07, color: k === 1 ? 0xffb12e : 0xff5a1a, geo: 'ball', kind: 'fire', own: true,
        vx: 0, vy: 1.5, vz: 0, rx: 0, rz: 0, life: 0.7 + k * 0.15, grow: 1.6,
      });
    }
    // A few smoke puffs over the lot while the dust settles.
    for (let k = 0; k < 6; k++) {
      spawn({
        at: { x: cx + (Math.random() - 0.5) * w * 0.6, y: 0.8 + Math.random() * 1.5, z: cz + (Math.random() - 0.5) * d * 0.6 },
        size: 0.9 + Math.random() * 0.7, color: k % 2 ? 0x6b6f78 : 0x8b8f96, geo: 'ball', kind: 'smoke', own: true,
        vx: (Math.random() - 0.5) * 1.5, vy: 0.8 + Math.random(), vz: (Math.random() - 0.5) * 1.5,
        rx: 0, rz: 0, life: 3.5 + Math.random(), grow: 0.3,
      });
    }
  }

  /** Keep a blown office out of sight — a scene rebuild during the dust would put it back. */
  function hideOffice(flowId: string): void {
    for (const g of ctx.roomGroups(flowId)) {
      g.visible = false;
      // CSS2D labels (the door sign) only read their own visibility, not their parents'.
      g.traverse((c: any) => { if (c.isCSS2DObject) c.visible = false; });
    }
    ctx.hideInterior(flowId);
  }

  function placeTruck(j: Job, phase: DemolitionPhase, p: number, dt: number): void {
    const t = j.truck;
    const prevX = t.group.position.x;
    if (phase === 'truck-in') t.group.position.x = j.startX + (j.truckStopX - j.startX) * easeOutCubic(p);
    else if (phase === 'dust') t.group.position.x = j.truckStopX + (j.endX - j.truckStopX) * (p * p);
    else t.group.position.x = j.truckStopX;
    spinWheels(t, prevX - t.group.position.x);
    if (t.beacon) t.beacon.rotation.y += dt * 9;
  }

  function disposeJob(j: Job): void {
    disposeVehicle(j.truck);
    for (const c of j.crew) disposeBuilder(c.b);
    // Charge geometry/materials are shared (chargeKit) and freed in dispose().
    for (const ch of j.charges) ch.group.parent?.remove(ch.group);
  }

  return {
    update(dt: number, time: number, active: ActiveDemolition | null): void {
      updateParticles(dt);
      for (let i = leaving.length - 1; i >= 0; i--) {
        const l = leaving[i];
        const prevX = l.v.group.position.x;
        l.v.group.position.x -= 12 * dt;
        spinWheels(l.v, prevX - l.v.group.position.x);
        if (l.v.group.position.x <= l.endX) { disposeVehicle(l.v); leaving.splice(i, 1); }
      }
      if (job && (!active || active.flowId !== job.flowId)) {
        disposeJob(job);
        job = null;
      }
      if (!active) return;
      if (!job) {
        job = start(active.flowId);
        if (!job) return;
      }
      const { phase, progress } = active;
      placeCrew(job, phase, progress, time);
      placeCharges(job, phase, progress, time);
      placeTruck(job, phase, progress, dt);
      if (!job.framedLot && (phase === 'plant' || (phase === 'walk-in' && progress > 0.7))) {
        job.framedLot = true;
        ctx.frame(job.room.cx, job.room.cz, Math.max(job.room.w, job.room.d) * 1.8);
      }
      if (phase === 'boom' && !job.blown) blow(job);
      else if (job.blown) hideOffice(job.flowId);
    },

    /** The demolition ended: the truck finishes driving off; the debris fades on its own. */
    finished(flowId: string): void {
      if (!job || job.flowId !== flowId) return;
      leaving.push({ v: job.truck, endX: job.endX });
      job.truck = { group: new rt.THREE.Group(), wheels: [] };
      disposeJob(job);
      job = null;
    },

    demolishingFlowId(): string | null { return job?.flowId ?? null; },

    dispose(): void {
      if (job) { disposeJob(job); job = null; }
      for (const l of leaving) disposeVehicle(l.v);
      leaving.length = 0;
      for (const s of particles) {
        ctx.scene.remove(s.mesh);
        if (s.kind === 'smoke' || s.kind === 'fire') s.mesh.material.dispose();
      }
      particles.length = 0;
      if (chargeKit) { for (const v of Object.values(chargeKit)) v.dispose(); chargeKit = null; }
      cube?.dispose(); ball?.dispose();
      cube = ball = null;
      for (const m of mats.values()) m.dispose();
      mats.clear();
    },
  };
}

export type DemolitionStage = ReturnType<typeof createDemolitionStage>;
