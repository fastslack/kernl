import { describe, it, expect, afterEach } from 'bun:test';
import { cameraTween } from './camera-tween.js';

type G = { window?: unknown };
const g = globalThis as unknown as G;
const hadWindow = 'window' in g;
const originalWindow = g.window;

function rig() {
  return {
    camera: { position: { x: 0, y: 0, z: 0 } },
    controls: { target: { x: 0, y: 0, z: 0 } },
  };
}

const opts = { target: { x: 1, y: 2, z: 3 }, position: { x: 10, y: 20, z: 30 } };

function setReducedMotion(matches: boolean) {
  g.window = { matchMedia: (q: string) => ({ matches: matches && q.includes('reduce') }) };
}

afterEach(() => {
  if (hadWindow) g.window = originalWindow;
  else delete g.window;
});

describe('cameraTween', () => {
  it('jumps to the destination at once when reduced motion is requested', () => {
    setReducedMotion(true);
    const { camera, controls } = rig();
    const ticker = cameraTween(camera, controls, opts);
    expect(controls.target).toEqual(opts.target);
    expect(camera.position).toEqual(opts.position);
    expect(ticker.tag).toBe('camera-tween');
    expect(ticker.update(0.016, 0)).toBe(true);
  });

  it('eases toward the destination without reduced motion', () => {
    setReducedMotion(false);
    const { camera, controls } = rig();
    const ticker = cameraTween(camera, controls, { ...opts, tag: 'focus' });
    expect(camera.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(ticker.tag).toBe('focus');
    expect(ticker.update(0.1, 0)).toBe(false);
    expect(camera.position.x).toBeGreaterThan(0);
    expect(camera.position.x).toBeLessThan(opts.position.x);
  });

  it('lands exactly on the destination at any frame rate', () => {
    setReducedMotion(false);
    for (const fps of [30, 60, 144]) {
      const { camera, controls } = rig();
      const ticker = cameraTween(camera, controls, opts);
      let done = false;
      for (let i = 0; i < 1000 && !done; i++) done = ticker.update(1 / fps, 0);
      expect(done).toBe(true);
      expect(controls.target).toEqual(opts.target);
      expect(camera.position).toEqual(opts.position);
    }
  });

  it('starts from wherever the camera is when its first frame runs', () => {
    setReducedMotion(false);
    const { camera, controls } = rig();
    const ticker = cameraTween(camera, controls, opts);
    camera.position.x = 5;
    ticker.update(0.001, 0);
    expect(camera.position.x).toBeGreaterThanOrEqual(5);
  });

  it('eases when there is no window (server / test runtime)', () => {
    delete g.window;
    const { camera, controls } = rig();
    cameraTween(camera, controls, opts);
    expect(controls.target).toEqual({ x: 0, y: 0, z: 0 });
  });
});
