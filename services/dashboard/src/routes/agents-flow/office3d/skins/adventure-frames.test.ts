import { describe, expect, test } from 'bun:test';
import { adventureFrame } from './adventure-frames.js';
import { listSkins, resolveSkin } from './index.js';
import { officeWorkerSkin } from './office-worker.js';
import { retroWorkerSkin } from './retro-worker.js';
import { adventureWorkerSkin } from './adventure-worker.js';

describe('adventure sprites', () => {
  test('shows the front, profile and back as the camera circles the worker', () => {
    expect(adventureFrame('idle', 0, 0).row).toBe(0);
    expect(adventureFrame('idle', 0, Math.PI / 2).row).toBe(1);
    expect(adventureFrame('idle', 0, Math.PI).row).toBe(2);
    expect(adventureFrame('idle', 0, -Math.PI / 2).mirrored).toBe(false);
    expect(adventureFrame('idle', 0, Math.PI / 2).mirrored).toBe(true);
    expect(adventureFrame('idle', 0, Math.PI * 2)).toEqual(adventureFrame('idle', 0, 0));
  });
  test('holds cels between ticks and advances from elapsed time without frame counters', () => {
    expect(adventureFrame('walk', 0.01, 0)).toEqual(adventureFrame('walk', 0.09, 0));
    expect(adventureFrame('walk', 0.1, 0).column).toBe(1);
    expect(adventureFrame('walk', 0.8, 0).column).toBe(0);
    expect(adventureFrame('typing', 0.1, 0).column).toBe(0);
    expect(adventureFrame('talk', 0.1, 0).column).toBe(0);
  });
  test('keeps the original default and resolves alternate styles per agent', () => {
    expect(resolveSkin(undefined)).toBe(officeWorkerSkin);
    expect(resolveSkin('unknown')).toBe(officeWorkerSkin);
    expect(resolveSkin('retro-worker')).toBe(retroWorkerSkin);
    expect(resolveSkin('adventure-worker')).toBe(adventureWorkerSkin);
    expect(listSkins().map(s => s.manifest.id)).toEqual(expect.arrayContaining(['office-worker', 'retro-worker', 'adventure-worker', 'ra-soldier']));
  });
});
