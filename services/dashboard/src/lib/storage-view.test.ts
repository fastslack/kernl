import { describe, it, expect } from "bun:test";
import { fmtBytes, sparkPoints, kindShares } from "./storage-view.js";

describe("storage view helpers", () => {
  it("formats bytes the way the page shows them", () => {
    expect(fmtBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
    expect(fmtBytes(12 * 1024 ** 3)).toBe("12 GB");
    expect(fmtBytes(510 * 1024 ** 2)).toBe("510 MB");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(-1)).toBe("—");
    expect(fmtBytes(null)).toBe("—");
  });

  it("draws a sparkline inside its box", () => {
    expect(sparkPoints([1], 100, 20)).toBe("");
    expect(sparkPoints([0, 10], 100, 20)).toBe("0.0,20.0 100.0,0.0");
    expect(sparkPoints([5, 5, 5], 100, 20)).toBe("0.0,10.0 50.0,10.0 100.0,10.0");
  });

  it("splits weight by kind, biggest kinds first in fixed order, skipping empty ones", () => {
    const shares = kindShares({ operational: 300, reference: 700, cache: 0, personal: 0, unclassified: 0 });
    expect(shares.map((s) => s.kind)).toEqual(["reference", "operational"]);
    expect(shares[0].pct).toBeCloseTo(70);
    expect(kindShares({})).toEqual([]);
  });
});
