/**
 * Floating glyph — a single CSS2D emoji/character that pops in, rises, and
 * fades out. Drives the "Thinking" 💭 and "Tool call" 🔧 animations, plus
 * generic "achievement" pop-ups (e.g. eval grades when you don't want a
 * full bubble).
 */

import type { Ticker } from '../registry.js';
import { easeOutCubic, easeOutQuad } from '../easing.js';
import { getCSS2D } from './_init.js';

export interface FloatingGlyphOpts {
  glyph: string;
  /** CSS color for text-shadow glow. Default `#fff`. */
  color?: string;
  /** Font size in px. Default 18. */
  fontSize?: number;
  /** Initial local Y above the parent. Default 2.6. */
  startY?: number;
  /** Y delta to rise over the lifetime. Default 0.8. */
  riseHeight?: number;
  /** Total lifetime in seconds. Default 1.2. */
  durationSec?: number;
  /** Scale-in time in seconds. Default 0.18. */
  popInSec?: number;
  /** Normalised time at which the fade-out begins (0..1). Default 0.6. */
  fadeStartT?: number;
  /** Local XZ offset inside the parent. */
  offsetXZ?: { x?: number; z?: number };
  tag?: string;
}

/** `parent` is any Three.js Object3D that the CSS2DObject will be added to. */
export function floatingGlyph(parent: any, opts: FloatingGlyphOpts): Ticker {
  const CSS2D = getCSS2D();
  const color = opts.color ?? '#fff';
  const fontSize = opts.fontSize ?? 18;
  const duration = opts.durationSec ?? 1.2;
  const popIn = opts.popInSec ?? 0.18;
  const startY = opts.startY ?? 2.6;
  const rise = opts.riseHeight ?? 0.8;
  const fadeStart = opts.fadeStartT ?? 0.6;
  const ox = opts.offsetXZ?.x ?? 0;
  const oz = opts.offsetXZ?.z ?? 0;

  const div = document.createElement('div');
  div.textContent = opts.glyph;
  div.style.cssText = `font-size:${fontSize}px;line-height:1;text-shadow:0 0 8px ${color};
    pointer-events:none;will-change:transform,opacity;transform-origin:center;
    transform:scale(0);opacity:0;`;
  const label = new CSS2D(div);
  label.position.set(ox, startY, oz);
  parent.add(label);

  let elapsed = 0;

  return {
    tag: opts.tag ?? 'floating-glyph',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      const t = elapsed / duration;
      if (t >= 1) return true;

      const scale = easeOutQuad(Math.min(elapsed / popIn, 1));
      label.position.y = startY + rise * easeOutCubic(t);
      const opacity = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (1 - fadeStart));
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
