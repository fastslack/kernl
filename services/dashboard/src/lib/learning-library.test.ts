import { describe, it, expect } from "bun:test";
import { bookAt, libraryWeeks, librarySummary, lineageHops, lineageReach, type LibraryBook, type LineageNode } from "./learning-library.js";

const book = (o: Partial<LibraryBook> = {}): LibraryBook => ({
  id: "b", type: "avoid", content: "x", confidence: 0.5, active: true,
  created_at: "2026-11-02T10:00:00.000Z", last_used: null, uses: 0, shared_uses: 0, ...o,
});
const T = (iso: string) => Date.parse(iso);

describe("the experience library at a moment", () => {
  it("a book appears when learned and holds the confidence recorded by then", () => {
    const tl = { points: [["2026-11-02T10:00:00.000Z", 0.4], ["2026-11-05T10:00:00.000Z", 0.48], ["2026-11-09T10:00:00.000Z", 0.33]] as Array<[string, number]>, retired_at: null };
    expect(bookAt(book(), tl, T("2026-11-01T00:00:00Z")).present).toBe(false);
    expect(bookAt(book(), tl, T("2026-11-03T00:00:00Z")).confidence).toBe(0.4);
    expect(bookAt(book(), tl, T("2026-11-06T00:00:00Z")).confidence).toBe(0.48);
    expect(bookAt(book(), tl, T("2026-11-12T00:00:00Z")).confidence).toBe(0.33);
  });

  it("a retired book falls only from when it was retired; without a date, always", () => {
    const b = book({ active: false });
    const tl = { points: [], retired_at: "2026-11-08T00:00:00.000Z" };
    expect(bookAt(b, tl, T("2026-11-07T00:00:00Z")).retired).toBe(false);
    expect(bookAt(b, tl, T("2026-11-09T00:00:00Z")).retired).toBe(true);
    expect(bookAt(b, undefined, T("2026-11-03T00:00:00Z")).retired).toBe(true);
  });

  it("dust gathers from the last use (or from when it was learned) over a month", () => {
    const used = book({ last_used: "2026-11-10T10:00:00.000Z" });
    expect(bookAt(used, undefined, T("2026-11-10T10:00:00Z")).dust).toBe(0);
    expect(bookAt(used, undefined, T("2026-11-25T10:00:00Z")).dust).toBeCloseTo(0.5);
    // Before its last use happened, the dust counts from when it was learned.
    expect(bookAt(used, undefined, T("2026-11-09T10:00:00Z")).dust).toBeCloseTo(7 / 30);
  });

  it("weeks run Monday to Monday from the first lesson and end now; the summary counts by then", () => {
    const lib = { agents: [{ id: "a", name: "A", flow_id: "", books: [
      book({ id: "1", created_at: "2026-10-29T09:00:00.000Z", confidence: 0.6, shared_uses: 1 }),
      book({ id: "2", created_at: "2026-11-10T09:00:00.000Z", confidence: 0.4 }),
      book({ id: "3", created_at: "2026-10-30T09:00:00.000Z", active: false }),
    ] }], timelines: { "3": { points: [], retired_at: "2026-11-04T00:00:00.000Z" } } };
    const now = T("2026-11-12T12:00:00Z");
    const weeks = libraryWeeks(lib, now);
    expect(new Date(weeks[0]).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(weeks.at(-1)).toBe(now);
    expect(librarySummary(lib, T("2026-11-01T00:00:00Z"))).toEqual({ held: 2, retired: 0, avgConfidence: 0.55, shared: 1 });
    expect(librarySummary(lib, now)).toEqual({ held: 2, retired: 1, avgConfidence: 0.5, shared: 1 });
  });
});

describe("a lesson's lineage", () => {
  const nodes: LineageNode[] = [
    { id: "l1", depth: 1, type: "insight", content: "", confidence: 0.6, active: true, created_at: "", owner: { id: "b", name: "Bruno" }, from_runs: ["r1"],
      uses: [{ run: "r2", agent: "c", name: "Ciro", status: "failed", at: "", child: null }] },
    { id: "l0", depth: 0, type: "avoid", content: "", confidence: 0.5, active: true, created_at: "", owner: { id: "a", name: "Ana" }, from_runs: ["r0"],
      uses: [
        { run: "r1", agent: "b", name: "Bruno", status: "completed", at: "", child: "l1" },
        { run: "r9", agent: "a", name: "Ana", status: "completed", at: "", child: null },
      ] },
  ];
  it("hops go from who learned each lesson to the agents whose runs carried it, root first", () => {
    expect(lineageHops(nodes)).toEqual([
      { learningId: "l0", depth: 0, from: "a", to: "b", toName: "Bruno", ok: true, child: "l1" },
      { learningId: "l1", depth: 1, from: "b", to: "c", toName: "Ciro", ok: false, child: null },
    ]);
  });
  it("reach: agents, runs and how they went, and the lessons it gave rise to", () => {
    expect(lineageReach(nodes)).toEqual({ agents: 3, runs: 3, ok: 2, descendants: 1 });
  });
});
