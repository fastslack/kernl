import { describe, expect, it } from 'bun:test';
import { layoutDesks } from '$shared/office-lots.js';
import { roomDecorLayout, toRoom, type DoorDir } from './room-decor.js';

const DOORS: DoorDir[] = ['top', 'bottom', 'left', 'right'];
const SIZES: Array<[number, number]> = [[8, 8], [14, 12], [20, 16], [25, 22], [30, 18]];
/** A desk with its chair and worker: what must stay clear. */
const DESK = { w: 2.6, d: 2.6 };

describe('roomDecorLayout', () => {
  for (const door of DOORS) for (const [w, d] of SIZES) {
    const variants = [0, 1, 2];
    it(`keeps a ${w}x${d} room with the door ${door} clear`, () => {
      for (const v of variants) {
        const l = roomDecorLayout(w, d, door, v);
        const doorAt = toRoom(door, w, d, 0, 0);
        for (const p of l.plants) {
          expect(Math.abs(p.dx) + 0.5).toBeLessThan(w / 2);
          expect(Math.abs(p.dz) + 0.5).toBeLessThan(d / 2);
          expect(Math.hypot(p.dx - doorAt.dx, p.dz - doorAt.dz)).toBeGreaterThan(1.25 + 0.5);
        }
        for (const n of [1, 4, 9, 16]) {
          for (const o of layoutDesks(n, w, d)) {
            for (const p of l.plants) {
              expect(Math.abs(o.dx - p.dx) < DESK.w / 2 + 0.5 && Math.abs(o.dz - p.dz) < DESK.d / 2 + 0.5).toBe(false);
            }
            if (l.piece) {
              const c = toRoom(door, w, d, l.piece.a, l.piece.b);
              const alongZ = door === 'left' || door === 'right';
              const hw = (alongZ ? l.piece.len : l.piece.deep) / 2, hd = (alongZ ? l.piece.deep : l.piece.len) / 2;
              expect(Math.abs(o.dx - c.dx) < DESK.w / 2 + hw && Math.abs(o.dz - c.dz) < DESK.d / 2 + hd).toBe(false);
            }
          }
        }
      }
    });
  }

  it('leaves the piece out of a room too small for it', () => {
    expect(roomDecorLayout(8, 8, 'top', 0).piece).toBeNull();
    expect(roomDecorLayout(20, 16, 'top', 0).piece).not.toBeNull();
  });

  it('cycles through the pieces by variant', () => {
    expect(new Set([0, 1, 2].map((v) => roomDecorLayout(20, 16, 'left', v).piece?.kind)).size).toBe(3);
  });
});
