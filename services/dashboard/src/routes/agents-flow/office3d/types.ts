/** Shared types for the 3D office visualization */

export interface AgentData {
  id: string; name: string; description: string;
  provider: string; model: string; active: number;
  builtin_handler: string; flow_id: string;
  rank_id?: string;
  role?: string;
  executor_type?: 'native' | 'claude_code' | string;
  model_chain?: string; // JSON array of ModelChainEntry, '' = use (provider, model) single
  /** Installed visual skin id (e.g. 'office-worker', 'ra-soldier'). Falls
   *  back to the registered default skin when undefined or unknown. */
  skin_id?: string;
}

/** Backend default when a claude_code agent leaves `model` empty. */
export const CLAUDE_CODE_DEFAULT_MODEL = 'claude-opus-4-6';

export interface RankData {
  id: string;
  name: string;
  level: number;
  insignia: string;
  color: string;
  description: string;
  active: number;
}

export interface ChainData {
  id: string; source_agent_id: string; target_agent_id: string;
  label: string; active: number;
}

export interface FlowData {
  id: string; name: string; color: string; active: number;
}

export interface StatsData {
  total_runs: number; completed: number; failed: number; success_rate: number;
}

export interface Vec3 { x: number; y: number; z: number; }

/** Axis-aligned bounding box in the XZ plane — used for walker obstacle avoidance. */
export interface Aabb2D {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  agentId?: string;
}

export interface HumanoidParts {
  group: any; head: any; torso: any;
  leftArm: any; rightArm: any;
  leftLeg: any; rightLeg: any;
}

export interface Walker {
  group: any;
  leftLeg: any; rightLeg: any; leftArm: any; rightArm: any;
  torso: any; head: any; envelope: any; light: any;
  curve: Vec3[]; progress: number; speed: number;
  age: number; maxAge: number; arrived: boolean;
  sourceId: string; targetId: string; color: any;
  returning: boolean; returnCurve: Vec3[];
  bubble: any;
  /** World units per second — used for delta-time based motion */
  unitsPerSec?: number;
  /** Total path length in world units */
  pathLength?: number;
  /** Pre-computed cumulative distances for each segment of forward path */
  fwdCumDist?: number[];
  /** Pre-computed cumulative distances for each segment of return path */
  retCumDist?: number[];
  /** Phase offset for talking animation (per walker) */
  talkPhase?: number;
  /** Lateral offset perpendicular to path (avoids walker overlap) */
  lateralOffset?: number;
  /** Seconds elapsed since arrived at target — used for talking animation timer */
  arrivedSec?: number;
  /** Accumulated time in seconds — used for delta-time based animation */
  timeSec?: number;
  /** Position to face when talking (target worker world position) */
  talkFacingPos?: { x: number; z: number };
  /** Fade state: 0=normal, 1=fading-in, 2=fading-out */
  fadeState?: number;
  fadeProgress?: number;
  /** Cached list of fadeable materials — avoids per-frame scene graph traversal. */
  fadeMats?: any[];
  /** Urgent walker — runs instead of walks, 1.6x speed */
  urgent?: boolean;
  /** One-way walker (LEAVE/ARRIVE for pause/resume). Skips the talking +
   *  return loop; fades out at the target instead. */
  oneWay?: boolean;
  /** ARRIVE walkers: when the walker finishes fading at the target desk,
   *  toggle the seated worker visible — the agent has "sat down". */
  restoreSeatedOnArrive?: boolean;
  /** Optional one-shot side-effect run the instant the walker reaches its
   *  target (after the seated pose / facing snap, before the talking phase).
   *  Used by report-walkers to deposit a paper note on the top agent's desk. */
  onArriveCallback?: () => void;
  /** True once `onArriveCallback` has fired — guards against repeat invocations
   *  during the talking phase where `w.arrived` stays true across many frames. */
  onArriveFired?: boolean;
  /** Meeting attendees: stay seated until removeArrivedWalkers() dismisses
   *  them (meeting_ended event / End Meeting button). Disables the auto-return
   *  timer; the age>maxAge safety still walks them home as a last resort. */
  stayAtTarget?: boolean;
}

export interface RoomInfo {
  cx: number; cz: number; w: number; d: number; color: string; name: string;
  /** Z coordinate of the door center (corridor-facing wall) */
  doorZ: number;
  /** Which of the 4 walls has the door: top(+Z), bottom(-Z), left(-X), right(+X) */
  doorDir?: 'top' | 'bottom' | 'left' | 'right';
  /** Exact X,Z of the door center point (where the walker should exit/enter) */
  doorX?: number;
  doorCZ?: number;
  /** Which side of corridor: -1 = left, +1 = right */
  side: -1 | 1;
}

export interface CorridorInfo {
  centerX: number;
  width: number;
  startZ: number;
  endZ: number;
}

export interface FloorPlan {
  deskPositions: Map<string, Vec3>;
  rooms: Map<string, RoomInfo>;
  corridor: CorridorInfo;
}

export interface SpeechBubble {
  div: HTMLElement;
  /** CSS2DObject when the tag was its own scene node. Null now that the tag
   *  lives inside the agent's nameplate chip. */
  label: any | null;
  age: number;
  maxAge: number;
}

export const FLOW_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#06b6d4',
  '#10b981', '#f59e0b', '#ef4444', '#3b82f6',
];

export function agentType(a: AgentData): 'llm' | 'claude_code' | 'function' | 'cli' {
  if (a.builtin_handler) {
    if (a.builtin_handler.startsWith('script:')) return 'cli';
    return 'function';
  }
  if (a.executor_type === 'claude_code') return 'claude_code';
  return 'llm';
}

/**
 * Can this agent actually use procedural skills?
 *
 * No, when a builtin handler is set. `executor.ts:238` short-circuits the LLM
 * path for those and returns with `tokens_used: 0`; the skills index is only
 * assembled ~400 lines later, at `:656`. A script agent never reaches it, so
 * attaching a skill to one is a no-op — and the SKILLS tab would quote a
 * per-run token cost that is never paid.
 *
 * The kernel already encodes this judgement elsewhere: the skill suggester
 * filters `builtin_handler != ?` and takes an operator-supplied list of
 * excluded prefixes, so builtins are never recommended anything.
 *
 * `claude_code` deliberately counts as yes. That executor is registered by an
 * extension through `registerAltExecutor`, its implementation is not in this
 * repo, and nothing here proves it ignores skills. Hiding a tab that may work
 * is worse than showing one that does not.
 */
export function agentUsesSkills(a: AgentData): boolean {
  const t = agentType(a);
  return t !== 'function' && t !== 'cli';
}

/** Number of fallback entries in a model_chain JSON string (excluding the primary). */
export function modelChainFallbacks(chain: string | undefined): number {
  if (!chain) return 0;
  try {
    const parsed = JSON.parse(chain);
    if (Array.isArray(parsed) && parsed.length > 1) return parsed.length - 1;
  } catch { /* invalid JSON — treat as no chain */ }
  return 0;
}

export function resolveFlowColor(
  agentId: string,
  agents: AgentData[],
  flows: FlowData[],
): string {
  const a = agents.find(x => x.id === agentId);
  if (a?.flow_id) {
    const f = flows.find(x => x.id === a.flow_id);
    if (f) return f.color;
  }
  return FLOW_COLORS[agents.findIndex(x => x.id === agentId) % FLOW_COLORS.length];
}
