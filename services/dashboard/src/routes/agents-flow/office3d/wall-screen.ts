// office3d/wall-screen.ts
// In-world screens and the interactive-prop convention.
//
// Floating CSS2D titles pile on top of each other once a room holds more than
// a couple of them, and they read the same from across the map as from inside
// the room. A prop instead carries its information on its own surface (a
// canvas texture on a plate, a wall screen, a console display) and says what
// it does only when the pointer is on it: cursor, tooltip, a slight glow.
//
// Convention: a mesh the raycaster can hit carries `userData.prop`. The world
// view handles every tagged mesh the same way, so a new clickable object needs
// no new branch in AgentWorld3D's hover and click handlers.
import { rt } from './runtime.js';

/** Where the pointer landed on a prop, in the prop mesh's own UV space. */
export interface PropHit {
  uv?: { x: number; y: number } | null;
}

export interface InteractiveProp {
  /** Tooltip for the pointer position, or null for none. */
  tip: (hit: PropHit) => string | null;
  /** What a click does. Absent → a hover-only prop (tooltip, no pointer cursor). */
  click?: (hit: PropHit) => void;
  /** Visual hover feedback; called with false when the pointer leaves. */
  hover?: (on: boolean) => void;
}

/** Tag `obj` as an interactive prop. Returns it, for chaining at build time. */
export function tagProp<T extends { userData: Record<string, unknown> }>(obj: T, prop: InteractiveProp): T {
  obj.userData.prop = prop;
  return obj;
}

/** The prop a raycast hit belongs to: the hit mesh or its nearest tagged ancestor. */
export function propOf(obj: any): InteractiveProp | null {
  for (let o = obj; o; o = o.parent) {
    const p = o.userData?.prop as InteractiveProp | undefined;
    if (p) return p;
  }
  return null;
}

/** Hover glow for flat screens: brighten the materials' colour while hovered. */
export function glowOnHover(mats: any[], factor = 1.35): (on: boolean) => void {
  return (on) => {
    for (const m of mats) m.color?.setScalar(on ? factor : 1);
  };
}

// ── List screens ─────────────────────────────────────────────────────

/** Vertical layout of a list screen, in canvas pixels from the top. */
export interface ListLayout {
  /** Canvas height. */
  height: number;
  pad: number;
  headerH: number;
  rowH: number;
  /** Rows drawn (not the full data length). */
  rows: number;
  /** Height of the footer line under the rows; 0 when there is none. */
  footerH: number;
}

export type ListPart =
  | { kind: 'header' }
  | { kind: 'row'; index: number }
  | { kind: 'footer' }
  | null;

/**
 * Which part of a list screen a UV coordinate falls on. UV y runs bottom→top
 * (three.js convention) while the canvas is drawn top→bottom, hence the flip.
 */
export function listPartAt(layout: ListLayout, uvY: number): ListPart {
  const y = (1 - uvY) * layout.height;
  const headerEnd = layout.pad + layout.headerH;
  if (y < layout.pad) return null;
  if (y < headerEnd) return { kind: 'header' };
  const rowsEnd = headerEnd + layout.rows * layout.rowH;
  if (y < rowsEnd) return { kind: 'row', index: Math.floor((y - headerEnd) / layout.rowH) };
  if (layout.footerH > 0 && y < rowsEnd + layout.footerH) return { kind: 'footer' };
  return null;
}

/** Canvas height that fits a layout exactly. */
export function listHeight(l: Omit<ListLayout, 'height'>): number {
  return l.pad * 2 + l.headerH + l.rows * l.rowH + l.footerH;
}

// ── Canvas panels ────────────────────────────────────────────────────

export interface CanvasPanel {
  mesh: any;
  mat: any;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D | null;
  /** Re-upload the canvas after drawing on it again. */
  refresh: () => void;
}

/**
 * A flat, unlit plane `wM`×`hM` metres showing a canvas of `pxW`×`pxH`.
 * Unlit on purpose: it reads as a backlit screen in any room lighting.
 * Faces local +Z; the caller positions and rotates it.
 */
export function canvasPanel(wM: number, hM: number, pxW: number, pxH: number): CanvasPanel {
  const THREE = rt.THREE;
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), mat);
  return { mesh, mat, canvas, g, refresh: () => { tex.needsUpdate = true; } };
}

/** Shorten `text` with an ellipsis until it fits `maxW` pixels in the current font. */
export function fitText(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
