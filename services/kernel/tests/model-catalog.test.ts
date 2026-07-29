import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ModelCatalog } from "../src/core/llm/model-catalog.js";

describe("ModelCatalog", () => {
  let db: Database;
  let clock: number;
  let catalog: ModelCatalog;

  beforeEach(() => {
    db = new Database(":memory:");
    clock = 1_000;
    catalog = new ModelCatalog(db, () => clock);
  });
  afterEach(() => db.close());

  it("first discovery reports every model as added, none removed", () => {
    const delta = catalog.recordDiscovery("minimax", ["MiniMax-M2.7", "MiniMax-Text-01"]);
    expect(delta.added.sort()).toEqual(["MiniMax-M2.7", "MiniMax-Text-01"]);
    expect(delta.removed).toEqual([]);
    expect(catalog.availableModels("minimax")).toEqual(["MiniMax-M2.7", "MiniMax-Text-01"]);
  });

  it("marks a vanished model 'gone' and reports it removed", () => {
    catalog.recordDiscovery("minimax", ["MiniMax-M2.7", "MiniMax-Text-01"]);
    clock = 2_000;
    const delta = catalog.recordDiscovery("minimax", ["MiniMax-Text-01"]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual(["MiniMax-M2.7"]);
    expect(catalog.isGone("minimax", "MiniMax-M2.7")).toBe(true);
    expect(catalog.isGone("minimax", "MiniMax-Text-01")).toBe(false);
    expect(catalog.availableModels("minimax")).toEqual(["MiniMax-Text-01"]);
  });

  it("a brand-new model on a later run is reported added", () => {
    catalog.recordDiscovery("minimax", ["MiniMax-M2.7"]);
    clock = 2_000;
    const delta = catalog.recordDiscovery("minimax", ["MiniMax-M2.7", "MiniMax-M3"]);
    expect(delta.added).toEqual(["MiniMax-M3"]);
    expect(delta.removed).toEqual([]);
  });

  it("a returning (gone→available) model is reported added again, first_seen preserved", () => {
    catalog.recordDiscovery("minimax", ["MiniMax-M2.7"]); // first_seen = 1000
    clock = 2_000;
    catalog.recordDiscovery("minimax", []); // empty list still reconciles here (caller guards, not the catalog)
    expect(catalog.isGone("minimax", "MiniMax-M2.7")).toBe(true);
    clock = 3_000;
    const delta = catalog.recordDiscovery("minimax", ["MiniMax-M2.7"]);
    expect(delta.added).toEqual(["MiniMax-M2.7"]);
    const row = catalog.list({ slug: "minimax" })[0];
    expect(row.first_seen).toBe(1_000); // unchanged across the round-trip
    expect(row.last_seen).toBe(3_000);
    expect(row.status).toBe("available");
  });

  it("isGone is false for never-seen pairs (unknown ≠ gone)", () => {
    catalog.recordDiscovery("minimax", ["MiniMax-M2.7"]);
    expect(catalog.isGone("minimax", "does-not-exist")).toBe(false);
    expect(catalog.isGone("openai", "MiniMax-M2.7")).toBe(false);
  });

  it("list filters by slug and status", () => {
    catalog.recordDiscovery("minimax", ["MiniMax-M2.7", "MiniMax-M3"]);
    catalog.recordDiscovery("openai", ["gpt-5"]);
    clock = 2_000;
    catalog.recordDiscovery("minimax", ["MiniMax-M3"]); // M2.7 → gone
    expect(catalog.list({ slug: "minimax" }).map((r) => r.model)).toEqual(["MiniMax-M2.7", "MiniMax-M3"]);
    expect(catalog.list({ status: "gone" }).map((r) => `${r.slug}/${r.model}`)).toEqual(["minimax/MiniMax-M2.7"]);
    expect(catalog.list({ slug: "openai", status: "available" }).map((r) => r.model)).toEqual(["gpt-5"]);
  });
});
