/**
 * Ticker card — a CSS2D order card that pops above a desk, holds, then flies
 * along a quadratic bezier to a destination world point. Emits a short comet
 * trail (Three.js spheres) while in flight. Drives Act 1 + Act 2 of the
 * trade-execution scene.
 *
 * Lifetime: popInSec → holdSec → flySec → fadeSec.
 * `onArrive` fires the moment the card reaches `flyTo` (before fade).
 */

import type { Ticker } from '../registry.js';
import { easeInOutQuad, easeOutQuad } from '../easing.js';
import { getThree, getCSS2D } from './_init.js';

export interface TickerCardOpts {
  /** Initial world-space position (e.g. above a trader's desk). */
  startWorld: { x: number; y: number; z: number };
  side: 'BUY' | 'SELL';
  symbol: string;
  quantity: number;
  /** Final world destination. If undefined, card stays at startWorld. */
  flyTo?: { x: number; y: number; z: number };
  /** Bezier apex above the midpoint. Default 1.5. */
  archHeight?: number;
  /** Scale-in time. Default 0.2. */
  popInSec?: number;
  /** Hold before flight. Default 0.15. */
  holdSec?: number;
  /** Flight duration (ignored when flyTo undefined). Default 0.7. */
  flySec?: number;
  /** Fade-out duration. Default 0.3. */
  fadeSec?: number;
  /** Emit comet trail during flight. Default true. */
  trail?: boolean;
  /** Trail particle count. Default 8. */
  trailCount?: number;
  /** Trail color override. Default = side color. */
  trailColor?: number;
  /** Called once the card reaches flyTo (before fade starts). */
  onArrive?: () => void;
  tag?: string;
}

const BUY_CSS  = '#00ff88';
const SELL_CSS = '#ff4466';
const BUY_HEX  = 0x00ff88;
const SELL_HEX = 0xff4466;

export function tickerCard(scene: any, opts: TickerCardOpts): Ticker {
  const THREE = getThree();
  const CSS2D = getCSS2D();
  const isBuy = opts.side === 'BUY';
  const cssColor = isBuy ? BUY_CSS : SELL_CSS;
  const hexColor = isBuy ? BUY_HEX : SELL_HEX;
  const popIn = opts.popInSec ?? 0.2;
  const hold  = opts.holdSec  ?? 0.15;
  const fly   = opts.flyTo ? (opts.flySec ?? 0.7) : 0;
  const fade  = opts.fadeSec ?? 0.3;
  const arch  = opts.archHeight ?? 1.5;

  // ── Card ─────────────────────────────────────────────────────────────
  const div = document.createElement('div');
  div.style.cssText = `font:700 11px/1.2 'Fira Code',monospace;color:#fff;
    background:linear-gradient(180deg,rgba(0,8,16,0.85),rgba(0,16,32,0.95));
    border:2px solid ${cssColor};padding:6px 10px;border-radius:4px;
    box-shadow:0 0 14px ${cssColor},0 0 28px ${cssColor}66;
    min-width:90px;text-align:center;font-feature-settings:'tnum';
    transform:scale(0);opacity:0;transform-origin:center;
    pointer-events:none;will-change:transform,opacity;`;
  div.innerHTML =
    `<div style="color:${cssColor};font-size:9px;letter-spacing:2px;">${opts.side}</div>` +
    `<div style="margin-top:1px;font-size:13px;letter-spacing:0.5px;">${opts.quantity} ${opts.symbol}</div>`;
  const label = new CSS2D(div);
  label.position.set(opts.startWorld.x, opts.startWorld.y, opts.startWorld.z);
  scene.add(label);

  // ── Trail ────────────────────────────────────────────────────────────
  const trailEnabled = opts.trail !== false && !!opts.flyTo;
  const trailCount = opts.trailCount ?? 8;
  const trailMeshes: any[] = [];
  const recent: { x: number; y: number; z: number }[] = [];
  let trailGeo: any = null;
  if (trailEnabled) {
    trailGeo = new THREE.SphereGeometry(0.06, 6, 6);
    const trailCol = new THREE.Color(opts.trailColor ?? hexColor);
    for (let i = 0; i < trailCount; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: trailCol, transparent: true, opacity: 0 });
      const m = new THREE.Mesh(trailGeo, mat);
      m.visible = false;
      scene.add(m);
      trailMeshes.push(m);
    }
  }

  // ── Phase boundaries ─────────────────────────────────────────────────
  const E1 = popIn;
  const E2 = popIn + hold;
  const E3 = popIn + hold + fly;
  const E4 = popIn + hold + fly + fade;

  let elapsed = 0;
  let arrived = false;

  return {
    tag: opts.tag ?? 'ticker-card',
    update(deltaSec: number): boolean {
      const wasBeforeArrive = elapsed < E3;
      elapsed += deltaSec;
      if (elapsed >= E4) return true;

      // Fire onArrive at the transition into fade.
      if (wasBeforeArrive && elapsed >= E3 && !arrived) {
        arrived = true;
        opts.onArrive?.();
      }

      let x = opts.startWorld.x;
      let y = opts.startWorld.y;
      let z = opts.startWorld.z;
      let scale = 1;
      let opacity = 1;
      let wobbleDeg = 0;

      if (elapsed < E1) {
        scale = easeOutQuad(elapsed / popIn);
      } else if (elapsed < E2) {
        // Hold
      } else if (elapsed < E3 && opts.flyTo) {
        const t = (elapsed - E2) / fly;
        const e = easeInOutQuad(t);
        const midX = (opts.startWorld.x + opts.flyTo.x) / 2;
        const midZ = (opts.startWorld.z + opts.flyTo.z) / 2;
        const midY = Math.max(opts.startWorld.y, opts.flyTo.y) + arch;
        const u = 1 - e;
        x = u * u * opts.startWorld.x + 2 * u * e * midX + e * e * opts.flyTo.x;
        y = u * u * opts.startWorld.y + 2 * u * e * midY + e * e * opts.flyTo.y;
        z = u * u * opts.startWorld.z + 2 * u * e * midZ + e * e * opts.flyTo.z;
        wobbleDeg = Math.sin(elapsed * 11) * 7;
      } else {
        // Fade
        if (opts.flyTo) {
          x = opts.flyTo.x; y = opts.flyTo.y; z = opts.flyTo.z;
        }
        opacity = Math.max(0, 1 - (elapsed - E3) / fade);
      }

      label.position.set(x, y, z);
      div.style.transform = `scale(${scale.toFixed(2)}) rotate(${wobbleDeg.toFixed(1)}deg)`;
      div.style.opacity = opacity.toFixed(3);

      // ── Trail update ───────────────────────────────────────────────
      if (trailEnabled) {
        if (elapsed >= E2 && elapsed < E3) {
          recent.unshift({ x, y, z });
          if (recent.length > trailCount) recent.length = trailCount;
          for (let i = 0; i < trailMeshes.length; i++) {
            const m = trailMeshes[i];
            const p = recent[i];
            if (!p) { m.visible = false; continue; }
            m.visible = true;
            m.position.set(p.x, p.y, p.z);
            m.material.opacity = (1 - i / trailCount) * 0.55;
          }
        } else if (elapsed >= E3) {
          // Fade trail
          for (const m of trailMeshes) {
            if (m.material) m.material.opacity *= 0.85;
          }
        }
      }
      return false;
    },
    dispose() {
      if (label.parent) label.parent.remove(label);
      div.remove();
      for (const m of trailMeshes) {
        if (m.parent) m.parent.remove(m);
        m.material?.dispose();
      }
      trailGeo?.dispose();
    },
  };
}
