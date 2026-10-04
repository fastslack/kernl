/**
 * Construction stage — draws the build the director (director.ts) is
 * running: the truck, the crew, the walls going up, the sparks, the agents'
 * car. Everything is recomputed from the director's phase + progress each
 * frame, so a scene rebuild in the middle of a build only means the stage
 * finds the office's (new) room group and keeps going.
 *
 * Scene-side needs come in through StageContext, so this module never
 * reaches into the Svelte component.
 */

import { rt } from '../runtime.js';
import type { RoomInfo, Vec3 } from '../types.js';
import type { CorridorGrid } from '../floor-plan.js';
import type { ActiveBuild, Phase } from './director.js';
import { buildAgentsCar, buildConstructionTruck, disposeVehicle, WHEEL_RADIUS, type Vehicle } from './vehicles.js';
import { createBuilder, disposeBuilder, poseHammering, poseWalking, type Builder } from './crew.js';
import { crewRoute, wallRise, workSpots, type WorkSpot } from './route.js';
import { buildCumDist, interpolatePath, pathDirection, pathLength } from '../anim/path.js';
import { clamp01, easeOutCubic } from '../anim/easing.js';
import { hammerStrikeIndex } from '../anim/poses/hammer.js';

type Rect = { cx: number; cz: number; w: number; d: number };

export interface StreetContext {
  entryCX: number;
  pedOuterZ1: number;
  plinthOuterZ1: number;
  streetDrop: number;
  southLaneZ: number;
}

export interface StageContext {
  scene: any;
  room(flowId: string): RoomInfo | undefined;
  /** The office's tagged groups (room shell + themed interior). */
  roomGroups(flowId: string): any[];
  street(): StreetContext | null;
  routing(): { rooms: Map<string, RoomInfo>; grid: CorridorGrid; coreRooms: ReadonlyArray<Rect> } | null;
  color(flowId: string): string;
  agentCount(flowId: string): number;
  setDurations(flowId: string, d: Partial<Record<Phase, number>>): void;
  /** Put the office's desks in (seated agents stay hidden). */
  showDesks(flowId: string): void;
  /** Agents step out at `outdoor[0]` and walk in through the stairs to their desks. */
  sendAgents(flowId: string, outdoor: Vec3[]): void;
  /** Point the camera at (x, z), close enough to take in `span` units. Skipped while the user steers. */
  frame(x: number, z: number, span: number): void;
}

const CREW_SIZE = 4;
/** The crew trots in: a walk would take most of a minute to the far lots. */
const CREW_SPEED = 18;
/** On the way out they stroll off and fade — retracing the whole route would double the wait. */
const LEAVE_SPEED = 7;
const LEAVE_SECONDS = 3.5;
const VEHICLE_MARGIN = 60;
const DECOR_FROM = 0.86;

interface CrewMember {
  b: Builder;
  spot: WorkSpot;
  path: Vec3[];
  cum: number[];
  len: number;
  lastStrike: number;
  opacity: number;
}

interface Build {
  flowId: string;
  truck: Vehicle;
  car: Vehicle | null;
  crew: CrewMember[];
  truckStopX: number;
  carStopX: number;
  startX: number;
  endX: number;
  laneY: number;
  laneZ: number;
  maxLen: number;
  desksShown: boolean;
  agentsSent: boolean;
  framedLot: boolean;
  street: StreetContext;
}

interface Spark { mesh: any; vx: number; vy: number; vz: number; life: number }

function easeOutBack(t: number): number {
  const c1 = 1.7, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function spinWheels(v: Vehicle, dx: number): void {
  const a = dx / WHEEL_RADIUS;
  for (const w of v.wheels) w.rotation.y += a;
}

export function createConstructionStage(ctx: StageContext) {
  let build: Build | null = null;
  /** Vehicles still driving off after their build ended. */
  const leaving: Array<{ v: Vehicle; endX: number }> = [];
  const sparks: Spark[] = [];
  let sparkGeo: any = null;
  let sparkMat: any = null;

  function emitSparks(at: Vec3): void {
    const T = rt.THREE;
    sparkGeo ??= new T.BoxGeometry(0.06, 0.06, 0.06);
    sparkMat ??= new T.MeshBasicMaterial({ color: 0xffb347 });
    for (let i = 0; i < 5; i++) {
      const mesh = new T.Mesh(sparkGeo, sparkMat);
      mesh.position.set(at.x, at.y, at.z);
      ctx.scene.add(mesh);
      const a = Math.random() * Math.PI * 2;
      sparks.push({ mesh, vx: Math.cos(a) * 1.8, vy: 1.5 + Math.random() * 1.8, vz: Math.sin(a) * 1.8, life: 0.45 });
    }
  }

  function updateSparks(dt: number): void {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt;
      s.vy -= 9 * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      if (s.life <= 0) { ctx.scene.remove(s.mesh); sparks.splice(i, 1); }
    }
  }

  function start(flowId: string): Build | null {
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
      crew.push({ b, spot, path, cum: buildCumDist(path), len: pathLength(path), lastStrike: 0, opacity: 1 });
    }
    const maxLen = Math.max(...crew.map(c => c.len));
    const walk = Math.min(10, Math.max(2.5, maxLen / CREW_SPEED));
    ctx.setDurations(flowId, { 'walk-in': walk, 'walk-out': LEAVE_SECONDS });
    // The truck arriving at the stairs first; the camera moves on to the lot once the crew gets there.
    ctx.frame(street.entryCX, street.southLaneZ - 8, 34);

    return {
      flowId, truck, car: null, crew, truckStopX, carStopX: street.entryCX + 1.2,
      startX, endX, laneY, laneZ: street.southLaneZ, maxLen,
      desksShown: false, agentsSent: false, framedLot: false, street,
    };
  }

  function disposeBuild(b: Build): void {
    disposeVehicle(b.truck);
    disposeVehicle(b.car);
    for (const c of b.crew) disposeBuilder(c.b);
  }

  /** Raise/lower the office's walls and show its furniture for this moment of the build. */
  function applyRoom(b: Build, phase: Phase, p: number): void {
    const order = new Map(b.crew.map((c, i) => [c.spot.wall as string, i]));
    const before = phase === 'truck-in' || phase === 'walk-in';
    const building = phase === 'build';
    for (const g of ctx.roomGroups(b.flowId)) {
      const groupPart = g.userData.part as string | undefined;
      const children = groupPart ? [g] : g.children;
      for (const c of children) {
        const part = (c.userData.part as string | undefined) ?? groupPart;
        if (part === 'wall') {
          c.userData.baseY ??= c.position.y;
          const k = order.get(c.userData.wallId) ?? 0;
          const s = before ? 0 : building ? wallRise(p, k, CREW_SIZE) : 1;
          c.visible = s > 0.005;
          c.scale.y = Math.max(s, 0.001);
          c.position.y = c.userData.baseY * s;
        } else if (part === 'decor' || part === 'sign') {
          const pop = before ? 0 : building ? clamp01((p - DECOR_FROM) / (1 - DECOR_FROM)) : 1;
          c.visible = pop > 0;
          // Meshes pop in place; a whole themed interior (a group at the origin) just appears.
          if (part === 'decor' && c.isMesh) c.scale.setScalar(pop > 0 && pop < 1 ? Math.max(0.01, easeOutBack(pop)) : 1);
        }
      }
    }
  }

  /** Put an office back exactly as the floor builds it — walls up, everything shown. */
  function restoreRoom(flowId: string): void {
    for (const g of ctx.roomGroups(flowId)) {
      const children = g.userData.part ? [g] : g.children;
      for (const c of children) {
        if (c.userData.baseY !== undefined) { c.position.y = c.userData.baseY; c.scale.y = 1; }
        if (c.userData.part === 'decor' || g.userData.part === 'decor') c.scale.setScalar(1);
        c.visible = true;
      }
    }
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

  function placeCrew(b: Build, phase: Phase, p: number, time: number): void {
    for (const c of b.crew) {
      const g = c.b.parts.group;
      if (phase === 'truck-in' || phase === 'car-in' || phase === 'agents') { g.visible = false; continue; }
      g.visible = true;
      if (phase === 'build') {
        g.position.set(c.spot.pos.x, 0, c.spot.pos.z);
        g.rotation.y = c.spot.facing;
        poseHammering(c.b, time);
        const strike = hammerStrikeIndex(time, c.b.phase);
        if (strike !== c.lastStrike && p < DECOR_FROM) {
          c.lastStrike = strike;
          emitSparks({
            x: c.spot.pos.x + Math.sin(c.spot.facing) * 0.9,
            y: 1.0 + p * 1.6,
            z: c.spot.pos.z + Math.cos(c.spot.facing) * 0.9,
          });
        }
        continue;
      }
      if (phase === 'walk-out') {
        // Out through the door and off down the corridor, fading as they go.
        const t = 1 - clamp01((p * LEAVE_SECONDS * LEAVE_SPEED) / c.len);
        const pos = interpolatePath(c.path, t, c.cum);
        g.position.set(pos.x, pos.y ?? 0, pos.z);
        g.rotation.y = pathDirection(c.path, t, c.cum) + Math.PI;
        poseWalking(c.b, time);
        setOpacity(c, 1 - clamp01((p - 0.55) / 0.45));
        continue;
      }
      // Walking in: everyone leaves together at the same pace; nearer builders arrive first and wait.
      setOpacity(c, 1);
      const along = clamp01((p * b.maxLen) / c.len);
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

  function placeVehicles(b: Build, phase: Phase, p: number, dt: number): void {
    const truck = b.truck;
    const prevX = truck.group.position.x;
    if (phase === 'truck-in') truck.group.position.x = b.startX + (b.truckStopX - b.startX) * easeOutCubic(p);
    else if (phase === 'car-in' || phase === 'agents') {
      const q = phase === 'car-in' ? p : 1;
      truck.group.position.x = b.truckStopX + (b.endX - b.truckStopX) * (q * q);
    } else truck.group.position.x = b.truckStopX;
    truck.group.visible = phase !== 'agents';
    spinWheels(truck, prevX - truck.group.position.x);
    if (truck.beacon) truck.beacon.rotation.y += dt * 9;

    if (phase === 'car-in' || phase === 'agents') {
      if (!b.car) {
        b.car = buildAgentsCar(ctx.color(b.flowId), ctx.agentCount(b.flowId));
        b.car.group.position.set(b.startX, b.laneY, b.laneZ);
        ctx.scene.add(b.car.group);
      }
      const cx = b.car.group.position.x;
      b.car.group.position.x = phase === 'car-in' ? b.startX + (b.carStopX - b.startX) * easeOutCubic(p) : b.carStopX;
      spinWheels(b.car, cx - b.car.group.position.x);
    }
  }

  return {
    /** Advance with the director's current build (null = nothing building). */
    update(dt: number, time: number, active: ActiveBuild | null): void {
      updateSparks(dt);
      for (let i = leaving.length - 1; i >= 0; i--) {
        const l = leaving[i];
        const prevX = l.v.group.position.x;
        l.v.group.position.x -= 9 * dt;
        spinWheels(l.v, prevX - l.v.group.position.x);
        if (l.v.group.position.x <= l.endX) { disposeVehicle(l.v); leaving.splice(i, 1); }
      }

      if (build && (!active || active.flowId !== build.flowId)) {
        // Skipped (or the office vanished): no ceremony, put everything back.
        restoreRoom(build.flowId);
        disposeBuild(build);
        build = null;
      }
      if (!active) return;
      if (!build) {
        build = start(active.flowId);
        if (!build) return;
      }
      const { phase, progress } = active;
      applyRoom(build, phase, progress);
      placeCrew(build, phase, progress, time);
      placeVehicles(build, phase, progress, dt);

      // Close on the lot for the build itself, just before the crew arrives.
      if (!build.framedLot && (phase === 'build' || (phase === 'walk-in' && progress > 0.7))) {
        build.framedLot = true;
        const room = ctx.room(build.flowId);
        if (room) ctx.frame(room.cx, room.cz, Math.max(room.w, room.d) * 1.6);
      }
      if (!build.desksShown && (phase === 'build' ? progress >= 0.92 : phase !== 'truck-in' && phase !== 'walk-in')) {
        build.desksShown = true;
        ctx.showDesks(build.flowId);
      }
      if (!build.agentsSent && phase === 'agents') {
        build.agentsSent = true;
        const s = build.street;
        ctx.sendAgents(build.flowId, [
          { x: build.carStopX - 0.4, y: build.laneY, z: build.laneZ - 1.5 },
          { x: s.entryCX, y: build.laneY, z: s.pedOuterZ1 - 0.3 },
          { x: s.entryCX, y: 0, z: s.plinthOuterZ1 - 0.3 },
        ]);
      }
    },

    /** The director finished a build on its own: the car drives off, the rest is cleared. */
    finished(flowId: string): void {
      if (!build || build.flowId !== flowId) return;
      restoreRoom(flowId);
      if (build.car) { leaving.push({ v: build.car, endX: build.endX }); build.car = null; }
      disposeBuild(build);
      build = null;
    },

    /** Where everyone is — for the console helper. */
    debug(): unknown {
      if (!build) return null;
      const r = (v: any) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
      return {
        truck: r(build.truck.group.position),
        crew: build.crew.map(c => `${c.b.parts.group.visible ? 'v' : 'h'} ${r(c.b.parts.group.position)} len=${c.len.toFixed(0)} inScene=${!!c.b.parts.group.parent}`),
      };
    },

    /** The build in progress, for a scene rebuild that must keep its walls down. */
    buildingFlowId(): string | null { return build?.flowId ?? null; },

    dispose(): void {
      if (build) { disposeBuild(build); build = null; }
      for (const l of leaving) disposeVehicle(l.v);
      leaving.length = 0;
      for (const s of sparks) ctx.scene.remove(s.mesh);
      sparks.length = 0;
      sparkGeo?.dispose(); sparkMat?.dispose();
      sparkGeo = sparkMat = null;
    },
  };
}

export type ConstructionStage = ReturnType<typeof createConstructionStage>;
