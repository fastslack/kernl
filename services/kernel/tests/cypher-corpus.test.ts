import { describe, it, expect } from "bun:test";
import { join, resolve } from "node:path";
import { relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { checkOnRelate, extractCypher } from "../scripts/relate-cypher-check.js";

/**
 * Every Cypher statement in the kernel and its bundled extensions must run on
 * the built-in graph (Relate): it is the default driver, and a statement
 * written for Neo4j alone fails there silently — graph writes are best-effort
 * and swallow the error. scripts/relate-cypher-check.ts lifts each statement
 * out of the source and asks Relate to plan it (EXPLAIN, so nothing runs); the
 * same script checks any other codebase.
 *
 * Neo4j-only work is exempt when it is gated on a capability Relate does not
 * advertise: Graph Data Science (`gds.*`, behind `capabilities.gds`) and
 * server administration. Statements assembled from parts at run time are
 * planned with placeholders where the parts are identifiers; the rest are
 * skipped and counted.
 */

const ROOT = resolve(import.meta.dir, "..");

describe.skipIf(!relateClientInstalled())("Cypher corpus on the built-in graph", () => {
  it("plans every graph statement in the kernel and its extensions", async () => {
    const r = await checkOnRelate(extractCypher(["src", "assets/extensions"].map((d) => join(ROOT, d)), ROOT));
    // Guard against the extractor silently finding nothing.
    expect(r.planned).toBeGreaterThan(80);
    if (r.failed.length) {
      const list = r.failed.map((f) => `${f.where}\n    ${f.error}\n    ${f.cypher.replace(/\s+/g, " ").slice(0, 160)}`);
      throw new Error(`${r.failed.length} Cypher statement(s) do not run on Relate:\n  ${list.join("\n  ")}`);
    }
    console.info(`Cypher corpus: ${r.planned} planned on Relate, ${r.neo4jOnly} Neo4j-only (GDS/admin), ${r.dynamic} assembled at run time`);
  }, 120_000);
});
