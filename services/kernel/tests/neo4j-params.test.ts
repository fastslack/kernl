import { describe, it, expect } from "bun:test";
import neo4j from "neo4j-driver";
import { integerPagingParams } from "../src/core/db/neo4j-params.js";

describe("integerPagingParams", () => {
  it("sends the LIMIT and SKIP parameters as integers, which Neo4j requires", () => {
    const p = integerPagingParams("MATCH (k:CinemaWork) WITH k SKIP $from LIMIT $n DETACH DELETE k", { n: 5000, from: 10, name: "x" })!;
    expect(neo4j.isInt(p.n)).toBe(true);
    expect((p.n as { toNumber(): number }).toNumber()).toBe(5000);
    expect(neo4j.isInt(p.from)).toBe(true);
    expect(p.name).toBe("x");
  });

  it("leaves every other number as it was, and the caller's object untouched", () => {
    const params = { limit: 3, score: 0.5, count: 7 };
    const p = integerPagingParams("MATCH (n) SET n.count = $count RETURN n LIMIT $limit", params)!;
    expect(p.count).toBe(7);
    expect(p.score).toBe(0.5);
    expect(params.limit).toBe(3);
    // Nothing to page: the same object back.
    expect(integerPagingParams("RETURN $count", params)).toBe(params);
    expect(integerPagingParams("RETURN 1 LIMIT $x", undefined)).toBeUndefined();
  });

  it("truncates a fractional page size instead of failing", () => {
    const p = integerPagingParams("MATCH (n) RETURN n limit $lim", { lim: 12.7 })!;
    expect((p.lim as { toNumber(): number }).toNumber()).toBe(12);
  });
});
