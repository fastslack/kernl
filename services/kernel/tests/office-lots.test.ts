import { describe, it, expect } from "bun:test";
import {
  colCenterX, rowCenterZ, colWidth, rowDepth, isReservedCell, lotAt, parseLotId,
  lotsInRing, pickLot, extentRing, layoutDesks, lotCapacity, LOT_CORRIDOR_W,
} from "../assets/extensions/_shared/office-lots.js";

describe("office lots — geometry", () => {
  it("puts the hall at the origin", () => {
    expect(colCenterX(0)).toBe(0);
    expect(rowCenterZ(0)).toBe(0);
  });

  it("leaves exactly one corridor between neighbouring cells", () => {
    for (let c = -6; c < 6; c++) {
      const gap = (colCenterX(c + 1) - colWidth(c + 1) / 2) - (colCenterX(c) + colWidth(c) / 2);
      expect(gap).toBeCloseTo(LOT_CORRIDOR_W);
    }
    for (let r = -6; r < 6; r++) {
      const gap = (rowCenterZ(r + 1) - rowDepth(r + 1) / 2) - (rowCenterZ(r) + rowDepth(r) / 2);
      expect(gap).toBeCloseTo(LOT_CORRIDOR_W);
    }
  });

  it("never offers the core or the hall's run to the entrance", () => {
    for (const [c, r] of [[0, 0], [-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1], [0, 1], [0, 5]]) {
      expect(isReservedCell(c, r)).toBe(true);
      expect(lotAt(c, r)).toBeNull();
    }
  });

  it("round-trips a lot id", () => {
    const lot = lotAt(2, -2)!;
    expect(parseLotId(lot.id)).toEqual(lot);
    expect(parseLotId("")).toBeNull();
    expect(parseLotId("0,0")).toBeNull();
    expect(parseLotId("garbage")).toBeNull();
  });

  it("sizes capacity from the square desk grid", () => {
    expect(lotCapacity(15, 15)).toBe(4);
    expect(lotCapacity(19.5, 19.5)).toBe(9);
    expect(lotCapacity(24, 24)).toBe(16);
  });

  it("orders a ring nearest the hall first", () => {
    const ring2 = lotsInRing(2);
    const d = ring2.map((l) => l.col ** 2 + l.row ** 2);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(ring2.every((l) => l.ring === 2)).toBe(true);
  });
});

describe("office lots — picking", () => {
  it("is deterministic and takes the nearest lot that fits", () => {
    const a = pickLot(new Set(), 3, "general");
    const b = pickLot(new Set(), 3, "general");
    expect(a).toEqual(b);
    expect(a.ring).toBe(1);
  });

  it("skips lots that are taken", () => {
    const first = pickLot(new Set(), 3);
    const second = pickLot(new Set([first.id]), 3);
    expect(second.id).not.toBe(first.id);
  });

  it("skips lots too small for the team", () => {
    const lot = pickLot(new Set(), 12);
    expect(lot.capacity).toBeGreaterThanOrEqual(12);
  });

  it("gives a data-center office more than the smallest lot", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const lot = pickLot(taken, 1, "devops");
      expect(lot.w * lot.d).toBeGreaterThanOrEqual(19.5 * 15);
      taken.add(lot.id);
    }
  });

  it("falls back to the biggest free lot for a team no lot holds", () => {
    const lot = pickLot(new Set(), 40);
    expect(lot.capacity).toBe(16);
  });

  it("picking never changes an existing lot's rectangle", () => {
    const before = lotAt(-2, 1)!;
    const taken = new Set<string>([before.id]);
    for (let i = 0; i < 30; i++) taken.add(pickLot(taken, 5).id);
    expect(lotAt(-2, 1)).toEqual(before);
  });

  it("grows the floor out to the farthest office", () => {
    expect(extentRing([])).toBe(2);
    expect(extentRing(["1,1"])).toBe(2);
    expect(extentRing(["1,1", "3,-1"])).toBe(3);
  });
});

describe("office lots — desks", () => {
  it("uses full spacing when the team fits", () => {
    const desks = layoutDesks(4, 19.5, 19.5);
    expect(desks).toHaveLength(4);
    expect(Math.abs(desks[1].dx - desks[0].dx)).toBeCloseTo(4.5);
  });

  it("compacts an overflowing team inside the walls", () => {
    const w = 15, d = 15;
    const desks = layoutDesks(12, w, d);
    expect(desks).toHaveLength(12);
    for (const p of desks) {
      expect(Math.abs(p.dx)).toBeLessThan(w / 2 - 1);
      expect(Math.abs(p.dz)).toBeLessThan(d / 2 - 1);
    }
  });
});
