/**
 * Free lots — the plots no office stands on yet, drawn as bare ground with an
 * amber survey outline and a small sign, so the floor shows where the next
 * office will go. All lots share two merged meshes (ground, outline); the
 * signs are CSS2D.
 */

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rt } from '../runtime.js';
import type { Lot } from '$shared/office-lots.js';

const EDGE_W = 0.22;
/** Gap between the outline and the lot edge, so it reads as a pegged survey line. */
const EDGE_INSET = 0.6;
const DASH = 1.6;
const GAP = 0.9;

export interface LotLabels {
  title: string;
  capacity: (n: number) => string;
  /** Tooltip on the sign: what a click does. */
  action?: string;
}

/** Which free lot, if any, a point on the ground falls in. */
export function lotAtPoint(lots: Lot[], x: number, z: number): Lot | null {
  return lots.find(l => Math.abs(x - l.cx) <= l.w / 2 && Math.abs(z - l.cz) <= l.d / 2) ?? null;
}

function dashes(geos: any[], x1: number, z1: number, x2: number, z2: number): void {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const ux = (x2 - x1) / len, uz = (z2 - z1) / len;
  for (let s = 0; s < len; s += DASH + GAP) {
    const l = Math.min(DASH, len - s);
    const g = Math.abs(ux) > 0.5
      ? new rt.THREE.BoxGeometry(l, 0.04, EDGE_W)
      : new rt.THREE.BoxGeometry(EDGE_W, 0.04, l);
    g.translate(x1 + ux * (s + l / 2), 0.035, z1 + uz * (s + l / 2));
    geos.push(g);
  }
}

/**
 * Draw the free lots. Returns the merged ground mesh (raycast it with
 * `lotAtPoint` to tell which lot a click landed on), or null when there are none.
 * `onPick` fires when a lot's sign is clicked.
 */
export function buildLotMarkers(target: any, lots: Lot[], labels: LotLabels, onPick?: (lot: Lot) => void): any | null {
  if (lots.length === 0) return null;
  const T = rt.THREE;
  const groundGeos: any[] = [];
  const edgeGeos: any[] = [];
  for (const lot of lots) {
    const ground = new T.PlaneGeometry(lot.w, lot.d);
    ground.rotateX(-Math.PI / 2);
    ground.translate(lot.cx, 0.015, lot.cz);
    groundGeos.push(ground);
    const x0 = lot.cx - lot.w / 2 + EDGE_INSET, x1 = lot.cx + lot.w / 2 - EDGE_INSET;
    const z0 = lot.cz - lot.d / 2 + EDGE_INSET, z1 = lot.cz + lot.d / 2 - EDGE_INSET;
    dashes(edgeGeos, x0, z0, x1, z0);
    dashes(edgeGeos, x0, z1, x1, z1);
    dashes(edgeGeos, x0, z0, x0, z1);
    dashes(edgeGeos, x1, z0, x1, z1);
  }
  const groundMat = new T.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 1, metalness: 0 });
  const ground = new T.Mesh(mergeGeometries(groundGeos, false), groundMat);
  ground.receiveShadow = true;
  ground.userData.lotMarkers = true;
  target.add(ground);
  const edgeMat = new T.MeshBasicMaterial({ color: 0xf2b705, transparent: true, opacity: 0.75 });
  const edges = new T.Mesh(mergeGeometries(edgeGeos, false), edgeMat);
  edges.userData.lotMarkers = true;
  target.add(edges);
  for (const g of [...groundGeos, ...edgeGeos]) g.dispose();

  for (const lot of lots) {
    const div = document.createElement('div');
    div.style.cssText = `font:600 10px 'Manrope',sans-serif;color:#f2d38a;text-align:center;
      background:rgba(23,24,27,0.78);border:1px dashed #f2b70588;border-radius:5px;padding:4px 8px;
      pointer-events:${onPick ? 'auto' : 'none'};cursor:${onPick ? 'pointer' : 'default'};white-space:nowrap;`;
    if (onPick) {
      if (labels.action) div.title = labels.action;
      div.addEventListener('click', (ev) => { ev.stopPropagation(); onPick(lot); });
    }
    const title = document.createElement('div');
    title.textContent = labels.title;
    const sub = document.createElement('div');
    sub.textContent = labels.capacity(lot.capacity);
    sub.style.cssText = 'font-weight:500;font-size:9px;color:#b9a77a;margin-top:2px;';
    div.append(title, sub);
    const sign = new rt.CSS2DObject(div);
    sign.position.set(lot.cx, 1.2, lot.cz);
    sign.userData.lotMarkers = true;
    target.add(sign);
  }
  return ground;
}
