/**
 * AnimationRegistry — a tiny ticker pool. Each ticker is `update(dt, t): boolean`
 * where returning `true` signals "I'm done, remove me". Use it to host the
 * one-shot camera tweens, pulse effects, particle bursts and any other
 * per-frame work that used to live inline in the Svelte animate() loop.
 *
 * The registry intentionally has no dependency on Three.js or the DOM — it
 * just iterates an array. The effects in `anim/effects/*` produce tickers
 * that close over their own Three.js objects.
 */

export interface Ticker {
  /**
   * Advance the animation by `deltaSec` real-time seconds. `sceneTimeSec` is
   * the monotonically increasing scene clock (same value passed to the pose
   * functions). Return `true` once the animation is finished — the registry
   * will dispose and remove it on the next sweep.
   */
  update(deltaSec: number, sceneTimeSec: number): boolean;
  /**
   * Optional cleanup. Called automatically after `update()` returns true, and
   * when `registry.clear()` runs. Implementations should be idempotent —
   * `clear()` may dispose tickers that have already finished.
   */
  dispose?(): void;
  /**
   * Opaque tag — handy for `cancelByTag()` when a downstream event needs to
   * cancel a specific in-flight tween (e.g. a new camera target arriving
   * before the previous tween finished).
   */
  tag?: string;
}

export interface AnimationRegistry {
  /** Add a ticker. Returns the same instance so callers can keep a handle. */
  add<T extends Ticker>(t: T): T;
  /** Cancel and dispose all tickers carrying `tag`. */
  cancelByTag(tag: string): void;
  /** Advance every ticker; remove finished ones in-place. */
  tick(deltaSec: number, sceneTimeSec: number): void;
  /** Dispose every ticker and empty the registry. */
  clear(): void;
  /** Current count — useful for tests + perf overlays. */
  size(): number;
}

export function createAnimationRegistry(): AnimationRegistry {
  const tickers: Ticker[] = [];

  return {
    add(t) {
      tickers.push(t);
      return t;
    },

    cancelByTag(tag) {
      for (let i = tickers.length - 1; i >= 0; i--) {
        const t = tickers[i];
        if (t.tag === tag) {
          t.dispose?.();
          tickers.splice(i, 1);
        }
      }
    },

    tick(deltaSec, sceneTimeSec) {
      // Iterate backwards so we can splice in-place without index drift.
      for (let i = tickers.length - 1; i >= 0; i--) {
        const t = tickers[i];
        let done = false;
        try {
          done = t.update(deltaSec, sceneTimeSec);
        } catch (err) {
          // A buggy ticker must not take down the whole loop — log and drop.
          // eslint-disable-next-line no-console
          console.error('[anim] ticker threw, removing:', err);
          done = true;
        }
        if (done) {
          t.dispose?.();
          tickers.splice(i, 1);
        }
      }
    },

    clear() {
      for (const t of tickers) t.dispose?.();
      tickers.length = 0;
    },

    size() {
      return tickers.length;
    },
  };
}
