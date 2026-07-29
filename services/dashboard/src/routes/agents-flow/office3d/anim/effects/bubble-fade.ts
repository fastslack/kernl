/**
 * Speech-bubble fade — age the bubble's lifetime counter, fade out across the
 * final `fadeFrames` frames, and remove from the parent + DOM when expired.
 *
 * NOTE: this preserves the original semantics where `age`/`maxAge` are in
 * *frames*, not seconds (showBubble/showGradeBubble document their dur as
 * frames). The ticker increments `age` by 1 per registry tick.
 */

import type { Ticker } from '../registry.js';

export interface BubbleFadeOpts {
  /** Lifetime in frames. */
  maxAgeFrames: number;
  /** Fade ramp length in frames. Default 30. */
  fadeFrames?: number;
  /** Called when the bubble has fully expired — host removes `label` from
   *  parent and drops the entry from its bookkeeping map here. */
  onExpire: () => void;
  tag?: string;
}

/**
 * `div` is the DOM element whose `style.opacity` we drive. `label` is the
 * CSS2DObject (only needed by `onExpire` callers — not the ticker itself).
 */
export function bubbleFade(div: HTMLElement, opts: BubbleFadeOpts): Ticker {
  const fadeFrames = opts.fadeFrames ?? 30;
  const fadeStart = opts.maxAgeFrames - fadeFrames;
  let age = 0;

  return {
    tag: opts.tag ?? 'bubble-fade',
    update(): boolean {
      age++;
      if (age > fadeStart) {
        div.style.opacity = String(Math.max(0, 1 - (age - fadeStart) / fadeFrames));
      }
      if (age > opts.maxAgeFrames) {
        opts.onExpire();
        return true;
      }
      return false;
    },
  };
}
