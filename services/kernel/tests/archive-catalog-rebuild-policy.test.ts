import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { ArchiveCatalog } from "../assets/extensions/leisure/_lib/archive-catalog/service.js";
import { archiveCatalogMigrations } from "../assets/extensions/leisure/_lib/archive-catalog/migrations.js";
import {
  derivedIndexIsDue,
  DERIVED_INDEX_MAX_AGE_MS,
} from "../assets/extensions/leisure/_lib/archive-catalog/rebuild-policy.js";

// Rebuilding a catalog's derived indexes (tags, works) reads every title and
// rewrites the whole table, synchronously. Ingest passes used to rebuild after
// any pass that "updated" rows — and a refresh updates every known row it
// sees — so cinema froze the kernel for 5.4s every 15 minutes and music for
// 1.1s every 5 minutes (measured against /api/health on a live install).

const NOW = Date.parse("2026-09-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

describe("derivedIndexIsDue", () => {
  it("rebuilds as soon as new titles arrive", () => {
    expect(derivedIndexIsDue({ inserted: 3, updated: 0, builtAt: ago(0), now: NOW })).toBe(true);
  });

  it("skips a pass that only refreshed known titles while the index is fresh", () => {
    expect(derivedIndexIsDue({ inserted: 0, updated: 200, builtAt: ago(HOUR), now: NOW })).toBe(false);
  });

  it("rebuilds a refreshed-only index once it reaches the max age", () => {
    expect(derivedIndexIsDue({ inserted: 0, updated: 200, builtAt: ago(DERIVED_INDEX_MAX_AGE_MS), now: NOW })).toBe(true);
  });

  it("builds an index that was never built, once a pass touched titles", () => {
    expect(derivedIndexIsDue({ inserted: 0, updated: 5, builtAt: null, now: NOW })).toBe(true);
  });

  it("does nothing after a pass that touched no titles", () => {
    expect(derivedIndexIsDue({ inserted: 0, updated: 0, builtAt: null, now: NOW })).toBe(false);
  });
});

describe("ArchiveCatalog.tagsBuiltAt", () => {
  it("is null until tags are built, then the time they were built", () => {
    const db = new Database(":memory:");
    runMigrations(db, "music_catalog", archiveCatalogMigrations("music"));
    const catalog = new ArchiveCatalog({ db, prefix: "music" });

    expect(catalog.tagsBuiltAt()).toBeNull();

    catalog.upsertFromScrape({ identifier: "x", title: "x", subject: ["Jazz"] } as never);
    catalog.rebuildTags();

    const builtAt = catalog.tagsBuiltAt();
    expect(builtAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(builtAt!))).toBe(false);
    db.close();
  });
});
