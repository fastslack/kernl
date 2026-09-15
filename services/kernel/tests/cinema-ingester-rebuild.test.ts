import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { ingestNextChunk } from "../assets/extensions/leisure/cinema/_module/ingester.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

// A cinema refresh pass re-reads the newest page of a collection and upserts
// titles it already has. Each of those counted as "updated", and any update
// triggered a full rebuild of cinema_tags and cinema_works: 5.4 seconds with
// the kernel frozen, every 15 minutes, on a 245K-title catalogue.

const realFetch = globalThis.fetch;

function archiveServing(ids: string[]): typeof fetch {
  return (async () =>
    Response.json({
      items: ids.map((identifier) => ({ identifier, title: identifier, subject: ["Drama"] })),
      cursor: null,
    })) as unknown as typeof fetch;
}

describe("cinema ingester rebuilds", () => {
  let db: SqliteDb;
  let svc: CinemaService;
  let rebuilds: { tags: number; works: number };

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "cinema", cinemaMigrations);
    svc = new CinemaService(db);
    rebuilds = { tags: 0, works: 0 };
    const rebuildTags = svc.rebuildTags.bind(svc);
    const rebuildWorks = svc.rebuildWorks.bind(svc);
    svc.rebuildTags = () => { rebuilds.tags++; return rebuildTags(); };
    svc.rebuildWorks = () => { rebuilds.works++; return rebuildWorks(); };
    globalThis.fetch = archiveServing(["a1", "a2"]);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("rebuilds after a pass that brings in new titles", async () => {
    await ingestNextChunk(svc, ["feature_films"]);
    expect(rebuilds).toEqual({ tags: 1, works: 1 });
  });

  it("does not rebuild after a refresh that only re-reads known titles", async () => {
    await ingestNextChunk(svc, ["feature_films"]);
    await ingestNextChunk(svc, ["feature_films"]);
    expect(rebuilds).toEqual({ tags: 1, works: 1 });
  });

  it("rebuilds on a refresh once the indexes are old enough", async () => {
    await ingestNextChunk(svc, ["feature_films"]);
    const sevenHoursAgo = new Date(Date.now() - 7 * 3_600_000).toISOString();
    db.prepare("UPDATE cinema_tags SET updated_at = ?").run(sevenHoursAgo);

    await ingestNextChunk(svc, ["feature_films"]);
    expect(rebuilds).toEqual({ tags: 2, works: 2 });
  });
});
