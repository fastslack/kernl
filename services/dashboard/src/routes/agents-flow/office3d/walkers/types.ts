/** Shared walker types — extracted from walkers.ts (structural refactor). */

import type { HumanoidParts, Vec3, RoomInfo, Walker, Aabb2D } from '../types.js';
import type { CorridorGrid } from '../floor-plan.js';

/** Type for the sittingWorkers map shared with furniture.ts. The `group`
 *  field is nullable because pooled (InstancedMesh-backed) workers don't have
 *  a per-instance Object3D; visibility goes through `setVisible()` instead. */
export interface SittingWorkerEntry {
  /** Per-instance humanoid hierarchy. Null when pooled. */
  group: HumanoidParts | null;
  phase: number;
  /** Toggle visibility. Works for both individual and pooled workers. */
  setVisible: (visible: boolean) => void;
  /** True when this worker lives in the InstancedMesh pool. */
  pooled: boolean;
}
export type SittingWorkers = Map<string, SittingWorkerEntry>;

/** Options for sendWalkerToPoint */
export interface WalkerToPointOpts {
  scene: any;
  walkers: Walker[];
  srcId: string;
  targetPoint: Vec3;
  deskPos: Map<string, Vec3>;
  rooms: Map<string, RoomInfo>;
  corridorGrid: CorridorGrid;
  agents: Array<{ id: string; flow_id: string; skin_id?: string }>;
  color: string;
  message?: string;
  deskAabbs?: Map<string, Aabb2D>;
  customTargetId?: string;
}

export interface CommuteWalkerOpts {
  scene: any;
  walkers: Walker[];
  agentId: string;
  mode: 'leave' | 'arrive';
  /** World-space point of the building's entrance/exit. */
  exitPoint: Vec3;
  deskPos: Map<string, Vec3>;
  rooms: Map<string, RoomInfo>;
  corridorGrid: CorridorGrid;
  agents: Array<{ id: string; flow_id: string; skin_id?: string }>;
  color: string;
  deskAabbs?: Map<string, Aabb2D>;
  sittingWorkers?: SittingWorkers;
  /** Optional outdoor waypoints to prepend (ARRIVE) or append (LEAVE) to the
   *  path. Use for the taxi drop-off: pass [carDoor, stairsBottom, stairsTop]
   *  so the walker visibly walks in from the street + up the staircase before
   *  entering the building. The walker's starting Y is taken from the first
   *  waypoint so it appears at street level, not floating on the plinth. */
  outdoorWaypoints?: Vec3[];
  /** Meeting rooms (slots from the layout's special-rooms grid). Treated as
   *  walls the walker MUST route around, exactly like flow offices. Caller
   *  passes the array of {cx,cz,w,d} that should count as obstacles — for
   *  commute walkers that's typically every meeting room except Central
   *  Hall (which is passable). */
  meetingRoomObstacles?: ReadonlyArray<{ cx: number; cz: number; w: number; d: number }>;
}
