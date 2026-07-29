/**
 * Falling glyph — a CSS2D character that starts high above the parent, falls
 * with quadratic gravity, rotates as it falls, lands at the floor, lingers
 * briefly, then fades. Drives the "lesson dropped" 📜 animation.
 */

import type { Ticker } from '../registry.js';
import { getCSS2D } from './_init.js';

export interface FallingGlyphOpts {
  glyph: string;
  color?: string;
  fontSize?: number;
  /** Initial local Y. Default 2.5. */
  startY?: number;
  /** Floor Y in local coords. Default 0.05. */
  floorY?: number;
  /** Gravity in units/sec². Default 9. */
  gravity?: number;
  /** Spin rate in rad/sec. Default 4. */
  spinSpeed?: number;
  /** Seconds to wait after landing before fading. Default 0.4. */
  lingerSec?: number;
  /** Fade-out duration after linger. Default 0.4. */
  fadeSec?: number;
  tag?: string;
}

export function fallingGlyph(parent: any, opts: FallingGlyphOpts): Ticker {
  const CSS2D = getCSS2D();
  const fontSize = opts.fontSize ?? 22;
  const startY = opts.startY ?? 2.5;
  const floorY = opts.floorY ?? 0.05;
  const gravity = opts.gravity ?? 9;
  const spinSpeed = opts.spinSpeed ?? 4;
  const linger = opts.lingerSec ?? 0.4;
  const fade = opts.fadeSec ?? 0.4;
  const color = opts.color ?? '#cc9';

  const div = document.createElement('div');
  div.textContent = opts.glyph;
  div.style.cssText = `font-size:${fontSize}px;line-height:1;color:${color};
    pointer-events:none;will-change:transform,opacity;transform-origin:center;`;
  const label = new CSS2D(div);
  label.position.set(0, startY, 0);
  parent.add(label);

  let y = startY;
  let vy = 0;
  let spin = 0;
  let landed = false;
  let landedT = 0;

  return {
    tag: opts.tag ?? 'falling-glyph',
    update(deltaSec: number): boolean {
      if (!landed) {
        vy += -gravity * deltaSec;
        y += vy * deltaSec;
        spin += spinSpeed * deltaSec;
        if (y <= floorY) {
          y = floorY;
          landed = true;
        }
        label.position.y = y;
        div.style.transform = `rotate(${spin.toFixed(2)}rad)`;
      } else {
        landedT += deltaSec;
        if (landedT >= linger) {
          const ft = Math.min((landedT - linger) / fade, 1);
          div.style.opacity = (1 - ft).toFixed(3);
          if (ft >= 1) return true;
        }
      }
      return false;
    },
    dispose() {
      if (label.parent) label.parent.remove(label);
      div.remove();
    },
  };
}
