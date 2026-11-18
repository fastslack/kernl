/**
 * World plugins — how an extension adds its own building to the 3D office
 * world without the core knowing what that building is.
 *
 * An extension declares a bundle in its manifest:
 *
 *   "frontend": { "worlds": [{ "entry": "frontend/world.js", "kinds": [{ "id": "warehouse", "offGrid": true }] }] }
 *
 * The dashboard imports `/ext-assets/<slug>/world.js` when an office of one of
 * those kinds exists and calls its default export (a `WorldPlugin`). The
 * bundle must NOT ship its own three.js: everything 3D comes from `WorldHost`.
 *
 * `offGrid` kinds take no lot on the office grid: the plugin places the
 * office in a building of its own (`site()`), and the kernel's lot assignment
 * skips them (office-lots.ts → takesNoLot).
 */

export interface WorldVec3 { x: number; y: number; z: number }
export interface WorldAabb { minX: number; maxX: number; minZ: number; maxZ: number }
/** `y`: height the camera aims at (e.g. a floor of a tower); ground level when absent. */
export interface WorldRect { cx: number; cz: number; w: number; d: number; y?: number }
export interface WorldSegment { x1: number; z1: number; x2: number; z2: number; width: number; outdoor?: boolean }

/** An office room the walker router treats like any grid office. */
export interface WorldRoom extends WorldRect {
  doorDir: 'top' | 'bottom' | 'left' | 'right';
  doorX: number;
  doorCZ: number;
  doorZ: number;
  corridorZ: number;
  side: 1 | -1;
}

/** Where an off-grid office stands, computed from the main building. */
export interface OffGridSite {
  /** The office room (its agents' desks are placed inside it). */
  room: WorldRoom;
  /** Corridor segments/nodes appended to the grid so walkers can get there. */
  extraSegments: WorldSegment[];
  extraNodes: WorldVec3[];
  /** Solid walls for the walker router. */
  obstacles: WorldAabb[];
  /** Everything the site covers (camera framing, shadow frustum). */
  extent: WorldAabb;
  /** What the camera frames when the office is focused. */
  focus: WorldRect;
  /** Desk positions for these agents inside the room. */
  desks(agentIds: string[]): Map<string, WorldVec3>;
  /** Ground height off the flat floor (stairs, streets); undefined = flat. */
  groundHeight?(x: number, z: number): number;
}

/** What the core lends a plugin. */
export interface WorldHost {
  THREE: any;
  CSS2DObject: any;
  mergeGeometries(geos: any[], useGroups?: boolean): any;
  applyPBR(mat: any, role: string): void;
  applyWorldTexture(mat: any, kind: string): void;
  scaleUV(geo: any, u: number, v: number): void;
  /** Kernel RPC (`POST /api/rpc/<action>`). */
  rpc(action: string, args?: Record<string, unknown>): Promise<any>;
  navigate(path: string): void;
  /** Frame a rectangle of the world with the camera. */
  focus(rect: WorldRect): void;
  /** Current UI language, e.g. "es". */
  locale: string;
  /** Whether a dashboard page view exists (e.g. the extension's own page). */
  hasPage(view: string): boolean;
  /** Ask the core to redraw the world (data changed). */
  invalidate(): void;
}

/**
 * A plugin building's headline numbers, shown by the core in the page's
 * header bar next to the building's own (agents, working, runs today) instead
 * of floating over the canvas. The core draws them; the plugin only says what
 * they are and republishes when they change.
 */
export type WorldStatTone = 'cyan' | 'violet' | 'green' | 'amber' | 'neutral';
export interface WorldStatMetric {
  key: string;
  /** Already formatted (the plugin knows its locale and units). */
  value: string;
  label: string;
  tone?: WorldStatTone;
  /** Shown in the compact (narrow) layout; the first metric when none is marked. */
  primary?: boolean;
  title?: string;
}
/** A connector or feed the building depends on. */
export interface WorldStatStatus {
  key: string;
  label: string;
  state: 'ok' | 'connecting' | 'error' | 'off';
  /** A number next to the label, e.g. "12"; `stale` when it is the last good value of a failing feed. */
  value?: string;
  unit?: string;
  stale?: boolean;
  /** Short state word drawn when the state is not ok, e.g. "error". */
  badge?: string;
  title?: string;
}
export interface WorldStatAction {
  key: string;
  label: string;
  icon?: string;
  title?: string;
  /** A toggle that is on. */
  pressed?: boolean;
  run(): void;
}
export interface WorldStats {
  title: string;
  /** A live badge ("EN VIVO") or a demo one; nothing when absent. */
  badge?: { text: string; tone: 'live' | 'demo' };
  metrics: WorldStatMetric[];
  statuses?: WorldStatStatus[];
  actions?: WorldStatAction[];
  /** A line instead of the metrics while there is nothing to show yet. */
  waiting?: string;
  /** Fly the camera to the building (a click on the stats). */
  focus?(): void;
}

export interface WorldMountContext {
  host: WorldHost;
  /**
   * Show the building's numbers in the page's header bar (null clears them).
   * Absent on cores older than this contract: the plugin then draws them on
   * `overlay` itself.
   */
  publishStats?(stats: WorldStats | null): void;
  /** Group to add the building to (removed and disposed by the core on rebuild). */
  target: any;
  site: OffGridSite | null;
  /** Absolutely positioned layer over the canvas for the plugin's own UI. */
  overlay: HTMLElement;
  /** The offices of the plugin's kinds. */
  offices: Array<{ id: string; name: string; color: string; kind: string }>;
  camera: any;
  /** Canvas bounding rect getter, for screen projections. */
  canvasRect(): DOMRect;
}

/** A raycast hit as the core reports it. */
export interface WorldHit { object: any; instanceId?: number; point?: { x: number; y: number; z: number } }

export interface WorldViewItem { id: string; label: string; run(): void }

export interface WorldPluginInstance {
  tick(dtSec: number): void;
  /** Meshes the core raycasts for hover/click. */
  pickTargets(): any[];
  /** A hit on one of pickTargets(): tooltip text, or null for none. */
  hover?(hit: WorldHit, screen: { x: number; y: number }): string | null;
  /** A click on one of pickTargets(); true when handled. */
  click?(hit: WorldHit): boolean;
  /** Entries for the world's View menu. */
  viewItems?(): WorldViewItem[];
  /** Window functions for testing animations, e.g. { __truckDemo: fn }. */
  consoleCommands?(): Record<string, (...args: any[]) => unknown>;
  /** One-line help per console command (listed by __animDemos()). */
  consoleHelp?(): string[];
  dispose(): void;
}

export interface WorldPlugin {
  /** Kinds this plugin draws. */
  kinds: string[];
  /** Off-grid site from the main building bounds and its horizontal corridor Zs. */
  site?(bounds: WorldAabb, hCorridorZs: number[]): OffGridSite;
  mount(ctx: WorldMountContext): WorldPluginInstance;
}

/** A plugin bundle's default export. */
export type WorldPluginFactory = () => WorldPlugin;
