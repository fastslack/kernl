import { describe, it, expect } from 'bun:test';
import { freeDropSpot, overlaps, type Spot } from './drop-spot.js';

const base: Spot = { x: 0, y: 1, z: 0 };

describe('freeDropSpot', () => {
  it('uses the base point when the counter is empty', () => {
    expect(freeDropSpot(base, [])).toEqual(base);
  });

  it('never returns a spot that overlaps a parcel already there', () => {
    const occupied: Spot[] = [];
    for (let i = 0; i < 40; i++) {
      const s = freeDropSpot(base, occupied);
      expect(occupied.some((o) => overlaps(s, o))).toBe(false);
      occupied.push(s);
    }
  });

  it('walks along the counter before stacking', () => {
    const s = freeDropSpot(base, [base]);
    expect(s.y).toBe(base.y);
    expect(s.z).toBe(base.z);
    expect(Math.abs(s.x - base.x)).toBeGreaterThan(0.4);
  });

  it('ignores parcels far enough away', () => {
    expect(freeDropSpot(base, [{ x: 5, y: 1, z: 0 }])).toEqual(base);
  });
});
