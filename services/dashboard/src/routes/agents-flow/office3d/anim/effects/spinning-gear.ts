/**
 * Spinning gear — a CSS2D ⚙️ glyph that rotates in place above the parent,
 * fades in, holds, fades out. Drives the "manager edited my prompt/tools"
 * animation. CSS-rotation is essentially free; we don't need a Three.js mesh.
 */

import type { Ticker } from '../registry.js';
import { getCSS2D } from './_init.js';

export interface SpinningGearOpts {
  /** Glyph to spin. Default '⚙️'. */
  glyph?: string;
  /** Glow color. Default gold. */
  color?: string;
  /** Font size in px. Default 22. */
  fontSize?: number;
  /** Local Y above parent. Default 3.2. */
  startY?: number;
  /** Lifetime in seconds. Default 1.5. */
  durationSec?: number;
  /** Revolutions per second. Default 1.2. */
  spinSpeed?: number;
  /** Optional XZ offset in the parent. */
  offsetXZ?: { x?: number; z?: number };
  tag?: string;
}

export function spinningGear(parent: any, opts: SpinningGearOpts = {}): Ticker {
  const CSS2D = getCSS2D();
  const glyph = opts.glyph ?? '⚙️';
  const fontSize = opts.fontSize ?? 22;
  const color = opts.color ?? '#ffd166';
  const duration = opts.durationSec ?? 1.5;
  const spinRev = opts.spinSpeed ?? 1.2;
  const ox = opts.offsetXZ?.x ?? 0;
  const oz = opts.offsetXZ?.z ?? 0;

  const div = document.createElement('div');
  div.textContent = glyph;
  div.style.cssText = `font-size:${fontSize}px;line-height:1;color:${color};
    text-shadow:0 0 10px ${color};pointer-events:none;will-change:transform,opacity;`;
  const label = new CSS2D(div);
  label.position.set(ox, opts.startY ?? 3.2, oz);
  parent.add(label);

  let elapsed = 0;
  return {
    tag: opts.tag ?? 'spinning-gear',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      const t = elapsed / duration;
      if (t >= 1) return true;

      const rot = elapsed * spinRev * 2 * Math.PI;
      // Fade ramps: in over first 10%, out over last 20%, full in between.
      const opacity = t < 0.1 ? t / 0.1 : t > 0.8 ? Math.max(0, 1 - (t - 0.8) / 0.2) : 1;
      div.style.transform = `rotate(${rot.toFixed(2)}rad)`;
      div.style.opacity = opacity.toFixed(3);
      return false;
    },
    dispose() {
      if (label.parent) label.parent.remove(label);
      div.remove();
    },
  };
}
