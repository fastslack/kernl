/**
 * Chyron label — a multi-line styled CSS2D card that pops, holds, drifts
 * upward slightly, and fades. Designed for richer info than `floatingGlyph`:
 * accepts raw HTML so the caller can compose multi-line ticker readouts.
 *
 * Used by the trade-execution scene for "🟢 BUY 100 AAPL @ $185.32"-style
 * summaries.
 */

import type { Ticker } from '../registry.js';
import { easeOutQuad } from '../easing.js';
import { getCSS2D } from './_init.js';

export interface ChyronLabelOpts {
  /** World position of the card center. */
  position: { x: number; y: number; z: number };
  /** Raw HTML content. Caller is responsible for trusting the source. */
  html: string;
  /** Border + glow color (CSS). Default white. */
  color?: string;
  /** Total lifetime. Default 2.5. */
  durationSec?: number;
  /** Scale-in time. Default 0.25. */
  popInSec?: number;
  /** Fade-out duration. Default 0.5. */
  fadeSec?: number;
  /** Y drift over the lifetime. Default 0.3. */
  riseHeight?: number;
  /** Minimum width in pixels. Default 160. */
  minWidthPx?: number;
  tag?: string;
}

export function chyronLabel(scene: any, opts: ChyronLabelOpts): Ticker {
  const CSS2D = getCSS2D();
  const color = opts.color ?? '#fff';
  const duration = opts.durationSec ?? 2.5;
  const popIn = opts.popInSec ?? 0.25;
  const fade = opts.fadeSec ?? 0.5;
  const rise = opts.riseHeight ?? 0.3;
  const minW = opts.minWidthPx ?? 160;

  const div = document.createElement('div');
  div.innerHTML = opts.html;
  div.style.cssText = `font:700 12px/1.3 'Fira Code',monospace;color:#fff;
    background:linear-gradient(180deg,rgba(0,8,16,0.92),rgba(0,16,32,0.96));
    border:2px solid ${color};padding:8px 14px;border-radius:6px;
    box-shadow:0 0 18px ${color},0 4px 14px rgba(0,0,0,0.5);
    min-width:${minW}px;text-align:center;letter-spacing:0.3px;
    transform:scale(0);opacity:0;
    transform-origin:center;pointer-events:none;will-change:transform,opacity;`;
  const label = new CSS2D(div);
  label.position.set(opts.position.x, opts.position.y, opts.position.z);
  scene.add(label);

  let elapsed = 0;
  const fadeStart = duration - fade;

  return {
    tag: opts.tag ?? 'chyron-label',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      if (elapsed >= duration) return true;

      const t = elapsed / duration;
      label.position.y = opts.position.y + rise * t;

      let scale: number;
      let opacity: number;
      if (elapsed < popIn) {
        scale = easeOutQuad(elapsed / popIn);
        opacity = scale;
      } else if (elapsed > fadeStart) {
        scale = 1;
        opacity = Math.max(0, 1 - (elapsed - fadeStart) / fade);
      } else {
        scale = 1;
        opacity = 1;
      }
      div.style.transform = `scale(${scale.toFixed(2)})`;
      div.style.opacity = opacity.toFixed(3);
      return false;
    },
    dispose() {
      if (label.parent) label.parent.remove(label);
      div.remove();
    },
  };
}
